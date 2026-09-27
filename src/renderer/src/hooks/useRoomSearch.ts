/**
 * The rooms a typed query finds, debounced and searched on the realm's index.
 *
 * Nothing below `roomSearchMinChars` is asked, and a late answer to an older
 * query is dropped, so the list is always the answer to what is in the field.
 * A search that failed clears the list and says why in `failed`.
 */
import { useEffect, useState } from 'react';

import { tuning } from '../lib/tuning';
import { errorMessage } from '@shared/values';
import type { WorldRoom } from '@shared/world';

export interface RoomSearch {
  matches: WorldRoom[];
  failed: string | null;
}

const NOTHING: RoomSearch = { matches: [], failed: null };

export function useRoomSearch(
  search: (query: string) => Promise<WorldRoom[]>,
  query: string
): RoomSearch {
  const [found, setFound] = useState<RoomSearch>(NOTHING);
  useEffect(() => {
    if (query.trim().length < tuning().roomSearchMinChars) {
      setFound(NOTHING);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void search(query)
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
  }, [query, search]);
  return found;
}
