/**
 * The console's own name index, per character: every name that character's
 * realm knows, asked once per realm, with the people and gangs it knows set
 * onto it in place as they change. The same objects go to the console and to
 * the cards, so the two cannot disagree about what is a name.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/console.md`.
 */
import { useEffect, useMemo, useState } from 'react';

import { useKnownNames } from './useKnownNames';
import type { SessionView } from './useSessionViews';
import { NameIndex } from '../lib/names';
import type { IpcApi, SessionId, SessionSummary } from '@shared/ipc';
import type { WorldNames } from '@shared/world';

export function useNameIndexes(
  api: Pick<IpcApi, 'names'>,
  sessions: readonly Pick<SessionSummary, 'id'>[],
  views: Readonly<Record<SessionId, SessionView>>
): Record<SessionId, NameIndex> {
  /** The people and the gangs each character knows, for its console to recognise. */
  const knownNames = useKnownNames(views);

  /**
   * Every name this character's realm knows, for the console to recognise.
   *
   * Once per realm rather than per hover: the list is a few thousand words
   * and the link provider is asked on every row the pointer crosses. Keyed on
   * the session because two characters may be on two realms.
   */
  const [names, setNames] = useState<Record<SessionId, WorldNames>>({});
  useEffect(() => {
    let live = true;
    for (const entry of sessions) {
      if (names[entry.id]) continue;
      void api.names(entry.id).then((found) => {
        if (live) setNames((current) => ({ ...current, [entry.id]: found }));
      });
    }
    return () => {
      live = false;
    };
  }, [api, names, sessions]);

  /*
   * The console's own index, per character, for the cards that quote the
   * server's sentences: built when the realm's names arrive and re-fed the
   * people when they change, so a card and the console cannot disagree about
   * what is a name. `knownNames` is value-keyed, so this reruns when the
   * people change and not on every status line.
   */
  const realmIndexes = useMemo<Record<SessionId, NameIndex>>(() => {
    const out: Record<SessionId, NameIndex> = {};
    for (const [id, found] of Object.entries(names)) out[id as SessionId] = new NameIndex(found);
    return out;
  }, [names]);
  /*
   * The people change while the realm's names do not — every arrival and
   * departure, against a realm index of thousands of names that is built
   * once — so they are set onto each index in place rather than the index
   * being rebuilt. The same objects go to the console and to the cards, which
   * is what makes "the console's own index" literally true rather than two
   * instances fed the same inputs.
   */
  const nameIndexes = useMemo<Record<SessionId, NameIndex>>(() => {
    for (const [id, index] of Object.entries(realmIndexes)) {
      const people = knownNames[id as SessionId];
      index.setPlayers(people?.known ?? [], people?.present ?? []);
      // Set in place beside the people and for the same reason: a gang changes
      // when a `who` lands, and the realm's thousands of names do not.
      index.setGangs(people?.gangs ?? []);
    }
    return realmIndexes;
  }, [realmIndexes, knownNames]);

  return nameIndexes;
}
