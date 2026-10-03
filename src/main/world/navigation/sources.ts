/**
 * Every way the realm gives an item, one table: a counter that sells it, a
 * word that hands it over, a monster that drops it (where the realm puts it,
 * where its summoner is, where a room's words call it up) and a monster whose
 * death hands it over. Each is a room to go to and what to do there; what it
 * costs this character and whether they can win the fight is the planner's.
 */
import {
  asRoomReference,
  roomId,
  type ItemHandover,
  type RoomId,
  type WorldMob,
  type WorldRoom
} from '../../../shared/world';

/** What the table reads of the realm, composed by `WorldGraph`. */
export interface SourceRealm {
  everyRoom(): Iterable<WorldRoom>;
  hasRoom(id: RoomId): boolean;
  /** The rooms whose counter sells the item (`sells`). */
  sellingRooms(item: number): readonly WorldRoom[];
  /** The script handovers of the item (`WorldItem.from`). */
  handovers(item: number): readonly ItemHandover[];
  /** The monsters whose drop list names the item. */
  droppers(item: number): readonly WorldMob[];
  summonersOf(mob: WorldMob): readonly WorldMob[];
  spawnRoomsOf(mob: WorldMob): ReadonlyArray<{ room: WorldRoom }>;
}

export type ItemSource =
  | { kind: 'buy'; room: RoomId }
  /** Say `say` in the room: `ask <who> <word>`, or a room's own phrase. */
  | { kind: 'ask'; room: RoomId; say: string }
  /**
   * Kill `monster` in the room for it. `summon` is what brings it there first:
   * a room's words, or the death of the monster that summons it. `certain`
   * marks a death that always hands the item over; a drop may not come.
   */
  | {
      kind: 'kill';
      monster: string;
      room: RoomId;
      summon?: { say: string } | { by: string };
      certain?: true;
    };

/** What to say at a source: an ask's words, or the words that summon its dropper. */
export function spokenFor(source: ItemSource): string | null {
  switch (source.kind) {
    case 'buy':
      return null;
    case 'ask':
      return source.say;
    case 'kill':
      return source.summon !== undefined && 'say' in source.summon ? source.summon.say : null;
    default: {
      const never: never = source;
      return never;
    }
  }
}

/** What a script handover asks, wherever it is: a death, words to an NPC, or a phrase. */
export type Handover =
  | { kind: 'kill'; monster: string }
  | { kind: 'ask'; who: string; word?: string }
  | { kind: 'said'; word: string };

/** A script handover as what it asks, or null where it states too little to act on. */
export function handoverSource(handover: ItemHandover): Handover | null {
  const word = handover.say?.[0];
  switch (handover.kind) {
    case 'killed':
      return handover.who === undefined ? null : { kind: 'kill', monster: handover.who };
    case 'asked':
      if (handover.who === undefined) return null;
      return word === undefined
        ? { kind: 'ask', who: handover.who }
        : { kind: 'ask', who: handover.who, word };
    case 'said':
      return word === undefined ? null : { kind: 'said', word };
    default: {
      const never: never = handover.kind;
      return never;
    }
  }
}

export class ItemSources {
  /** Monster row → the rooms whose words summon it and ask nothing else. */
  private scripts: Map<number, Array<{ room: RoomId; say: string }>> | null = null;

  constructor(private readonly realm: SourceRealm) {}

  /** Every way to get the item, each once. */
  of(item: number): ItemSource[] {
    const found: ItemSource[] = [];
    const seen = new Set<string>();
    const add = (source: ItemSource): void => {
      const key = JSON.stringify(source);
      if (seen.has(key) || !this.realm.hasRoom(source.room)) return;
      seen.add(key);
      found.push(source);
    };
    for (const room of this.realm.sellingRooms(item)) {
      add({ kind: 'buy', room: roomId(room.map, room.room) });
    }
    for (const handover of this.realm.handovers(item)) {
      const at = handover.room === undefined ? null : asRoomReference(handover.room);
      const asks = handoverSource(handover);
      if (at === null || asks === null) continue;
      const room = roomId(at.map, at.room);
      switch (asks.kind) {
        case 'kill':
          add({ kind: 'kill', monster: asks.monster, room, certain: true });
          break;
        case 'said':
          add({ kind: 'ask', room, say: asks.word });
          break;
        case 'ask':
          if (asks.word !== undefined)
            add({ kind: 'ask', room, say: `ask ${asks.who} ${asks.word}` });
          break;
        default: {
          const never: never = asks;
          return never;
        }
      }
    }
    for (const mob of this.realm.droppers(item)) {
      for (const { room } of this.realm.spawnRoomsOf(mob)) {
        add({ kind: 'kill', monster: mob.name, room: roomId(room.map, room.room) });
      }
      // A dropper only ever summoned is where its summoner is (todo 806).
      for (const by of this.realm.summonersOf(mob)) {
        for (const { room } of this.realm.spawnRoomsOf(by)) {
          add({
            kind: 'kill',
            monster: mob.name,
            room: roomId(room.map, room.room),
            summon: { by: by.name }
          });
        }
      }
      for (const id of mob.ids ?? []) {
        for (const script of this.summonScripts().get(id) ?? []) {
          add({ kind: 'kill', monster: mob.name, room: script.room, summon: { say: script.say } });
        }
      }
    }
    return found;
  }

  /** Every room where the item can be had: what `Router.fetchPrice` prices the walk to. */
  rooms(item: number): ReadonlySet<RoomId> {
    return new Set(this.of(item).map((source) => source.room));
  }

  /**
   * A room command that summons a monster, asks nothing of whoever says it
   * and moves nobody: most summoning scripts also want an item or a price,
   * and saying the phrase without them does nothing.
   */
  private summonScripts(): Map<number, Array<{ room: RoomId; say: string }>> {
    if (this.scripts !== null) return this.scripts;
    const index = new Map<number, Array<{ room: RoomId; say: string }>>();
    for (const known of this.realm.everyRoom()) {
      const room = roomId(known.map, known.room);
      for (const command of known.commands ?? []) {
        const say = command.say[0];
        if (say === undefined || command.gates !== undefined || command.to) continue;
        for (const id of command.summons ?? []) {
          const held = index.get(id);
          if (held === undefined) index.set(id, [{ room, say }]);
          else held.push({ room, say });
        }
      }
    }
    this.scripts = index;
    return index;
  }
}
