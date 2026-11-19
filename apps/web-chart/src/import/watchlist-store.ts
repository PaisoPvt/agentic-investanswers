// Where an imported watchlist is kept (UI-03): in the browser, per account,
// like drawings (decision record T-10). Guarded: blocked storage just means
// the watchlist lasts for the page only.

import type { KeyValueStorage } from '../chart/drawing-store.js';
import type { ImportedWatchlist } from './tradingview.js';

function isWatchlist(value: unknown): value is ImportedWatchlist {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, name, sections } = value as Record<string, unknown>;
  return (
    kind === 'watchlist' &&
    typeof name === 'string' &&
    Array.isArray(sections) &&
    sections.every((s: unknown) => {
      const { title, symbols } = (s ?? {}) as Record<string, unknown>;
      return (title === undefined || typeof title === 'string') && Array.isArray(symbols) && symbols.every((x) => typeof x === 'string');
    })
  );
}

export class WatchlistStore {
  constructor(
    private readonly storage: () => KeyValueStorage | undefined,
    private readonly owner: string,
  ) {}

  private get key(): string {
    return `aia.watchlist.v1.${this.owner}`;
  }

  load(): ImportedWatchlist | undefined {
    try {
      const raw = this.storage()?.getItem(this.key);
      if (raw === null || raw === undefined) return undefined;
      const parsed: unknown = JSON.parse(raw);
      return isWatchlist(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  save(watchlist: ImportedWatchlist | undefined): boolean {
    try {
      const storage = this.storage();
      if (storage === undefined) return false;
      if (watchlist === undefined) storage.removeItem(this.key);
      else storage.setItem(this.key, JSON.stringify(watchlist));
      return true;
    } catch {
      return false;
    }
  }
}
