// A usage and audit record (M4-04): one per request a principal makes to the
// platform, human or agent (CLAUDE.md rule 4). Who, what, when and the
// outcome; never a token, a password, a request body or a full query string.
// Pure.

/** Who made the request: a signed-in human, an agent (with the account it acts for), or nobody yet (sign-in, sign-up). */
export interface Subject {
  readonly kind: 'human' | 'agent' | 'anonymous';
  /** The account id (human), the agent key id (agent), or "anonymous". */
  readonly id: string;
  /** For an agent, the account it acts for. */
  readonly owner?: string;
}

export const ANONYMOUS: Subject = { kind: 'anonymous', id: 'anonymous' };

export interface UsageRecord {
  /** When the request arrived, in milliseconds since the epoch. */
  readonly time: number;
  /** The platform's request id, unique within a process. */
  readonly requestId: string;
  readonly subject: Subject;
  readonly method: string;
  /** The route pattern (`/indicators/:id/outputs`), never the full URL. */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  /** The error code of a refused request (`forbidden`, `rate_limited`, ...). */
  readonly errorCode?: string;
  readonly instrument?: string;
  readonly timeframe?: string;
  readonly indicator?: string;
  /** The MCP tool an agent called. */
  readonly tool?: string;
  readonly clientAddress?: string;
}

/** Where one subject's records are kept together: `human#<id>`, `agent#<keyId>` or `anonymous#anonymous`. */
export function subjectKey(subject: Pick<Subject, 'kind' | 'id'>): string {
  return `${subject.kind}#${subject.id}`;
}

/** The longest value kept for a detail; anything longer was not one of ours. */
const DETAIL_MAX = 64;

/** A detail taken from a request (an instrument, a timeframe, a tool name): kept only if it is a short plain string. */
export function detail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text !== '' && text.length <= DETAIL_MAX && /^[\w.:\-/]+$/.test(text) ? text : undefined;
}

/** Days a record is kept before it expires (decision record T-11); configuration can change it. */
export const DEFAULT_RETENTION_DAYS = 400;

/** Records per page when reading back, and the most one page may hold. */
export const USAGE_DEFAULT_LIMIT = 50;
export const USAGE_MAX_LIMIT = 200;
