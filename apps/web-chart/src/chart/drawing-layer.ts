// The trader's drawings on the chart (UI-01). Each drawing is a KLineChart
// overlay in one group, pinned to bar times and prices, so it stays put when
// the timeframe changes. Switching instrument swaps in that instrument's
// drawings. After every change (placed, moved, removed, note text) the whole
// set for the instrument is saved (drawing-store.ts).
//
// The panel drives it: start a tool, the magnet, lock all, hide all, delete
// the selected drawing, delete all. React reads its state through
// subscribe/get (useSyncExternalStore).

import type { Overlay, OverlayCreate, OverlayEvent, OverlayFilter, OverlayMode } from 'klinecharts';

import type { DrawingPoint, DrawingStore, SavedDrawing } from './drawing-store.js';
import { NOTE_TOOL, toolByName } from './drawing-tools.js';

export const DRAWING_GROUP = 'aia-drawings';

/** The part of KLineChart's Chart used here (a fake in the unit tests). */
export interface DrawingChart {
  createOverlay(value: OverlayCreate): unknown;
  getOverlays(filter?: OverlayFilter): Overlay[];
  overrideOverlay(override: Partial<OverlayCreate>): boolean;
  removeOverlay(filter?: OverlayFilter): boolean;
}

export interface DrawingState {
  /** The tool being placed, until its last click. */
  readonly tool: string | undefined;
  readonly magnet: boolean;
  readonly locked: boolean;
  readonly hidden: boolean;
  /** How many drawings the instrument has. */
  readonly count: number;
  readonly selected: string | undefined;
}

export interface DrawingLayerOptions {
  readonly store: DrawingStore;
  /** A text note was placed or double-clicked: ask for its text. */
  readonly onNote?: (id: string, text: string, isNew: boolean) => void;
}

const INITIAL: DrawingState = { tool: undefined, magnet: false, locked: false, hidden: false, count: 0, selected: undefined };

function pointsOf(overlay: Overlay): DrawingPoint[] | undefined {
  const points: DrawingPoint[] = [];
  for (const p of overlay.points) {
    if (typeof p.timestamp !== 'number' || typeof p.value !== 'number') return undefined;
    points.push({ timestamp: p.timestamp, value: p.value });
  }
  return points.length > 0 ? points : undefined;
}

export class DrawingLayer {
  private chart: DrawingChart | undefined;
  private instrument: string | undefined;
  private state: DrawingState = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** The drawing being placed, until its last click. */
  private drawing: string | undefined;
  /** Set while drawings are taken off the chart by us, not by the trader. */
  private swapping = false;
  private nextId = 0;

  constructor(private readonly options: DrawingLayerOptions) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): DrawingState => this.state;

  private set(patch: Partial<DrawingState>): void {
    const next = { ...this.state, ...patch };
    if ((Object.keys(patch) as (keyof DrawingState)[]).every((k) => next[k] === this.state[k])) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Called by the chart view when the chart is created (and with undefined when it goes). */
  attach(chart: DrawingChart | undefined): void {
    this.chart = chart;
    this.drawing = undefined;
    if (chart !== undefined && this.instrument !== undefined) this.restore();
    else this.set({ tool: undefined, selected: undefined, count: 0 });
  }

  /** Shows the instrument's drawings in place of the previous instrument's. */
  show(instrument: string): void {
    if (instrument === this.instrument) return;
    this.instrument = instrument;
    if (this.chart !== undefined) this.restore();
  }

  private restore(): void {
    const chart = this.chart;
    const instrument = this.instrument;
    if (chart === undefined || instrument === undefined) return;
    this.takeOff();
    const saved = this.options.store.load(instrument).filter((d) => toolByName(d.name) !== undefined);
    for (const drawing of saved) chart.createOverlay(this.create(drawing.name, drawing));
    this.set({ tool: undefined, selected: undefined, count: saved.length });
  }

  /** Removes every drawing from the chart without touching what is saved. */
  private takeOff(): void {
    this.swapping = true;
    try {
      this.chart?.removeOverlay({ groupId: DRAWING_GROUP });
    } finally {
      this.swapping = false;
    }
    this.drawing = undefined;
  }

  private create(name: string, saved?: SavedDrawing): OverlayCreate {
    const { magnet, locked, hidden } = this.state;
    this.nextId += 1;
    return {
      name,
      id: `aia-drawing-${this.nextId}`,
      groupId: DRAWING_GROUP,
      lock: locked,
      visible: !hidden,
      mode: (magnet ? 'weak_magnet' : 'normal') satisfies OverlayMode,
      ...(saved === undefined ? {} : { points: saved.points.map((p) => ({ ...p })) }),
      ...(saved?.text === undefined ? {} : { extendData: saved.text }),
      onDrawEnd: (e) => this.drawEnd(e),
      onPressedMoveEnd: () => this.persist(),
      onRemoved: (e) => this.removed(e),
      onSelected: (e) => this.set({ selected: e.overlay.id }),
      onDeselected: (e) => this.state.selected === e.overlay.id && this.set({ selected: undefined }),
      onDoubleClick: (e) => this.editNote(e.overlay, false),
    };
  }

  /** Starts placing a drawing with the tool; choosing the tool being placed again cancels it. */
  start(name: string): void {
    const chart = this.chart;
    if (chart === undefined || toolByName(name) === undefined) return;
    const again = this.state.tool === name;
    this.cancel();
    if (again) return;
    // Hidden drawings come back so the new one is not placed blind.
    if (this.state.hidden) this.setHidden(false);
    const create = this.create(name);
    this.drawing = create.id;
    chart.createOverlay(create);
    this.set({ tool: name });
  }

  /** Stops placing a drawing, removing what was placed of it so far. */
  cancel(): void {
    const id = this.drawing;
    this.drawing = undefined;
    if (id !== undefined) {
      this.swapping = true;
      try {
        this.chart?.removeOverlay({ id });
      } finally {
        this.swapping = false;
      }
    }
    this.set({ tool: undefined });
  }

  private drawEnd(event: OverlayEvent<unknown>): void {
    if (event.overlay.id === this.drawing) this.drawing = undefined;
    this.set({ tool: undefined });
    this.persist();
    if (event.overlay.name === NOTE_TOOL) this.editNote(event.overlay, true);
  }

  private editNote(overlay: Overlay, isNew: boolean): void {
    if (overlay.name !== NOTE_TOOL || overlay.lock) return;
    this.options.onNote?.(overlay.id, typeof overlay.extendData === 'string' ? overlay.extendData : '', isNew);
  }

  /** Sets a note's text; an empty text removes the note. */
  setNoteText(id: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') {
      this.chart?.removeOverlay({ id });
      return;
    }
    this.chart?.overrideOverlay({ id, extendData: trimmed });
    this.persist();
  }

  private removed(event: OverlayEvent<unknown>): void {
    if (this.swapping) return;
    const id = event.overlay.id;
    if (this.state.selected === id) this.set({ selected: undefined });
    // KLineChart tells us before it takes the overlay off.
    this.persist(id);
  }

  setMagnet(on: boolean): void {
    this.set({ magnet: on });
    this.chart?.overrideOverlay({ groupId: DRAWING_GROUP, mode: on ? 'weak_magnet' : 'normal' });
  }

  setLocked(on: boolean): void {
    this.set({ locked: on });
    this.chart?.overrideOverlay({ groupId: DRAWING_GROUP, lock: on });
  }

  setHidden(on: boolean): void {
    if (on) this.cancel();
    this.set({ hidden: on });
    this.chart?.overrideOverlay({ groupId: DRAWING_GROUP, visible: !on });
  }

  /** Deletes the selected drawing, unless drawings are locked. Returns whether one was deleted. */
  removeSelected(): boolean {
    const id = this.state.selected;
    if (id === undefined || this.state.locked || this.chart === undefined) return false;
    this.chart.removeOverlay({ id });
    return true;
  }

  /** Deletes every drawing of the instrument. */
  clear(): void {
    this.cancel();
    this.takeOff();
    if (this.instrument !== undefined) this.options.store.save(this.instrument, []);
    this.set({ selected: undefined, count: 0 });
  }

  /** Saves the instrument's finished drawings, leaving out `without` (being removed). */
  private persist(without?: string): void {
    const chart = this.chart;
    const instrument = this.instrument;
    if (chart === undefined || instrument === undefined) return;
    const drawings: SavedDrawing[] = [];
    for (const overlay of chart.getOverlays({ groupId: DRAWING_GROUP })) {
      if (overlay.id === without || overlay.id === this.drawing) continue;
      const points = pointsOf(overlay);
      if (points === undefined) continue;
      const text = overlay.name === NOTE_TOOL && typeof overlay.extendData === 'string' ? overlay.extendData : undefined;
      drawings.push({ name: overlay.name, points, ...(text === undefined ? {} : { text }) });
    }
    this.options.store.save(instrument, drawings);
    this.set({ count: drawings.length });
  }
}
