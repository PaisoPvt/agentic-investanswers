import { describe, expect, it } from 'vitest';

import { MemoryPreferencesStore } from '../adapters/memory-preferences-store.js';
import { ChartPreferencesBook } from './chart-preferences-book.js';

describe('ChartPreferencesBook', () => {
  it('loads nothing before the first save, then what was saved', async () => {
    const book = new ChartPreferencesBook(new MemoryPreferencesStore());
    expect(await book.load('acc-1')).toEqual({});
    expect(await book.save('acc-1', { instrument: 'ETHUSD', timeframe: '1h' })).toEqual({ ok: true });
    expect(await book.load('acc-1')).toEqual({ instrument: 'ETHUSD', timeframe: '1h' });
    expect(await book.load('acc-2')).toEqual({});
  });

  it('refuses what fails the check and keeps what was there', async () => {
    const book = new ChartPreferencesBook(new MemoryPreferencesStore());
    await book.save('acc-1', { theme: 'dark' });
    expect(await book.save('acc-1', { theme: 'blue' })).toEqual({ ok: false, code: 'invalid_preferences', message: 'theme must be light or dark' });
    expect(await book.load('acc-1')).toEqual({ theme: 'dark' });
  });
});
