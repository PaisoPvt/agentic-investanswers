// Where saved chart preferences are kept (M2-13): DynamoDB on AWS and locally,
// memory in tests and with developer access. One record per account.

import type { ChartPreferences } from '../domain/chart-preferences.js';

export interface PreferencesStorePort {
  /** The account's preferences; undefined when nothing was saved yet. */
  get(accountId: string): Promise<ChartPreferences | undefined>;
  /** Replaces the account's preferences with these. */
  put(accountId: string, preferences: ChartPreferences): Promise<void>;
}
