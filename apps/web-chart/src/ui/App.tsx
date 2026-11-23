// The chart app: pickers, the chart, and a status line (connection state and
// any message from the server, with the upgrade link for a locked choice).
// Indicators (M3-02, M3-05): choosing one opens its settings dialog; Apply
// sends the settings to the server and, once accepted, the chart draws the
// server's output with them. Each shown indicator has a chip to change its
// settings or remove it.
// Drawings (UI-01): the panel left of the chart places the trader's own lines,
// shapes and notes; Delete removes the selected one, Esc cancels placing.
// TradingView import (UI-03): chart data is drawn over our bars with a match
// report (browser only, never stored); a watchlist opens beside the chart.
// Preferences (M2-13): the chart opens on the instrument and timeframe saved
// for the account, and saves each new choice on the server.

import type { ChartPreferencesDto, IndicatorSettingsDialog, IndicatorsResponse, InstrumentInfo, SettingsAccepted } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { DrawingLayer } from '../chart/drawing-layer.js';
import { DrawingStore, browserStorage } from '../chart/drawing-store.js';
import { toolByName } from '../chart/drawing-tools.js';
import type { ShownImport } from '../chart/import-layer.js';

import type { ShownIndicator } from '../chart/indicator-layer.js';
import type { SeriesStatus } from '../data/bar-series.js';
import { FreshnessTracker } from '../data/freshness.js';
import type { ConnectionState, LiveConnection } from '../data/live-connection.js';
import type { PlatformClient } from '../data/platform-client.js';
import type { MatchReport } from '../import/compare.js';
import type { ImportedWatchlist } from '../import/tradingview.js';
import { MAX_IMPORT_BYTES, matchInstrument, parseTradingViewFile } from '../import/tradingview.js';
import { WatchlistStore } from '../import/watchlist-store.js';
import type { Session } from './AuthGate.js';
import { ChartView } from './ChartView.js';
import { DrawingPanel } from './DrawingPanel.js';
import { FreshnessBadge } from './FreshnessBadge.js';
import { NoteDialog } from './NoteDialog.js';
import { WatchlistPanel } from './WatchlistPanel.js';
import { SettingsDialog } from './SettingsDialog.js';
import { defaultTimeframe, startingChoice } from './starting-choice.js';
import { Toolbar } from './Toolbar.js';

/** The live connection's state, for useSyncExternalStore. */
export interface StateSource {
  get(): ConnectionState;
  subscribe(listener: () => void): () => void;
}

export interface AppProps {
  readonly client: PlatformClient;
  readonly live: LiveConnection;
  readonly connection: StateSource;
  /** The signed-in account; none in developer access. */
  readonly session?: Session | undefined;
}

/** Keys typed into a field or a dialog are not chart shortcuts. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="dialog"]') !== null;
}

function hintFor(tool: string | undefined): string | undefined {
  const chosen = tool === undefined ? undefined : toolByName(tool);
  if (chosen === undefined) return undefined;
  const clicks = chosen.clicks === 1 ? 'click the chart' : `click ${chosen.clicks} points on the chart`;
  return `${chosen.label}: ${clicks}. Esc cancels.`;
}

function utcMinute(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function reportText(report: MatchReport | undefined, precision: number): string {
  if (report === undefined) return '';
  if (report.compared === 0) return 'no bars in common with the chart yet';
  const head = `${report.matched} of ${report.compared} bars match`;
  const d = report.firstDifference;
  if (d === undefined) return head;
  const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
  return `${head} · first difference ${utcMinute(d.time)} UTC, ${d.field} ${fmt(d.ours)} here vs ${fmt(d.theirs)}`;
}

/** How long the chart waits after the last change before saving preferences. */
const SAVE_AFTER_MS = 1_000;

export function App({ client, live, connection, session }: AppProps) {
  const [instruments, setInstruments] = useState<readonly InstrumentInfo[]>();
  const [failure, setFailure] = useState<string>();
  const [symbol, setSymbol] = useState<string>();
  const [timeframe, setTimeframe] = useState<Timeframe>();
  const [status, setStatus] = useState<SeriesStatus>({ state: 'loading' });
  const state = useSyncExternalStore(connection.subscribe, connection.get);
  const [indicators, setIndicators] = useState<IndicatorsResponse['indicators']>([]);
  const [applied, setApplied] = useState<Readonly<Record<string, SettingsAccepted>>>({});
  const [editing, setEditing] = useState<IndicatorSettingsDialog>();
  const [indicatorErrors, setIndicatorErrors] = useState<Readonly<Record<string, string>>>({});
  const [note, setNote] = useState<{ readonly id: string; readonly text: string; readonly isNew: boolean }>();
  const owner = session?.account.id ?? 'local';
  const drawings = useMemo(
    () => new DrawingLayer({ store: new DrawingStore(browserStorage, owner), onNote: (id, text, isNew) => setNote({ id, text, isNew }) }),
    [owner],
  );
  const drawing = useSyncExternalStore(drawings.subscribe, drawings.get);
  const freshness = useMemo(() => new FreshnessTracker(), []);
  const watchlists = useMemo(() => new WatchlistStore(browserStorage, owner), [owner]);
  const [watchlist, setWatchlist] = useState<ImportedWatchlist | undefined>(() => watchlists.load());
  useEffect(() => setWatchlist(watchlists.load()), [watchlists]);
  const [imported, setImported] = useState<ShownImport>();
  const [importReport, setImportReport] = useState<MatchReport>();
  const [importError, setImportError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  /** The saved theme, kept as it is until the chart has themes (M2-12). */
  const theme = useRef<ChartPreferencesDto['theme']>(undefined);
  /** The instrument and timeframe last saved or loaded, so they are not saved again. */
  const lastSaved = useRef<string | undefined>(undefined);
  const shown = useMemo<readonly ShownIndicator[]>(() => Object.values(applied).map((a) => ({ id: a.indicatorId, settings: a.settings })), [applied]);

  useEffect(() => {
    let current = true;
    // Without the list the chart still works, just with no indicator picker.
    client.indicators().then(
      ({ indicators: list }) => current && setIndicators(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client]);

  useEffect(() => {
    let current = true;
    // Both at once, so preferences never delay the chart; without them it opens on the defaults.
    const saved = client.preferences().catch((): ChartPreferencesDto => ({}));
    Promise.all([client.instruments(), saved]).then(
      ([{ instruments: list }, preferences]) => {
        if (!current) return;
        setInstruments(list);
        theme.current = preferences.theme;
        const choice = startingChoice(list, preferences);
        if (choice !== undefined) {
          lastSaved.current = `${choice.symbol}/${choice.timeframe ?? ''}`;
          setSymbol(choice.symbol);
          setTimeframe(choice.timeframe);
        }
      },
      (error: unknown) => current && setFailure(error instanceof Error ? error.message : 'could not reach the server'),
    );
    return () => {
      current = false;
    };
  }, [client]);

  // Each new choice is saved once the trader pauses; a failed save never stops the chart.
  useEffect(() => {
    if (symbol === undefined || timeframe === undefined || lastSaved.current === `${symbol}/${timeframe}`) return undefined;
    const timer = setTimeout(() => {
      lastSaved.current = `${symbol}/${timeframe}`;
      client
        .savePreferences({ instrument: symbol, timeframe, ...(theme.current === undefined ? {} : { theme: theme.current }) })
        .catch((error: unknown) => console.warn(`preferences not saved: ${error instanceof Error ? error.message : String(error)}`));
    }, SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [client, symbol, timeframe]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (event.key === 'Escape' && drawings.get().tool !== undefined) {
        drawings.cancel();
        event.preventDefault();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && drawings.removeSelected()) {
        event.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawings]);

  // Another instrument or timeframe: the badge waits for its data.
  useEffect(() => freshness.reset(), [freshness, symbol, timeframe]);

  const instrument = instruments?.find((i) => i.symbol === symbol);

  const chooseInstrument = (next: string) => {
    const chosen = instruments?.find((i) => i.symbol === next);
    if (chosen === undefined) return;
    setSymbol(next);
    if (timeframe === undefined || !chosen.included.includes(timeframe)) setTimeframe(defaultTimeframe(chosen));
  };

  const importFile = async (file: File) => {
    setImportError(undefined);
    if (file.size > MAX_IMPORT_BYTES) {
      setImportError(`${file.name} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
      return;
    }
    const result = parseTradingViewFile(await file.text(), file.name);
    if (!result.ok) {
      setImportError(`${file.name}: ${result.message}`);
      return;
    }
    const value = result.value;
    if (value.kind === 'watchlist') {
      watchlists.save(value);
      setWatchlist(value);
      return;
    }
    const target = matchInstrument(value.symbol, (instruments ?? []).map((i) => i.symbol));
    const info = instruments?.find((i) => i.symbol === target);
    if (info === undefined) {
      setImportError(`${file.name}: ${value.symbol === undefined ? 'the file name does not say which instrument it is' : `${value.symbol} is not available here`}, so it cannot be compared.`);
      return;
    }
    setImported({ data: value, instrument: info.symbol, timeframe: value.timeframe });
    if (value.timeframe !== undefined && info.included.includes(value.timeframe)) {
      setSymbol(info.symbol);
      setTimeframe(value.timeframe);
    } else if (info.included.length > 0) {
      setSymbol(info.symbol);
      if (timeframe === undefined || !info.included.includes(timeframe)) setTimeframe(defaultTimeframe(info));
    }
  };

  const openIndicator = (id: string) => setEditing(applied[id]?.dialog ?? indicators.find((i) => i.id === id)?.dialog);

  const applySettings = async (dialog: IndicatorSettingsDialog, settings: Record<string, unknown>) => {
    const outcome = await client.checkSettings(dialog.indicatorId, settings);
    if (!outcome.ok) return outcome.fields;
    setApplied({ ...applied, [dialog.indicatorId]: outcome.accepted });
    setEditing(undefined);
    return undefined;
  };

  const removeIndicator = (id: string) => setApplied(Object.fromEntries(Object.entries(applied).filter(([key]) => key !== id)));

  const indicatorError = (id: string, message: string | undefined) =>
    setIndicatorErrors((errors) => {
      if (errors[id] === message) return errors;
      const rest = Object.fromEntries(Object.entries(errors).filter(([key]) => key !== id));
      return message === undefined ? rest : { ...rest, [id]: message };
    });

  if (failure !== undefined) return <p className="message" role="alert">{failure}</p>;
  if (instruments === undefined) return <p className="message">Loading…</p>;
  if (instrument === undefined || timeframe === undefined) return <p className="message">No instrument is available on your plan.</p>;

  return (
    <div className="app">
      <Toolbar
        instruments={instruments}
        instrument={instrument}
        timeframe={timeframe}
        onInstrument={chooseInstrument}
        onTimeframe={setTimeframe}
        indicators={indicators}
        onIndicator={openIndicator}
        session={session}
        onImport={() => fileInput.current?.click()}
      />
      <input
        ref={fileInput}
        type="file"
        hidden
        accept=".csv,.txt,text/csv,text/plain"
        data-testid="import-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file !== undefined) void importFile(file);
        }}
      />
      {(imported !== undefined || importError !== undefined) && (
        <div className="import-bar" data-testid="import-bar">
          {importError !== undefined && (
            <span className="error" role="alert" data-testid="import-error">
              {importError}
              <button type="button" className="remove" aria-label="Dismiss" onClick={() => setImportError(undefined)}>
                ×
              </button>
            </span>
          )}
          {imported !== undefined && (
            <span className="chip" data-testid="import-chip">
              <span className="swatch" aria-hidden="true" />
              <strong>TradingView</strong> {imported.instrument} {imported.timeframe ?? '(timeframe unknown)'}
              {' · '}
              {imported.instrument === instrument.symbol && imported.timeframe === timeframe ? (
                <span data-testid="import-report">{reportText(importReport, instrument.pricePrecision)}</span>
              ) : imported.timeframe !== undefined && instruments.find((i) => i.symbol === imported.instrument)?.included.includes(imported.timeframe) ? (
                <button
                  type="button"
                  className="link"
                  data-testid="import-goto"
                  onClick={() => {
                    if (imported.instrument !== undefined) setSymbol(imported.instrument);
                    if (imported.timeframe !== undefined) setTimeframe(imported.timeframe);
                  }}
                >
                  Show on {imported.instrument} {imported.timeframe}
                </button>
              ) : (
                <span>{imported.timeframe === undefined ? 'its timeframe could not be read' : `${imported.timeframe} is not on your plan`}</span>
              )}
              <button type="button" className="remove" aria-label="Remove import" data-testid="import-remove" onClick={() => setImported(undefined)}>
                ×
              </button>
            </span>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <div className="indicator-bar" data-testid="indicator-bar">
          {Object.values(applied).map((a) => {
            const name = indicators.find((i) => i.id === a.indicatorId)?.name ?? a.indicatorId;
            const numbers = Object.values(a.settings).filter((v) => typeof v === 'number');
            const failed = indicatorErrors[a.indicatorId];
            return (
              <span key={a.indicatorId} className="chip" data-testid={`indicator-chip-${a.indicatorId}`} data-failed={failed !== undefined}>
                <button type="button" className="link" title="Change settings" data-testid={`edit-indicator-${a.indicatorId}`} onClick={() => setEditing(a.dialog)}>
                  {name}
                  {numbers.length > 0 && ` (${numbers.join(', ')})`}
                </button>
                {failed !== undefined && <span role="alert"> {failed}</span>}
                <button type="button" className="remove" aria-label={`Remove ${name}`} data-testid={`remove-indicator-${a.indicatorId}`} onClick={() => removeIndicator(a.indicatorId)}>
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="workspace">
        <DrawingPanel layer={drawings} />
        <ChartView
          client={client}
          live={live}
          instrument={instrument}
          timeframe={timeframe}
          onStatus={setStatus}
          indicators={shown}
          onIndicatorError={indicatorError}
          drawings={drawings}
          onActivity={(event) => freshness.seen(event)}
          imported={imported}
          onImportReport={setImportReport}
        />
        {watchlist !== undefined && (
          <WatchlistPanel
            watchlist={watchlist}
            available={instruments.filter((i) => i.included.length > 0).map((i) => i.symbol)}
            current={instrument.symbol}
            onPick={chooseInstrument}
            onRemove={() => {
              watchlists.save(undefined);
              setWatchlist(undefined);
            }}
          />
        )}
      </div>
      <div className="status" data-testid="status" data-connection={state} data-series={status.state}>
        <FreshnessBadge tracker={freshness} connection={state} timeframe={timeframe} />
        {drawing.tool !== undefined && <span data-testid="drawing-hint">{hintFor(drawing.tool)}</span>}
        {status.state === 'loading' && <span>Loading bars…</span>}
        {status.state === 'error' && (
          <span role="alert">
            {status.message}
            {status.upgradeUrl !== undefined && (
              <>
                {' '}
                <a href={status.upgradeUrl}>Upgrade</a>
              </>
            )}
          </span>
        )}
      </div>
      {editing !== undefined && (
        <SettingsDialog
          key={editing.indicatorId}
          dialog={editing}
          onApply={(settings) => applySettings(editing, settings)}
          onClose={() => setEditing(undefined)}
        />
      )}
      {note !== undefined && (
        <NoteDialog
          key={note.id}
          text={note.text}
          isNew={note.isNew}
          onSave={(text) => {
            drawings.setNoteText(note.id, text);
            setNote(undefined);
          }}
          onCancel={() => {
            if (note.isNew) drawings.setNoteText(note.id, '');
            setNote(undefined);
          }}
        />
      )}
      <output hidden data-testid="applied-settings">
        {JSON.stringify(Object.fromEntries(Object.entries(applied).map(([id, a]) => [id, a.settings])))}
      </output>
    </div>
  );
}
