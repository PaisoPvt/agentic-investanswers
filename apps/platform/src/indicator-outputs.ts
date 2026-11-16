// POST /indicators/:id/outputs (M3-05): the request body and the answer, free
// of HTTP. The rules are elsewhere: settings are checked by acceptSettings
// (indicator-routes.ts, M3-02), the plan by ReadQueries, the run by the
// indicator engine (@aia/indicators). Only drawn points come back (rule 5).

import type { IndicatorOutputsResponse, IndicatorSettings, OutputPoint } from '@aia/client-contract';
import { INDICATOR_OUTPUT_DEFAULT_LIMIT, INDICATOR_OUTPUT_MAX_LIMIT } from '@aia/client-contract';
import type { DrawnPoint, IndicatorDefinition, IndicatorRequest, IndicatorResult } from '@aia/indicators';
import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { isTimeframe } from '@aia/shared-kernel';

/** What runs indicators: the engine, and the forming bar it previews. */
export interface IndicatorRunner {
  drawn(request: IndicatorRequest): Promise<IndicatorResult>;
  forming(instrument: Instrument, timeframe: Timeframe): Promise<Bar | undefined>;
}

export interface OutputsRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly settings: unknown;
  readonly limit: number;
}

type Parsed = { readonly ok: true; readonly request: OutputsRequest } | { readonly ok: false; readonly code: 'bad_parameter' | 'limit_too_large'; readonly message: string };

const FIELDS = new Set(['instrument', 'timeframe', 'settings', 'limit']);

const bad = (message: string): Parsed => ({ ok: false, code: 'bad_parameter', message });

/** Checks the body's shape; the instrument, plan and settings are checked after. */
export function parseOutputsRequest(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('the body must be an object: { instrument, timeframe, settings?, limit? }');
  const given = body as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!FIELDS.has(name)) return bad(`unknown field "${name}"; allowed: instrument, timeframe, settings, limit`);
  }
  const symbol = given['instrument'];
  if (typeof symbol !== 'string' || symbol === '') return bad('"instrument" is required, for example BTCUSD');
  const timeframe = given['timeframe'];
  if (typeof timeframe !== 'string' || !isTimeframe(timeframe)) return bad('"timeframe" must be one of 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M');
  let limit = INDICATOR_OUTPUT_DEFAULT_LIMIT;
  if (given['limit'] !== undefined) {
    const asked = given['limit'];
    if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 1) return bad('"limit" must be a whole number from 1');
    if (asked > INDICATOR_OUTPUT_MAX_LIMIT) return { ok: false, code: 'limit_too_large', message: `"limit" may be at most ${INDICATOR_OUTPUT_MAX_LIMIT}; got ${asked}` };
    limit = asked;
  }
  return { ok: true, request: { symbol, timeframe, settings: given['settings'] ?? {}, limit } };
}

const toPoint = (point: DrawnPoint): OutputPoint => ({ time: point.time, values: point.values });

/** The engine's drawn points in the contract's shape. */
export function outputsResponse(
  definition: IndicatorDefinition<unknown>,
  instrument: Instrument,
  timeframe: Timeframe,
  settings: IndicatorSettings,
  result: Extract<IndicatorResult, { ok: true }>,
): IndicatorOutputsResponse {
  return {
    indicatorId: definition.id,
    name: definition.name,
    instrument: instrument.symbol,
    timeframe,
    settings,
    outputs: definition.outputs.map(({ key, label, kind }) => ({ key, label, kind })),
    points: result.points.map(toPoint),
    ...(result.forming === undefined ? {} : { forming: toPoint(result.forming) }),
  };
}
