// Usage and audit records for every request (M4-04): one record per request
// to the platform, human, agent or not signed in yet, written through the
// audit log (@aia/audit) after the reply is sent.
//
// - Who: each route resolves its own principal; the resolver handed to the
//   routes is wrapped so the principal it finds is noted for the request
//   (AsyncLocalStorage, set up per request), with no change to the routes.
//   The sign-in routes find the account themselves and note it (`noteHuman`);
//   a failed sign-in and sign-out stay anonymous.
// - What: method, the route pattern, and the instrument, timeframe, indicator
//   or MCP tool read from named fields only (never a body, a token or a full
//   query string). The error code of a refused request is noted as it is sent.
// - When it is written: Fastify's onResponse, which also runs for the MCP
//   route's hijacked reply. An accepted /live connection never gets one, so the
//   live route calls `liveClosed` when the connection ends. /health is not
//   recorded.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Principal, PrincipalResolverPort } from '@aia/access';
import type { AuditLog, Subject, UsageRecord } from '@aia/audit';
import { ANONYMOUS, detail } from '@aia/audit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface Notes {
  principal?: Principal;
  errorCode?: string;
}

const current = new AsyncLocalStorage<Notes>();

/** The resolver the routes use: the same answers, and the principal noted for the request's record. */
export function auditedPrincipals(inner: PrincipalResolverPort): PrincipalResolverPort {
  return {
    resolve: async (credentials) => {
      const principal = await inner.resolve(credentials);
      const notes = current.getStore();
      if (notes !== undefined && principal !== undefined) notes.principal = principal;
      return principal;
    },
  };
}

/** Notes the signed-in account for a request whose route finds it itself (sign-up, sign-in, /auth/me). */
export function noteHuman(accountId: string): void {
  const notes = current.getStore();
  if (notes !== undefined) notes.principal = { kind: 'human', id: accountId };
}

export interface AuditHooks {
  /** Records an accepted /live connection when it ends. */
  liveClosed(request: FastifyRequest, principal: Principal): void;
}

const subjectOf = (principal: Principal | undefined): Subject =>
  principal === undefined ? ANONYMOUS : { kind: principal.kind, id: principal.id, ...(principal.owner === undefined ? {} : { owner: principal.owner }) };

const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined);

/** The instrument, timeframe, indicator and MCP tool of a request, from named fields only. */
function details(request: FastifyRequest): Pick<UsageRecord, 'instrument' | 'timeframe' | 'indicator' | 'tool'> {
  const { query, body, params } = request;
  const call = field(body, 'method') === 'tools/call' ? field(body, 'params') : undefined;
  const args = field(call, 'arguments');
  const found = {
    instrument: detail(field(query, 'instrument') ?? field(body, 'instrument') ?? field(args, 'instrument')),
    timeframe: detail(field(query, 'tf') ?? field(body, 'timeframe') ?? field(args, 'tf')),
    indicator: detail(field(params, 'id') ?? field(args, 'indicator')),
    tool: detail(field(call, 'name')),
  };
  return Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined));
}

export function mountAudit(app: FastifyInstance, log: Pick<AuditLog, 'record'>, nowMs: () => number): AuditHooks {
  const started = new WeakMap<FastifyRequest, { readonly at: number; readonly notes: Notes }>();

  const write = (request: FastifyRequest, status: number, principal: Principal | undefined) => {
    const entry = started.get(request);
    const route = request.routeOptions.url ?? '(no route)';
    if (entry === undefined || route === '/health') return;
    const end = nowMs();
    log.record({
      time: entry.at,
      requestId: request.id,
      subject: subjectOf(principal ?? entry.notes.principal),
      method: request.method,
      route,
      status,
      durationMs: Math.max(0, end - entry.at),
      ...(entry.notes.errorCode === undefined ? {} : { errorCode: entry.notes.errorCode }),
      ...details(request),
      ...(request.ip === undefined ? {} : { clientAddress: request.ip }),
    });
  };

  app.addHook('onRequest', (request, _reply, done) => {
    const notes: Notes = {};
    started.set(request, { at: nowMs(), notes });
    current.run(notes, done);
  });
  app.addHook('preSerialization', async (request, reply, payload) => {
    const code = reply.statusCode >= 400 ? detail(field(field(payload, 'error'), 'code')) : undefined;
    const entry = started.get(request);
    if (code !== undefined && entry !== undefined) entry.notes.errorCode = code;
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    write(request, reply.statusCode, undefined);
  });

  return { liveClosed: (request, principal) => write(request, 101, principal) };
}
