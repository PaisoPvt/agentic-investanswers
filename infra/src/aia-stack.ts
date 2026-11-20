// The whole AWS environment for one account (M2-01; docs/architecture.md,
// "AWS"). One container image runs both apps: the platform behind an internal
// load balancer, and hydration's live stream. CloudFront is the only public
// door: the chart from S3, the API and the live WebSocket through a private
// VPC origin, so the load balancer is never reachable from the internet.
//
// Raw bars are kept whatever happens to the stack (CLAUDE.md rule 3); cooked
// bars and the users table are kept too. The stack creates no helper Lambda
// functions, so it creates no IAM roles beyond the four task roles.

import { fileURLToPath } from 'node:url';

import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

import type { AiaEnvironment } from './environments.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PLATFORM_PORT = 8080;
const REDIS_PORT = 6379;

/** The platform's routes; everything else is the chart. Keep in step with apps/platform/src/server.ts. */
/** AWS's managed prefix list com.amazonaws.global.cloudfront.origin-facing (the same id in every account and region). */
export const CLOUDFRONT_ORIGIN_FACING = 'pl-3b927c52';

export const API_PATHS = ['/bars*', '/instruments*', '/indicators*', '/plan*', '/auth/*', '/live*', '/mcp*', '/health'] as const;

export interface AiaStackProps extends StackProps {
  readonly environment: AiaEnvironment;
}

export class AiaStack extends Stack {
  private readonly zones: readonly string[];

  constructor(scope: Construct, id: string, props: AiaStackProps) {
    super(scope, id, props);
    const { environment } = props;
    this.zones = environment.zones;
    const prefix = `aia-${environment.name}`;
    const nat = environment.natGateways > 0;

    // Network. Without NAT (dev) the tasks sit in public subnets with a public
    // IP for their outbound calls (Coinbase, Massive); inbound is still only
    // from the load balancer. The cache is in isolated subnets either way.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: [...this.zones],
      natGateways: environment.natGateways,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        ...(nat ? [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 }] : []),
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        s3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        dynamodb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });
    const taskSubnets: ec2.SubnetSelection = { subnetType: nat ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC };

    // Storage.
    const bucketDefaults = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    };
    const raw = new s3.Bucket(this, 'Raw', { ...bucketDefaults, versioned: true, removalPolicy: RemovalPolicy.RETAIN });
    const cooked = new s3.Bucket(this, 'Cooked', { ...bucketDefaults, removalPolicy: RemovalPolicy.RETAIN });
    const chart = new s3.Bucket(this, 'Chart', { ...bucketDefaults, removalPolicy: RemovalPolicy.RETAIN });
    const users = new dynamodb.Table(this, 'Users', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const massiveKey = new secretsmanager.Secret(this, 'MassiveKey', {
      secretName: `${prefix}/massive`,
      description: 'Massive API key for stock history (MASSIVE_API_KEY). Set with `pnpm aws:secret`.',
    });

    // Security groups: the load balancer takes traffic only from CloudFront
    // (its VPC origin keeps CloudFront's own public addresses as the source,
    // so a rule for the VPC's range never matches); the platform only from the
    // load balancer; the cache only from the two apps.
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'Internal ALB: CloudFront VPC origin only', allowAllOutbound: false });
    albSg.addIngressRule(ec2.Peer.prefixList(CLOUDFRONT_ORIGIN_FACING), ec2.Port.tcp(80), 'CloudFront VPC origin');
    const platformSg = new ec2.SecurityGroup(this, 'PlatformSg', { vpc, description: 'Platform tasks' });
    platformSg.addIngressRule(albSg, ec2.Port.tcp(PLATFORM_PORT), 'from the ALB');
    albSg.addEgressRule(platformSg, ec2.Port.tcp(PLATFORM_PORT), 'to the platform');
    const hydrationSg = new ec2.SecurityGroup(this, 'HydrationSg', { vpc, description: 'Hydration tasks: no inbound' });
    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc, description: 'Valkey: the apps only', allowAllOutbound: false });
    cacheSg.addIngressRule(platformSg, ec2.Port.tcp(REDIS_PORT), 'platform');
    cacheSg.addIngressRule(hydrationSg, ec2.Port.tcp(REDIS_PORT), 'hydration');

    // Hot bars, the live bus, rate limits and indicator output (Valkey, TLS
    // only). Usage limits cap what a runaway could cost.
    const cache = new elasticache.CfnServerlessCache(this, 'Cache', {
      serverlessCacheName: prefix,
      engine: 'valkey',
      majorEngineVersion: '8',
      securityGroupIds: [cacheSg.securityGroupId],
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      cacheUsageLimits: { dataStorage: { maximum: 5, unit: 'GB' }, ecpuPerSecond: { maximum: 20_000 } },
    });
    const redisUrl = `rediss://${cache.attrEndpointAddress}:${cache.attrEndpointPort}`;

    // The apps.
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: prefix });
    const image = ecs.ContainerImage.fromAsset(REPO_ROOT, { platform: Platform.LINUX_ARM64 });
    const shared = {
      AWS_REGION: this.region,
      AIA_S3_ENDPOINT: 'aws',
      AIA_S3_REGION: this.region,
      AIA_RAW_BUCKET: raw.bucketName,
      AIA_COOKED_BUCKET: cooked.bucketName,
      AIA_REDIS_URL: redisUrl,
    };
    const role = (name: string, description: string) =>
      new iam.Role(this, name, { roleName: `${prefix}-${name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'), description });
    const task = (name: string, cpu: number, memoryLimitMiB: number, taskRole: iam.Role, executionRole: iam.Role) =>
      new ecs.FargateTaskDefinition(this, `${name}Task`, {
        family: `${prefix}-${name.toLowerCase()}`,
        cpu,
        memoryLimitMiB,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
        taskRole,
        executionRole,
      });
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, { logGroupName: `/${prefix}/${name.toLowerCase()}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });

    // Platform: History API, live gateway, sign-in, MCP. Reads bars, writes accounts.
    const platformRole = role('PlatformTaskRole', 'The platform app: read bars, read and write the users table');
    raw.grantRead(platformRole);
    cooked.grantRead(platformRole);
    users.grantReadWriteData(platformRole);
    const platformTask = task('Platform', 512, 1024, platformRole, role('PlatformTaskExecutionRole', 'ECS: pull the image, write the platform logs'));
    platformTask.addContainer('platform', {
      image,
      portMappings: [{ containerPort: PLATFORM_PORT }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup('Platform'), streamPrefix: 'platform' }),
      environment: {
        ...shared,
        AIA_HOST: '0.0.0.0',
        AIA_PORT: String(PLATFORM_PORT),
        AIA_DYNAMODB_ENDPOINT: 'aws',
        AIA_USERS_TABLE: users.tableName,
        // Two hops: the ALB, then CloudFront (from its public addresses).
        AIA_TRUSTED_PROXIES: '2',
      },
    });
    const platform = new ecs.FargateService(this, 'PlatformService', {
      cluster,
      serviceName: `${prefix}-platform`,
      taskDefinition: platformTask,
      desiredCount: environment.platformTasks,
      vpcSubnets: taskSubnets,
      assignPublicIp: !nat,
      securityGroups: [platformSg],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    // Hydration: the live stream for every instrument with a live feed, one
    // writer per instrument, so never two tasks at once (a deploy stops the old
    // one first). Backfill and gap repair run as one-off tasks from the same
    // definition with another command (`pnpm aws:task`).
    const hydrationRole = role('HydrationTaskRole', 'The hydration app: write raw bars (never delete), read and write cooked bars');
    raw.grantRead(hydrationRole);
    raw.grantPut(hydrationRole);
    cooked.grantReadWrite(hydrationRole);
    const hydrationTask = task('Hydration', 512, 1024, hydrationRole, role('HydrationTaskExecutionRole', 'ECS: pull the image, write the hydration logs, read the Massive key'));
    hydrationTask.addContainer('hydration', {
      image,
      command: ['tsx', 'apps/hydration/src/live.ts'],
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup('Hydration'), streamPrefix: 'hydration' }),
      // Live minute latency as CloudWatch metrics from the log lines (M1-11), namespace AIA/<env>.
      environment: { ...shared, AIA_METRICS: 'emf', AIA_ENV: environment.name },
      secrets: { MASSIVE_API_KEY: ecs.Secret.fromSecretsManager(massiveKey) },
    });
    const hydration = new ecs.FargateService(this, 'HydrationService', {
      cluster,
      serviceName: `${prefix}-hydration`,
      taskDefinition: hydrationTask,
      desiredCount: 1,
      vpcSubnets: taskSubnets,
      assignPublicIp: !nat,
      securityGroups: [hydrationSg],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // The internal load balancer in front of the platform.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetType: nat ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED },
      // Live WebSockets are pinged every 30 s (apps/platform, pingMs).
      idleTimeout: Duration.seconds(120),
    });
    alb.addListener('Http', { port: 80, open: false }).addTargets('Platform', {
      port: PLATFORM_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [platform],
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15) },
      deregistrationDelay: Duration.seconds(30),
    });

    // CloudFront: one address for the chart and the platform, so the browser
    // sees one origin (no CORS), as `pnpm chart` does locally.
    const api: cloudfront.BehaviorOptions = {
      origin: origins.VpcOrigin.withApplicationLoadBalancer(alb, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY, httpPort: 80 }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `${prefix}: chart and platform`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(chart),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: Object.fromEntries(API_PATHS.map((path) => [path, api])),
    });

    // What the deploy and task scripts need (scripts/aws.mjs).
    const output = (name: string, value: string) => new CfnOutput(this, `Out${name}`, { key: name, value });
    output('Url', `https://${distribution.distributionDomainName}`);
    output('DistributionId', distribution.distributionId);
    output('ChartBucket', chart.bucketName);
    output('ClusterName', cluster.clusterName);
    output('HydrationTaskDefinition', hydrationTask.family);
    output('HydrationService', hydration.serviceName);
    output('PlatformService', platform.serviceName);
    output('TaskSubnets', vpc.selectSubnets(taskSubnets).subnetIds.join(','));
    output('HydrationSecurityGroup', hydrationSg.securityGroupId);
    output('AssignPublicIp', nat ? 'DISABLED' : 'ENABLED');
    output('MassiveSecret', massiveKey.secretName);
  }

  /** The environment's zones, so building the template never asks AWS for them. */
  override get availabilityZones(): string[] {
    return [...this.zones];
  }
}
