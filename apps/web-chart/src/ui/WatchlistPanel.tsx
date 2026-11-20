// An imported TradingView watchlist (UI-03), right of the chart. Symbols we
// serve open on the chart; the others are shown greyed out.

import type { ImportedWatchlist } from '../import/tradingview.js';
import { matchInstrument } from '../import/tradingview.js';

export interface WatchlistPanelProps {
  readonly watchlist: ImportedWatchlist;
  /** Our instruments the caller can open (with at least one timeframe on their plan). */
  readonly available: readonly string[];
  readonly current: string;
  readonly onPick: (symbol: string) => void;
  readonly onRemove: () => void;
}

export function WatchlistPanel({ watchlist, available, current, onPick, onRemove }: WatchlistPanelProps) {
  return (
    <aside className="watchlist" aria-label="Watchlist" data-testid="watchlist">
      <header>
        <strong title={watchlist.name}>{watchlist.name}</strong>
        <button type="button" className="remove" aria-label="Remove watchlist" title="Remove watchlist" data-testid="watchlist-remove" onClick={onRemove}>
          ×
        </button>
      </header>
      {watchlist.sections.map((section, index) => (
        <section key={`${section.title ?? ''}-${index}`}>
          {section.title !== undefined && <h3>{section.title}</h3>}
          <ul>
            {section.symbols.map((tv) => {
              const ours = matchInstrument(tv, available);
              return (
                <li key={tv}>
                  <button
                    type="button"
                    data-testid={`watch-${tv}`}
                    disabled={ours === undefined}
                    aria-current={ours !== undefined && ours === current ? 'true' : undefined}
                    title={ours === undefined ? 'Not available here yet' : `Open ${ours}`}
                    onClick={() => ours !== undefined && onPick(ours)}
                  >
                    <span className="sym">{tv.includes(':') ? tv.slice(tv.indexOf(':') + 1) : tv}</span>
                    {tv.includes(':') && <span className="exch">{tv.slice(0, tv.indexOf(':'))}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
