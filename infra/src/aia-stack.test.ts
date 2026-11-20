// M2-01: what the AWS stack must guarantee, checked on the synthesized
// template (no AWS access needed): raw bars kept and never deletable by the
// apps, nothing public but CloudFront, least-privilege task roles, no secret in
// plain environment variables, one hydration writer, and every platform route
// reachable through CloudFront.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { API_PATHS, AiaStack } from './aia-stack.js';
import { ENVIRONMENTS } from './environments.js';

type Resource = { readonly Type: string; readonly Properties: Record<string, unknown>; readonly DeletionPolicy?: string };
type Statement = { readonly Action: string | string[]; readonly Resource: unknown };

let template: Template;
let resources: Record<string, Resource>;

beforeAll(() => {
  const environment = ENVIRONMENTS['dev'];
  if (environment === undefined) throw new Error('no dev environment');
  const app = new App();
  const stack = new AiaStack(app, 'aia-dev', { environment, env: { account: environment.account, region: environment.region } });
  template = Template.fromStack(stack);
  resources = template.toJSON().Resources as Record<string, Resource>;
});

const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
const logicalId = (prefix: string, type: string) => {
  const found = ofType(type).find(([id]) => id.startsWith(prefix));
  if (found === undefined) throw new Error(`no ${type} ${prefix}`);
  return found[0];
};
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
/** The policy statements attached to a role, by its logical id prefix. */
function statements(rolePrefix: string): Statement[] {
  const role = logicalId(rolePrefix, 'AWS::IAM::Role');
  return ofType('AWS::IAM::Policy')
    .filter(([, p]) => (p.Properties['Roles'] as { Ref: string }[]).some((r) => r.Ref === role))
    .flatMap(([, p]) => (p.Properties['PolicyDocument'] as { Statement: Statement[] }).Statement);
}
const mentions = (s: Statement, logical: string) => JSON.stringify(s.Resource).includes(`"${logical}"`);
function container(name: string): Record<string, unknown> {
  for (const [, task] of ofType('AWS::ECS::TaskDefinition')) {
    const found = (task.Properties['ContainerDefinitions'] as Record<string, unknown>[]).find((c) => c['Name'] === name);
    if (found !== undefined) return found;
  }
  throw new Error(`no container ${name}`);
}
const environmentOf = (name: string) =>
  Object.fromEntries((container(name)['Environment'] as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]));

describe('storage', () => {
  it('keeps raw bars whatever happens to the stack, versioned (CLAUDE.md rule 3)', () => {
    const raw = resources[logicalId('Raw', 'AWS::S3::Bucket')];
    expect(raw?.DeletionPolicy).toBe('Retain');
    expect(raw?.Properties['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
  });

  it('keeps cooked bars, the chart and the users table too', () => {
    expect(resources[logicalId('Cooked', 'AWS::S3::Bucket')]?.DeletionPolicy).toBe('Retain');
    expect(resources[logicalId('Users', 'AWS::DynamoDB::Table')]?.DeletionPolicy).toBe('Retain');
  });

  it('blocks public access on every bucket and refuses plain HTTP', () => {
    const buckets = ofType('AWS::S3::Bucket');
    expect(buckets).toHaveLength(3);
    for (const [, bucket] of buckets) {
      expect(bucket.Properties['PublicAccessBlockConfiguration']).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
    expect(ofType('AWS::S3::BucketPolicy')).toHaveLength(3);
    template.allResourcesProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });

  it('has the users table the access context expects', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});

describe('access', () => {
  it('creates exactly the four task roles and no helper functions', () => {
    const names = ofType('AWS::IAM::Role').map(([, r]) => r.Properties['RoleName']);
    expect(names.sort()).toEqual([
      'aia-dev-hydration-task-execution-role',
      'aia-dev-hydration-task-role',
      'aia-dev-platform-task-execution-role',
      'aia-dev-platform-task-role',
    ]);
    expect(ofType('AWS::Lambda::Function')).toEqual([]);
    expect(ofType('Custom::AWS')).toEqual([]);
  });

  it('lets hydration write raw bars but never delete them', () => {
    const raw = logicalId('Raw', 'AWS::S3::Bucket');
    const onRaw = statements('HydrationTaskRole').filter((s) => mentions(s, raw));
    expect(onRaw.flatMap(actions)).toContain('s3:PutObject');
    expect(onRaw.flatMap(actions).filter((a) => a.startsWith('s3:Delete'))).toEqual([]);
  });

  it('lets the platform only read bars, and use the users table', () => {
    const platform = statements('PlatformTaskRole');
    const s3 = platform.flatMap(actions).filter((a) => a.startsWith('s3:'));
    expect(s3.filter((a) => !/^s3:(Get|List)/.test(a))).toEqual([]);
    expect(platform.some((s) => mentions(s, logicalId('Users', 'AWS::DynamoDB::Table')))).toBe(true);
    expect(platform.some((s) => mentions(s, logicalId('MassiveKey', 'AWS::SecretsManager::Secret')))).toBe(false);
  });

  it('gives the Massive key to hydration only, as an ECS secret, never as a plain variable', () => {
    expect(container('hydration')['Secrets']).toEqual([{ Name: 'MASSIVE_API_KEY', ValueFrom: { Ref: logicalId('MassiveKey', 'AWS::SecretsManager::Secret') } }]);
    expect(container('platform')['Secrets']).toBeUndefined();
    for (const name of ['platform', 'hydration']) {
      expect(Object.keys(environmentOf(name)).filter((k) => /KEY|SECRET|PASSWORD|TOKEN/.test(k))).toEqual([]);
    }
  });

  it('runs the platform with the real sign-in, never developer access', () => {
    const env = environmentOf('platform');
    expect(env['AIA_DEV_AUTH']).toBeUndefined();
    expect(env).toMatchObject({ AIA_S3_ENDPOINT: 'aws', AIA_DYNAMODB_ENDPOINT: 'aws', AIA_HOST: '0.0.0.0', AIA_PORT: '8080' });
    expect(env['AIA_TRUSTED_PROXIES']).toBe('2');
  });
});

describe('network', () => {
  it('keeps the load balancer internal, reachable only from CloudFront', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    // CloudFront's VPC origin connects from CloudFront's public addresses, so a VPC range would never match.
    const alb = logicalId('AlbSg', 'AWS::EC2::SecurityGroup');
    expect(resources[alb]?.Properties['SecurityGroupIngress']).toBeUndefined();
    const albIngress = ofType('AWS::EC2::SecurityGroupIngress')
      .map(([, r]) => r.Properties)
      .filter((p) => JSON.stringify(p['GroupId']) === JSON.stringify({ 'Fn::GetAtt': [alb, 'GroupId'] }));
    expect(albIngress).toEqual([
      { GroupId: { 'Fn::GetAtt': [alb, 'GroupId'] }, SourcePrefixListId: 'pl-3b927c52', Description: 'CloudFront VPC origin', FromPort: 80, IpProtocol: 'tcp', ToPort: 80 },
    ]);
  });

  it('lets nothing reach the tasks or the cache except the load balancer and the apps', () => {
    for (const [, sg] of ofType('AWS::EC2::SecurityGroup')) {
      for (const rule of (sg.Properties['SecurityGroupIngress'] as { CidrIp?: unknown }[] | undefined) ?? []) expect(rule.CidrIp).not.toBe('0.0.0.0/0');
    }
    const ingress = ofType('AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties);
    const sg = (prefix: string) => ({ 'Fn::GetAtt': [logicalId(prefix, 'AWS::EC2::SecurityGroup'), 'GroupId'] });
    expect(ingress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ GroupId: sg('AlbSg'), SourcePrefixListId: 'pl-3b927c52', FromPort: 80 }),
        expect.objectContaining({ GroupId: sg('PlatformSg'), SourceSecurityGroupId: sg('AlbSg'), FromPort: 8080 }),
        expect.objectContaining({ GroupId: sg('CacheSg'), SourceSecurityGroupId: sg('PlatformSg'), FromPort: 6379 }),
        expect.objectContaining({ GroupId: sg('CacheSg'), SourceSecurityGroupId: sg('HydrationSg'), FromPort: 6379 }),
      ]),
    );
    expect(ingress).toHaveLength(4);
  });

  it('uses Valkey Serverless over TLS, with a cost ceiling', () => {
    template.hasResourceProperties('AWS::ElastiCache::ServerlessCache', {
      Engine: 'valkey',
      CacheUsageLimits: { DataStorage: { Maximum: 5, Unit: 'GB' }, ECPUPerSecond: { Maximum: 20_000 } },
    });
    expect(JSON.stringify(environmentOf('hydration')['AIA_REDIS_URL'])).toContain('rediss://');
  });
});

describe('apps', () => {
  it('never runs two hydration writers at once', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'aia-dev-hydration',
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
    });
    expect(container('hydration')['Command']).toEqual(['tsx', 'apps/hydration/src/live.ts']);
  });

  it('runs both apps on ARM Fargate', () => {
    template.allResourcesProperties('AWS::ECS::TaskDefinition', { RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' } });
  });
});

describe('CloudFront', () => {
  it('sends every platform route to the load balancer, uncached, and the rest to the chart', () => {
    const distribution = ofType('AWS::CloudFront::Distribution')[0]?.[1].Properties['DistributionConfig'] as {
      CacheBehaviors: { PathPattern: string; CachePolicyId: string; TargetOriginId: string }[];
      DefaultCacheBehavior: { TargetOriginId: string };
    };
    expect(distribution.CacheBehaviors.map((b) => b.PathPattern)).toEqual([...API_PATHS]);
    const cachingDisabled = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
    for (const behavior of distribution.CacheBehaviors) {
      expect(behavior.CachePolicyId).toBe(cachingDisabled);
      expect(behavior.TargetOriginId).not.toBe(distribution.DefaultCacheBehavior.TargetOriginId);
    }
    expect(ofType('AWS::CloudFront::VpcOrigin')).toHaveLength(1);
    expect(ofType('AWS::CloudFront::OriginAccessControl')).toHaveLength(1);
  });

  it('covers every route the platform serves (apps/platform/src)', () => {
    const dir = fileURLToPath(new URL('../../apps/platform/src/', import.meta.url));
    const routes = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'e2e-server.ts')) {
      for (const match of readFileSync(`${dir}${file}`, 'utf8').matchAll(/app\.(?:get|post|put|delete|patch)(?:<[^>]*>)?\(\s*'(\/[^']*)'/g)) {
        routes.add(match[1] as string);
      }
    }
    expect(routes.size).toBeGreaterThan(5);
    const covered = (route: string) =>
      API_PATHS.some((pattern) => (pattern.endsWith('*') ? route.startsWith(pattern.slice(0, -1)) : route === pattern));
    expect([...routes].filter((route) => !covered(route))).toEqual([]);
  });
});

describe('audit records (M4-04)', () => {
  it('keeps them in their own retained table, expired by ttl', () => {
    const audit = resources[logicalId('Audit', 'AWS::DynamoDB::Table')];
    expect(audit?.DeletionPolicy).toBe('Retain');
    expect(audit?.Properties['TimeToLiveSpecification']).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(audit?.Properties['BillingMode']).toBe('PAY_PER_REQUEST');
    expect(environmentOf('platform')['AIA_AUDIT_TABLE']).toEqual({ Ref: logicalId('Audit', 'AWS::DynamoDB::Table') });
  });

  it('lets the platform add and read records, never change or delete them, and hydration not at all', () => {
    const audit = logicalId('Audit', 'AWS::DynamoDB::Table');
    const onAudit = statements('PlatformTaskRole').filter((s) => mentions(s, audit));
    expect(onAudit.flatMap(actions).sort()).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DescribeTable', 'dynamodb:PutItem', 'dynamodb:Query']);
    expect(statements('HydrationTaskRole').some((s) => mentions(s, audit))).toBe(false);
  });

  it('routes GET /usage through CloudFront to the platform', () => {
    expect(API_PATHS).toContain('/usage*');
  });
});

