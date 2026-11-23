// Public entry of the preferences context (M2-13). Other packages import only from here.
export type { ChartPreferences, PreferencesParse, Theme } from './domain/chart-preferences.js';
export { THEMES, parsePreferences } from './domain/chart-preferences.js';
export type { PreferencesStorePort } from './application/preferences-store-port.js';
export type { SaveOutcome } from './application/chart-preferences-book.js';
export { ChartPreferencesBook } from './application/chart-preferences-book.js';
export { MemoryPreferencesStore } from './adapters/memory-preferences-store.js';
export { DynamoPreferencesStore } from './adapters/dynamodb-preferences-store.js';
