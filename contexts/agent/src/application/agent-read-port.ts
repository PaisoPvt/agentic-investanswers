// What an agent may read (M4-02), already scoped to the agent making the
// request: the platform implements it with the same queries, plan checks and
// rate limits as its REST routes, so the tools add no logic of their own
// (contexts/agent/AGENTS.md). Values are what the API returns: display
// units, drawn outputs only, never indicator internals (CLAUDE.md rule 5).

export type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly upgradeUrl?: string;
      /** Per-setting reasons, when indicator settings are refused. */
      readonly fields?: readonly { readonly key: string; readonly code: string; readonly message: string }[];
    };

export interface BarsArgs {
  readonly instrument: string;
  readonly tf: string;
  readonly limit?: number | undefined;
  readonly before?: number | undefined;
}

export interface IndicatorOutputArgs {
  readonly indicator: string;
  readonly instrument: string;
  readonly tf: string;
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  readonly limit?: number | undefined;
}

export interface AgentReadPort {
  /** One page of bars, newest last, as GET /bars returns it. */
  bars(args: BarsArgs): Promise<ReadResult<unknown>>;
  /** The instruments, the timeframes served for each, and which the caller's plan includes. */
  instruments(): Promise<ReadResult<unknown>>;
  /** What the caller's plan includes, as GET /plan returns it. */
  plan(): Promise<ReadResult<unknown>>;
  /** The indicators and their settings, as GET /indicators returns them (M3-05). */
  indicators(): Promise<ReadResult<unknown>>;
  /** An indicator's drawn outputs, as POST /indicators/:id/outputs returns them (M3-05). */
  indicatorOutput(args: IndicatorOutputArgs): Promise<ReadResult<unknown>>;
}
