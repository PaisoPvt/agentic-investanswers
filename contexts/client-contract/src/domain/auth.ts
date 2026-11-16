// The app's own sign-in as clients see it (M2-08, M2-14; decision record T-01).
// The rules are the access context's (SignIn). Pure.
//
//   POST /auth/sign-up   { email, password }  201 SessionResponse · 400 · 409
//   POST /auth/sign-in   { email, password }  200 SessionResponse · 401
//   POST /auth/sign-out  204
//   GET  /auth/me        200 AccountInfo · 401 (not mounted, so 404, in developer access mode)

/** What a client may see about an account. */
export interface AccountInfo {
  readonly id: string;
  readonly email: string;
}

/** A new session: send `token` as `Authorization: Bearer <token>`, or `?token=` on GET /live. */
export interface SessionResponse {
  readonly token: string;
  readonly account: AccountInfo;
}
