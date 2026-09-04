import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { tuning } from '../lib/tuning';

/**
 * Throughput-driven adaptation.
 *
 * The honest cognitive-load signal in a MUD client is how fast text is
 * arriving. Above the threshold — a combat burst, a `who` dump, a room full of
 * spam — the chrome goes quiet so the eye stays on the terminal.
 *
 * This hook is also where the per-chunk character count is batched. Counting in
 * React state on every socket chunk would re-render the whole app during
 * exactly the bursts we are trying to keep smooth, so chunks accumulate in a
 * ref and flush on a fixed tick.
 *
 * **And the figures the tick produces are not application state either.**
 * They were: `charsPerSecond` and `total` were `useState` in the window's root
 * component, so every tick with output flowing re-rendered the whole window —
 * four times a second, all evening, for two numbers read by the status rail
 * and the Session card. Measured with `npm run profile:ui` (2026-09-04): with
 * memoisation working, that tick was the largest remaining source of commits
 * at idle. The rate and the total now live in a `StreamMeter`, a small store
 * the two readouts subscribe to through `useMeter`; only `pressure` — which
 * changes rarely, by design of the hysteresis below, and which every card
 * reads — is React state.
 */
export type Pressure = 'calm' | 'high';

/** How many samples in a row each edge has seen, and where that leaves it. */
export interface PressureRun {
  pressure: Pressure;
  /** Consecutive samples at or above the water line. */
  high: number;
  /** Consecutive samples below it. */
  calm: number;
}

/** What the two edges are measured against, read from `tuning()` at the tick. */
export interface PressureLimits {
  highWater: number;
  highSamples: number;
  calmSamples: number;
}

export const CALM: PressureRun = { pressure: 'calm', high: 0, calm: 0 };

/** What the meter reads right now. One object per change, so a reader can compare by identity. */
export interface MeterReading {
  charsPerSecond: number;
  /** Total decoded characters received this session. */
  total: number;
}

/** The throughput figures, subscribable — a store, not state. */
export interface StreamMeter {
  subscribe(listener: () => void): () => void;
  read(): MeterReading;
}

const NOTHING: MeterReading = { charsPerSecond: 0, total: 0 };

/** A meter that never moves, for a readout about a character this window is not watching. */
export const ZERO_METER: StreamMeter = {
  subscribe: () => () => undefined,
  read: () => NOTHING
};

/** The figures a meter holds, kept current by the store that owns it. */
export function useMeter(meter: StreamMeter): MeterReading {
  return useSyncExternalStore(meter.subscribe, meter.read);
}

/**
 * One sample's effect on the pressure state.
 *
 * Pure, and its own function, because this is a decision with edges rather
 * than a line of bookkeeping — the precedent being `clipboardIntent` and
 * `scrollMovesAnchor`, both extracted for the same reason. It is also the
 * decision that was wrong: **the exit had hysteresis and the entry had none**,
 * so one sample over the water line dimmed the whole window. At the shipped
 * 250ms sample that is 375 characters, which is a single combat round with
 * its colour codes in a single packet, so the chrome pulsed once per round
 * for as long as somebody was fighting. It read as the client flickering
 * every few seconds and nothing in the DOM said which of thirty timers it
 * was.
 *
 * Each edge resets the other's run, so a stream that alternates over and
 * under the line never accumulates towards either — that is what makes this
 * hysteresis rather than two independent counters.
 */
export function nextPressure(
  current: PressureRun,
  rate: number,
  limits: PressureLimits
): PressureRun {
  if (rate >= limits.highWater) {
    const high = current.high + 1;
    return {
      pressure: high >= limits.highSamples ? 'high' : current.pressure,
      high,
      calm: 0
    };
  }
  const calm = current.calm + 1;
  return {
    pressure: calm >= limits.calmSamples ? 'calm' : current.pressure,
    high: 0,
    calm
  };
}

export function useStreamPressure(): {
  pressure: Pressure;
  meter: StreamMeter;
  record: (chars: number) => void;
  reset: () => void;
} {
  const unflushed = useRef(0);
  const totalRef = useRef(0);
  /** The run of samples behind the current reading, kept out of React state. */
  const run = useRef<PressureRun>(CALM);

  const [pressure, setPressure] = useState<Pressure>('calm');

  /*
   * The store. Built once — a `useRef` initialiser rather than a `useMemo`,
   * because React reserves the right to drop a memo and a store that changed
   * identity would lose every subscriber.
   */
  const store = useRef<{
    reading: MeterReading;
    listeners: Set<() => void>;
    meter: StreamMeter;
    set(next: MeterReading): void;
  } | null>(null);
  if (store.current === null) {
    const listeners = new Set<() => void>();
    const box = {
      reading: NOTHING,
      listeners,
      meter: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        read: () => box.reading
      },
      set: (next: MeterReading) => {
        if (next.charsPerSecond === box.reading.charsPerSecond && next.total === box.reading.total)
          return;
        box.reading = next;
        for (const listener of listeners) listener();
      }
    };
    store.current = box;
  }

  const record = useCallback((chars: number) => {
    unflushed.current += chars;
    totalRef.current += chars;
  }, []);

  const reset = useCallback(() => {
    unflushed.current = 0;
    totalRef.current = 0;
    run.current = CALM;
    store.current?.set(NOTHING);
    setPressure('calm');
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const chars = unflushed.current;
      unflushed.current = 0;

      const rate = Math.round((chars * 1000) / tuning().streamSampleMs);
      store.current?.set({ charsPerSecond: rate, total: totalRef.current });

      run.current = nextPressure(run.current, rate, {
        highWater: tuning().streamHighWater,
        highSamples: tuning().streamHighSamples,
        calmSamples: tuning().streamCalmSamples
      });
      // Setting the same value is free in React, so the guard the runs already
      // provide is the only one needed.
      setPressure(run.current.pressure);
    }, tuning().streamSampleMs);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset['pressure'] = pressure;
  }, [pressure]);

  return { pressure, meter: store.current.meter, record, reset };
}
