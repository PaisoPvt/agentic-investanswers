import { describe, expect, it } from 'vitest';

import { parsePreferences } from './chart-preferences.js';

describe('parsePreferences', () => {
  it('accepts every field, some or none', () => {
    expect(parsePreferences({ instrument: 'ETHUSD', timeframe: '1h', theme: 'dark' })).toEqual({ ok: true, value: { instrument: 'ETHUSD', timeframe: '1h', theme: 'dark' } });
    expect(parsePreferences({ timeframe: '1D' })).toEqual({ ok: true, value: { timeframe: '1D' } });
    expect(parsePreferences({})).toEqual({ ok: true, value: {} });
  });

  it('refuses anything but an object', () => {
    for (const input of [null, 'ETHUSD', 3, [], undefined]) expect(parsePreferences(input).ok).toBe(false);
  });

  it('refuses unknown fields, so nothing else is ever stored', () => {
    expect(parsePreferences({ instrument: 'BTCUSD', password: 'x' })).toEqual({ ok: false, message: 'unknown field "password"' });
  });

  it('refuses malformed values', () => {
    expect(parsePreferences({ instrument: '' }).ok).toBe(false);
    expect(parsePreferences({ instrument: 'X'.repeat(33) }).ok).toBe(false);
    expect(parsePreferences({ instrument: 'BTC USD' }).ok).toBe(false);
    expect(parsePreferences({ instrument: 7 }).ok).toBe(false);
    expect(parsePreferences({ timeframe: '2h' }).ok).toBe(false);
    expect(parsePreferences({ timeframe: '1d' }).ok).toBe(false);
    expect(parsePreferences({ theme: 'blue' }).ok).toBe(false);
  });
});
