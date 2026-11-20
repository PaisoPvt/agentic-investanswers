// GET /usage (M4-04): usage and audit records read back. A signed-in user
// reads their own records (`subject=me`, the default) or those of one of their
// own agent keys (`subject=<keyId>`); an agent reads only its own. Anyone
// else's answers 404, so ids are not confirmed. Newest first, paged with
// `before` (the response's `next`). The records are the audit log's
// (@aia/audit); the shape is the contract's (UsageResponse).
//
//   GET /usage?subject=me&limit=50&before=<next>   200 · 400 · 401 · 404 · 429

import type { AgentKeys, Principal, PrincipalResolverPort } from '@aia/access';
import type { AuditLog, UsageRecord } from '@aia/audit';
import { USAGE_MAX_LIMIT, isCursor } from '@aia/audit';
import type { UsageRecordView, UsageResponse } from '@aia/client-contract';
import type { FastifyInstance } from 'fastify';

import type { Limits } from './rate-limit.js';
import { refusedForRate } from './rate-limit.js';

const error = (code: string, message: string) => ({ error: { code, message } });

const PARAMETERS = new Set(['subject', 'limit', 'before']);

function view(record: UsageRecord): UsageRecordView {
  const { time, method, route, status, durationMs, errorCode, instrument, timeframe, indicator, tool, clientAddress } = record;
  const optional = { errorCode, instrument, timeframe, indicator, tool, clientAddress };
  return {
    time: new Date(time).toISOString(),
    method,
    route,
    status,
    durationMs,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}

export function mountUsageRoute(
  app: FastifyInstance,
  log: Pick<AuditLog, 'page'>,
  principals: PrincipalResolverPort,
  agentKeys: Pick<AgentKeys, 'list'> | undefined,
  limits?: Limits,
): void {
  /** Whose records the caller asked for, if they may read them. */
  const target = async (principal: Principal, subject: string): Promise<UsageResponse['subject'] | undefined> => {
    if (subject === 'me' || subject === principal.id) return { kind: principal.kind === 'agent' ? 'agent' : 'human', id: principal.id };
    if (principal.kind !== 'human' || agentKeys === undefined) return undefined;
    const own = await agentKeys.list(principal.id);
    return own.some((key) => key.id === subject) ? { kind: 'agent', id: subject } : undefined;
  };

  app.get('/usage', async (request, reply) => {
    const principal = await principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to see your usage'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;

    const query = request.query as Record<string, unknown>;
    const unknown = Object.keys(query).find((name) => !PARAMETERS.has(name));
    if (unknown !== undefined) return reply.code(400).send(error('bad_parameter', `unknown parameter "${unknown}"; allowed: subject, limit, before`));
    const text = (name: string) => (typeof query[name] === 'string' ? (query[name] as string) : undefined);
    const limitText = text('limit');
    const limit = limitText === undefined ? undefined : Number(limitText);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > USAGE_MAX_LIMIT)) {
      return reply.code(400).send(error('bad_parameter', `"limit" must be a whole number from 1 to ${USAGE_MAX_LIMIT}`));
    }
    const before = text('before');
    if (before !== undefined && !isCursor(before)) return reply.code(400).send(error('bad_parameter', '"before" must be the "next" of a previous page'));

    const subject = await target(principal, text('subject') ?? 'me');
    if (subject === undefined) return reply.code(404).send(error('not_found', 'no such agent key on your account'));
    const page = await log.page(subject, { ...(limit === undefined ? {} : { limit }), ...(before === undefined ? {} : { before }) });
    const response: UsageResponse = { subject, records: page.records.map(view), next: page.next };
    return response;
  });
}
