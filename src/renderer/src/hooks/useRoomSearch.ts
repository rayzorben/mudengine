/**
 * The rooms a typed query finds, debounced and searched on the realm's index,
 * the rooms walked to before first.
 *
 * Below `roomSearchMinChars` nothing is asked; with the field blank and
 * `recentWhenBlank`, the latest rooms walked to are (main answers a blank
 * query with those). A
 * late answer to an older query is dropped, so the list is always the answer
 * to what is in the field. A search that failed clears the list and says why
 * in `failed`.
 */
import { useEffect, useState } from 'react';

import { tuning } from '../lib/tuning';
import { errorMessage } from '@shared/values';
import type { FoundRoom } from '@shared/destinations';

export interface RoomSearch {
  matches: FoundRoom[];
  failed: string | null;
}

const NOTHING: RoomSearch = { matches: [], failed: null };

export function useRoomSearch(
  search: (query: string) => Promise<FoundRoom[]>,
  query: string,
  recentWhenBlank = false
): RoomSearch {
  const [found, setFound] = useState<RoomSearch>(NOTHING);
  const typed = query.trim().length;
  const asked =
    typed >= tuning().roomSearchMinChars ? query : typed === 0 && recentWhenBlank ? '' : null;
  useEffect(() => {
    if (asked === null) {
      setFound(NOTHING);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void search(asked)
        .then((matches) => {
          if (live) setFound({ matches, failed: null });
        })
        .catch((error) => {
          if (live) setFound({ matches: [], failed: errorMessage(error) });
        });
    }, tuning().roomSearchDebounceMs);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [asked, search]);
  return found;
}
