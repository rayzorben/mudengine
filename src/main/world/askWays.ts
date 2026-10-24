/**
 * The ways a monster's `ask` table moves somebody, as commands of the rooms
 * the monster stands in (format 73): `ask prisoner return` with the four
 * shards puts the character in Blackstone Cavern, and `ask deckhand return`
 * takes them off the islands. Behind `monster-here`, since a monster that is
 * dead or wandered off answers nothing. Read through `scriptLandings`, so a
 * roll in an answer is a chance as it is in a room's own script.
 */
import { askLines, askPhrase, longest } from './mobAsks';
import { gatesOf, nameGate, type GateNames } from './navigation/stepGates';
import { landingsOf, runEnds, type LandingRealm } from './navigation/scriptLandings';
import { commandMoves, type RoomCommand } from '../../shared/world';
import type { RealmSource } from './RealmSource';
import { number, text } from './values';

/** A monster row as the ask ways read it. */
export interface AskingMonster {
  id: number;
  name: string;
  greet: number;
}

/** Every room's ask ways, by the monster rows standing there. */
export class AskWays {
  private readonly kept = new Map<number, RoomCommand[]>();

  constructor(
    private readonly monster: (id: number) => AskingMonster | undefined,
    private readonly realm: Omit<LandingRealm, 'here'>,
    private readonly names: GateNames
  ) {}

  /** The ask ways of a room where these rows stand, its resident and its lair. */
  in(rows: readonly number[]): RoomCommand[] {
    return [...new Set(rows)].flatMap((id) => this.of(id));
  }

  private of(id: number): RoomCommand[] {
    const held = this.kept.get(id);
    if (held !== undefined) return held;
    const monster = this.monster(id);
    const ways = monster === undefined ? [] : this.read(monster);
    this.kept.set(id, ways);
    return ways;
  }

  private read(monster: AskingMonster): RoomCommand[] {
    // An answer is asked wherever the monster stands, so a cast naming no map lands nowhere known.
    const realm: LandingRealm = { ...this.realm, here: null };
    const here = { kind: 'monster-here' as const, monster: monster.id };
    return askLines(monster.greet, this.realm.blocks).flatMap(({ words, steps }) => {
      const moves = landingsOf(runEnds(steps, realm), this.names);
      if (!commandMoves(moves)) return [];
      const gates = [here, ...gatesOf(steps)].map((gate) => nameGate(gate, this.names));
      const first = longest(words);
      const say = [first, ...words.filter((word) => word !== first)];
      return [
        { say: say.map((word) => askPhrase(monster.name, word)), ...moves, gates, asks: monster.id }
      ];
    });
  }
}

/** Every monster row with a greeting, by row id. */
export function askingMonsters(source: RealmSource): Map<number, AskingMonster> {
  const found = new Map<number, AskingMonster>();
  for (const row of source.table('Monsters')?.rows ?? []) {
    const id = number(row['Number']);
    const greet = number(row['GreetTXT']);
    const name = text(row['Name']).trim();
    if (id !== null && greet !== null && greet > 0 && name.length > 0) {
      found.set(id, { id, name, greet });
    }
  }
  return found;
}
