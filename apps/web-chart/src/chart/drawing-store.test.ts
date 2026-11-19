import { describe, expect, it } from 'vitest';

import type { KeyValueStorage } from './drawing-store.js';
import { DrawingStore } from './drawing-store.js';

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

const line = { name: 'segment', points: [{ timestamp: 1_000, value: 10 }, { timestamp: 2_000, value: 12.5 }] };

describe('DrawingStore', () => {
  it('keeps drawings per account and instrument', () => {
    const storage = new MemoryStorage();
    const mine = new DrawingStore(() => storage, 'acc-1');
    const theirs = new DrawingStore(() => storage, 'acc-2');
    expect(mine.save('BTCUSD', [line])).toBe(true);
    expect(mine.load('BTCUSD')).toEqual([line]);
    expect(mine.load('ETHUSD')).toEqual([]);
    expect(theirs.load('BTCUSD')).toEqual([]);
  });

  it('forgets the key when the last drawing goes', () => {
    const storage = new MemoryStorage();
    const store = new DrawingStore(() => storage, 'acc-1');
    store.save('BTCUSD', [line]);
    store.save('BTCUSD', []);
    expect(storage.items.size).toBe(0);
  });

  it('drops what is not a drawing, and survives what is not JSON', () => {
    const storage = new MemoryStorage();
    const store = new DrawingStore(() => storage, 'acc-1');
    storage.setItem('aia.drawings.v1.acc-1.BTCUSD', JSON.stringify([line, { name: 'segment', points: [] }, { name: 1 }, { name: 'priceLine', points: [{ timestamp: 'x', value: 1 }] }]));
    expect(store.load('BTCUSD')).toEqual([line]);
    storage.setItem('aia.drawings.v1.acc-1.BTCUSD', '{not json');
    expect(store.load('BTCUSD')).toEqual([]);
  });

  it('works without storage, or with storage that refuses', () => {
    const none = new DrawingStore(() => undefined, 'acc-1');
    expect(none.save('BTCUSD', [line])).toBe(false);
    expect(none.load('BTCUSD')).toEqual([]);
    const refusing: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const store = new DrawingStore(() => refusing, 'acc-1');
    expect(store.save('BTCUSD', [line])).toBe(false);
    expect(store.load('BTCUSD')).toEqual([]);
  });
});
