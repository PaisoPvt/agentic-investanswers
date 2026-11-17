// The platform's REST routes as the chart uses them (GET /bars, GET
// /instruments, GET /indicators, POST /indicators/:id/settings, POST
// /indicators/:id/outputs, /auth/*), and the /live URL. Same origin: the Vite dev server proxies
// to the platform locally, and staging serves both behind one host (M2-01).
//
// A session token, when there is one, goes on every request: the
// Authorization header on REST, `?token=` on /live (browsers cannot set
// WebSocket headers). The sign-in screen (M2-14) stores it; in developer
// access mode (AIA_DEV_AUTH=1) there is none and none is needed.

import type {
  AccountInfo,
  ApiErrorBody,
  HistoryResponse,
  IndicatorOutputsRequest,
  IndicatorOutputsResponse,
  IndicatorsResponse,
  InstrumentsResponse,
  InvalidSettingsBody,
  SettingFieldError,
  SessionResponse,
  SettingsAccepted,
} from '@aia/client-contract';
import { HISTORY_DEFAULT_LIMIT } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

/** A refused request, with the server's own message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly upgradeUrl?: string,
  ) {
    super(message);
  }
}

/** The server's answer to a settings check: accepted, or every field it refused. */
export type SettingsOutcome =
  | { readonly ok: true; readonly accepted: SettingsAccepted }
  | { readonly ok: false; readonly fields: readonly SettingFieldError[] };

export interface PlatformClientOptions {
  /** The session token, if signed in. */
  readonly token: () => string | undefined;
  /** Page origin, for example `https://charts.example.com`. */
  readonly origin: string;
  readonly fetch?: typeof fetch;
}

export class PlatformClient {
  constructor(private readonly options: PlatformClientOptions) {}

  /** The newest page of bars, or the page before `before`. */
  history(instrument: string, tf: Timeframe, limit = HISTORY_DEFAULT_LIMIT): Promise<HistoryResponse> {
    const query = new URLSearchParams({ instrument, tf, limit: String(limit) });
    return this.get<HistoryResponse>(`/bars?${query.toString()}`);
  }

  instruments(): Promise<InstrumentsResponse> {
    return this.get<InstrumentsResponse>('/instruments');
  }

  /** The indicators the caller may add, each with its settings dialog at defaults. */
  indicators(): Promise<IndicatorsResponse> {
    return this.get<IndicatorsResponse>('/indicators');
  }

  /** Asks the server to check settings; the server decides, the dialog's limits are only a convenience. */
  async checkSettings(indicatorId: string, settings: Readonly<Record<string, unknown>>): Promise<SettingsOutcome> {
    const response = await this.send(`/indicators/${encodeURIComponent(indicatorId)}/settings`, { method: 'POST', body: { settings } });
    if (response.ok) return { ok: true, accepted: (await response.json()) as SettingsAccepted };
    const body = await readError(response);
    if (response.status === 400 && body.error?.code === 'invalid_settings') return { ok: false, fields: (body as InvalidSettingsBody).error.fields };
    throw apiError(response.status, body);
  }

  /** What an indicator draws on one instrument and timeframe: drawn outputs only, computed on the server. */
  async indicatorOutputs(indicatorId: string, request: IndicatorOutputsRequest): Promise<IndicatorOutputsResponse> {
    const response = await this.send(`/indicators/${encodeURIComponent(indicatorId)}/outputs`, { method: 'POST', body: request });
    if (response.ok) return (await response.json()) as IndicatorOutputsResponse;
    throw apiError(response.status, await readError(response));
  }

  /**
   * Who the session token belongs to: the account, `undefined` when signed out
   * (401), or `'open'` when the platform runs without sign-in (developer
   * access: the /auth routes are not there, 404).
   */
  async me(): Promise<AccountInfo | 'open' | undefined> {
    const response = await this.send('/auth/me', { method: 'GET' });
    if (response.ok) return (await response.json()) as AccountInfo;
    if (response.status === 401) return undefined;
    if (response.status === 404) return 'open';
    throw apiError(response.status, await readError(response));
  }

  /** Signs in, or creates an account; the server's refusal comes back as an ApiError with its message. */
  async startSession(kind: 'sign-in' | 'sign-up', email: string, password: string): Promise<SessionResponse> {
    const response = await this.send(`/auth/${kind}`, { method: 'POST', body: { email, password } });
    if (response.ok) return (await response.json()) as SessionResponse;
    throw apiError(response.status, await readError(response));
  }

  /** Ends the session on the server; signing out locally never waits on it. */
  async signOut(): Promise<void> {
    await this.send('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
  }

  liveUrl(): string {
    const url = new URL('/live', this.options.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = this.options.token();
    if (token !== undefined) url.searchParams.set('token', token);
    return url.toString();
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.send(path, { method: 'GET' });
    if (response.ok) return (await response.json()) as T;
    throw apiError(response.status, await readError(response));
  }

  private send(path: string, { method, body }: { readonly method: 'GET' | 'POST'; readonly body?: unknown }): Promise<Response> {
    const token = this.options.token();
    const headers: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return (this.options.fetch ?? fetch)(new URL(path, this.options.origin), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

async function readError(response: Response): Promise<Partial<ApiErrorBody>> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return {}; // not JSON: fall back to the status alone
  }
}

function apiError(status: number, body: Partial<ApiErrorBody>): ApiError {
  const error = body.error;
  return new ApiError(status, error?.code ?? 'http_error', error?.message ?? `the server answered ${status}`, error?.upgradeUrl);
}

const SESSION_KEY = 'aia.session';
/** The token for this tab, for when storage is blocked. */
let tabToken: string | undefined;

/** The stored session token, if any. */
export function storedToken(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(SESSION_KEY) ?? tabToken;
  } catch {
    return tabToken;
  }
}

/** Keeps the session token for the next visit, or forgets it. */
export function storeToken(token: string | undefined): void {
  tabToken = token;
  try {
    if (token === undefined) globalThis.localStorage?.removeItem(SESSION_KEY);
    else globalThis.localStorage?.setItem(SESSION_KEY, token);
  } catch {
    // Storage blocked (private window): the session lasts until the tab closes.
  }
}
