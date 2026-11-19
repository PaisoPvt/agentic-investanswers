// The chart app: pickers, the chart, and a status line (connection state and
// any message from the server, with the upgrade link for a locked choice).
// Indicators (M3-02, M3-05): choosing one opens its settings dialog; Apply
// sends the settings to the server and, once accepted, the chart draws the
// server's output with them. Each shown indicator has a chip to change its
// settings or remove it.
// Drawings (UI-01): the panel left of the chart places the trader's own lines,
// shapes and notes; Delete removes the selected one, Esc cancels placing.

import type { IndicatorSettingsDialog, IndicatorsResponse, InstrumentInfo, SettingsAccepted } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { DrawingLayer } from '../chart/drawing-layer.js';
import { DrawingStore, browserStorage } from '../chart/drawing-store.js';
import { toolByName } from '../chart/drawing-tools.js';

import type { ShownIndicator } from '../chart/indicator-layer.js';
import type { SeriesStatus } from '../data/bar-series.js';
import { FreshnessTracker } from '../data/freshness.js';
import type { ConnectionState, LiveConnection } from '../data/live-connection.js';
import type { PlatformClient } from '../data/platform-client.js';
import type { Session } from './AuthGate.js';
import { ChartView } from './ChartView.js';
import { DrawingPanel } from './DrawingPanel.js';
import { FreshnessBadge } from './FreshnessBadge.js';
import { NoteDialog } from './NoteDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
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

/** The first choice open to the caller: 1m if included, else the shortest included timeframe. */
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

function defaultTimeframe(instrument: InstrumentInfo): Timeframe | undefined {
  return instrument.included.includes('1m') ? '1m' : instrument.included[0];
}

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
    client.instruments().then(
      ({ instruments: list }) => {
        if (!current) return;
        setInstruments(list);
        const first = list.find((i) => i.included.length > 0);
        if (first !== undefined) {
          setSymbol(first.symbol);
          setTimeframe(defaultTimeframe(first));
        }
      },
      (error: unknown) => current && setFailure(error instanceof Error ? error.message : 'could not reach the server'),
    );
    return () => {
      current = false;
    };
  }, [client]);

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
      />
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
        />
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
