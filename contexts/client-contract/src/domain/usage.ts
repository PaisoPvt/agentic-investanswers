// GET /usage (M4-04): a signed-in user's own usage and audit records, or one
// of their agent keys' records; an agent reads its own. Newest first, paged
// with `before`.
//
//   GET /usage?subject=me&limit=50
//   GET /usage?subject=<agentKeyId>&before=<next>

export interface UsageRecordView {
  /** When the request arrived, ISO 8601 UTC. */
  readonly time: string;
  readonly method: string;
  /** The route pattern, for example `/indicators/:id/outputs`. */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  /** The error code of a refused request. */
  readonly errorCode?: string;
  readonly instrument?: string;
  readonly timeframe?: string;
  readonly indicator?: string;
  /** The MCP tool an agent called. */
  readonly tool?: string;
  readonly clientAddress?: string;
}

export interface UsageResponse {
  /** Whose records: `human` (the signed-in account) or `agent` (an agent key id). */
  readonly subject: { readonly kind: 'human' | 'agent'; readonly id: string };
  readonly records: readonly UsageRecordView[];
  /** Pass as `before` for the next older page; null once there are no more. */
  readonly next: string | null;
}
