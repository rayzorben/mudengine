/**
 * Where each supply row would be bought, asked of main when the Supplies face
 * opens and when the list changes (todo 49). Not per step: each row naming no
 * shop is a sweep of the realm, so the steps are as of the ask.
 */
import { useEffect, useState } from 'react';

import type { SupplyCounters } from '@shared/supplies';
import { errorMessage } from '@shared/values';
import type { SupplyList } from '../components/SupplyControls';

export interface SupplyCountersRead {
  /** Null until main has answered. */
  counters: SupplyCounters | null;
  /** Why the last ask failed, kept as the Shop cell's tooltip. */
  failed: string | null;
}

export function useSupplyCounters(supplies: SupplyList, open: boolean): SupplyCountersRead {
  const [read, setRead] = useState<SupplyCountersRead>({ counters: null, failed: null });
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void supplies.counters().then(
      (counters) => {
        if (!stale) setRead({ counters, failed: null });
      },
      (error: unknown) => {
        if (!stale) setRead({ counters: null, failed: errorMessage(error) });
      }
    );
    return () => {
      stale = true;
    };
    // The bundle is rebuilt when the list moves, which is the other reason to ask.
  }, [open, supplies]);
  return read;
}
