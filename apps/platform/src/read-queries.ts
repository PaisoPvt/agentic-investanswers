// The reads the platform serves, shared by the REST routes and the MCP tools
// (M4-02), so an agent gets exactly what the API gives: the History API's
// parameters, cap and pages (@aia/serving), what is served (the data layer,
// @aia/data), the plan check (@aia/access), and indicator outputs (M3-05:
// the settings check and the engine, @aia/indicators). No rules of its own.

import type { Access, Entitlements, Principal } from '@aia/access';
import type { IndicatorOutputsResponse, IndicatorsResponse, InstrumentInfo, InstrumentListing, InstrumentsResponse } from '@aia/client-contract';
import type { DataAccess } from '@aia/data';
import type { HistoryErrorCode, HistoryQuery, HistoryResponse } from '@aia/serving';
import type { BarTime, Timeframe } from '@aia/shared-kernel';
import { TIMEFRAMES } from '@aia/shared-kernel';

import type { IndicatorRunner } from './indicator-outputs.js';
import { outputsResponse, parseOutputsRequest } from './indicator-outputs.js';
import type { IndicatorCatalog } from './indicator-routes.js';
import { acceptSettings, listIndicators } from './indicator-routes.js';

export interface ReadError {
  readonly code: string;
  readonly message: string;
  readonly upgradeUrl?: string;
  /** Per-setting reasons, on `invalid_settings`. */
  readonly fields?: readonly { readonly key: string; readonly code: string; readonly message: string }[];
}

export type ReadOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly error: ReadError };

export interface ReadQueriesDeps {
  readonly history: Pick<HistoryQuery, 'parse' | 'run'>;
  readonly policy: Access['policy'];
  readonly now: () => BarTime;
  /** The instruments and what is served, for listings: the data layer's. */
  readonly catalog?: Pick<DataAccess, 'instruments' | 'whyNotServed'> | undefined;
  /** The indicators and what runs them, for indicator outputs (M3-05). */
  readonly indicators?: { readonly catalog: IndicatorCatalog; readonly runner: IndicatorRunner } | undefined;
}

const HISTORY_STATUS: Readonly<Record<HistoryErrorCode, number>> = {
  bad_parameter: 400,
  limit_too_large: 400,
  unknown_instrument: 404,
  timeframe_not_served: 409,
};

export class ReadQueries {
  constructor(private readonly deps: ReadQueriesDeps) {}

  /** GET /bars: parameters as the query string carries them. */
  async bars(principal: Principal, query: Readonly<Record<string, unknown>>): Promise<ReadOutcome<HistoryResponse>> {
    const parsed = this.deps.history.parse(query);
    if (!parsed.ok) return { ok: false, status: HISTORY_STATUS[parsed.error.code], error: parsed.error };
    const { instrument, timeframe } = parsed.request;
    const refused = await this.planRefusal(principal, instrument.symbol, timeframe);
    if (refused !== undefined) return refused;
    return { ok: true, value: await this.deps.history.run(parsed.request, this.deps.now()) };
  }

  /** The indicators that can be drawn, with their settings (the MCP listing; GET /indicators is the same list). */
  async indicators(): Promise<ReadOutcome<IndicatorsResponse>> {
    const catalog = this.deps.indicators?.catalog;
    return { ok: true, value: catalog === undefined ? { indicators: [] } : listIndicators(catalog) };
  }

  /** POST /indicators/:id/outputs: an indicator's drawn points on one instrument and timeframe. */
  async indicatorOutputs(principal: Principal, indicatorId: string, body: unknown): Promise<ReadOutcome<IndicatorOutputsResponse>> {
    const indicators = this.deps.indicators;
    const definition = indicators?.catalog.get(indicatorId);
    if (indicators === undefined || definition === undefined) return { ok: false, status: 404, error: { code: 'not_found', message: `no indicator "${indicatorId}"` } };
    const parsed = parseOutputsRequest(body);
    if (!parsed.ok) return { ok: false, status: 400, error: { code: parsed.code, message: parsed.message } };
    const { symbol, timeframe, limit } = parsed.request;

    const instrument = this.deps.catalog?.instruments.find((i) => i.symbol === symbol);
    if (instrument === undefined) return { ok: false, status: 404, error: { code: 'unknown_instrument', message: `unknown instrument "${symbol}"` } };
    const notServed = this.deps.catalog?.whyNotServed(instrument, timeframe);
    if (notServed !== undefined) return { ok: false, status: 409, error: { code: 'timeframe_not_served', message: notServed } };
    const refused = await this.planRefusal(principal, symbol, timeframe);
    if (refused !== undefined) return refused;

    const accepted = acceptSettings(indicators.catalog, indicatorId, parsed.request.settings);
    if (!accepted.ok) return { ok: false, status: accepted.status, error: accepted.body.error };
    const { settings } = accepted.value;
    const forming = await indicators.runner.forming(instrument, timeframe);
    const result = await indicators.runner.drawn({ indicatorId, instrument, timeframe, settings, limit, ...(forming === undefined ? {} : { forming }) });
    // Settings were checked above, so the engine refusing them means the catalog and engine disagree.
    if (!result.ok) throw new Error(`indicator engine refused ${indicatorId}: ${result.code}`);
    return { ok: true, value: outputsResponse(definition, instrument, timeframe, settings, result) };
  }

  /** GET /plan. */
  async plan(principal: Principal): Promise<ReadOutcome<Entitlements>> {
    return { ok: true, value: await this.deps.policy.entitlements(principal) };
  }

  /** Every instrument, the timeframes served for it, and which the caller's plan includes (MCP). */
  async instruments(principal: Principal): Promise<ReadOutcome<readonly InstrumentListing[]>> {
    const listings = (await this.instrumentInfo(principal)).map(({ symbol, kind, timeframes, included }) => ({ symbol, kind, timeframes, included }));
    return { ok: true, value: listings };
  }

  /** GET /instruments: the listing plus the display precision of each instrument's bars (the chart, M2-05). */
  async instrumentsForChart(principal: Principal): Promise<ReadOutcome<InstrumentsResponse>> {
    return { ok: true, value: { instruments: await this.instrumentInfo(principal) } };
  }

  /** The 403 when the caller's plan does not include this instrument and timeframe (the same check for bars and indicators). */
  private async planRefusal(principal: Principal, symbol: string, timeframe: Timeframe): Promise<ReadOutcome<never> | undefined> {
    if (await this.deps.policy.canReadBars(principal, symbol, timeframe)) return undefined;
    const { upgradeUrl } = await this.deps.policy.entitlements(principal);
    return {
      ok: false,
      status: 403,
      error: {
        code: 'forbidden',
        message: `your plan does not include ${symbol} ${timeframe}`,
        ...(upgradeUrl === undefined ? {} : { upgradeUrl }),
      },
    };
  }

  private async instrumentInfo(principal: Principal): Promise<InstrumentInfo[]> {
    const infos: InstrumentInfo[] = [];
    const catalog = this.deps.catalog;
    for (const instrument of catalog?.instruments ?? []) {
      const timeframes = TIMEFRAMES.filter((tf) => catalog?.whyNotServed(instrument, tf) === undefined);
      const included: Timeframe[] = [];
      for (const tf of timeframes) if (await this.deps.policy.canReadBars(principal, instrument.symbol, tf)) included.push(tf);
      infos.push({
        symbol: instrument.symbol,
        kind: instrument.kind,
        timeframes,
        included,
        pricePrecision: instrument.priceScale,
        volumePrecision: instrument.volumeScale,
      });
    }
    return infos;
  }
}
