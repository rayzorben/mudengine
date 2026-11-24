/**
 * What a typed palette query reaches past the commands (`lib/paletteFind.ts`),
 * bound to the shown character. Out of `App`, which is at its line ceiling.
 */
import { useCallback } from 'react';

import { paletteFind, type PaletteFindDeps } from '../lib/paletteFind';

export function usePaletteFind({
  api,
  session,
  openRouteOn,
  inspect,
  findMob,
  acquire
}: PaletteFindDeps) {
  return useCallback(
    (query: string) => paletteFind(query, { api, session, openRouteOn, inspect, findMob, acquire }),
    [api, session, openRouteOn, inspect, findMob, acquire]
  );
}
