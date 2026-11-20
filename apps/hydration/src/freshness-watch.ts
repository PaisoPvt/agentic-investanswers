// Watching freshness (M2-07): for each instrument and each minute that closes
// while watching, when it first shows up at each step, measured from its close
// (open time + 60 s). The checks come in as functions, so tests drive them on
// a fake clock and `pnpm freshness` gives the real ones (freshness.ts).

import type { FreshnessStep, Observation } from './freshness-report.js';

export interface FreshnessProbes {
  /** Calls `seen(symbol, minute)` whenever the live connection delivers a stored 1m bar; returns a stop. */
  readonly chart: (seen: (symbol: string, minute: number) => void) => Promise<() => void>;
  /** True once the History API's newest 1m bar is this minute or later. */
  readonly cache: (symbol: string, minute: number) => Promise<boolean>;
  /** True once raw storage holds this minute; none when the stores cannot be reached. */
  readonly storage?: (symbol: string, minute: number) => Promise<boolean>;
}

export interface WatchOptions {
  readonly symbols: readonly string[];
  /** How many minute closes to watch. */
  readonly minutes: number;
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** How often cache and storage are asked; storage less often, since each ask lists a day. */
  readonly pollMs?: { readonly cache: number; readonly storage: number };
  /** A minute not seen this long after its close counts as missing. */
  readonly giveUpMs?: number;
}

export async function watchFreshness(probes: FreshnessProbes, options: WatchOptions): Promise<Observation[]> {
  const { nowMs, sleep } = options;
  const poll = options.pollMs ?? { cache: 250, storage: 1_000 };
  const giveUp = options.giveUpMs ?? 60_000;
  const start = nowMs();
  // The first close after start, then one a minute.
  const firstClose = Math.ceil((start + 1) / 60_000) * 60_000;
  const minutes = Array.from({ length: options.minutes }, (_, i) => (firstClose + i * 60_000) / 1000 - 60);
  const watched = new Set(minutes);

  const charted = new Map<string, number>();
  const stop = await probes.chart((symbol, minute) => {
    const key = `${symbol}|${minute}`;
    if (watched.has(minute) && !charted.has(key)) charted.set(key, nowMs() - (minute + 60) * 1000);
  });

  const observe = async (symbol: string, minute: number, step: FreshnessStep, check: (s: string, m: number) => Promise<boolean>, every: number): Promise<Observation> => {
    const close = (minute + 60) * 1000;
    while (nowMs() < close) await sleep(Math.min(every, close - nowMs()));
    while (nowMs() - close <= giveUp) {
      try {
        if (await check(symbol, minute)) return { symbol, minute, step, ms: nowMs() - close };
      } catch {
        // A failed ask is asked again; a minute never seen counts as missing.
      }
      await sleep(every);
    }
    return { symbol, minute, step, ms: undefined };
  };

  const polled: Promise<Observation>[] = [];
  for (const symbol of options.symbols) {
    for (const minute of minutes) {
      polled.push(observe(symbol, minute, 'cache', probes.cache, poll.cache));
      if (probes.storage !== undefined) polled.push(observe(symbol, minute, 'storage', probes.storage, poll.storage));
    }
  }
  const observations = await Promise.all(polled);
  // Live bars may come after the polls are answered: wait for them too, up to the same limit.
  const lastClose = ((minutes[minutes.length - 1] ?? 0) + 60) * 1000;
  const allCharted = () => options.symbols.every((symbol) => minutes.every((minute) => charted.has(`${symbol}|${minute}`)));
  while (!allCharted() && nowMs() - lastClose <= giveUp) await sleep(poll.cache);
  stop();
  for (const symbol of options.symbols) {
    for (const minute of minutes) observations.push({ symbol, minute, step: 'chart', ms: charted.get(`${symbol}|${minute}`) });
  }
  return observations;
}
