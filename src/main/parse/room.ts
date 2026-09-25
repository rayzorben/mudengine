/**
 * The room this character stands in: the draft `Obvious exits:` completes,
 * who is in it, its doors and floor, and where on the realm it is.
 *
 * The room cluster out of `CharacterTracker` (`mudengine-wire` › *Five clusters
 * live outside the tracker*): `draft.ts` was its first piece and is its helper,
 * and todo 720 took the rest. Each room case in `reduce` keeps its line and
 * calls one function here, so the reducer's order is stated in one place. What
 * needs no memory is `state in → state out`; `RoomTracker` owns the draft and
 * reads the realm, handed the rest (`RoomSources`). The queue a room answers
 * is `expectations.ts`'s; the stealth receipt is `stealth.ts`'s, the trail `trail.ts`'s.
 */
import {
  coinNamed,
  emptyRoom,
  isBlinding,
  type Adventurer,
  type Afflictions,
  type CharacterState,
  type Room,
  type RoomExit,
  type RoomLight,
  type RoomOccupant,
  type Stealth
} from '../../shared/character';
import { addCoins } from '../../shared/coins';
import {
  wireExit,
  type CurrencyEntity,
  type ExitEntity,
  type ItemEntity
} from '../../shared/entities';
import { countedName } from '../../shared/items';
import type { Discovery } from '../../shared/memory';
import { classifyOccupant, type MobFacts } from '../../shared/mobs';
import { playerEntity, playerKey, type PlayerRegistry } from '../../shared/players';
import type { RealmFamily } from '../../shared/realm';
import type { Direction, RoomId, WorldRoom } from '../../shared/world';
import { mobKey, roomAddress, roomId } from '../../shared/world';
import { tuning } from '../app/tuning';
import { resolveByDeadReckoning, resolveRoom, type ResolveGraph } from '../world/resolve';
import type { WorldGraph } from '../world/WorldGraph';
import { RoomDraft } from './draft';
import { isPortalClaim, MOVE_COMMANDS, type Expectations } from './expectations';
import { itemList, list, parseCoinEntry } from './inventory';

/** What the wire observed about one thing, beside its name (`WorldGraph.buildItemEntity`). */
export type ItemObservation = Parameters<WorldGraph['buildItemEntity']>[1];

/** The realm as the room reads it: resolution's lookups, and the joins a placed room takes. */
export type RoomWorld = ResolveGraph &
  Pick<
    WorldGraph,
    | 'shop'
    | 'lair'
    | 'spellById'
    | 'buildNpcEntity'
    | 'buildExitEntities'
    | 'itemPlacedHere'
    | 'mob'
    | 'buildMobEntity'
  >;

/** The command queue's readers a room block answers (`expectations.ts` keeps the queue). */
export type RoomClaims = Pick<
  Expectations,
  | 'head'
  | 'shift'
  | 'takeUnmodelled'
  | 'takeTeleport'
  | 'clearLooks'
  | 'promised'
  | 'portalOwed'
  | 'answerRereadBehind'
>;

/** What the room reads from the rest of the character, handed in as `FightSources` are. */
export interface RoomSources {
  /** The realm, where one is loaded; without it a room is the wire's words and nothing more. */
  world: RoomWorld | undefined;
  /** The tracker's own queue, the one `observeCommand` writes. */
  claims: RoomClaims;
  /** The server's lineage, for a lair's clock (`CharacterTracker.useFamily`). */
  family(): RealmFamily | null;
  /** Everything known about other players, for an occupant's entity. */
  registry(): PlayerRegistry;
  /** A thing joined to the realm's row: the pack's join, so the floor and the pack agree. */
  itemEntity(name: string, observed: ItemObservation): ItemEntity;
  /** Whether a committed move kept this character unseen; spends the receipt (`stealth.ts`). */
  stealthAfterMove(): Stealth;
  /** A move landed: the trail's to record (`Trail.rememberTheWayBack`). */
  rememberTheWayBack(s: CharacterState, room: Room, moved: Direction | null): void;
  /** Told when the character proves the realm data wrong. */
  onDiscovery: ((discovery: Discovery) => void) | undefined;
}

/**
 * Spoken direction to canonical short code, longest first so `northeast` wins
 * over `north`.
 *
 * The short code is canonical everywhere — it is what the realm database uses,
 * and having two representations is what let exit-signature room resolution
 * silently never match: the parser produced `north` and the world data held
 * `n`. Display expands it again via `DIRECTION_NAME`.
 */
const SPOKEN: Array<[string, Direction]> = [
  ['northeast', 'ne'],
  ['northwest', 'nw'],
  ['southeast', 'se'],
  ['southwest', 'sw'],
  ['north', 'n'],
  ['south', 's'],
  ['east', 'e'],
  ['west', 'w'],
  ['up', 'u'],
  ['down', 'd'],
  /*
   * The server's other pair of words for the same two ways, and the exits that
   * carry them are always qualified: `Obvious exits: north, open trap door
   * below` — 20 lines across the corpus, in five captures, and never a bare
   * `below`. Read as nothing until now, so a vertical exit the server printed
   * was a direction no route could plan on and no walk could recognise as
   * found. Last, so `above`/`below` never shadow a suffix match on `up`/`down`.
   */
  ['above', 'u'],
  ['below', 'd']
];

/**
 * Separates an exit's direction from whatever qualifies it.
 *
 * `closed gate west` is a real line from the local server: the obstacle is
 * described inline, so a naive split leaves an "exit" that is not a direction
 * and cannot be pathed on.
 */
export function parseExit(entry: string): RoomExit {
  const text = entry.trim().toLowerCase();
  for (const [word, code] of SPOKEN) {
    if (text === word || text === code) return { direction: code, note: null };
    if (text.endsWith(` ${word}`)) {
      return { direction: code, note: text.slice(0, -word.length).trim() || null };
    }
  }
  // Not a direction we know. Keep it rather than dropping it — an unrecognised
  // exit is still information, and silently losing one strands a route.
  return { direction: text, note: null };
}

/**
 * The room's listed exit that way, re-noted as the server now says the door
 * stands — `closed door`, `open gate` — in the words `parseExit` would have
 * read off a reprint, so `Barriers.shutAhead` and the Room card need no second
 * reading. Null when the list never printed that exit, or the note already
 * says so.
 */
function doorNoted(
  s: CharacterState,
  direction: Direction,
  barrier: string,
  state: 'open' | 'closed'
): CharacterState | null {
  const note = `${state} ${barrier}`;
  const listed = s.room.exits.find((exit) => exit.direction === direction);
  if (listed === undefined || listed.note === note) return null;
  return {
    ...s,
    room: {
      ...s.room,
      exits: s.room.exits.map((exit) => (exit === listed ? { ...exit, note } : exit))
    }
  };
}

/**
 * `door-changed`: the door the command named (`aim`, the tracker's one slot)
 * re-noted. The stealth it costs is `StealthReceipt.broke`'s to say.
 */
export function doorChanged(
  s: CharacterState,
  aim: Direction | null,
  barrier: string | undefined,
  state: string | undefined
): CharacterState | null {
  /*
   * The door the command named stands as the server now says, whether
   * or not it did anything: `The door was already open.` is as much a
   * statement of the door as `is now open.` A pick leaves a shut door
   * shut, so `unlocked` re-notes nothing.
   */
  return aim !== null && barrier !== undefined && (state === 'open' || state === 'closed')
    ? doorNoted(s, aim, barrier, state)
    : null;
}

/** `door-swings`: a door this character did not touch, named by its direction. */
export function doorSwings(
  s: CharacterState,
  spoken: string | undefined,
  barrier: string | undefined,
  state: string | undefined
): CharacterState | null {
  const direction = MOVE_COMMANDS[spoken?.trim().toLowerCase() ?? ''];
  if (direction === undefined || barrier === undefined) return null;
  if (state !== 'opened' && state !== 'closed') return null;
  return doorNoted(s, direction, barrier, state === 'opened' ? 'open' : 'closed');
}

/**
 * `room-coins`: `18 gold drop to the ground.` — a broadcast that maintains the
 * floor between looks, the same shape every listing here follows. It used to
 * push the string `18 gold` into `room.items`, which put coins in the
 * encumbrance count and offered them as something to `get` by name.
 */
export function coinsDropped(
  s: CharacterState,
  count: number | null,
  coin: string | undefined
): CharacterState | null {
  // The drop line names the bare denomination (`18 gold`) where a
  // listing names the realm's own noun (`18 gold crowns`), so the first
  // word is what both have in common — the pack's rule, applied here.
  const denomination = coinNamed(coin ?? '');
  if (count === null || denomination === undefined) return null;
  return {
    ...s,
    room: { ...s.room, cash: addCoins(s.room.cash, denomination, count) }
  };
}

/** `player-arrives-room`: somebody walking in, kept on the list between looks. */
export function playerArrives(
  s: CharacterState,
  player: string | undefined
): CharacterState | null {
  if (!player || s.room.occupants.some((who) => who.name === player)) return null;
  /*
   * A *player*, said outright rather than classified.
   *
   * `<Name> walks into the room from the east.` is composed in
   * `Player.cs` and nowhere else; a monster's arrival comes out of
   * `MobType.MoveMessage`, which is realm data and reads nothing like
   * this (docs/greatermud/messages.md — the text is data, not code). So
   * the sentence itself is the statement, and running it through the
   * classifier would only be able to weaken it: somebody who has not
   * appeared in a listing yet has a capitalised name and nothing else,
   * which is precisely the `unknown` case.
   */
  const arrival: RoomOccupant = {
    name: player,
    kind: 'player',
    disposition: null,
    uncertain: false,
    costly: 'never',
    charmed: false,
    hidden: false,
    free: false
  };
  return { ...s, room: { ...s.room, occupants: [...s.room.occupants, arrival] } };
}

/** `player-leaves-room`: somebody walking out, taken off the list between looks. */
export function playerLeaves(s: CharacterState, player: string | undefined): CharacterState | null {
  if (!player || !s.room.occupants.some((who) => who.name === player)) return null;
  return {
    ...s,
    room: { ...s.room, occupants: s.room.occupants.filter((who) => who.name !== player) }
  };
}

/**
 * `user-search-failed`: `Your search revealed nothing.` — the same listing,
 * empty, clearing what `hidden` set and `exits` carries across a reprint.
 */
export function searchFoundNothing(
  s: CharacterState,
  direction: string | undefined
): CharacterState | null {
  if (direction !== undefined) return null;
  if (s.room.hidden.length === 0 && s.room.hiddenCash === null) return null;
  return { ...s, room: { ...s.room, hidden: [], hiddenCash: null } };
}

/**
 * The name in an arrival sentence the realm data could not resolve.
 *
 * `A large lashworm crawls into the room from the above!` leaves
 * `large lashworm crawls`, and the last word is the finite verb — that is
 * positional grammar rather than a verb list, which is the thing
 * docs/greatermud/messages.md forbids: English puts the verb immediately before
 * `into the room from`, whatever word the realm chose for it.
 *
 * A last resort, used only when neither the room nor the realm's monster table
 * could say. It can be wrong — a two-word verb phrase leaves a word on the
 * name — and both consequences of being wrong are bounded: the next `Also
 * here:` replaces the list outright, and a name nothing recognises carries no
 * disposition, so it is never something the client opens a fight with.
 */
function trimVerb(middle: string): string {
  const words = middle.trim().split(/\s+/).filter(Boolean);
  return words.length <= 1 ? '' : words.slice(0, -1).join(' ');
}

/**
 * Whether a room block that printed these exits cannot be this realm room.
 *
 * The one comparison between a printed exit list and the realm's that is sound
 * in a single direction. The realm records exits the server does **not** print
 * — 249 of them are `Hidden/Searchable` — so the printed set is a subset of
 * the realm's and never an equal of it. Asking for equality is what made an
 * earlier exit-signature guard read every real arrival as a reprint.
 *
 * Asked as a refusal, it holds: an exit on the screen that the realm does not
 * record for that room means the block describes somewhere else. An exit the
 * realm has and the screen does not proves nothing, and is ignored.
 *
 * An exit word the parser did not recognise is ignored for the same reason it
 * is kept on the room: it is information, not evidence, and refusing a room
 * over a word this client cannot read would be the client blaming the realm
 * for its own gap.
 */
function cannotBe(room: WorldRoom, printed: readonly RoomExit[]): boolean {
  const known = new Set<string>(room.exits.map((exit) => exit.direction));
  return printed.some(
    (exit) => MOVE_COMMANDS[exit.direction] !== undefined && !known.has(exit.direction)
  );
}

/**
 * What a confirmed step says about being held: that the character is not.
 *
 * The one release that needs no sentence. Every hold ends in the realm's own
 * words and the client reads twenty-two of them, but a realm is free to ship a
 * twenty-third — and a `held` flag with no ending stands a route and a lap
 * still for the rest of the session, which is the failure the whole
 * three-state vocabulary exists to avoid. `Exits.Move` refuses a held
 * character before anybody moves anywhere, so a step that *landed* is proof
 * the hold was over, whoever caused the step and whatever the wire said about
 * it.
 *
 * Only `held`: a blind character walks, a poisoned one walks, and arriving
 * somewhere says nothing about either.
 */
function stoodUp(s: CharacterState): Afflictions {
  return s.afflictions.held === 'yes' ? { ...s.afflictions, held: 'no' } : s.afflictions;
}

/**
 * The room being assembled, and the lookups that turn the wire's words into
 * the realm's rows. One call per room case in `CharacterTracker.reduce`, and
 * two readings of the occupants other cases need: `withOccupant` (the fight's)
 * and `rereadOccupants` (a `who`'s).
 */
export class RoomTracker {
  /** The room being assembled; promoted to `state.room` when exits arrive. */
  private readonly draft = new RoomDraft();
  private readonly world: RoomWorld | undefined;
  /** The queue the commands sent wait on: consumed in the order the server answers, never queued, here. */
  private readonly expect: RoomClaims;
  private readonly onDiscovery: ((discovery: Discovery) => void) | undefined;

  constructor(private readonly sources: RoomSources) {
    this.world = sources.world;
    this.expect = sources.claims;
    this.onDiscovery = sources.onDiscovery;
  }

  /** `room-name`: a new draft. See `RoomDraft.begin`. */
  begin(name: string | null): void {
    this.draft.begin(name);
  }

  /** `room-description`: a line of prose into the draft. See `RoomDraft.describe`. */
  describe(text: string): void {
    this.draft.describe(text);
  }

  /** `room-items`: the open floor, into the draft. */
  items(text: string | undefined): void {
    /*
     * One comma-separated line mixing things and coins, exactly as the
     * pack listing does — so it is split the same way, on commas and
     * **not** on `and`: `You notice … 2 rope and grapple, 2 mine pass …`
     * is one item and not two (`captures/119`). See `itemList`. Coins fold
     * into `room.cash` rather than joining the item list: `18 gold` among
     * the items lands in the paste of what is lying here and reads as
     * something to `get` by name.
     */
    const floor = this.floorListing(text);
    this.draft.items(floor.items);
    // A listing is authoritative and replaces what is there — including
    // saying there are no coins, which a fold could not.
    this.draft.cash(floor.cash);
  }

  /** `room-hidden-items`: a search's finds, onto the published room. */
  hidden(s: CharacterState, text: string | undefined): CharacterState {
    const floor = this.floorListing(text);
    return { ...s, room: { ...s.room, hidden: floor.items, hiddenCash: floor.cash } };
  }

  /** `room-also-here`: the occupants, classified and hydrated, into the draft. */
  alsoHere(s: CharacterState, text: string | undefined): void {
    this.draft.occupants(this.hydrate(this.classify(list(text), s.online), s));
  }

  /**
   * `room-exits`: the draft completed, answered against the queue, placed on
   * the realm and published — or, for a peek, published as another room.
   */
  exits(s: CharacterState, text: string | undefined, at: number): CharacterState {
    // Exits complete a room. Everything before this was provisional.
    const exits = list(text).map(parseExit);
    const room = this.draft.complete(this.exitEntities(exits, null));

    let expectation = this.expect.head();
    /*
     * The client asked for this one, so nothing about the room has to be
     * guessed at: a bare Enter and a bare `look` reprint where the
     * character is standing, and the block that answers one is not the
     * answer to a move queued behind it.
     *
     * This is the guard below made unnecessary for the case it cannot
     * settle. That one asks the realm data whether the block *can* be the
     * room the pending move predicts, and in a corridor of namesakes
     * printing a subset of the destination's exits the honest answer is
     * *maybe* — which is why the walker's own nudge, sent one second into
     * a stalled step and answered in the same packet as the step
     * (`2026-09-02_18-07-07_festus.mudcap.jsonl`, t=4862445), was read as
     * the arrival of the step the first block had just released. The walk
     * sent `e` twice inside three milliseconds and ran a room ahead of the
     * character from then on. Consumed here and then treated exactly as an
     * unattributed reprint, which is what it is.
     */
    if (expectation?.kind === 'reread') {
      this.expect.shift();
      expectation = null;
    }
    // A scripted teleport the walker hinted: no exit leads there, its script says where.
    const portal = isPortalClaim(expectation);
    /*
     * A reprint of the room you are standing in is not the answer to a
     * move. The server reprints the current room unasked — measured live:
     * the sewer fight ended, the room printed again, the reprint consumed
     * the `e` that was still in flight, and the *real* arrival then had no
     * expectation, fell back to name matching among 293 Sewer Tunnels, and
     * a known location died of a courtesy. So a block whose name is the
     * room already resolved, when the pending move predicts somewhere with
     * a *different* name, leaves the queue alone: the move's answer is
     * still coming. A corridor of namesakes (Sewer Tunnel to Sewer Tunnel)
     * is indistinguishable from a reprint and is consumed as an arrival,
     * which is today's behaviour and the safer bias.
     */
    if (
      expectation?.kind === 'move' &&
      this.world &&
      room.name &&
      s.room.map !== null &&
      s.room.number !== null
    ) {
      const direction = expectation.direction;
      const here = this.world.byId(roomId(s.room.map, s.room.number));
      const hereName = here?.name.trim().toLowerCase();
      if (hereName !== undefined && hereName === room.name.trim().toLowerCase()) {
        const exit = here?.exits.find((entry) => entry.direction === direction);
        /*
         * A portal's destination is the one its script stated (todo 808), so
         * a reprint of the room being left is read as the step not having
         * landed yet, and the promise waits for the room that has.
         */
        const promised = portal ? this.expect.promised : null;
        const to = promised ?? (exit ? { map: exit.map, number: exit.room } : null);
        const destination = to ? this.world.byId(roomId(to.map, to.number)) : null;
        const destinationName = destination?.name.trim().toLowerCase();
        if (destinationName !== undefined && destinationName !== hereName) {
          expectation = null;
        } else if (
          here !== undefined &&
          destination !== undefined &&
          destination !== null &&
          cannotBe(destination, exits) &&
          !cannotBe(here, exits)
        ) {
          /*
           * The names tie — a corridor of namesakes — and the exits settle
           * it anyway, because **83.85% of this realm's edges lead to a
           * room with the origin's name** and a guard that only reads
           * names is therefore blind on almost every step.
           *
           * Asked as a refusal in both directions rather than as a match,
           * which is what the earlier exit-signature attempt got wrong: it
           * compared the printed set with the destination's realm set for
           * *equality*, and the realm's set includes hidden exits the
           * server never prints, so every real arrival looked like a
           * mismatch. What is sound is the subset — the server can only
           * print exits the realm has — so a block printing an exit the
           * destination does not have cannot be the destination. Both
           * halves are required: the block must also be consistent with
           * standing here, so realm data too stale to place the arrival
           * falls through to the old bias instead of answering wrongly.
           *
           * Settles 64.7% of the namesake edges the name guard cannot,
           * taking the blind spot from 83.85% of edges to 29.6%.
           */
          expectation = null;
        }
        /*
         * When the exits tie as well the move is consumed as an arrival,
         * which is today's behaviour and the safer bias: a true namesake
         * reprint of a room whose exits also match mis-anchors by one
         * step, and the next room block that does not fit re-derives.
         */
      }
    }
    // Not landed, so an Enter sent behind the portal is what this block answers.
    if (portal && expectation === null) this.expect.answerRereadBehind();
    // The claim this block answers, kept: a cast exit's second block
    // carries the landing it has to be resolved inside (`hintCast`).
    const answered = expectation !== null ? this.expect.shift() : null;
    /*
     * Whatever was last said that this client does not model as movement,
     * taken here and cleared here: this room is the answer to it, and the
     * next room is the answer to something else. Held only while the
     * expectation queue is empty — a room that answers a queued direction
     * was caused by that direction, not by the `pull lever` before it.
     */
    const said = this.expect.takeUnmodelled(expectation === null);

    /*
     * A look in a direction describes somewhere else.
     *
     * `l n` prints the room to the north in full — name, description,
     * occupants, `Obvious exits:` — and nothing about it says it is not
     * where you are standing. Applying it moved the character into the
     * neighbouring room without a step being taken, and every route planned
     * afterwards started from the wrong place.
     *
     * The block still reaches every other consumer as a fact; it is only
     * the *character's* room that must not change. This is `Room.coffee`'s
     * `wasLooking` guard, which returns before any of the room handling.
     */
    if (expectation?.kind === 'peek') {
      this.draft.discard();
      /*
       * Published as *another* room, never as this one: `RestAway` reads
       * what stands next door before stepping there (todo 08). The
       * direction is the peek's own command (`l n`), and a peek nothing
       * can direct is published with none.
       */
      const target = expectation.command?.split(/\s+/)[1];
      const direction = target === undefined ? null : (MOVE_COMMANDS[target] ?? null);
      return { ...s, peeked: { direction, room, at } };
    }

    /*
     * Two facts, not one, since portals: a scripted teleport is queued as
     * a move with **no direction** (`hintTeleport`), so "did anything
     * move the character" and "which way" separated. Every guard below
     * that used `moved === null` to mean *nothing moved* reads
     * `movedSomehow` now — a portal arrival read as "still standing where
     * we were" kept a location across a teleport to the far side of the
     * realm.
     */
    const movedSomehow = expectation?.kind === 'move';

    /*
     * And the count of arrivals, moved by the same fact and published so
     * that something other than this file can tell an arrival from a
     * reprint — see `Room.arrival`. Here, above every return, for the
     * reason `stealth` and `combat` below are: the room object is rebuilt
     * from the draft and a count left off one route out of this case is a
     * count that silently stops moving.
     */
    room.arrival = s.room.arrival + (movedSomehow ? 1 : 0);

    /*
     * And whether the character is still unseen, computed here for the
     * reason `combat` below is: ahead of the early returns, so every way
     * out of this case agrees about it and none of them can forget.
     *
     * It has to be read *before* the returns for a second reason the fight
     * does not have — `stealthAfterMove` clears the flag, so calling it at
     * each return would make the first one that fired the only one that
     * worked.
     */
    const stealth = movedSomehow ? this.sources.stealthAfterMove() : s.stealth;

    /*
     * What a search turned up here, carried across a reprint of the same
     * room.
     *
     * The room object is rebuilt from the draft on every block, so
     * anything the *wire* will not say again has to be carried or it is
     * simply gone. `items` needs no carrying because the server reprints
     * `You notice …` on every look; this is precisely the fact that it
     * does **not** — a bare Enter after a search reprints the room with no
     * listing at all, which is the evidence the second floor was built on.
     * So the reprint the evidence came from was the reprint that erased
     * it: `automation.idle` sends one every 45 seconds by default,
     * `refreshRounds` re-reads the room and a loop queues an `rm` on every
     * `*Combat Off*` — the Hidden row vanished while the character stood
     * still, and said nothing.
     *
     * **Here rather than in `sameRoomAgain` below**, which is where this
     * was first written and which is wrong twice: that branch needs a
     * loaded realm *and* an already-resolved position, so a derivative
     * realm, an unplaced character and every test without world data all
     * kept losing it. The test of "same room" this needs is weaker and
     * exact for the purpose — **no move was consumed and the name is
     * unchanged** — and it sits above every return path in this case, so
     * no route through can skip it. A move consumed means the character is
     * somewhere else, which is what keeps a `Sewer Tunnel` from handing
     * its discoveries to the next `Sewer Tunnel`.
     */
    if (
      !movedSomehow &&
      room.name !== null &&
      s.room.name !== null &&
      room.name.trim().toLowerCase() === s.room.name.trim().toLowerCase()
    ) {
      room.hidden = s.room.hidden;
      room.hiddenCash = s.room.hiddenCash;
    }
    const moved = expectation?.kind === 'move' ? expectation.direction : null;

    /*
     * A step taken leaves the fight's participants behind. `attackers`
     * used to survive the move, and the first state change in the new
     * room read the old room's monster as something still swinging —
     * retaliation attacked it from a room it is not in, the server said
     * `Your command had no effect.`, and the wasted ask armed the engage
     * cooldown that then delayed the *real* fight on walking back in
     * (captured live, 2026-08-26). `*Combat Off*` does this when the
     * server ends a fight; a move while merely being attacked is the case
     * where no Off ever comes. A portal is a move — computed here, ahead
     * of the early returns, so a teleport-resolved arrival leaves them
     * behind too.
     */
    const combat =
      movedSomehow && (s.combat.attackers.length > 0 || s.combat.target !== null)
        ? { ...s.combat, attackers: [], target: null, health: null }
        : s.combat;
    // The same move, read for the other thing it proves — see `stoodUp`.
    const afflictions = movedSomehow ? stoodUp(s) : s.afflictions;

    /*
     * A room block that carries no name.
     *
     * The name has no marker of its own — it is a title-cased line before
     * the description — so any line the classifier does not recognise as
     * one leaves the draft nameless, and `Obvious exits:` then completes a
     * room with nothing to look up. Wiping the location at that point was
     * the bug behind "I walk one room and the map goes blank": the client
     * knew exactly where it was, failed to parse a street corner's name,
     * and threw away a certainty because of a parse miss.
     *
     * Nothing moved, so nowhere changed. Where we were is where we are.
     * Only a room that arrives *after a move* may honestly report that it
     * does not know.
     */
    if (!room.name && !movedSomehow && s.room.map !== null && s.room.number !== null) {
      room.name = s.room.name;
      room.map = s.room.map;
      room.number = s.room.number;
      room.resolvedBy = s.room.resolvedBy;
      room.confidence = s.room.confidence;
      room.ambiguous = s.room.ambiguous;
      room.candidates = s.room.candidates;
      // The realm join, for the reason the `sameRoomAgain` branch below
      // states: the room object is new on every block, so what the realm
      // knows has to be hung off it again or it is simply gone.
      this.attachRealm(room);
      this.draft.discard();
      return { ...s, room, stealth };
    }

    // Only a landing spends the promise: a block that answered a portal's claim, or one with
    // no portal owed. A retried portal's first landing is the first (todo 763).
    const teleported =
      this.world && room.name && (isPortalClaim(answered) || !this.expect.portalOwed)
        ? this.expect.takeTeleport()
        : null;
    if (this.world && room.name && teleported !== null) {
      const there = this.world.byId(roomId(teleported.map, teleported.number));
      const said = teleported;
      if (there && there.name.trim().toLowerCase() === room.name.trim().toLowerCase()) {
        room.map = said.map;
        room.number = said.number;
        room.resolvedBy = 'coordinates';
        room.confidence = 1;
        room.ambiguous = 0;
        room.candidates = [];
        // Same again, and it matters most here: a portal arrival with no
        // destinations on its exits leaves the escape's `doubles-back` and
        // `known` rungs with nothing to read in a room nobody has walked
        // to before.
        this.attachRealm(room);
        this.draft.discard();
        return { ...s, room, combat, afflictions, stealth };
      }
    }

    if (this.world && room.name) {
      const previous =
        s.room.map !== null && s.room.number !== null ? roomId(s.room.map, s.room.number) : null;

      /*
       * A second look at the room you are already standing in does not
       * change where you are.
       *
       * Re-deriving on every room block *loses* information, because the
       * ladder can only return what a name and an exit list support. Ask
       * the realm `pro`, learn `Location: 1,2147` — certainty — then type
       * `l`, and the same room comes back resolved by unique name, or
       * reported as ambiguous among thirteen Town Gates when the client
       * knew the answer exactly a moment ago.
       *
       * Carried forward only when the previous belief actually identified a
       * room and nothing has moved since. An ambiguous belief is re-derived
       * as before: there is nothing there worth keeping.
       */
      const anchor = !movedSomehow && previous !== null ? this.world.byId(previous) : null;
      // Checked against the *realm data* at those coordinates, not against
      // the name parsed last time: `pro` states a location and no name at
      // all, so comparing parsed names would fail on the very first look
      // after asking — which is the case this exists for.
      /*
       * And the printed exits have to be consistent with standing there,
       * because the name alone is blind: 83.85% of this realm's edges lead
       * to a room with the origin's name, so a block arriving with no move
       * on the queue is not therefore a re-look. A move the client *gave
       * up on* is the case (`Expectations.expire`): the server took 8,175ms
       * to answer a loop's `w` out of Dark Cave 1/865, the claim lapsed at
       * `staleMoveMs` on the line before its own answer, and the room that
       * then arrived — `Dark Cave`, `Obvious exits: east`, which is 1/866 —
       * was carried forward as 1/865 (exits west, southeast) on the
       * strength of its name. Every idle reprint that night printed the
       * same exits and re-affirmed the same wrong room, so no later fact
       * could correct it; the loop planned `w` out of a room whose only
       * exit is east, was refused three times, and stopped, and the
       * character stood in the lair until morning
       * (`2026-09-04_22-01-13_festus.mudcap.jsonl`, t=24430802).
       *
       * The test is the same one-sided subset the move guard above makes:
       * the server can only print exits the realm has, so a block printing
       * one the anchored room lacks cannot be that room, whatever the name
       * says. A re-look that fits keeps its certainty; one that does not
       * falls through to `resolveRoom`'s neighbour rung, which is the rung
       * for exactly this — something moved the character and no queued
       * direction says which way.
       */
      const sameRoomAgain =
        anchor !== undefined &&
        anchor !== null &&
        anchor.name.trim().toLowerCase() === room.name.trim().toLowerCase() &&
        !cannotBe(anchor, exits);

      if (sameRoomAgain) {
        room.map = s.room.map;
        room.number = s.room.number;
        room.resolvedBy = s.room.resolvedBy;
        room.confidence = s.room.confidence;
        room.ambiguous = 1;
        room.candidates = s.room.candidates;
        /*
         * And the realm's own answers about it, which this path used to
         * return without.
         *
         * The room is rebuilt from the wire on every block — `complete()`
         * hands back exits with no destinations, no shop, no lair, no room
         * script — and `attachRealm` at the bottom of this case is what
         * fills them in once the room is placed. This early return skipped
         * it, so **a second look at the room you are standing in stripped
         * everything the realm knew about it**: the Room card's exits lost
         * where they went, the shop and the lair vanished, and the escape's
         * `known` rung went quiet in a room the realm could place perfectly
         * well. Found by the test for that rung, which resolved 1/3 and
         * then took the printed exit as though nothing were known about it.
         *
         * Placement is carried forward here rather than re-derived, which
         * is what this branch is *for*; the realm join is not a belief and
         * has to be redone, because the object it hangs off is new.
         */
        this.attachRealm(room);
        this.draft.discard();
        return { ...s, room, stealth };
      }

      /*
       * A cast exit's landing, where the claim this block answers carried
       * one. It replaces the previous room and the direction rather than
       * joining them — see `ResolveInput.among` — because this is the
       * *second* of the two blocks such an exit prints and the first one
       * was the room the table names.
       */
      const located = resolveRoom(this.world, {
        name: room.name,
        exits: exits.map((exit) => exit.direction as Direction),
        ...(answered?.kind === 'move' && answered.landing !== undefined
          ? { among: answered.landing }
          : { previous, moved })
      });

      // What it considered, and which one it took. Bounded: a name shared
      // by thirty rooms is interesting as a count, not as a list.
      room.candidates = located.candidates
        .slice(0, tuning().parse.maxRoomCandidates)
        .map((candidate) => ({
          map: candidate.map,
          room: candidate.room,
          name: candidate.name,
          chosen: candidate.map === located.room?.map && candidate.room === located.room?.room
        }));

      if (located.room) {
        room.map = located.room.map;
        room.number = located.room.room;
        room.resolvedBy = located.method === 'none' ? null : located.method;
        room.confidence = located.confidence;
        room.ambiguous = 1;
      } else {
        // Ambiguous or unknown: report how many candidates remain rather
        // than picking one. A confidently wrong location sends the
        // pathfinder somewhere else entirely.
        room.ambiguous = located.candidates.length;
        room.confidence = located.confidence;
      }

      /*
       * **A teleport is not a way somebody found.** The second block an
       * exit whose cast moves you prints is the realm doing exactly what
       * its own data says, along no edge at all — so there is no edge to
       * record, and recording one wrote a permanent `Discovery` of a way
       * the realm describes in full into the character's file. 49 exits
       * on each shipped realm, and none of them walked until the router
       * learned where they land.
       */
      if (answered?.kind !== 'move' || answered.landing === undefined) {
        this.notice(s.room, room, moved ?? said, located.candidates.length);
      }
    }

    /*
     * The realm's own answers about this room, attached now.
     *
     * `resolveRoom` had the `WorldRoom` in its hand and threw it away,
     * keeping the coordinates alone — so every question beyond *where am
     * I* (is there a shop, is this a lair, what does that exit want, who
     * lives here) became a separate IPC call the Room card made from a
     * React effect *after* it had already drawn once without the answer.
     * Doing it here costs a lookup the resolver has already done.
     *
     * The exits are rebuilt rather than merged: they completed the room
     * before it was placed, so they had no destinations to carry.
     */
    this.attachRealm(room);
    this.sources.rememberTheWayBack(s, room, moved);

    this.draft.discard();
    // `combat` and `stealth` are both computed above, ahead of the early
    // returns, so every way out of this case agrees about the fight and
    // about whether this character is still unseen.
    return { ...s, room, combat, afflictions, stealth };
  }

  /** `room-light`: a phrase annotating the room, or a blinding one standing for it. */
  light(s: CharacterState, text: string | undefined): CharacterState | null {
    const light = (text ?? null) as RoomLight | null;
    if (light === null) return null;

    if (!isBlinding(light)) {
      if (s.room.light === light) return null;
      return { ...s, room: { ...s.room, light } };
    }

    const arrival = this.arrivedUnseen(s, 'dark');
    if (arrival === null) {
      // Not an arrival: a `look` in a room already known to be dark, or a
      // repaint. The room stands; only the phrase is news.
      return s.room.light === light ? null : { ...s, room: { ...s.room, light } };
    }
    return { ...arrival, room: { ...arrival.room, light } };
  }

  /** `mob-arrives-room`: a monster walking in, classified as `Also here:` would be. */
  mobArrives(
    s: CharacterState,
    attacker: string | undefined,
    line: string | undefined
  ): CharacterState | null {
    const named = attacker ?? trimVerb(line ?? '');
    if (named.length === 0) return null;
    if (s.room.occupants.some((who) => mobKey(who.name) === mobKey(named))) return null;
    const [arrival] = this.classify([named], s.online);
    if (arrival === undefined) return null;
    return { ...s, room: { ...s.room, occupants: [...s.room.occupants, arrival] } };
  }

  /**
   * An arrival the server would not describe, whichever of the two reasons it
   * had for not describing it.
   *
   * Two sentences produce this: `The room is pitch black - you can't see
   * anything`, where the *room* cannot be described, and `You are blind.`,
   * where the *character* cannot read one. Neither carries a name, a
   * description, occupants or exits, so nothing further down `reduce` would
   * ever complete the room they stand for, and both are the answer to a
   * command the client sent.
   *
   * Returns `null` when the head of the queue is not a move — a look in a room
   * already known to be dark, a peek down an exit, a repaint after a bare
   * Enter. The expectation is still **shifted** in that case: the sentence is
   * that command's answer whether or not it moved the character, and leaving a
   * consumed peek on the queue is how the next real room comes to be resolved
   * against the wrong exit.
   *
   * Otherwise it is an arrival, and it does what a described room does: the
   * draft goes, the fight's participants are left behind, the looks and the
   * unmodelled command were about the room just *left*, and dead reckoning
   * says where here is — the only method available, since there is no name to
   * check and 98% of the realm's dark rooms share theirs with another anyway.
   *
   * The two callers differ in one place and it is inside
   * `resolveByDeadReckoning`: a dark room is corroborated by the realm data
   * agreeing the destination is dark, and a blinded character has nothing to
   * corroborate. The light belongs to the caller for the same reason — only
   * the dark sentence states one.
   */
  arrivedUnseen(s: CharacterState, unseen: 'dark' | 'blind'): CharacterState | null {
    const expectation = this.expect.shift();
    if (expectation === null || expectation.kind !== 'move') return null;

    const previous =
      s.room.map !== null && s.room.number !== null ? roomId(s.room.map, s.room.number) : null;
    const located =
      this.world && previous !== null && expectation.direction
        ? resolveByDeadReckoning(this.world, {
            previous,
            moved: expectation.direction,
            unseen
          })
        : null;

    /*
     * A scripted teleport into the dark — 46 of the shipped realm's 60
     * routable portals land in one (`go vortex`, `jump pit`). The script
     * states the coordinates and the realm must agree the destination is
     * dark, exactly the refusal dead reckoning makes; consumed either way,
     * because the server answers in order and this room is that command's
     * answer whatever the data says about it.
     */
    const promised = this.world ? this.expect.takeTeleport() : null;
    /*
     * A cast exit's landing is on the claim, so it went with `shift()` above
     * and there is nothing to spend here. Where it named **one** room the
     * answer is exact even unseen — the same standing a `sys go`'s
     * coordinates have — and where it named several a room nobody could see
     * states neither a name nor exits, which are the only two things a draw's
     * rooms can be told apart by. Not knowing is then the answer, and the walk
     * asks (`rm`).
     */
    const drawn = expectation.landing;
    const exact =
      drawn !== undefined && drawn.length === 1 ? (this.world?.byId(drawn[0]!) ?? null) : null;
    const landed = promised ? this.world?.byId(roomId(promised.map, promised.number)) : null;
    const arrived =
      exact ??
      (landed !== null && landed !== undefined && landed.light !== undefined && landed.light < 0
        ? landed
        : null);

    this.draft.discard();
    // An arrival nothing described: the looks and the unmodelled command were
    // about the room just left.
    this.expect.clearLooks();
    this.expect.takeUnmodelled(false);
    const combat =
      s.combat.attackers.length > 0 || s.combat.target !== null
        ? { ...s.combat, attackers: [], target: null, health: null }
        : s.combat;
    // A step that landed is the one proof a hold has passed that needs no
    // sentence to read — see `stoodUp`.
    const afflictions = stoodUp(s);

    const room: Room = emptyRoom();
    if (arrived) {
      room.map = arrived.map;
      room.number = arrived.room;
      room.name = arrived.name;
      // The script stated the coordinates: the one source that is not
      // inference, same as `Location:` and a `sys go`.
      room.resolvedBy = 'coordinates';
      room.confidence = 1;
      room.ambiguous = 1;
      room.candidates = [
        { map: arrived.map, room: arrived.room, name: arrived.name, chosen: true }
      ];
    } else if (located?.room) {
      room.map = located.room.map;
      room.number = located.room.room;
      room.name = located.room.name;
      room.resolvedBy = 'dead-reckoning';
      room.confidence = located.confidence;
      room.ambiguous = 1;
      room.candidates = [
        { map: located.room.map, room: located.room.room, name: located.room.name, chosen: true }
      ];
    } else if (located) {
      // The realm data named a destination and called it lit. Keep it as the
      // candidate that was ruled out rather than dropping the working.
      room.ambiguous = located.candidates.length;
      room.candidates = located.candidates
        .slice(0, tuning().parse.maxRoomCandidates)
        .map((candidate) => ({
          map: candidate.map,
          room: candidate.room,
          name: candidate.name,
          chosen: false
        }));
    }

    /*
     * The realm's answers about it, and the way back out of it — the same two
     * things the lit path does, and this path did neither.
     *
     * A dark arrival that dead reckoning *placed* is a room the client knows
     * exactly as well as a described one; all it is missing is the server's
     * prose. Skipping the join left its exits with no destinations, and
     * skipping the trail left the escape with nothing to retrace in the one
     * place a character most needs it: 46 of the shipped realm's 60 routable
     * portals land in the dark, and a dark room prints no exits at all, so
     * every rung of `Travel.wayOut` went quiet at once and the escape
     * had to refuse. The way in was the single thing the client did know, and
     * it was being thrown away here.
     */
    this.attachRealm(room);
    this.sources.rememberTheWayBack(s, room, expectation.direction);

    /*
     * A move in the dark breaks stealth exactly as a lit one does, and the
     * server prints `Sneaking...` for it just the same — the line comes out of
     * `MoveCommand` before any room description, so it arrives whether or not
     * the room that follows can be seen or placed.
     */
    return { ...s, room, combat, afflictions, stealth: this.sources.stealthAfterMove() };
  }

  /**
   * The room, with one more name in it if it was not there already.
   *
   * The maintained half of the room listing: a command establishes who is
   * here, and the sentences the server volunteers keep it true until the next
   * one. Matched on `mobKey` rather than on the printed name, because the two
   * sources are written by different parts of the server and need not agree on
   * the article — which is the trap the carried-items list already fell into
   * once. Injected into `FightTracker` as its `withOccupant`: a blow puts its
   * attacker in the room, and classifying the name asks the realm's monster
   * table and the roster, which live here.
   */
  withOccupant(state: CharacterState, name: string): Room {
    const key = mobKey(name);
    if (key.length === 0) return state.room;
    if (state.room.occupants.some((who) => mobKey(who.name) === key)) return state.room;
    const [entry] = this.classify([name], state.online);
    if (entry === undefined) return state.room;
    return { ...state.room, occupants: [...state.room.occupants, entry] };
  }

  /**
   * `who-list`: the room's occupants read again against a fresh roster.
   *
   * Hydrated again, because `reclassify` returns what
   * `classifyOccupant` answers and that shape carries no entity:
   * a `who` listing was silently dropping the realm's row from
   * every monster in the room, and `Also here:` routinely arrives
   * before the first listing. Re-derived rather than carried
   * across, since the listing may also have just turned a monster
   * into a person.
   */
  rereadOccupants(s: CharacterState, roster: Adventurer[]): RoomOccupant[] {
    return this.hydrate(this.reclassify(s.room.occupants, roster), {
      ...s,
      online: roster
    });
  }

  /**
   * The same, over occupants already classified, when the roster has changed.
   *
   * The *name* is re-run rather than the raw entry, because the annotations
   * were stripped when it was first read and re-attaching them to hand back to
   * a parser would be inventing text the server never sent. They are carried
   * across instead: they are facts about that entry and a listing arriving
   * later says nothing about them.
   */
  private reclassify(
    occupants: readonly RoomOccupant[],
    roster: readonly Adventurer[]
  ): RoomOccupant[] {
    const players = new Set(roster.map((entry) => entry.name.toLowerCase()));
    return occupants.map((who) => {
      const fresh = classifyOccupant(who.name, { players, mob: (name) => this.mobFacts(name) });
      return {
        ...fresh,
        // A charmed monster stays a monster whatever a listing says, and a
        // player marked free-to-attack stays one. Both were read off the line.
        kind: who.charmed ? 'mob' : who.free || who.hidden ? 'player' : fresh.kind,
        charmed: who.charmed,
        hidden: who.hidden,
        free: who.free
      };
    });
  }

  /** Each classified occupant with the realm's row or the player's record hung off it. */
  private hydrate(occupants: RoomOccupant[], s: CharacterState): RoomOccupant[] {
    return occupants.map((occupant) => {
      if (occupant.kind === 'mob') return this.asRowHere(occupant, roomAddress(s.room));
      if (occupant.kind === 'player') {
        const key = playerKey(occupant.name);
        const listed = s.online.find((entry) => playerKey(entry.name) === key) ?? null;
        return {
          ...occupant,
          player: playerEntity(occupant.name, {
            record: this.sources.registry()[key] ?? null,
            roster: listed,
            hidden: occupant.hidden === true,
            free: occupant.free === true,
            inParty: s.party.members.some((member) => playerKey(member.name) === key),
            // The worn kit a `look` printed, priced by the realm where it can.
            equip: (item) => this.sources.itemEntity(item.name, { slot: item.slot, equipped: true })
          })
        };
      }
      // `unknown` is left alone on purpose: a named NPC and a person nobody
      // has listed look identical, and attaching either entity to one would
      // be the reassuring guess this classification exists to refuse.
      return occupant;
    });
  }

  /** The room is done with — completed, superseded, or left behind. */
  discard(): void {
    this.draft.discard();
  }

  /**
   * Which of the two kinds each entry of `Also here:` is.
   *
   * The realm data is reached through `this.world`, which is why this lives
   * here rather than beside the pure classifier: `classifyOccupant` is
   * dependency-free and takes a lookup, and the graph is a main-process thing.
   *
   * A character with no realm at all — the anonymous session, every unit test
   * that does not pass one — still gets a useful answer: the roster and the
   * listing's own annotations both work without it, and the capitalisation
   * heuristic is what the `mobs` guard field has always been.
   */
  private classify(entries: readonly string[], roster: readonly Adventurer[]): RoomOccupant[] {
    const players = new Set(roster.map((entry) => entry.name.toLowerCase()));
    return entries.map((entry) =>
      classifyOccupant(entry, { players, mob: (name) => this.mobFacts(name) })
    );
  }

  /** The realm's monster table as `classifyOccupant` asks it: both readings share it. */
  private mobFacts(name: string): MobFacts | undefined {
    const known = this.world?.mob(name);
    return known === undefined
      ? undefined
      : {
          disposition: known.disposition,
          uncertain: known.uncertain,
          costly: known.costly
        };
  }

  /**
   * What the realm knows about a room that has just been placed.
   *
   * Mutates the room being built, which is what every other step of the
   * resolution does — it is a local under construction, not published state.
   * Every field is left alone where the realm says nothing, so an unresolved
   * room and a derivative realm both come out as the room the server printed
   * and nothing more, which is the honest answer.
   */
  private attachRealm(room: Room): void {
    const world = this.world;
    if (world === undefined || room.map === null || room.number === null) return;
    const placed = world.get(room.map, room.number);
    if (placed === undefined) return;

    room.shop = placed.shop === undefined ? null : (world.shop(placed.shop) ?? null);
    // The family the wire stated, for the clock's own offset — see `lair`.
    room.lair = world.lair(placed, this.sources.family());
    if (placed.commands !== undefined) room.commands = placed.commands;
    room.spell = placed.spell === undefined ? null : world.spellById(placed.spell);
    if (placed.light !== undefined) room.lightLevel = placed.light;
    room.npc = world.buildNpcEntity(placed);
    // Now that the room is placed, its exits can say where they go.
    room.exits = world.buildExitEntities(room.exits, placed);
    /*
     * And its occupants can say which row they are. `Also here:` arrives
     * before `Obvious exits:` completes the room, so the address in hand when
     * that list was read is the room the character was standing in *before*
     * the step — the wrong room, and wrong confidently rather than merely
     * unresolved, since rung one of `resolveMobRow` reads the room's own lair
     * and the room behind you names its own rows. Seven edges across the two
     * shipped worlds answer a different row of the same name that way
     * (`dark goblin archer` 967 against 48, `vampire elder` 835 against 2813).
     */
    const at = roomAddress(room);
    room.occupants = room.occupants.map((who) => this.asRowHere(who, at));
    // And the floor the same way: a room that places one of a shared name's
    // rows has said which is lying here (format 42).
    room.items = room.items.map((item) => world.itemPlacedHere(item, placed));
  }

  /**
   * The room's ways out, joined to where each goes.
   *
   * `from` is the realm's row for the room the exits belong to, which is only
   * known *after* resolution — so the room completes with the wire's own
   * directions and is re-hydrated once it is placed. Drawing an unresolved
   * room's exits with no destinations is right: nothing knows where they go
   * yet, and inventing one would be the confidently wrong answer.
   */
  private exitEntities(exits: readonly RoomExit[], from: WorldRoom | null): ExitEntity[] {
    const world = this.world;
    if (world === undefined) return exits.map((exit) => wireExit(exit.direction, exit.note));
    return world.buildExitEntities(exits, from);
  }

  /**
   * The realm's and the roster's answer about each occupant, hung off the
   * classification rather than replacing it.
   *
   * The three-state `kind` is what stops the client swinging at a capitalised
   * stranger, so it stays exactly as it was and this only *adds*: a monster
   * the realm can place gets its row, a person the roster or the registry
   * knows gets theirs. An occupant neither can improve on is returned
   * untouched, which is the ordinary case on a derivative realm.
   */
  private asRowHere(who: RoomOccupant, at: RoomId | null): RoomOccupant {
    const world = this.world;
    if (world === undefined || who.kind !== 'mob') return who;
    // Standing *here*, which is what tells two of the realm's rows apart under
    // one name — see `WorldGraph.resolveMobRow`.
    const mob = world.buildMobEntity(who.name, { charmed: who.charmed === true, at });
    /*
     * And the classification's own answer is brought into step with the row's.
     *
     * `classifyOccupant` is dependency-free and takes a name-only lookup, so
     * `disposition` and `uncertain` have always come off the fold — the worst
     * of every row sharing the name, marked uncertain wherever they disagree
     * (21 names in the shipped realm). `AutoCombat` reads `who.disposition` to
     * decide whether to swing and `who.mob.hp` to price the swing in the same
     * filter, so leaving one half folded is two halves of one fact
     * disagreeing: a row the realm states is good reads as *uncertain* and is
     * swung at, which is exactly the refusal that is not a setting.
     *
     * `costly` is not brought over: `BuiltMobRow` carries no alignment cost,
     * so there is no row answer to prefer to the fold's — and *sometimes* on a
     * resolved row is the same artefact, a format bump away.
     */
    return mob.row === undefined
      ? { ...who, mob }
      : { ...who, mob, disposition: mob.disposition, uncertain: mob.uncertain };
  }

  /**
   * Reports a way through the realm that the realm data does not have.
   *
   * Called once a room block has completed and been located, with where the
   * character was, where it is now, and what was typed in between. The whole of
   * the judgement is here, and it is deliberately narrow — this writes to a
   * character's permanent record, so it says nothing rather than something it
   * cannot stand behind:
   *
   * - **Where we were has to be known.** An edge from nowhere is not an edge.
   * - **Something has to have been typed.** A room that arrives because
   *   somebody else opened a door is not a way *we* found.
   * - **A room the data has, reached by an edge the data has, is not news.**
   *   That is the ordinary case and it is the majority of every walk.
   * - **Ambiguity is not discovery.** A name shared by thirteen Town Gates
   *   resolves to none of them, and recording "a room the realm does not have"
   *   about a room it has thirteen of is the confidently wrong claim this
   *   client refuses to make everywhere else.
   */
  private notice(was: Room, now: Room, command: string | null, candidates: number): void {
    if (!this.onDiscovery || !this.world) return;
    if (command === null || command.trim().length === 0) return;
    if (was.map === null || was.number === null) return;
    // Standing still is not a discovery, however it was arrived at.
    if (was.map === now.map && was.number === now.number) return;

    const from = roomId(was.map, was.number);
    const previous = this.world.byId(from);
    if (!previous) return;

    const to = now.map !== null && now.number !== null ? roomId(now.map, now.number) : null;

    if (to !== null) {
      // The data already knows this way out. Every ordinary step lands here —
      // including the first of the two blocks an exit whose cast moves you
      // prints, which is the room its table names and nothing else.
      if (previous.exits.some((exit) => roomId(exit.map, exit.room) === to)) return;
      // A room-script teleport is the data knowing the way out exactly as an
      // exit is — format 13 put it on the room. Without this, every walked or
      // typed `dive pool` wrote a "discovery" of a way the realm records.
      if (previous.commands?.some((entry) => entry.to === to)) return;
    } else if (candidates > 0) {
      // Several rooms match: unresolved, not unknown. Nothing is learned from
      // "it could be any of these".
      return;
    } else if (!now.name) {
      // A room that could not even be named says nothing worth keeping.
      return;
    }

    this.onDiscovery({
      reason: to === null ? 'unknown-room' : 'unknown-exit',
      from,
      fromName: previous.name,
      command: command.trim(),
      to,
      name: now.name ?? '',
      exits: now.exits.map((exit) => exit.direction),
      at: Date.now()
    });
  }

  /**
   * A floor, from the one sentence that prints one — the open floor a look
   * lists and the concealed one a search turns up are the same grammar.
   *
   * One method for both because the two cases had the same eight lines twice,
   * which is how they came to be wrong in the same way: the floor **counts**
   * (`You notice 6 silver nobles, 66 bone key, iron ring, 2 amethyst ring
   * here.` — reported 2026-09-06; `2 rope and grapple, 2 mine pass` in
   * captures/119), and the figure was left glued to the front of the name. The
   * realm's index is keyed on `bone key`, so nothing on that floor could be
   * priced, looked up on the Reference card, or recognised as the key the door
   * across the room demands.
   *
   * The count goes where the wire's other observations about *this* one go —
   * `ItemEntity.count`, which the pack's own listing has always used and
   * whose absence means one. Passing it also makes the entry `hybrid` rather
   * than `mdb`, which is the truer label anyway: something the server printed
   * lying here is a row *with* an observation against it.
   */
  private floorListing(text: string | undefined): {
    items: ItemEntity[];
    cash: CurrencyEntity | null;
  } {
    const items: ItemEntity[] = [];
    let cash: CurrencyEntity | null = null;
    for (const entry of itemList(text)) {
      const coin = parseCoinEntry(entry);
      if (coin !== null) {
        cash = addCoins(cash, coin.denomination, coin.count);
        continue;
      }
      const { count, name } = countedName(entry);
      items.push(this.sources.itemEntity(name, count > 1 ? { count } : {}));
    }
    return { items, cash };
  }
}
