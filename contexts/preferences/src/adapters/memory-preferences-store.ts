// Saved chart preferences in memory (tests, the e2e server, developer access).

import type { PreferencesStorePort } from '../application/preferences-store-port.js';
import type { ChartPreferences } from '../domain/chart-preferences.js';

export class MemoryPreferencesStore implements PreferencesStorePort {
  private readonly saved = new Map<string, ChartPreferences>();

  get(accountId: string): Promise<ChartPreferences | undefined> {
    return Promise.resolve(this.saved.get(accountId));
  }

  put(accountId: string, preferences: ChartPreferences): Promise<void> {
    this.saved.set(accountId, { ...preferences });
    return Promise.resolve();
  }
}
