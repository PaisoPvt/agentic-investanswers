// Saved chart preferences (M2-13): the last instrument, timeframe and theme of
// the signed-in person, so the chart opens where they left it on any browser.
// No rules here: the check is the preferences context's (ChartPreferencesBook);
// the shape is the contract's (ChartPreferencesDto). Agent keys have no
// preferences of their own: reading answers 404, saving 403 read_only.
//
//   GET /preferences   200 { instrument?, timeframe?, theme? } · 401 · 404 · 429
//   PUT /preferences   the whole record  204 · 400 invalid_preferences · 401 · 403 · 429
//
// Both count against the caller's request limit (M2-10), as reads do; the
// chart saves at most once a second.

import type { PrincipalResolverPort } from '@aia/access';
import { mayWrite } from '@aia/access';
import type { ChartPreferencesDto } from '@aia/client-contract';
import type { ChartPreferencesBook } from '@aia/preferences';
import type { FastifyInstance } from 'fastify';

import type { Limits } from './rate-limit.js';
import { refusedForRate } from './rate-limit.js';

const error = (code: string, message: string) => ({ error: { code, message } });

/** Three short fields; anything bigger is refused before it is read. */
const bodyLimit = 1_024;

export function mountPreferencesRoute(app: FastifyInstance, book: Pick<ChartPreferencesBook, 'load' | 'save'>, principals: PrincipalResolverPort, limits?: Limits): void {
  app.get('/preferences', async (request, reply) => {
    const principal = await principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to read your preferences'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
    if (!mayWrite(principal)) return reply.code(404).send(error('not_found', 'agent keys have no chart preferences'));
    const saved: ChartPreferencesDto = await book.load(principal.id);
    return saved;
  });

  app.put('/preferences', { bodyLimit }, async (request, reply) => {
    const principal = await principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to save your preferences'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
    if (!mayWrite(principal)) return reply.code(403).send(error('read_only', 'agent keys are read-only; sign in as the user to save preferences'));
    const outcome = await book.save(principal.id, request.body);
    if (!outcome.ok) return reply.code(400).send(error(outcome.code, outcome.message));
    return reply.code(204).send();
  });
}
