import type { Overlay, OverlayCreate, OverlayFilter } from 'klinecharts';
import { describe, expect, it } from 'vitest';

import type { DrawingChart } from './drawing-layer.js';
import { DRAWING_GROUP, DrawingLayer } from './drawing-layer.js';
import type { KeyValueStorage, SavedDrawing } from './drawing-store.js';
import { DrawingStore } from './drawing-store.js';

/** Overlays as KLineChart keeps them, with its callbacks fired by the test. */
class FakeChart implements DrawingChart {
  overlays: Overlay[] = [];
  private matches(o: Overlay, filter?: OverlayFilter): boolean {
    if (filter?.id !== undefined) return o.id === filter.id;
    return filter?.groupId === undefined || o.groupId === filter.groupId;
  }
  createOverlay = (value: OverlayCreate) => {
    const overlay = { lock: false, visible: true, mode: 'normal', points: [], ...value } as unknown as Overlay;
    this.overlays.push(overlay);
    return overlay.id;
  };
  getOverlays = (filter?: OverlayFilter) => this.overlays.filter((o) => this.matches(o, filter));
  overrideOverlay = (override: Partial<OverlayCreate>) => {
    for (const o of this.getOverlays(override)) Object.assign(o, { ...override, id: o.id, groupId: o.groupId });
    return true;
  };
  removeOverlay = (filter?: OverlayFilter) => {
    for (const o of this.getOverlays(filter)) {
      o.onRemoved?.({ overlay: o, chart: undefined as never });
      this.overlays = this.overlays.filter((x) => x !== o);
    }
    return true;
  };
  /** The trader clicks the drawing's points; KLineChart then reports the end. */
  place(id: string, points: { timestamp: number; value: number }[]) {
    const o = this.overlays.find((x) => x.id === id);
    if (o === undefined) throw new Error(`no overlay ${id}`);
    o.points = points;
    o.onDrawEnd?.({ overlay: o, chart: undefined as never });
  }
  fire(id: string, event: 'onSelected' | 'onDeselected' | 'onDoubleClick' | 'onPressedMoveEnd') {
    const o = this.overlays.find((x) => x.id === id);
    if (o !== undefined) o[event]?.({ overlay: o, chart: undefined as never });
  }
}

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

const P1 = { timestamp: 1_000, value: 10 };
const P2 = { timestamp: 2_000, value: 12 };

function setup(saved: Record<string, SavedDrawing[]> = {}) {
  const storage = new MemoryStorage();
  const store = new DrawingStore(() => storage, 'acc');
  for (const [instrument, drawings] of Object.entries(saved)) store.save(instrument, drawings);
  const notes: [string, string, boolean][] = [];
  const layer = new DrawingLayer({ store, onNote: (id, text, isNew) => notes.push([id, text, isNew]) });
  const chart = new FakeChart();
  layer.attach(chart);
  layer.show('BTCUSD');
  return { chart, store, layer, notes };
}

/** Starts a tool and returns the overlay id being placed. */
function begin(layer: DrawingLayer, chart: FakeChart, tool: string): string {
  layer.start(tool);
  const id = chart.overlays.at(-1)?.id;
  if (id === undefined) throw new Error('nothing started');
  return id;
}

describe('DrawingLayer', () => {
  it('places a drawing with the chosen tool and saves it once placed', () => {
    const { chart, store, layer } = setup();
    const id = begin(layer, chart, 'segment');
    expect(chart.overlays[0]).toMatchObject({ name: 'segment', groupId: DRAWING_GROUP, lock: false, visible: true, mode: 'normal' });
    expect(layer.get().tool).toBe('segment');
    expect(store.load('BTCUSD')).toEqual([]); // not saved while being placed

    chart.place(id, [P1, P2]);
    expect(layer.get()).toMatchObject({ tool: undefined, count: 1 });
    expect(store.load('BTCUSD')).toEqual([{ name: 'segment', points: [P1, P2] }]);
  });

  it('cancels a drawing being placed: again on its tool, by cancel, or by another tool', () => {
    const { chart, layer } = setup();
    begin(layer, chart, 'segment');
    layer.start('segment');
    expect(chart.overlays).toHaveLength(0);
    expect(layer.get().tool).toBeUndefined();

    begin(layer, chart, 'rayLine');
    layer.cancel();
    expect(chart.overlays).toHaveLength(0);

    begin(layer, chart, 'rayLine');
    begin(layer, chart, 'fibonacciLine');
    expect(chart.overlays.map((o) => o.name)).toEqual(['fibonacciLine']);
  });

  it('ignores names that are not drawing tools', () => {
    const { chart, layer } = setup();
    layer.start('aia-output');
    expect(chart.overlays).toHaveLength(0);
  });

  it('keeps each instrument its own drawings, and restores them', () => {
    const { chart, store, layer } = setup({ ETHUSD: [{ name: 'horizontalStraightLine', points: [P1] }] });
    chart.place(begin(layer, chart, 'segment'), [P1, P2]);

    layer.show('ETHUSD');
    expect(chart.overlays.map((o) => [o.name, o.points])).toEqual([['horizontalStraightLine', [P1]]]);
    expect(layer.get().count).toBe(1);
    // Swapping instruments does not delete what is saved.
    expect(store.load('BTCUSD')).toEqual([{ name: 'segment', points: [P1, P2] }]);

    layer.show('BTCUSD');
    expect(chart.overlays.map((o) => o.name)).toEqual(['segment']);
  });

  it('restores drawings onto a new chart', () => {
    const { layer, store } = setup({ BTCUSD: [{ name: 'priceLine', points: [P1] }] });
    const next = new FakeChart();
    layer.attach(next);
    expect(next.overlays.map((o) => o.name)).toEqual(['priceLine']);
    expect(store.load('BTCUSD')).toHaveLength(1);
  });

  it('saves a drawing moved by the trader', () => {
    const { chart, store, layer } = setup();
    const id = begin(layer, chart, 'segment');
    chart.place(id, [P1, P2]);
    const moved = chart.overlays[0];
    if (moved !== undefined) moved.points = [P2, { timestamp: 3_000, value: 15 }];
    chart.fire(id, 'onPressedMoveEnd');
    expect(store.load('BTCUSD')[0]?.points).toEqual([P2, { timestamp: 3_000, value: 15 }]);
  });

  it('deletes the selected drawing, but not while locked', () => {
    const { chart, store, layer } = setup();
    const id = begin(layer, chart, 'segment');
    chart.place(id, [P1, P2]);
    expect(layer.removeSelected()).toBe(false);

    chart.fire(id, 'onSelected');
    expect(layer.get().selected).toBe(id);
    layer.setLocked(true);
    expect(chart.overlays[0]?.lock).toBe(true);
    expect(layer.removeSelected()).toBe(false);

    layer.setLocked(false);
    expect(layer.removeSelected()).toBe(true);
    expect(chart.overlays).toHaveLength(0);
    expect(layer.get()).toMatchObject({ selected: undefined, count: 0 });
    expect(store.load('BTCUSD')).toEqual([]);
  });

  it('deletes all drawings of the instrument only', () => {
    const { chart, store, layer } = setup({ ETHUSD: [{ name: 'priceLine', points: [P1] }] });
    chart.place(begin(layer, chart, 'segment'), [P1, P2]);
    chart.place(begin(layer, chart, 'aiaRectangle'), [P1, P2]);
    layer.clear();
    expect(chart.overlays).toHaveLength(0);
    expect(store.load('BTCUSD')).toEqual([]);
    expect(store.load('ETHUSD')).toHaveLength(1);
  });

  it('applies the magnet, lock and hide to every drawing and to new ones', () => {
    const { chart, layer } = setup();
    chart.place(begin(layer, chart, 'segment'), [P1, P2]);
    layer.setMagnet(true);
    layer.setLocked(true);
    layer.setHidden(true);
    expect(chart.overlays[0]).toMatchObject({ mode: 'weak_magnet', lock: true, visible: false });

    // A new drawing brings hidden drawings back, so it is not placed blind.
    begin(layer, chart, 'rayLine');
    expect(layer.get().hidden).toBe(false);
    expect(chart.overlays.map((o) => [o.mode, o.lock, o.visible])).toEqual([
      ['weak_magnet', true, true],
      ['weak_magnet', true, true],
    ]);
  });

  it('asks for a new note text, saves it, and removes a note left empty', () => {
    const { chart, store, layer, notes } = setup();
    const id = begin(layer, chart, 'aiaNote');
    chart.place(id, [P1]);
    expect(notes).toEqual([[id, '', true]]);

    layer.setNoteText(id, '  breakout  ');
    expect(store.load('BTCUSD')).toEqual([{ name: 'aiaNote', points: [P1], text: 'breakout' }]);

    chart.fire(id, 'onDoubleClick');
    expect(notes.at(-1)).toEqual([id, 'breakout', false]);

    layer.setNoteText(id, '');
    expect(chart.overlays).toHaveLength(0);
    expect(store.load('BTCUSD')).toEqual([]);
  });

  it('restores a note with its text', () => {
    const { chart } = setup({ BTCUSD: [{ name: 'aiaNote', points: [P1], text: 'support' }] });
    expect(chart.overlays[0]).toMatchObject({ name: 'aiaNote', extendData: 'support' });
  });

  it('tells subscribers when its state changes, and only then', () => {
    const { chart, layer } = setup();
    let calls = 0;
    const stop = layer.subscribe(() => (calls += 1));
    layer.setMagnet(false);
    expect(calls).toBe(0);
    begin(layer, chart, 'segment');
    expect(calls).toBe(1);
    stop();
    layer.cancel();
    expect(calls).toBe(1);
  });
});
