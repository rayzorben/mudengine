import { useMemo } from 'react';

import { knownGangs } from '../lib/gangs';
import { knownPlayerNames, presentPlayerNames } from '../lib/players';
import type { CharacterState } from '@shared/character';
import type { SessionId } from '@shared/ipc';
import type { PlayerRegistry } from '@shared/players';

/**
 * The people and the gangs each character knows, for its console and the
 * cards that quote the server to recognise (`NameIndex.setPlayers`,
 * `setGangs`): the registry and the roster, by the server's spelling.
 *
 * Out of `App` since the registry left the character's push (todo 730),
 * because what it reads now moves at two rates: a status line replaces the
 * character and its roster, and only a record changing replaces the registry.
 * With a realm of a thousand known players the fold is three sorts of a
 * thousand names, and it ran on every status line; see `mudengine-ui` ›
 * *The window redraws what changed*.
 */
export interface KnownNames {
  /** Everyone with a record or a roster row, offline included. */
  known: string[];
  /** The ones in the realm now, who outrank a realm name of the same spelling. */
  present: string[];
  gangs: string[];
}

/** What the fold is handed per character: the registry and the character it is pushed beside. */
interface Seen {
  players: PlayerRegistry;
  character: CharacterState;
}

/** The last fold of each registry, with the roster it was folded against; one slot, so it cannot grow. */
const folded = new WeakMap<PlayerRegistry, { roster: string; names: KnownNames }>();

/**
 * What the fold reads off the character, by value: its own name and each
 * roster row's name and gang (`ownGang` is its own row's). A character push
 * is a fresh clone, so the arrays are new every status line and this string
 * is what stays equal.
 */
function rosterOf(character: CharacterState): string {
  const rows = character.online.map((entry) => `${entry.name}\u0000${entry.gang ?? ''}`);
  return `${character.name ?? ''}\u0001${rows.join('\u0002')}`;
}

/** One character's names, folded again only when its registry or its roster moved. */
function namesOf(players: PlayerRegistry, character: CharacterState): KnownNames {
  const roster = rosterOf(character);
  const held = folded.get(players);
  if (held !== undefined && held.roster === roster) return held.names;
  const names = {
    known: knownPlayerNames(players, character),
    present: presentPlayerNames(players, character),
    gangs: knownGangs(players, character)
  };
  folded.set(players, { roster, names });
  return names;
}

const NAME = '\u0000';
const LIST = '\u0003';
const SESSION = '\u0002';
const ID = '\u0001';

/**
 * Keyed by value: the joined names are what stays equal between two pushes
 * that changed nothing a name index reads, so the record below — and the
 * indexes fed from it — are rebuilt only when a name did.
 */
export function useKnownNames(
  views: Readonly<Record<SessionId, Seen>>
): Readonly<Record<SessionId, KnownNames>> {
  const key = useMemo(
    () =>
      Object.entries(views)
        .map(([id, view]) => {
          const { known, present, gangs } = namesOf(view.players, view.character);
          return `${id}${ID}${[known, present, gangs].map((list) => list.join(NAME)).join(LIST)}`;
        })
        .join(SESSION),
    [views]
  );
  return useMemo(() => {
    const out: Record<SessionId, KnownNames> = {};
    if (key.length === 0) return out;
    const split = (names: string | undefined): string[] =>
      names === undefined || names.length === 0 ? [] : names.split(NAME);
    for (const entry of key.split(SESSION)) {
      const [id, lists] = entry.split(ID);
      if (id === undefined) continue;
      const [known, present, gangs] = (lists ?? '').split(LIST);
      out[id as SessionId] = { known: split(known), present: split(present), gangs: split(gangs) };
    }
    return out;
  }, [key]);
}
