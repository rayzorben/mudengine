/**
 * The throughput meter's last few readings, oldest first, for a trace of the
 * rate. A store over the meter (`useStreamPressure`), sampled on the meter's
 * own period while something reads it: the meter notifies only on a change,
 * so an idle stream would otherwise leave the trace frozen on its last burst.
 * Only the reader redraws per sample. See `mudengine-ui` › `SKILL.md`, *the
 * throughput meter is a store*.
 */
import { useMemo, useSyncExternalStore } from 'react';

import { tuning } from '../lib/tuning';
import type { StreamMeter } from './useStreamPressure';

interface MeterHistory {
  subscribe(listener: () => void): () => void;
  read(): readonly number[];
}

function meterHistory(meter: StreamMeter, length: number): MeterHistory {
  let values: readonly number[] = [];
  const listeners = new Set<() => void>();
  let timer: number | undefined;
  const sample = (): void => {
    values = [...values, meter.read().charsPerSecond].slice(-length);
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === undefined) timer = window.setInterval(sample, tuning().streamSampleMs);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        window.clearInterval(timer);
        timer = undefined;
      };
    },
    read: () => values
  };
}

/** The last `length` rates the meter read, oldest first; empty until the first sample. */
export function useMeterHistory(meter: StreamMeter, length: number): readonly number[] {
  const store = useMemo(() => meterHistory(meter, length), [meter, length]);
  return useSyncExternalStore(store.subscribe, store.read);
}
