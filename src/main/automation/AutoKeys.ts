/**
 * Bending down for the key to the door in front of you.
 *
 * Reported 2026-09-06 (todo 01), standing in `Crypt, Sealed Tomb`:
 *
 *     You notice 6 silver nobles, 66 bone key, iron ring, 2 amethyst ring here.
 *     Obvious exits: closed door north, south
 *
 * The realm records that north as `Key: 177`, and 177 is `bone key`. The
 * client knew all three facts — what the door wants, what the pack holds, and
 * what is lying on the floor — and refused to route north because the pack
 * held no key, with sixty-six of them at the character's feet. *"If a key is
 * needed and the key is right there it should always pick up the key."*
 *
 * ## Why this is not the walker's, and not the route's
 *
 * A keyed edge with nothing that substitutes for the key is **pruned by the
 * router** (`edgePenalty`'s `key` case returns null once a listing has landed),
 * so there is no step for `Walker`'s barrier ladder to be refused at and no
 * route for the panel's Walk button to enable — the refusal happens before
 * either exists. The one moment the client can act is while it is standing in
 * the room, which is also the only moment the floor is a fact.
 *
 * So the trigger is the room rather than a journey: **the realm says an exit
 * of this room demands a thing, the pack does not hold it, and it is on this
 * floor.** That conjunction is rare — twenty-six items gate an exit in the
 * shipped realm — and the whole of it is one `get`.
 *
 * **It also fires for a keyed door the realm says can be picked**, which the
 * pruning argument above does not cover: `edgePenalty` prices that one rather
 * than pruning it, so a route does exist and `Walker`'s pick rung would be
 * asked. Deliberate, and the reason is `pickLocks` — off by default, so on an
 * ordinary configuration the route is planned through a door nothing will
 * open, and the character walks to it and stops. A key on the floor is one
 * command against a rung that is switched off and a skill roll that can fail.
 *
 * **No weight gate**, where `AutoLoot` has one that overrides even a name on
 * the player's own list. The bound here is the realm's rather than a
 * threshold: one row per room, only for rooms whose exits are gated, and the
 * shipped realm gates its exits on **twenty-six items in total** — so the
 * whole of what this can add to a pack over a whole realm is twenty-six
 * things, each picked up once. A ceiling on top of that would refuse the key
 * that opens the corridor to save weight the character is not carrying.
 *
 * ## What it will not do
 *
 * - **Decide on a pack nobody has listed.** `packKnown` is the same gate the
 *   router uses: an unread pack does not say the key is missing, so it does not
 *   say to pick one up either. Both halves read the *same* list of carried row
 *   ids, because two spellings of "does this character hold item 177" would
 *   agree exactly until one of them was edited.
 * - **Guess which row a name means.** The floor's spelling is resolved through
 *   `WorldGraph.itemIdNamed`, which refuses a name several rows share — the
 *   realm has three `iron key`s — so a door is never opened on a coin toss.
 * - **Ask twice in one room.** A look reprints the floor; the memory is per
 *   room and per item, exactly as `AutoLoot`'s is.
 * - **Reach for one while the character is resting**, which is `AutoLoot`'s
 *   unmeasured refusal and costs only a delay.
 *
 * `Items.Gettable` is deliberately **not** consulted, which is `AutoLoot`'s
 * position too: the realm records the refusal for 45 of its 2,639 items, and
 * the server's own answer to a `get` is both more current and bounded to one
 * command — the memory below stops it being asked twice in the same room.
 *
 * Both instructions that name an item are read, because the router reads both
 * the same way: a `Key:` lock and an `Item:` gate are one question — *is this
 * thing in the pack* — and treating them differently here would be the two
 * halves of one gate disagreeing.
 *
 * Proposes to `CommandQueue` in the `probe` band; nothing here touches a
 * socket.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import { sameItem } from '../../shared/items';
import { tuning } from '../app/tuning';

/** A thing the realm says an exit of the room being stood in demands. */
export interface KeyedWay {
  /** The `Items` row the exit names. */
  keyId: number;
  /** Which way out it is, so the sentence can say what the key is for. */
  direction: string;
  /**
   * The realm's own name for that row, where it has one.
   *
   * Carried so the *refusal* can be said. A floor entry whose name several
   * rows share resolves to no row at all, which is indistinguishable from a
   * floor entry that is simply something else — unless the name the exit wants
   * is in hand to compare against.
   */
  itemName?: string;
}

export interface KeyEvents {
  notice?(message: string): void;
  /** Whether an escape is in flight; nothing is picked up while one is. */
  escaping?(): boolean;
  /**
   * Whether anything is moving the character — a move on the wire, or a walk
   * marching. See `onCharacter`.
   */
  busy?(): boolean;
}

export interface KeySources {
  /**
   * What the realm says this room's exits demand, from the realm's own exit
   * list rather than the printed one.
   *
   * The realm's, because that is what the router plans through: it holds
   * hidden exits the server never prints, and a key picked up for a door the
   * client has not found yet is still the key the route will want.
   */
  ways(state: CharacterState): readonly KeyedWay[];
  /**
   * The `Items` rows the pack holds, and whether anything has listed it —
   * the router's own answer, not a second reading of it.
   */
  carried(state: CharacterState): { keys: number[]; packKnown: boolean };
  /** The one row a floor entry's name can mean, or null. */
  idOf(name: string): number | null;
}

export class AutoKeys {
  /** Where the last decision was taken, so leaving a room re-arms the memory. */
  private askedIn: string | null = null;
  /** The rows already asked for in this room. */
  private asked = new Set<number>();
  /** The rows already refused out loud in this room. See `sayIfAmbiguous`. */
  private said = new Set<number>();

  constructor(
    private config: MovementConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly sources: KeySources,
    private readonly events: KeyEvents = {}
  ) {}

  configure(config: MovementConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.askedIn = null;
    this.asked.clear();
    this.said.clear();
  }

  /**
   * Every state change, while the character is standing still.
   *
   * **Standing still is a correctness gate, not a courtesy.** With a move on
   * the wire the room on the books is the one being *left*, so `room.items` is
   * another room's floor — the refusal `Walker.start`, `LoopRunner.advance`
   * and `considerRetreat` all make from the same fact. And a walk marching
   * sends its step from the `movement` band while this proposes in `probe`, so
   * a `get` queued behind it would be spent in the next room, refused out loud
   * — and the per-room memory would already have been re-armed by the room
   * change, so the same key would be walked past every lap. The feature would
   * have worked standing still, which is how it was reported, and misfired on
   * every route.
   *
   * Not marked as asked when it is held: the character has not left, and the
   * next line after the walk is where this belongs.
   */
  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.collectKeys || state.phase !== 'in-game') return;
    // `AutoLoot`'s refusal, for its reason: whether `get` breaks a rest has
    // never been asked of the wire, and waiting costs only the wait.
    if (state.vitals.resting || state.vitals.meditating) return;
    // And an escape has the character. `AutoLight` stands down on the same
    // fact: a command queued in that window lands after the character has fled.
    if (this.events.escaping?.() === true) return;
    if (this.events.busy?.() === true) return;

    const here = roomKey(state);
    if (here === null) return;
    if (here !== this.askedIn) {
      this.askedIn = here;
      this.asked.clear();
      this.said.clear();
    }

    const ways = this.sources.ways(state);
    if (ways.length === 0) return;
    const pack = this.sources.carried(state);
    /*
     * An unlisted pack is not an empty one. The router refuses to call a keyed
     * door a wall on this same silence, so this refuses to bend down on it —
     * and silently, because `i` is in the default entry probe and this is a
     * state that lasts a second. A character configured never to ask on the
     * way in has every keyed door read as unevaluated by the router too; that
     * is one silence with one cause, and it is stated on `packKnown` itself.
     */
    if (!pack.packKnown) return;

    for (const way of ways) {
      if (pack.keys.includes(way.keyId) || this.asked.has(way.keyId)) continue;
      const lying = state.room.items.find((item) => this.sources.idOf(item.name) === way.keyId);
      if (lying === undefined) {
        this.sayIfAmbiguous(way, state);
        continue;
      }
      this.asked.add(way.keyId);
      this.queue.enqueue({
        command: `get ${lying.name}`,
        priority: 'probe',
        // One key per row, so a floor listed twice is one `get` and two
        // different keys on one floor are two.
        coalesceKey: `keys:${way.keyId}`,
        /*
         * The **search** window rather than the loot one, on `internal.ts`'s
         * own distinction: loot is about the floor and is worth waiting a
         * moment for, while a search — and this — is about *the room the
         * character is standing in*, so one still queued after the character
         * has walked out is asking somewhere else for something it was never
         * asked about.
         */
        expiresAt: Date.now() + tuning().search.expiresMs,
        reason: t('automation.keys.reasonNeeded', {
          item: lying.name,
          direction: way.direction
        })
      });
      /*
       * Said out loud, because this fires with auto-loot off and picking
       * something up unasked is otherwise `automation.loot`'s to decide. The
       * server's own `You took bone key.` says *what*; only this says *why*.
       */
      this.events.notice?.(
        t('automation.keys.picking', { item: lying.name, direction: way.direction })
      );
    }
  }

  /**
   * The refusal that would otherwise be invisible, and the one the header
   * names: a floor entry whose name several rows share.
   *
   * `idOf` answers null for it, which from inside the loop above is
   * indistinguishable from a floor holding nothing relevant — so the character
   * stands on an `iron key` beside a door demanding one, nothing happens, and
   * the router goes on calling that door a wall with no line anywhere saying
   * why. A refusal nobody can read did not happen.
   *
   * Compared by name against the realm's own name for the row, which is the
   * only thing that can tell the two silences apart. Once per room per row,
   * because a look reprints the floor.
   */
  private sayIfAmbiguous(way: KeyedWay, state: CharacterState): void {
    const wanted = way.itemName;
    if (wanted === undefined || this.said.has(way.keyId)) return;
    const lookalike = state.room.items.find(
      (item) => sameItem(item.name, wanted) && this.sources.idOf(item.name) === null
    );
    if (lookalike === undefined) return;
    this.said.add(way.keyId);
    this.events.notice?.(
      t('automation.keys.ambiguous', { item: lookalike.name, direction: way.direction })
    );
  }
}

/**
 * The room, as a key for the per-room memory.
 *
 * The realm's coordinates only: an unplaced room has no exit list to read a
 * requirement off, so there is nothing here to decide and nothing to remember.
 */
function roomKey(state: CharacterState): string | null {
  const { map, number } = state.room;
  return map === null || number === null ? null : `${map}/${number}`;
}
