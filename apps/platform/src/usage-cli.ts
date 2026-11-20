// `pnpm usage`: an account's usage and audit records (M4-04), for Sham or an
// operator, read straight from DynamoDB (local, or AWS with a profile).
//
//   pnpm usage --account sam@example.com [--agent <keyId>] [--days 7]
//   AIA_DYNAMODB_ENDPOINT=aws AWS_PROFILE=aia-dev AIA_USERS_TABLE=... AIA_AUDIT_TABLE=... pnpm usage --account ...
//
// Prints the account's agent keys, then the records of the account (or of one
// of its agent keys), newest first, and totals per route and per day.
// Exits 2 on a usage or setup error.

import type { Subject, UsageRecord } from '@aia/audit';
import { AuditLog, DynamoUsageRecordStore, summarise } from '@aia/audit';
import { DynamoAccountStore, DynamoAgentKeyStore, dynamoClient } from '@aia/access';

function usage(message: string): never {
  console.error(`${message}\nUsage: pnpm usage --account <email or account id> [--agent <keyId>] [--days N]`);
  process.exit(2);
}

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  return args[at + 1] ?? usage(`--${name} needs a value`);
}

function line(record: UsageRecord): string {
  const what = [record.instrument, record.timeframe, record.indicator, record.tool].filter((v) => v !== undefined).join(' ');
  const outcome = record.errorCode === undefined ? String(record.status) : `${record.status} ${record.errorCode}`;
  return [new Date(record.time).toISOString(), record.method.padEnd(6), record.route.padEnd(26), outcome.padEnd(20), `${record.durationMs} ms`.padStart(8), what, record.clientAddress ?? ''].join('  ');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const who = option(args, 'account') ?? usage('--account is required');
  const agent = option(args, 'agent');
  const daysText = option(args, 'days') ?? '7';
  const days = Number(daysText);
  if (!Number.isInteger(days) || days < 1) usage(`--days must be a whole number of days; got "${daysText}"`);

  const env = process.env;
  const endpoint = env['AIA_DYNAMODB_ENDPOINT'] ?? 'http://127.0.0.1:8000';
  const usersTable = env['AIA_USERS_TABLE'] ?? 'aia-users';
  const auditTable = env['AIA_AUDIT_TABLE'] ?? 'aia-audit';
  const client = dynamoClient(endpoint === 'aws' ? { endpoint, table: usersTable } : { endpoint, table: usersTable, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });

  const accounts = new DynamoAccountStore(client, usersTable);
  const account = who.includes('@') ? await accounts.findByEmail(who.trim().toLowerCase()) : await accounts.findById(who);
  if (account === undefined) usage(`No account "${who}"`);
  const keys = await new DynamoAgentKeyStore(client, usersTable).listByAccount(account.id);
  console.log(`Account ${account.email} (${account.id}); agent keys: ${keys.map((k) => `${k.name} (${k.id})`).join(', ') || 'none'}`);
  if (agent !== undefined && !keys.some((k) => k.id === agent)) usage(`Agent key "${agent}" is not one of this account's`);

  const subject: Subject = agent === undefined ? { kind: 'human', id: account.id } : { kind: 'agent', id: agent, owner: account.id };
  const log = new AuditLog({ store: new DynamoUsageRecordStore(client, auditTable), every: () => () => undefined });
  const since = Date.now() - days * 86_400_000;
  const records: UsageRecord[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await log.page(subject, { limit: 200, ...(before === undefined ? {} : { before }) });
    const recent = page.records.filter((r) => r.time >= since);
    records.push(...recent);
    if (page.next === null || recent.length < page.records.length) break;
    before = page.next;
  }

  console.log(`\n${subject.kind === 'agent' ? `Agent ${agent}` : 'The account'}: ${records.length} requests in the last ${days} days, newest first\n`);
  for (const record of records) console.log(line(record));
  const summary = summarise(records);
  console.log(`\nTotal ${summary.requests}, refused ${summary.refused}`);
  console.log('By route:');
  for (const r of summary.byRoute) console.log(`  ${r.route.padEnd(26)} ${String(r.requests).padStart(7)}  refused ${r.refused}`);
  console.log('By day (UTC):');
  for (const d of summary.byDay) console.log(`  ${d.day}  ${String(d.requests).padStart(7)}  refused ${d.refused}`);
  client.destroy();
}

await main().catch((failure: unknown) => {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exit(2);
});
