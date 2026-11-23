// Reading and saving a user's chart preferences (M2-13). Who may do so is the
// caller's to check: only a signed-in human, for their own account (agents
// are read-only and have no preferences of their own).

import type { ChartPreferences } from '../domain/chart-preferences.js';
import { parsePreferences } from '../domain/chart-preferences.js';
import type { PreferencesStorePort } from './preferences-store-port.js';

export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly code: 'invalid_preferences'; readonly message: string };

export class ChartPreferencesBook {
  constructor(private readonly store: PreferencesStorePort) {}

  /** What the account saved; empty when nothing was saved yet. */
  async load(accountId: string): Promise<ChartPreferences> {
    return (await this.store.get(accountId)) ?? {};
  }

  /** Checks what a client sent, then replaces the account's preferences with it. */
  async save(accountId: string, input: unknown): Promise<SaveOutcome> {
    const parsed = parsePreferences(input);
    if (!parsed.ok) return { ok: false, code: 'invalid_preferences', message: parsed.message };
    await this.store.put(accountId, parsed.value);
    return { ok: true };
  }
}
