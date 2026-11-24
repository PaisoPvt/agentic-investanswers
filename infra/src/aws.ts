// Deploying and running things on AWS (M2-01), through the AWS CLI and CDK
// with the environment's profile (`aws sso login --profile aia-dev` first).
//
//   pnpm aws deploy dev                 deploy the stack (CDK asks before any IAM or security change),
//                                       then publish the chart and refresh CloudFront
//   pnpm aws secret dev                 put MASSIVE_API_KEY from .env into Secrets Manager, never printed
//   pnpm aws task dev backfill --symbol NVDA --symbol TSLA
//                                       a one-off hydration command on ECS (backfill, gaps, cook)
//   pnpm aws logs dev platform          follow the platform's (or hydration's) logs
//
// Nothing here runs without the person at the keyboard: every command is
// started by hand, and `deploy` stops at CDK's approval prompt.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ENVIRONMENTS } from './environments.js';
import type { AiaEnvironment } from './environments.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ONE_OFF = new Set(['backfill', 'gaps', 'cook', 'rebuild-check']);
const USAGE = 'Usage: pnpm aws <deploy|secret|task|logs> <environment> [...]';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Runs a command with no shell; output goes to the terminal unless captured. */
function run(command: string, args: readonly string[], options: { capture?: boolean; input?: string } = {}): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: [options.input === undefined ? 'inherit' : 'pipe', options.capture ? 'pipe' : 'inherit', 'inherit'],
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0] ?? ''} failed (exit ${result.status ?? 'signal'})`);
  return result.stdout ?? '';
}

const aws = (environment: AiaEnvironment, args: readonly string[], options: { capture?: boolean; input?: string } = {}) =>
  run('aws', [...args, '--profile', environment.profile, '--region', environment.region], options);

/** Refuses to touch an account other than the environment's, whatever the profile points at. */
function checkAccount(environment: AiaEnvironment): void {
  const account = aws(environment, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { capture: true }).trim();
  if (account !== environment.account) fail(`Profile ${environment.profile} signs in to account ${account}, not ${environment.name} (${environment.account}).`);
}

function outputs(environment: AiaEnvironment): Record<string, string> {
  const text = aws(
    environment,
    ['cloudformation', 'describe-stacks', '--stack-name', `aia-${environment.name}`, '--query', 'Stacks[0].Outputs', '--output', 'json'],
    { capture: true },
  );
  const list = JSON.parse(text) as { OutputKey: string; OutputValue: string }[] | null;
  return Object.fromEntries((list ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

function need(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (value === undefined) fail(`The stack has no output ${key}; deploy it first (pnpm aws deploy <environment>).`);
  return value;
}

function deploy(environment: AiaEnvironment): void {
  checkAccount(environment);
  run('pnpm', ['--filter', '@aia/infra', 'exec', 'cdk', 'deploy', `aia-${environment.name}`, '--profile', environment.profile, '--require-approval', 'broadening']);
  const out = outputs(environment);
  run('pnpm', ['--filter', '@aia/app-web-chart', 'build']);
  aws(environment, ['s3', 'sync', 'apps/web-chart/dist', `s3://${need(out, 'ChartBucket')}`, '--delete']);
  aws(environment, ['cloudfront', 'create-invalidation', '--distribution-id', need(out, 'DistributionId'), '--paths', '/*'], { capture: true });
  console.log(`Deployed. The chart and platform: ${need(out, 'Url')}`);
}

function secret(environment: AiaEnvironment): void {
  if (existsSync(`${ROOT}.env`)) process.loadEnvFile(`${ROOT}.env`);
  const key = process.env['MASSIVE_API_KEY'];
  if (key === undefined || key === '') fail('MASSIVE_API_KEY is not set (in .env or the environment).');
  checkAccount(environment);
  // Passed on stdin, so the key never appears in a process list or the terminal.
  aws(environment, ['secretsmanager', 'put-secret-value', '--secret-id', `aia-${environment.name}/massive`, '--secret-string', 'file:///dev/stdin'], {
    capture: true,
    input: key,
  });
  console.log(`Stored MASSIVE_API_KEY in aia-${environment.name}/massive. Restart hydration to pick it up: pnpm aws deploy ${environment.name}, or force a new deployment of its service.`);
}

function task(environment: AiaEnvironment, command: string | undefined, args: readonly string[]): void {
  if (command === undefined || !ONE_OFF.has(command)) fail(`Usage: pnpm aws task <environment> <${[...ONE_OFF].join('|')}> [arguments]`);
  checkAccount(environment);
  const out = outputs(environment);
  const network = {
    awsvpcConfiguration: {
      subnets: need(out, 'TaskSubnets').split(','),
      securityGroups: [need(out, 'HydrationSecurityGroup')],
      assignPublicIp: need(out, 'AssignPublicIp'),
    },
  };
  const overrides = { containerOverrides: [{ name: 'hydration', command: ['tsx', `apps/hydration/src/${command}.ts`, ...args] }] };
  const started = aws(
    environment,
    [
      'ecs', 'run-task',
      '--cluster', need(out, 'ClusterName'),
      '--task-definition', need(out, 'HydrationTaskDefinition'),
      '--launch-type', 'FARGATE',
      '--network-configuration', JSON.stringify(network),
      '--overrides', JSON.stringify(overrides),
      '--query', 'tasks[0].taskArn', '--output', 'text',
    ],
    { capture: true },
  ).trim();
  console.log(`Started ${command} as ${started}. Follow it with: pnpm aws logs ${environment.name} hydration`);
}

function tail(environment: AiaEnvironment, app: string | undefined): void {
  if (app !== 'platform' && app !== 'hydration') fail('Usage: pnpm aws logs <environment> <platform|hydration>');
  aws(environment, ['logs', 'tail', `/aia-${environment.name}/${app}`, '--follow', '--since', '30m']);
}

const [action, name, ...rest] = process.argv.slice(2);
const environment = name === undefined ? undefined : ENVIRONMENTS[name];
if (environment === undefined) fail(`${USAGE}\nEnvironments: ${Object.keys(ENVIRONMENTS).join(', ')}`);
switch (action) {
  case 'deploy':
    deploy(environment);
    break;
  case 'secret':
    secret(environment);
    break;
  case 'task':
    task(environment, rest[0], rest.slice(1));
    break;
  case 'logs':
    tail(environment, rest[0]);
    break;
  default:
    fail(USAGE);
}
