/**
 * Folds parsed blocks into character and room state.
 *
 * A pure reducer over blocks: no timers, no I/O, no commands. Per
 * docs/legacy-assessment.md §6 this is on the *inbound* side of the chain, so
 * it only ever records what the server said. Nothing here decides to do
 * anything about it — that belongs to the arbiter.
 *
 * Room assembly is the part worth being careful about. `megamind-client` built
 * a room out of four separate events accumulated into mutable fields and
 * emitted it when exits arrived, which is order-dependent and leaves stale
 * fragments behind when a line is missed. Here, `Obvious exits:` *completes* a
 * room and everything before it is a draft, so a missed line costs one room
 * rather than corrupting the next. That assembly is `room.ts`'s.
 */
import {
  EMPTY_CHARACTER,
  emptyRoom,
  NO_COMBAT,
  NO_PARTY,
  type CarriedItem,
  type CharacterState,
  type Room,
  NO_AFFLICTIONS,
  type RealmFamily as RealmWord
} from '../../shared/character';
import {
  coinsListed,
  gained,
  lost,
  parseCarriedEntries,
  parseCoinEntry,
  parseKeyEntries,
  withEquipped,
  withItem,
  withoutItem,
  withoutRoomItem,
  withRoomItem,
  itemList
} from './inventory';
import { coinsPickedUp, Ledger, takenByAnother, trained, wealthStated } from './ledger';
import { resolveFromCoordinates } from '../world/resolve';
import type { WorldGraph } from '../world/WorldGraph';
import type { Direction, RoomId, TrailStep } from '../../shared/world';
import { mobKey, nameAnswersTo, roomId } from '../../shared/world';
import type { Block } from '../../shared/blocks';
import { figure } from '../../shared/values';
import { NO_LORE, type MobLore } from '../../shared/lore';
import type { RealmFamily } from '../../shared/realm';
import { NO_SPELL_LORE, type SpellLore } from '../../shared/spell-messages';
import { PLAYER_STATUS_HEADER } from './patterns';
import type { Discovery } from '../../shared/memory';
import { NO_FIGHTS, type FightSink } from '../../shared/fights';
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import { bareName, WORN_SLOT } from '../../shared/items';
import { learnLoadout } from '../../shared/gear';
import { isWoundBand } from '../../shared/wounds';
import { FightTracker, playerDies } from './combat';
import { Expectations, MOVE_COMMANDS, type LapsedClaim } from './expectations';
import {
  coinsDropped,
  doorChanged,
  doorSwings,
  playerArrives,
  playerLeaves,
  RoomTracker,
  searchFoundNothing,
  type ItemObservation
} from './room';
import {
  abilitiesListed,
  afflicted,
  derivedExperience,
  died,
  droppedWounded,
  encumbranceStated,
  experienceGained,
  experienceStated,
  experienceTable,
  healthStated,
  levelled,
  lightOut,
  livesGained,
  livesStated,
  rested,
  spellbookEmpty,
  spellbookListed,
  spellLearned,
  spellRead,
  statAll,
  statSheet,
  StatusLine,
  type PromptReading
} from './sheet';
import { EffectTracker } from './effects';
import { seen, StealthReceipt } from './stealth';
import { Trail } from './trail';
import { DeathSentence } from './deathSentence';
import { Kills } from './kills';
import { isProcHousekeeping, readsAsProc } from './proc';
import { withPackRows, withSight, withSpans, withTargetEntity } from './joins';
import { attackAim, occupantNamed } from '../../shared/aim';
import { commandOf, type RereadClaim } from '../../shared/commands';
import { wireItem, type ItemEntity } from '../../shared/entities';
import { Company } from './company';
import { claimedBy, engagedBy, swingingAtMe, threatenedBy, vouchedFor } from './engagements';
import { trackTally } from './tally';
import { NO_TALLY, settleClocks, type CombatTally } from '../../shared/tally';
import {
  withArrival,
  withFollowing,
  withInvited,
  withJoined,
  withLeft,
  withNoGang,
  withoutPlayer,
  withPartyListing,
  withRank,
  withResting,
  withRoster
} from './presence';
import {
  NO_REALM_PLAYERS,
  type PlayerFacts,
  type PlayerRegistry,
  type RealmPlayers
} from '../../shared/players';
import { tuning } from '../app/tuning';

/** Whether the character stands somewhere else than it did. See `apply`. */
function leftRoom(before: Room, after: Room): boolean {
  if (before === after) return false;
  if (before.name !== after.name) return true;
  return (
    before.map !== null &&
    before.number !== null &&
    (before.map !== after.map || before.number !== after.number)
  );
}

export class CharacterTracker {
  private state: CharacterState = structuredClone(EMPTY_CHARACTER);
  /** The other players and what is known of them, beside the state — `company.ts`. */
  private readonly company: Company;
  /** The server's lineage, as `SessionManager` read it. See `useFamily`. */
  private serverFamily: RealmFamily | null = null;

  /** The room being assembled, and its lookups against the realm — `room.ts`. */
  private readonly room: RoomTracker;
  /** The status line's reader, built from what `pro` reported — `sheet.ts`. */
  private readonly statusLine = new StatusLine();
  /** The buffs and effects, and what their sentences have taught — `effects.ts`. */
  private readonly effects: EffectTracker;

  /** Coins, banks and counters, and the vault the character stands in — `ledger.ts`. */
  private readonly ledger: Ledger;

  /**
   * What went into or out of the pack, with the line it happened on.
   *
   * A listing is authoritative and replaces what is there — that is the rule
   * the four maintained lists all follow, and it is what makes the maintained
   * half safe. It is authoritative **as of when it was asked for**, though, and
   * a batch is not one line: `i` prints five, and the client does not know the
   * listing has finished until the *status line after it*. Anything picked up
   * in between arrives, is recorded, and is then wiped out by a listing that
   * predates it.
   *
   * Which is not a fixture's problem. Take something the moment after typing
   * `i` — the ordinary way anybody plays — and the Carrying card silently loses
   * it until the next `i`, which is the command the maintained list exists to
   * make unnecessary.
   *
   * So each change carries the sequence number of the line that caused it, and
   * a listing replays the ones that happened after its own header. Bounded, and
   * cleared by the listing that supersedes them: this is a handful of entries
   * covering the second or so a listing takes to arrive, not a history.
   */
  private packChanges: Array<{ seq: number; item: string; gained: boolean; count: number }> = [];

  /**
   * Which slot each item was last *listed* in, by bare name.
   *
   * `You are now wearing padded boots.` does not say where the boots went. The
   * `i` listing does say — it wrote `padded boots (Feet)` the last time they
   * were on — so the slot is *remembered from the listing* and put back when
   * the same item goes back on. For an item never listed worn in this session
   * the realm-wide lore answers second (`slotFromLore`): the realm's `Worn`
   * column is a number, and every listing that named an item and its slot has
   * taught what the server prints for that number.
   *
   * This is the same shape as every other listing in the client: a command
   * establishes the fact and the sentences the server volunteers keep it true
   * for free. An item nothing has ever listed worn has no entry, and then the
   * card says it is in use without naming a slot, which is the honest answer
   * rather than a guessed one.
   *
   * Kept across leaving the realm, unlike anything positional: where a helm
   * goes is a fact about the helm, and a fresh session re-teaching it would
   * cost the `i` this exists to save.
   */
  private wornAt = new Map<string, string>();
  /**
   * The direction this character's last command aimed at a door, or null.
   *
   * `The door is now open.` names no direction, so the exit it re-notes is
   * the one the command named: `open nw`, `close nw`, `pi nw`, `bas nw`. One
   * slot, cleared by any other command, because the server answers the
   * command it was sent and a `door-changed` after `l s` is about nothing
   * this client can place.
   */
  private barrierAim: Direction | null = null;
  /** The unread line a kill's experience may name as its death sentence — `deathSentence.ts`. */
  private readonly deathSentence: DeathSentence;
  /** The monsters seen to die since the session last asked — `kills.ts`. */
  private readonly kills: Kills;
  /**
   * Whether the stat sheet is being printed right now.
   *
   * Its lines arrive twice: once each as their own block, and again as the
   * `player-status` batch. A line of the sheet is the *listing restating*
   * what is up, so it may not be read as an ending — without this, an
   * unrecognised effect sentence on the sheet ends the one buff whose stop
   * nobody knows, in the middle of the sentence that says it is still there.
   */
  private sheetOpen = false;
  /**
   * Whether the block being applied is a line of a listing the classifier is
   * collecting — any batch, not only the sheet. Handed in per block by
   * `SessionManager` (`apply`'s `collecting`), because the classifier is the
   * one thing that knows, and the `unknown` case is the reader: a row of an
   * `i` or a `pro` typed `unknown` by the single-line table is that listing's,
   * whatever it looks like, and is neither learned nor suspected as an effect.
   * `You have no keys.` was (2026-09-12), and cost an `st` and a notice.
   */
  private listingOpen = false;
  /**
   * Where this character's own record is kept between sessions — the balances
   * each bank stated, and what was in each worn slot.
   *
   * Set by `useBelongings` at connect and read at `reset()`, exactly as the
   * realm's player book is: a reconnect is a new session and has to be seeded
   * like the first one.
   */
  private belongings: BelongingsSink = NO_BELONGINGS;
  /** The fight this character is in — its own memory, its own file. */
  private readonly fight: FightTracker;
  /** What the commands sent are waiting on — the command path's memory, its own file. */
  private readonly expect = new Expectations();
  /** The confirmed moves behind this character — `trail.ts`. */
  private readonly backtrail = new Trail();

  /** Whether this character is moving unseen: the move's receipt — `stealth.ts`. */
  private readonly stealth = new StealthReceipt();

  constructor(
    private readonly world?: WorldGraph,
    private readonly lore: MobLore = NO_LORE,
    /**
     * Told when the character proves the realm data wrong.
     *
     * A callback rather than a store, for the reason the realm graph is an
     * injected interface: this is the parse path, and it may not acquire a file
     * handle. It reports a fact — the tracker still never *sends* anything —
     * and what to do with it belongs to whoever wired it up.
     */
    onDiscovery?: (discovery: Discovery) => void,
    /**
     * Where fights are written down.
     *
     * Last, and defaulting to nowhere: a session with no character file behind
     * it has nowhere to write, and every existing caller predates this.
     */
    fights: FightSink = NO_FIGHTS,
    /**
     * What the realm already knows about the other players on it.
     *
     * Seeds the registry, is told about every record that changes, and is
     * where what other sessions on the same realm learn comes from. Last, and
     * defaulting to a realm that knows nothing, for the reason `fights` does.
     */
    book: RealmPlayers = NO_REALM_PLAYERS,
    /**
     * The realm's sentences for an effect landing and ending — the shipped
     * table and what this realm's wire has taught — and where a new one is
     * taught. Defaults to knowing none, which leaves the frames in
     * `patterns.ts` and the watchdog clock as the only readers of a buff's
     * life, exactly as before the table existed.
     */
    spellLore: SpellLore = NO_SPELL_LORE
  ) {
    // The book's guard reads the phase, and a kit teaches the pack's slots.
    this.company = new Company(book, {
      inGame: () => this.state.phase === 'in-game',
      teachSlot: (item, slot, at) => this.teachSlot(item, slot, at),
      rememberSlot: (item, slot) => this.wornAt.set(bareName(item), slot)
    });
    this.room = new RoomTracker({
      world,
      claims: this.expect,
      family: () => this.serverFamily,
      registry: () => this.company.players,
      itemEntity: (name, observed) => this.itemEntity(name, observed),
      stealthAfterMove: () => this.stealth.afterMove(),
      rememberTheWayBack: (s, room, moved) => this.backtrail.rememberTheWayBack(s, room, moved),
      onDiscovery
    });
    // Classification asks the realm's monster table and the roster, so a blow
    // that puts its attacker in the room asks the room (`room.ts`) to do it.
    this.fight = new FightTracker({
      lore,
      fights,
      withOccupant: (state, name) => this.room.withOccupant(state, name)
    });
    // A hold refuses the move at the head of the queue, and a measured
    // duration goes to whichever record `useBelongings` last handed in.
    this.effects = new EffectTracker({
      world,
      spellLore,
      claims: this.expect,
      belongings: () => this.belongings
    });
    // A counter's stock is the realm's, what crossed it is the pack's pending
    // change, and a balance goes to whichever record `useBelongings` handed in.
    this.ledger = new Ledger({
      world,
      onDiscovery,
      notePack: (seq, item, gained, count) => this.notePack(seq, item, gained, count),
      belongings: () => this.belongings
    });
    // Both read a monster's name against the realm's table, and the learning
    // writes what it learned to the lore.
    const known = (name: string): boolean => world?.mob(name) !== undefined;
    this.deathSentence = new DeathSentence({ known, lore });
    this.kills = new Kills(known);
  }

  /** The walker is about to send `command`, and knows it is a move. See `Expectations`. */
  hintMove(command: string, direction: Direction): void {
    this.expect.hintMove(command, direction);
  }

  /**
   * The walker's word that a command is a scripted teleport to exact
   * coordinates — a portal step. See `Expectations.hintTeleport`.
   */
  hintTeleport(command: string, map: number, number: number): void {
    this.expect.hintTeleport(command, map, number);
  }

  /**
   * The walker's word that a command walks an exit whose cast moves the
   * character — and so answers with two room blocks. See
   * `Expectations.hintCast`.
   */
  hintCast(command: string, direction: Direction, rooms: readonly RoomId[]): void {
    this.expect.hintCast(command, direction, rooms);
  }

  /**
   * A bare Enter went out — `REREAD_ROOM`, or the player pressing Return on an
   * empty line — which prints the room the character is standing in.
   *
   * Separate from `observeCommand` because an empty line is deliberately not a
   * command here: `SessionManager` skips all three observers for one, so that
   * the slots interpreting the *previous* command survive it. See
   * `Expectations.noteReread`, which is the only thing this touches.
   */
  observeReread(): void {
    this.expect.noteReread(this.state.phase === 'in-game');
  }

  /** The claim the latest bare Enter filed, for its sender to ask after. See `Expectations.reread`. */
  get lastReread(): RereadClaim | null {
    return this.expect.lastReread;
  }

  /**
   * A command the server threw away before it looked at it — `You fumble in
   * confusion!`, named by the status line that echoed it.
   *
   * `ActionFigure.CheckConfusion` runs at the top of `Player.HandleCommand`
   * and `return`s on a hit, so whatever was sent did not run and **no room is
   * coming for it**. That is the same fact `command-not-understood` carries,
   * and it is consumed the same way — by matching the *text*, because most
   * commands queue nothing at all and shifting the queue for one of those
   * would take the answer a real move is still waiting for.
   *
   * The sentence names nothing, which is why the command comes from the echo
   * (`SessionManager.answering`) rather than from the block. Null is a bare
   * prompt: nobody can say what was fumbled, so nothing is consumed.
   *
   * Left stranded, the expectation poisons dead reckoning exactly as the
   * refused `go manhole` did — the only position this client has ever lost.
   */
  noteFumbled(command: string | null): void {
    if (command !== null) this.expect.refused(command);
  }

  /**
   * Records an outbound command: what the fight may be about to bind, and what
   * the next room may be the answer to. The command path's memory is
   * `Expectations`; the one thing decided here is what only this class can —
   * whether a typed word is a way out of the room the character is standing in.
   *
   * Returns whether the command was queued as a **move**, so a caller can tell
   * a step from everything else without a second copy of the command table.
   * `at` is when it went out, the clock an attack's engagement is aged on.
   */
  observeCommand(command: string, at = Date.now()): boolean {
    const trimmed = command.trim();
    const space = trimmed.indexOf(' ');
    const named = commandOf(trimmed);
    const argument = space < 0 ? '' : trimmed.slice(space + 1).trim();
    /*
     * `Bash` is two commands wearing one word. `bas <monster>` is the all-out
     * attack; `bas <direction>` is how a door comes down — captured in
     * `captures/024`, where `aa s` answered `You bashed the door open.` in a
     * room holding four snakes, so the server itself reads a bare direction as
     * the barrier rather than as a name to match against the floor.
     *
     * Without this the walker's own `bas w` would file `w` as the thing this
     * character is fighting, and the Combat card would name a compass point.
     */
    // `Object.hasOwn`, not a truthy lookup: every object inherits `toString`
    // and `constructor`, and `bas constructor` is not a door.
    const atBarrier = named === 'Bash' && Object.hasOwn(MOVE_COMMANDS, argument.toLowerCase());
    // Which door the answer will be about, for the sentences that do not say.
    this.barrierAim =
      atBarrier || named === 'Open' || named === 'Close' || named === 'Pick'
        ? (MOVE_COMMANDS[argument.toLowerCase()] ?? null)
        : null;
    // And what it costs in stealth before it goes out, and the two that ask for it back.
    this.state = this.stealth.sent(this.state, trimmed, named);
    const aim = attackAim(trimmed, this.state, (word) => this.world?.spellNamed(word) ?? null);
    if (aim !== undefined && !atBarrier) this.fight.noteAttack(aim, trimmed, at);
    return this.expect.observeCommand(command, {
      inGame: this.state.phase === 'in-game',
      atMenu: this.state.phase === 'authenticating',
      typedExit: (text) => this.directionOfTypedExit(text),
      occupantNamed: (typed) => occupantNamed(this.state.room.occupants, typed)
    });
  }

  private directionOfTypedExit(command: string): Direction | null {
    if (this.state.phase !== 'in-game' || !this.world) return null;
    const { map, number } = this.state.room;
    if (map === null || number === null) return null;
    const here = this.world.byId(roomId(map, number));
    if (!here) return null;

    const typed = command.trim().toLowerCase();
    if (typed.length === 0) return null;

    let found: Direction | null = null;
    for (const exit of here.exits) {
      const accepts = exit.requirement?.commands ?? [];
      if (!accepts.some((phrase) => phrase.trim().toLowerCase() === typed)) continue;
      // A second match is an ambiguity, not a better answer.
      if (found !== null && found !== exit.direction) return null;
      found = exit.direction as Direction;
    }
    return found;
  }

  get current(): CharacterState {
    return this.state;
  }

  /** The registry, by identity — `Company.players`. */
  get players(): PlayerRegistry {
    return this.company.players;
  }

  /**
   * How many commands are still waiting to be answered.
   *
   * Exposed for tests only. The queue is the load-bearing part of room
   * resolution — a single slot matched the *last* direction typed against the
   * *first* room to arrive — and it is otherwise invisible from outside.
   */
  get pendingCount(): number {
    return this.expect.count;
  }

  /**
   * Whether the next room block answers a **peek** rather than a step.
   *
   * `l n` prints the neighbouring room in full and nothing in it says it is
   * not where you are standing — the settled decision the expectation queue
   * exists for. The tracker has always honoured it; `Marks.markFor`
   * needs the same answer, because it decorates a room's name line *before*
   * `act()` runs and a button beside a room the character is not in sends its
   * command into the room the character *is* in. A glyph mislabelling a peeked
   * room was cosmetic; a control is not.
   *
   * Read at the head and never shifted: the block that consumes this
   * expectation has not been applied yet, and consuming it here would take the
   * answer away from the room resolution that needs it.
   */
  get nextRoomIsPeek(): boolean {
    return this.expect.head()?.kind === 'peek';
  }

  /**
   * How many *moves* are still waiting for their room.
   *
   * Read by `SessionManager` and handed to auto-combat: a fight opened while
   * a step is unanswered lands in the room the character is leaving —
   * measured as `Your command had no effect.` arriving after the new room. A
   * peek is deliberately not counted; `l n` describes somewhere else and the
   * character is not going there.
   */
  get pendingMoves(): number {
    return this.expect.moves;
  }

  /**
   * Gives up on commands nothing has answered, and says which.
   *
   * Read on every line by `SessionManager`, because a claim about what the
   * server owes this client is a fact about the **wire** and does not wait for
   * the character state to change. See `Expectations.expire` for why the bound
   * lives there rather than in the one consumer that used to have it.
   */
  expireStaleClaims(now: number): LapsedClaim[] {
    return this.expect.expire(now);
  }

  /** The head claim to probe, marked as probed; null when none is due. See `Expectations.staleProbe`. */
  staleProbe(now: number): string | null {
    return this.expect.staleProbe(now);
  }

  /** The player has a half-typed line on the wire, or no longer has. See `Expectations.noteTyping`. */
  noteTyping(partial: boolean): void {
    this.expect.noteTyping(partial);
  }

  /** The claims a `Location:` answer proved unanswerable, taken once. */
  takeSettledByLocate(): LapsedClaim[] {
    return this.expect.takeSettledByLocate();
  }

  /** The locate word was refused (`You say "rm"`): an ordered answer all the same. */
  locateRefused(): LapsedClaim[] {
    return this.expect.answeredInOrder();
  }

  /** The last few moves the character is known to have made, oldest first — `Trail.steps`. */
  get trail(): readonly TrailStep[] {
    return this.backtrail.steps;
  }

  /** The way back out of `here`, when the last confirmed move landed here — `Trail.wayBackFrom`. */
  wayBackFrom(here: RoomId): TrailStep | null {
    return this.backtrail.wayBackFrom(here);
  }

  reset(): void {
    this.deathSentence.forget();
    this.stealth.forget();
    this.barrierAim = null;
    this.company.reset();
    this.state = {
      ...structuredClone(EMPTY_CHARACTER),
      /*
       * What the banks said before this session, restored with the times they
       * said it. Not merged through `withBankBalance`: the list came out of
       * that function on the way to disk, so merging it against an empty state
       * would only re-run a decision already made — and `at` is carried so the
       * card draws a stale figure as stale rather than as current.
       */
      banks: this.belongings.recallBanks().map((bank) => ({ ...bank })),
      /*
       * What was in each slot before this session, restored beside the
       * balances. Not a claim that any of it is *on* — a death may be exactly
       * why the client was restarted — which is why it is its own field and
       * not a seeding of `inventory.items`.
       */
      loadout: this.belongings.recallLoadout().map((worn) => ({ ...worn })),
      /*
       * What the book held last session on this realm, so the settings screen
       * and the asking routine start from knowledge rather than a dash. The
       * next `sp`/`pow` replaces it whole; null stays null, because *never
       * read* must survive a restart as itself.
       */
      spellbook: this.belongings.recallSpellbook()?.map((spell) => ({ ...spell })) ?? null,
      /*
       * And what `abil` last summed, with the clock it was read on.
       *
       * Nothing on the wire reports a quest counter moving, which was the
       * argument for dropping this and is not one for forgetting it: the same
       * is true of a bank balance three lines up, and the answer there is the
       * one taken here — keep the figure, keep `at` beside it, and let the card
       * draw a stale number as stale. The quest book already draws the clock
       * and names `abil` as its source. Null stays null: *never read* has to
       * survive a restart as itself, or an unasked book reads as a character
       * the realm counts nothing for.
       */
      abilities: this.belongings.recallAbilities(),
      /*
       * And what the fighting has added up to, so the Combat Stats card and
       * its rate graph open where they were left. A reconnect within one
       * launch hands back the tally `leaveRealm` settled; a launch hands back
       * the file's, with any clock it left open closed at the write.
       */
      tally: this.recalledTally()
    };
    this.room.discard();
    this.expect.forget();
    // A new connection is a new journey. Nothing on the old trail is known to
    // be one room from where the character is standing now.
    this.backtrail.forget();
    // Discarded rather than settled: a reset is a new session, and a fight that
    // was in progress has an unknown outcome. Learning from it would record a
    // survival that never happened.
    this.fight.forget();
    this.packChanges = [];
    // And it is standing in no bank until one answers.
    this.ledger.forget();
    this.effects.forget();
    this.sheetOpen = false;
    this.kills.forget();
    this.statusLine.forget();
  }

  /**
   * The socket closed, so the character is no longer in the realm.
   *
   * Not a full reset: who they are — the name, race, class and level from the
   * stat sheet — is still the last true thing known about them, and it is what
   * the tab rail and the offline card have to show. What stops being true is
   * everything about *standing somewhere*.
   *
   * The room is cleared rather than kept, because a stale room is worse than
   * none: the map keeps drawing a place the character is not, and a route
   * planned on reconnect starts from it. The pending queue goes for the same
   * reason — a move sent before the socket died can never be answered now, and
   * holding it would let the *next* session's first room consume it.
   *
   * Without this the phase stayed `in-game` after a disconnect, so the HUD went
   * on reporting vitals for a character that was gone. It only became visible
   * once the rail stopped disappearing along with the connection.
   */
  leaveRealm(at = Date.now()): boolean {
    this.expect.dropHint();
    /*
     * Both clocks close now: the character is in no fight and in no realm,
     * and nothing on the wire describes the moment the socket died. The
     * totals themselves stay — they outlive the socket and the launch.
     */
    const tally = settleClocks(this.state.tally, at);
    const settled = tally !== this.state.tally;
    if (settled) {
      this.state = { ...this.state, tally };
      this.belongings.rememberStats(tally);
    }
    // The buffs go with the realm, and so does every half-learned ending.
    this.effects.leaveRealm();
    this.sheetOpen = false;
    // A kill nobody read before the socket closed, or a sneak, can no longer be acted on.
    this.kills.forget();
    this.stealth.forget();
    if (this.state.phase === 'unknown' && this.state.room.name === null) return settled;
    this.state = {
      ...this.state,
      phase: 'unknown',
      room: emptyRoom(),
      inCombat: false,
      // A character on the ground in a realm it is no longer in is not a fact
      // about anything; the next status line states it afresh.
      mortallyWounded: false,
      // A fight cannot continue through a closed socket, and a remembered
      // target would be the first thing a rule swung at on reconnecting.
      combat: NO_COMBAT,
      // The running totals stay, their clocks settled above: what a night
      // disconnected must not do is count, and now it does not.
      party: NO_PARTY,
      // Nobody is sneaking through a closed socket, and "seen" would be a claim
      // about a realm this character is no longer in.
      stealth: 'unknown',
      // And nobody is poisoned in a realm they have left; the next session says.
      afflictions: NO_AFFLICTIONS,
      // A buff may in fact survive a relog — nothing has measured it — but a
      // list kept across the gap would claim to know. Absence is honest, and
      // the cost of being wrong is one recast per configured blessing.
      buffs: [],
      online: [],
      shopListing: null,
      /*
       * The ability listing **stays** (2026-09-07). It used to go here, on the
       * argument that nothing on the wire reports a quest counter moving so a
       * kept listing could only get further from the truth — which is true, and
       * is the same thing that is true of a bank balance, which is kept anyway
       * with `at` beside it so a stale figure can be drawn as stale. What the
       * drop actually cost was a quest book that opened empty after every
       * disconnect and every launch until somebody spent an `abil`.
       *
       * Not restated here at all: the field is simply not in this patch, so
       * whatever the last listing said survives leaving the realm, exactly as
       * the name, race, class and level below it do.
       */
      lastStatusAt: null
    };
    this.company.leaveRealm();
    this.room.discard();
    this.expect.forget();
    // A socket that closed mid-fight says nothing about whether the monster
    // lived, so nothing is learned from it. Recording a survival here would put
    // a floor under an entry on the strength of a disconnection.
    this.fight.forget();
    // The balances stay — they are what the banks said. Standing in one does
    // not survive a closed socket.
    this.ledger.forget();
    return true;
  }

  /** The character has walked back over `step`: give it up, and what came after — `Trail.retraced`. */
  retraced(step: TrailStep): void {
    this.backtrail.retraced(step);
  }

  /**
   * A thing on the floor or in the pack, joined to the realm's row.
   *
   * One call site for the join so a floor item and a carried one cannot come
   * out differently shaped. A character with no realm at all still gets a
   * whole entity — `source: 'wire'` — which is the dual-source rule and the
   * reason this can be called unconditionally.
   */
  private itemEntity(name: string, observed: ItemObservation = {}): ItemEntity {
    const world = this.world;
    return world === undefined ? wireItem(name, observed) : world.buildItemEntity(name, observed);
  }

  /**
   * Records that something entered or left the pack, and on which line.
   *
   * See `packChanges`. Bounded to the handful of lines a listing takes to
   * arrive: this exists to survive one batch, not to be a history.
   */
  private notePack(seq: number, item: string, wasGained: boolean, count = 1): void {
    this.packChanges.push({ seq, item, gained: wasGained, count });
    if (this.packChanges.length > tuning().parse.maxPackChanges) this.packChanges.shift();
  }

  /**
   * A listing's items, with anything that happened while it was arriving.
   *
   * Only changes *after* the listing's own header line, which is the seq the
   * batch carries: everything before it is already in the listing, and
   * replaying it would double the entry. Older changes are dropped here rather
   * than by a timer — the listing is exactly the thing that makes them
   * historical.
   */
  private replayPack(listedAt: number, listed: CarriedItem[]): CarriedItem[] {
    const after = this.packChanges.filter((change) => change.seq > listedAt);
    this.packChanges = after;
    let items = listed;
    for (const change of after) {
      items = change.gained
        ? gained(items, change.item, change.count)
        : lost(items, change.item, change.count);
    }
    /*
     * The realm's row, joined on the way out — once, for the whole pack, after
     * the replay rather than during it.
     *
     * After, because `gained`/`lost` are pure and hold no graph, and because
     * the join is idempotent: a row that already carries its realm fields is
     * rebuilt to the same thing. Doing it here means the Carrying card can
     * show a weight and a price without the `itemsKnown` round trip it used to
     * make from a React effect, and `AutoDrop` can ask what something is worth.
     */
    return items.map((item) =>
      this.itemEntity(item.name, {
        slot: item.slot,
        slotSource: item.slotSource,
        equipped: item.equipped,
        charges: item.charges,
        count: item.count
      })
    );
  }

  /**
   * Applies one block; whether the character changed, so a combat burst's unremarkable
   * lines republish nothing. The registry answers for itself, by identity (`players`).
   */
  apply(block: Block, rows?: Array<Record<string, string>>, collecting = false): boolean {
    const before = this.state;
    const known = this.company.players;
    /*
     * Whether this block is a weapon's chance-on-hit, decided **before** the
     * reducer and handed to both readers of it.
     *
     * The fight ledger and the accuracy table have to agree about the same
     * blow, and the verdict reads a memory the reducer is about to write — the
     * blow this character last landed. Deciding it once, here, is what keeps
     * the two answers from being asked either side of that write.
     */
    const proc = readsAsProc(block, before, this.fight);
    /*
     * And anything that is *not* the proc breaks the binding it would have
     * ridden on, unless it is the prompt or a blank line.
     *
     * The server composes a proc into the same write as the blow that fired
     * it — all 581 in the recorded sessions of 2026-09-06 arrive with nothing
     * but status-line repaints in the gap. A line in between means another
     * actor's got interleaved, and that is exactly when attribution stops
     * being safe: `A withering blast of dragonfire sears storm giant king for
     * 163 damage!` (captures/168) is article-led, names nobody, lands on the
     * monster this character last hit — and is Vulcan's, four lines and two
     * other players later. A window alone cannot tell those apart, because
     * the server writes the whole round in one breath.
     *
     * Before the reducer, so this character's own next blow clears the old
     * binding and then arms a new one in `FightTracker.hit`.
     */
    if (!proc && !isProcHousekeeping(block)) this.fight.interrupt();
    this.fight.heard(block);
    this.expect.heard(block); // The echo, and a `sys go` answered by no room (todos 768, 769).
    /*
     * **The sheet is open from its header until its batch closes.** Its lines
     * arrive twice — once each as their own block, then again as the
     * `player-status` batch — and a line of a listing restating what is up is
     * not an event. Set before the reducer so the `unknown` case sees it, and
     * cleared after, so the batch that closes the sheet is still read as one.
     */
    if (PLAYER_STATUS_HEADER.test(block.text.trim())) this.sheetOpen = true;
    // And every other listing, on the classifier's word — see `listingOpen`.
    this.listingOpen = collecting;
    const reduced = this.reduce(block, rows, proc);
    this.listingOpen = false;
    if (block.type === 'player-status' || block.type === 'status-line') this.sheetOpen = false;
    // After the reducer, so the experience line reads the line before it.
    this.deathSentence.heard(block);
    /*
     * A quotation belongs to the shop it was made in. When a block puts the
     * character in a *different* room, the counter's listing goes with the
     * old one — decided here, once, rather than in each of the room cases, so
     * no case can forget it. "Different" is a new name, or new coordinates
     * where the old ones were known: an `rm` that first resolves the shop's
     * own coordinates is not a move, and must not throw the listing away.
     */
    const moved = reduced !== null && leftRoom(before.room, reduced.room);
    // A quotation and a vault both belong to the room they were given in.
    let next = reduced !== null && moved ? this.ledger.roomChanged(reduced) : reduced;
    // And so does what other people were fighting: a monster spoken for in the
    // room just left says nothing about the one this room lists under the
    // same name.
    if (next !== null && moved && Object.keys(next.combat.claimed).length > 0) {
      next = { ...next, combat: { ...next.combat, claimed: {} } };
    }
    /*
     * **A room the character could read is proof it can see** — the second
     * half of todo 02, asked for as *"if you get a room you know you can see,
     * so likely blind can be removed"*.
     *
     * The server does not describe a room to a blind character: it answers a
     * look, a peek and a move alike with `You are blind.` and prints no room
     * at all (`room-unseen`, and the report's own transcript — `n` answered
     * by that one line). So a block that completed a room is the wire stating
     * sight, and it is the backstop for every ending the client cannot read:
     * a spell whose stop sentence no table holds, a cure somebody else cast,
     * a condition that lapsed while the socket was down.
     *
     * **Only a stated blindness is cleared.** `unknown` is left alone, because
     * turning it into `no` would move the flag on the first room of every
     * session for every character nobody has ever blinded — a state change per
     * character per session for a fact nothing reads differently (`unknown`
     * already holds no walk). The rule that only the wire moves a flag is
     * unbroken; this *is* the wire.
     *
     * Decided here rather than in the `room-exits` case for the reason the
     * shop quotation above is: one place, so no path through that case's
     * fifteen returns can forget it.
     */
    if (block.type === 'room-exits') {
      const sighted = next ?? this.state;
      if (sighted.afflictions.blind === 'yes') {
        next = { ...sighted, afflictions: { ...sighted.afflictions, blind: 'no' } };
      }
    }
    /*
     * The player registry is folded *after* the reducer and from the state it
     * produced, so it needs no case of its own among the 74 — see
     * `src/main/parse/players.ts` for why that placement rather than a line in
     * each case that names somebody.
     *
     * It runs even when the reducer declined the block (`next` is null, meaning
     * "nothing about *this* character changed"): somebody else speaking changes
     * nothing about this character and is precisely a sighting of them. Without
     * that, every line of chat from a person standing still would be dropped.
     */
    const base = derivedExperience(next ?? this.state, before, this.world);
    this.company.track(block, base, before);
    /*
     * And what the fighting has added up to, folded from the same place and
     * for the same reason — see `trackTally`. It reads the engagement clock
     * off the *transition*, so it is given both states rather than only the
     * one the reducer produced.
     */
    const tally = trackTally(base.tally, block, base, before, proc);
    // Written down as it moves, so the Combat Stats card opens where it was
    // left; the record defers the write, so this costs the parse path nothing.
    if (tally !== this.state.tally) this.belongings.rememberStats(tally);
    // Folded from the same place and for the same reason `trackPlayers` is: a
    // condition can move in any of a dozen cases, and this reads the
    // transition rather than any one of them. See `EffectTracker.deduceCauses`.
    this.effects.deduceCauses(before, base, block.at);
    const idle = !next && base === this.state && tally === this.state.tally;
    if (!idle) this.state = { ...base, tally, updatedAt: block.at };
    this.company.remember(known, block.type === 'room-exits');
    if (!next) return !idle;
    /*
     * What is worn, written down, from the one place a new state is committed
     * — the same placement `company.remember` has and for the same reason: a
     * line in each of the seventy-four cases that can move an item is
     * seventy-four chances to forget one.
     *
     * Only when the pack actually changed. A status line arrives every few
     * hundred milliseconds and carries no inventory at all; running the merge
     * on each of them would be work for nothing on the thread that is framing
     * bytes.
     */
    if (this.state.inventory.items !== before.inventory.items) this.rememberGear(block.at);
    if (this.state.inventory.items !== before.inventory.items || this.state.race !== before.race) {
      this.state = withSight(this.state, this.world);
    }
    /*
     * And the realm's row for each thing in it, from the same commit point and
     * for the same reason: five things ask whether the pack holds a row — the
     * router, `AutoKeys`, a room's hazard, what the things standing here can be
     * asked, and the quest book's ticks — and each of them working it out for
     * itself is the "two halves of one gate in two files" failure with a door
     * on the end of it.
     *
     * Both halves of the listing, because the server prints belongings as two
     * (`You are carrying …` and `You have the following keys: …`) and the
     * question is asked of both at once.
     */
    if (
      this.state.inventory.items !== before.inventory.items ||
      this.state.inventory.keys !== before.inventory.keys
    ) {
      this.state = withPackRows(this.state, this.world);
    }
    // And what the race's attributes run between, which moves only with the
    // race itself — the sheet reads a number against it (`AttributeSpans`).
    if (this.state.race !== before.race) this.state = withSpans(this.state, this.world);
    /*
     * The realm's row for what is being fought, joined from the one place a
     * new state is committed — the placement `company.remember` and the gear
     * already have, and for the reason stated there: a line in each of the
     * dozen combat cases that can move the target is a dozen chances to
     * forget one.
     *
     * Only when the *name* changed. A status line arrives several times a
     * second through a whole fight and none of them changes what a giant rat
     * is; re-resolving on each would be a lookup per prompt for one answer.
     */
    if (this.state.combat.target !== before.combat.target) {
      this.state = withTargetEntity(this.state, this.world);
    }
    // The book, written down from the same single commit point as the gear.
    if (this.state.spellbook !== before.spellbook && this.state.spellbook !== null)
      this.belongings.rememberSpellbook(this.state.spellbook);
    return this.state !== before;
  }

  /**
   * What was in each slot, kept for after a death takes it all off.
   *
   * `learnLoadout` returns what it was handed when nothing moved, so the
   * common case — an item picked up, a coin dropped, anything that touches the
   * pack without touching a slot — reaches the store as an identity and is
   * written nowhere.
   */
  private rememberGear(at: number): void {
    const before = this.state.loadout;
    const after = learnLoadout(before, this.state.inventory.items, at);
    if (after === before) return;
    this.state = { ...this.state, loadout: after };
    this.belongings.rememberLoadout(after);
  }

  /**
   * Whether an `st` sheet has been wanted since this was last asked.
   *
   * A flag taken rather than an event fired, because the answer is wanted
   * once per burst of questions, not once per line: three emotes in a row
   * while one buff's ending is unknown are one sheet. Cleared by the taking.
   */
  takeSheetRequest(): boolean {
    return this.effects.takeSheetRequest();
  }

  /**
   * Which monsters have been seen to die since this was last asked, by realm
   * row. Cleared by the taking, as the flag above is.
   */
  takeDeaths(): string[] {
    return this.kills.take();
  }

  /** A prompt stopped matching what `pro` reported, so `pro` is worth asking again. Cleared by the taking. */
  takeStatlineRequest(): boolean {
    return this.statusLine.takeStatlineRequest();
  }

  /** The figures off a prompt, however it is read. See `StatusLine.readPrompt`. */
  readPrompt(text: string): PromptReading | null {
    return this.statusLine.readPrompt(text);
  }

  /** Somebody sent an `@` command — `Company.noteRemoteCall`. */
  noteRemoteCall(from: string, raw: string, at: number): boolean {
    return this.company.noteRemoteCall(from, raw, at);
  }

  /** Which client another player runs — `Company.noteRemoteClient`. */
  noteRemoteClient(
    from: string,
    at: number,
    facts: { client?: string; extendedRemotes: 'yes' | 'no' }
  ): boolean {
    return this.company.noteRemoteClient(from, at, facts);
  }

  /** Where another client said it was standing — `Company.noteRemoteRoom`. */
  noteRemoteRoom(from: string, room: number, name: string | null, at: number): boolean {
    return this.company.noteRemoteRoom(from, room, name, at);
  }

  /** The realm the next connection dials, from `reset()` on — `Company.useRealm`. */
  useRealm(players: RealmPlayers): void {
    this.company.useRealm(players);
    // A different realm may be a different lineage, and carrying the last
    // one's answer forward would be worse than having none. See `useFamily`.
    this.serverFamily = null;
  }

  /**
   * Which lineage's arithmetic the *server* runs — `SessionManager`'s reading,
   * handed over.
   *
   * Told rather than worked out here, because the reading is `familyToldBy`'s
   * and it is a fold over three positive tells (`shared/realm.ts`), none of
   * which is the `[MAJORMUD]:` menu prompt this file reads into
   * `CharacterState.realm`. Those are two different facts and they have two
   * different unions: `paradigm` is a *database*, and there is no Paradigm
   * arithmetic. The one thing this decides is the lair's respawn clock, whose
   * only reading outside the realm's own column is GreaterMUD's thirty-second
   * offset (`WorldGraph.lair`); null is unknown and takes the nominal figure.
   */
  useFamily(family: RealmFamily | null): void {
    this.serverFamily = family;
  }

  /**
   * Where the next connection's own record is kept.
   *
   * Beside `useRealm` and for its reasons: a vault and a kit are both the
   * *server's*, so a character dialled at a saved realm from the palette must
   * not be shown the savings or the slots it has somewhere else. Takes effect
   * at `reset()`, which every connection runs.
   */
  /**
   * Re-seeds only the fields the belongings record supplies, because the
   * record has just been thrown away.
   *
   * `reset()` beside it does this and everything else — the room, the roster,
   * the phase, the trail — which is right for a new connection and wrong here:
   * the character is standing somewhere, and what changed is a *file*. So this
   * is the same lines as `reset()`'s seeding, applied in place.
   */
  forgetBelongings(at = Date.now()): void {
    this.state = {
      ...this.state,
      banks: this.belongings.recallBanks().map((bank) => ({ ...bank })),
      loadout: this.belongings.recallLoadout().map((worn) => ({ ...worn })),
      spellbook: this.belongings.recallSpellbook()?.map((spell) => ({ ...spell })) ?? null,
      abilities: this.belongings.recallAbilities(),
      // And the totals, which were somebody gone's. The character is standing
      // in the realm, so the clocks that were running start again now.
      tally:
        this.state.phase === 'in-game'
          ? {
              ...NO_TALLY,
              since: at,
              at,
              onlineSince: at,
              engagedSince: this.state.inCombat ? at : null
            }
          : NO_TALLY
    };
  }

  /**
   * The totals as the record last kept them, with any clock it left open
   * closed at the moment it was written: a launch that ended without the
   * socket closing left `onlineSince` running, and the write is the last
   * moment the client is known to have been in the realm.
   */
  private recalledTally(): CombatTally {
    const kept = this.belongings.recallStats();
    return kept === null ? NO_TALLY : settleClocks(kept.tally, kept.savedAt);
  }

  useBelongings(belongings: BelongingsSink): void {
    this.belongings = belongings;
  }

  /** What another session on this realm learned — `Company.absorb`. */
  absorbPlayers(batch: readonly PlayerFacts[]): boolean {
    return this.company.absorb(batch);
  }

  /**
   * Where an item just put on sits, from whatever knows — and which of them.
   *
   * Three sources, best first, because they are three different claims:
   *
   * 1. **This session's own listing** (`wornAt`): the exact item, the exact
   *    word, printed by this server for this character.
   * 2. **The realm-wide slot memory** (`lore.slotWordsFor`): a listing named
   *    an item of the same `Worn` code and this is the word it printed for it.
   *    Still the server's word, learned from an item that is not this one, and
   *    only while every listing has agreed on one — two words for one code is
   *    a code that does not decide the word on this realm, which rules out the
   *    third rung as well as the second.
   * 3. **The realm database itself** (`WORN_SLOT`): the item's `Worn` code
   *    read as a word by this client. **No listing has ever printed it**,
   *    which is why it is returned with `source: 'realm'` and carried onto
   *    `CarriedItem.slotSource` — the card names it as the realm's reading
   *    rather than dropping it under a heading of the server's words.
   *
   * The third rung is new (2026-08-31) and it exists because the second could
   * not answer at all until some listing had happened to name an item of that
   * code: a character that bought and wore a vest, gloves, helm and boots as
   * its first act read `in use` on all four, with the realm file on disk
   * saying `Torso`, `Hands`, `Head`, `Feet` the whole time. Typing `i` fixed
   * it, which is precisely the command the maintained listing exists to save.
   *
   * Null only when the realm does not know the item at all, or records no
   * `Worn` code for it — a thing that is not worn. The card then says `in
   * use`, which stays the honest answer for a slot nothing anywhere names.
   */
  private slotOf(item: string): { slot: string | null; source?: 'realm' } {
    const listed = this.wornAt.get(bareName(item));
    if (listed !== undefined) return { slot: listed };

    const worn = this.wornCodeOf(item);
    if (worn === null) return { slot: null };

    const learned = this.lore.slotWordsFor(worn);
    if (learned.length === 1) return { slot: learned[0] ?? null };
    if (learned.length > 1) return { slot: null };

    return { slot: WORN_SLOT[worn] ?? null, source: 'realm' };
  }

  /** A listing named both the item and where it sits, so the code is taught. */
  private teachSlot(item: string, slot: string, at: number): void {
    const worn = this.wornCodeOf(item);
    if (worn !== null) this.lore.observeSlot(worn, slot, at);
  }

  /** The realm's `Worn` code for an item of this name, or null when it does not say. */
  private wornCodeOf(item: string): number | null {
    if (!this.world) return null;
    const key = bareName(item);
    return this.world.itemsNamed([key])[key]?.worn ?? null;
  }

  /**
   * The character walked out of the realm to the menu, so it is forgotten.
   *
   * **Not the same as a closed socket.** `leaveRealm` keeps who the character
   * is, deliberately: the tab rail and the offline card have to show somebody,
   * and the last stat sheet is still the last true thing known about the
   * character that was there. Coming back from the *menu* has no such
   * guarantee — the menu is exactly where a player picks a different character,
   * or rerolls the one they had — so everything the stat sheet, the pack and
   * the status line ever said is now about somebody who may not be who walks
   * back in.
   *
   * It went wrong precisely that way (2026-08-31): a character was rerolled and
   * renamed, re-entered the realm on the same connection, and every card went
   * on naming the character before it — because nothing had been forgotten and,
   * worse, `Routines` had already fired its realm-entry probe for this
   * connection and would not fire it again. The two halves are one bug: the
   * client keeps stale facts *and* declines to ask for fresh ones.
   *
   * What survives is what is not about this character standing in this realm:
   * the realm's own name, the player registry (everyone marked offline, nobody
   * forgotten — the same reasoning as `leaveRealm`), the banks and the loadout,
   * which are the character's *record* rather than its state and are keyed on
   * disk by character and realm anyway.
   */
  private forgetCharacter(realm: RealmWord | null): CharacterState {
    const s = this.state;
    this.room.discard();
    // Nothing outstanding can be answered from the menu, and a room arriving
    // after the next login must not be resolved against a move typed before it.
    this.expect.forget();
    // A fight interrupted by walking out has an unknown outcome; learning from
    // it would record a survival that never happened.
    this.fight.forget();
    this.stealth.forget();
    this.packChanges = [];
    this.company.forget();
    this.ledger.forget();
    return {
      ...structuredClone(EMPTY_CHARACTER),
      realm,
      phase: 'authenticating',
      banks: s.banks.map((bank) => ({ ...bank })),
      loadout: s.loadout.map((worn) => ({ ...worn })),
      // And where it died: a reconnect after a death is when the kit is fetched.
      lastDeath: s.lastDeath === null ? null : { ...s.lastDeath }
    };
  }

  private reduce(
    block: Block,
    rows?: Array<Record<string, string>>,
    /** See `proc.ts`'s `readsAsProc`. Only the `user-hits` case reads it. */
    proc = false
  ): CharacterState | null {
    const s = this.state;
    const g = block.groups;

    switch (block.type) {
      /* ------------------------------------------------------- session */
      case 'prompt-username':
      case 'prompt-password':
      case 'prompt-new-password':
      case 'prompt-selection':
      case 'prompt-realm':
      case 'prompt-character':
      case 'prompt-menu': {
        /*
         * The menu prompt names the realm's data — `[MAJORMUD]:`,
         * `[PARADIGM]:` — which is the one place the wire says which member of
         * the family this is. Read whether or not the phase moves.
         */
        const word = g['realm']?.toUpperCase();
        const realm = word === 'MAJORMUD' ? 'majormud' : word === 'PARADIGM' ? 'paradigm' : s.realm;
        /*
         * Only ever a *downgrade* from in-game on evidence, because forgetting
         * the character is what follows and a false positive costs the HUD
         * mid-fight. There are two strengths of it and they are not the same.
         *
         * `[MAJORMUD]:` is a **prompt**, and the loosest pattern here: it
         * arrives on every line at the menu and can be echoed inside the game.
         * So it counts as leaving only alongside the request that produced it
         * — asked to leave, then the menu — which is what `leftForMenu` is.
         *
         * The account menu's own **questions** need no such corroboration.
         * `Please select a character:` and its three siblings are asked by the
         * account layer above the realm and are never printed in a room; the
         * one way to see one is to be standing at that menu. That matters
         * because typing `quit` is not the only way out of the realm — a
         * character can be returned to the menu by the server, and until this
         * read those prompts the client sat there believing it was still in
         * the realm as whoever it had been before (2026-08-31).
         */
        const left =
          block.type === 'prompt-menu'
            ? this.expect.leftForMenu()
            : block.type === 'prompt-username' ||
              block.type === 'prompt-selection' ||
              block.type === 'prompt-realm' ||
              block.type === 'prompt-character';
        if (s.phase === 'in-game' && left) {
          return this.forgetCharacter(realm);
        }
        if (s.phase === 'in-game') return realm === s.realm ? null : { ...s, realm };
        return { ...s, realm, phase: 'authenticating' };
      }

      /*
       * Leaving on purpose. The realm is left exactly as a closed socket
       * leaves it — no room, no fight, no party — except that the connection
       * is still up and the menu is about to be printed. `phase` goes to
       * `authenticating` so nothing automated sends into the menu, and
       * `LoginAutomator` reads this block to stand down until reconnect.
       */
      case 'user-exits-realm':
        /*
         * A request, not the leaving. The exit takes a configurable few
         * seconds, `break` cancels it and so does being attacked, so nothing
         * changes here beyond remembering that it was asked for. The menu
         * prompt is the only sure sign of having left, and it is read below.
         */
        if (s.phase === 'in-game') this.expect.askedToLeave();
        return null;

      case 'user-exit-interrupted':
        this.expect.stayed();
        return null;

      // MajorMUD's word that the exit completed: the menu prompt behind it is
      // the way out, whether or not the request was read.
      case 'user-left-realm':
        if (s.phase === 'in-game') this.expect.askedToLeave();
        return null;

      case 'login-welcome': {
        // GreaterMUD's welcome names the server; kept only where the menu has
        // not named the data, which is the more specific of the two.
        const realm =
          s.realm === null && /greatermud/i.test(g['realm'] ?? '') ? 'greatermud' : s.realm;
        if (g['name']) return { ...s, name: g['name'], realm, phase: 'authenticating' };
        return realm === s.realm ? null : { ...s, realm };
      }

      /* -------------------------------------------------------- status */
      case 'user-health':
        return healthStated(s, g);

      case 'status-line':
        // The in-game discriminator. Everything else about phase is a guess;
        // this is the server telling us directly.
        return this.statusLine.prompt(s, block);

      /*
       * `pro`'s `Statusline:` row: what the prompt is, and so what reads it.
       * `full` and a template no matcher can be built from leave the tolerant
       * pattern as the reader, with `exact` null to say so; `SessionManager`
       * says which out loud. The same report twice changes nothing.
       */
      case 'user-statline':
        return this.statusLine.reported(s, g['statline']);

      /* `You are now resting.` arrives before the status line that carries the flag. */
      case 'user-rests':
        return rested(s, g['state']);

      /*
       * This character died.
       *
       * The whole of what is done here is *forgetting*: every expectation in
       * the queue is about a room that will never arrive, because the realm has
       * just moved the character to wherever it keeps the dead and no command
       * asked it to. Leaving them standing is what let the temple's room block
       * be resolved against the last direction typed and written into a
       * permanent per-character file as a way through the realm.
       *
       * The fight goes with them. A monster that killed you is not a monster
       * you are still fighting, and a stale target is what a rule swings at —
       * from a room, now, that may have somebody else in it. What the death
       * leaves of the state is `sheet.ts`'s (`died`).
       */
      /*
       * On the ground, and the server is refusing everything until it is up.
       *
       * Recorded and nothing else: it is **not** death — `Misc.DeathHP` is −30
       * and thirty hit points of this state are survivable — so none of the
       * tearing down `user-dies` does belongs here (todo 20). The arbiter
       * reads the flag and stands down; the flag lifts on the first status
       * line with positive health.
       */
      case 'user-mortally-wounded':
        return droppedWounded(s);

      case 'user-dies': {
        this.expect.died();
        this.fight.forget();
        /*
         * And the trail, for the same reason and one more. The realm moves a
         * dead character to its area's temple along no edge, so nothing behind
         * it is one room away any more — and the newest step on it is the one
         * that walked into whatever did the killing, which is the last
         * direction any escape should offer.
         */
        this.backtrail.forget();
        return died(s, block.at);
      }

      /*
       * `You have 8 lives left.` — the server restating the figure at the one
       * moment it changes, which is exactly the maintained-listing shape: the
       * stat sheet's `Lives/CP:` establishes it, this keeps it true for free.
       *
       * Unlike `You gain N additional lives.` above, this is an absolute and
       * needs no prior total: the server counted for us.
       */
      case 'user-lives':
        return livesStated(s, g['lives']);

      /* The guild said so; the next `exp` will agree. */
      case 'user-levels':
        return levelled(s, g['level']);

      case 'user-experience':
        return experienceStated(s, g);

      /*
       * The table itself — what each level in the window costs. The realm's own
       * word, so it wins wherever a derivation disagreed; `withRealmExperience`
       * has what that costs the rest of the table.
       */
      case 'user-experience-table':
        return experienceTable(s, rows ?? []);

      case 'user-gain-experience': {
        // Something died, and the fight says which thing and takes it out of
        // the room and the attacker list — see `FightTracker.died`. The line
        // before this one, if it named the target, was its death sentence,
        // and the realm learns it (`DeathSentence.before`).
        const after = this.fight.died(s, block.at, this.deathSentence.before(s, block.at));
        // And a quest step can be owned by a monster's death, so the name goes
        // where `SessionManager` can read it. `after !== s` is `FightTracker`
        // saying the target is what died.
        if (after !== s && s.combat.target !== null) this.kills.noted(s.combat.target);
        return experienceGained(after, s, g['exp']);
      }

      case 'user-profile': {
        const map = figure(g['map']);
        const number = figure(g['room']);
        if (map === null || number === null) return null;
        // `rm`'s answer, and an ordered one: every step still unanswered from
        // before it was answered by nothing (todo 10).
        this.expect.located();
        // The one source that is not inference: the game said so.
        const located = this.world ? resolveFromCoordinates(this.world, map, number) : null;
        return {
          ...s,
          room: {
            ...s.room,
            map,
            number,
            resolvedBy: located?.room ? 'coordinates' : s.room.resolvedBy,
            confidence: located?.room ? 1 : s.room.confidence,
            ambiguous: located?.room ? 1 : s.room.ambiguous,
            // Nothing was weighed: the game stated it. One candidate, chosen.
            candidates: located?.room
              ? [
                  {
                    map: located.room.map,
                    room: located.room.room,
                    name: located.room.name,
                    chosen: true
                  }
                ]
              : s.room.candidates
          }
        };
      }

      case 'player-status':
        // What the sheet says is up first, then its figures over that.
        return statSheet(this.effects.listed(s, block.text, block.at), g);

      /* ---------------------------------------------------------- room */
      /*
       * A direction that did not work. It consumes the move it was for and
       * moves nobody: without this the queue keeps a direction that never
       * happened, and the next room to arrive is resolved against an exit the
       * character never took.
       */
      case 'direction-failed':
      case 'bash-failed':
        // A bare Enter cannot be refused, so a re-read still queued ahead of
        // the move this answers never got its room. See `shiftRefused`.
        this.expect.shiftRefused();
        /*
         * And both of these break stealth, silently, which is the whole
         * difficulty with tracking it (see `StealthReceipt`).
         *
         * `MoveCommand`'s no-exit branch calls `BreakStealth()` beside the
         * sentence — walking into a wall is loud, and the server says so in
         * the room (`<name> runs into the wall to the <direction>.`). Bashing
         * a door does the same in `Door.cs`.
         *
         * `direction-failed` covers four causes and only one of them is
         * proven to break stealth, so this is stated as the deliberately
         * pessimistic reading: `seen` is the answer that costs one `sn` if it
         * is wrong, and `sneaking` is the one that walks a character into a
         * lair believing it is hidden. The flag is cleared with it, or a
         * `Sneaking...` from before a refused move would be spent on the next
         * one.
         */
        return this.stealth.broke(s);

      /*
       * A look down an exit the server would not describe — `There are no
       * exits to the south!`. The peek it answers is consumed and nothing
       * moves, exactly as a refused direction consumes its move: left queued,
       * the peek answered the *next* room block, which was a real move's, and
       * the character stayed filed in the room it had walked out of. See
       * `Expectations.shiftPeekRefused` for the capture and the bound.
       */
      case 'peek-failed':
        this.expect.shiftPeekRefused();
        return null;

      /*
       * `You may not do that while you are mortally wounded!` — the server
       * refusing whatever was sent, without naming it.
       *
       * Consumed exactly as the two above are, and for the same reason: no
       * room is coming for the step this answered. It names no command, so
       * counting is all that can be done — `shiftRefused`'s own limit, and the
       * one this shares. The direction is deliberately **not** written off:
       * the step failed because the character is at zero health, and
       * blacklisting the edge would cost every route through it for the rest
       * of the session.
       *
       * Left unread it stranded a move for 126 seconds in
       * `2026-09-01_21-49-21_festus` — with the escape, the walker and the
       * loop all gated on `pendingMoves`, at `[HP=-21]`, which is precisely
       * when a character needs to be able to run.
       */
      case 'command-refused':
        this.expect.shiftRefused();
        return null;

      /*
       * A command the server would not run, which it answers by *saying out
       * loud* — `You say "go manhole"`. If that command queued a room to wait
       * for, no room is coming, and the expectation has to go with it.
       *
       * Without this it stayed, and the next room block was read as its
       * answer. Measured 2026-08-29 in the sewer: a walk sent `go manhole`
       * twice three milliseconds apart, the server ran the first and refused
       * the second, and the dark room the following `w` reached was resolved
       * against the phantom `go manhole` instead of against `w`. Dead
       * reckoning had no direction that fitted, the client lost its position,
       * and three `rm`s went out to find it again — the only position this
       * client has lost in 113 recorded sessions, and it was this.
       *
       * The refusal is the only thing that names the command, so `refused`
       * matches on the text: most refused commands queued nothing, and
       * shifting the queue for one of those would take a move that is still
       * being answered.
       */
      case 'command-not-understood':
        this.expect.refused(g['message'] ?? '');
        return null;

      case 'room-name':
        this.room.begin(g['name'] ?? null);
        return null;

      case 'room-items':
        this.room.items(g['items']);
        return null;

      /*
       * The same sentence answering a `search`, and a different floor.
       *
       * It goes onto the **published** room rather than into the draft, which
       * is not a nicety: a search's answer arrives long after `Obvious exits:`
       * completed the room, so the draft it would land in has already been
       * discarded and everything written to it is thrown away. That is where
       * every find went until now — parsed, and read by nothing.
       *
       * `items` is left alone. What a search turns up stays concealed (a bare
       * Enter afterwards reprints the room with no `You notice` line), so
       * folding it in would claim it is lying in the open *and* replace the
       * open floor with it, since a listing replaces what is there.
       */
      case 'room-hidden-items':
        return this.room.hidden(s, g['items']);

      /*
       * `Your search revealed nothing.` — the same listing, empty.
       *
       * A search is a listing and a listing is authoritative, so this clears
       * what the last one found. Only the **bare** search: the directional
       * form (`You notice nothing different to the north`) is a question about
       * an exit and says nothing about the floor, and `Walker` sends one at
       * every `Hidden/Searchable` edge it is refused by.
       */
      case 'user-search-failed':
        return searchFoundNothing(s, g['direction']);

      case 'room-also-here':
        this.room.alsoHere(s, g['who']);
        return null;

      case 'room-exits':
        return this.room.exits(s, g['exits'], block.at);

      /* A listing replaces the roster, and the room is re-read against it (`withRoster`). */
      case 'who-list':
        return withRoster(s, rows, (roster) => this.room.rereadOccupants(s, roster));

      /* ------------------------------------------------------ presence */
      /* Realm-wide, and **not** room occupancy: maintained between listings (`presence.ts`). */
      case 'player-enters':
        return withArrival(s, g['player']);

      case 'player-look':
        return this.company.lookOpened(s, g['name'], g['gang']);

      case 'player-described':
        return this.company.described(s, g['player'], g['who'], block.at);

      case 'player-equipment':
        return this.company.equipment(s, rows, block.at);

      /* The gang: `bg`'s listing, and the joins and departures that keep it (`company.ts`). */
      case 'gang-roster':
        return this.company.gangListed(s, g['gang'], g['count'], rows, block.at);

      case 'gang-joined':
        return this.company.gangJoined(s, g['player'], block.at);

      case 'gang-left':
        return this.company.gangLeft(s, g['player'], g['gang'], block.at);

      case 'gang-none':
        return withNoGang(s, block.at);

      case 'player-exits':
      case 'player-disconnects':
        return withoutPlayer(s, g['player']);

      /* The party roster: a listing, and the one view of another character's health. */
      case 'party-roster':
      case 'party-alone':
        return withPartyListing(s, rows, block.type === 'party-alone');

      /* What is said: read here only for another client answering `@health` (`withRemoteVitals`). */
      case 'conversation-telepath':
      case 'conversation-directed':
      case 'conversation-local':
      case 'conversation-gossip':
      case 'conversation-broadcast':
      case 'conversation-auction':
      case 'conversation-gangpath':
        return this.company.remoteVitals(s, g['player'], g['message'], block.at);

      case 'party-following':
        return withFollowing(s, g['leader']);

      /* Membership, announced rather than asked for, and so with no health (`member`). */
      case 'party-invited':
        return withInvited(s, g['player']);

      case 'party-joined':
        return withJoined(s, g['leader'], g['player']);

      case 'party-left':
        return withLeft(s, g['leader'] !== undefined, g['player']);

      case 'party-rank-changed':
        return withRank(s, g['player'] ?? s.name ?? undefined, g['rank']);

      /* A member sitting down, which the roster prints as a flag (`withResting`). */
      case 'player-rests':
        return withResting(s, g['player'], g['verb']);

      /*
       * Somebody walking into, or out of, *this room*.
       *
       * Kept in `room.occupants` so the list stays true between looks — the
       * same reasoning as the realm roster, and free for the same reason: the
       * server volunteers it. `Also here:` remains authoritative and replaces
       * the list outright whenever a room completes.
       */
      case 'player-arrives-room':
        return playerArrives(s, g['player']);

      /*
       * A monster walking in, which the room's list has to hear about.
       *
       * The same maintained-listing shape as a player's arrival and for the
       * same reason — the server volunteers it, so it costs nothing, and
       * `Also here:` still replaces the whole list whenever a room completes.
       * Without it the list only ever *shrank*: everything auto-combat, the
       * retreat threshold and the room's monster count read was a snapshot of
       * whoever happened to be standing there the last time a room block
       * arrived.
       *
       * `attacker` is what the classifier could name from the room and the
       * realm data. When it could name nothing the sentence is still an
       * arrival, and the honest thing is to record that something is here: the
       * word immediately before `into the room from` is the verb, so dropping
       * it leaves the name — and the entry goes in with whatever
       * `classifyOccupant` makes of it, which for a name the realm has never
       * heard of is a monster with **no disposition at all**. That is the
       * useful property: nothing with an unknown disposition is engaged
       * unasked, so a name this arrived at by counting words can never become
       * something the client swings at first — while retaliation, which needs
       * no disposition, still works the moment it hits back.
       */
      /*
       * A monster's death sentence, learned (`mob`) or the server's own
       * fallback (`line`, resolved against the room). The room said which
       * thing died, whoever killed it — the case the experience line cannot
       * reach: somebody else's kill, one worth nothing, the second of two.
       */
      case 'mob-dies': {
        const named = g['mob'] ?? g['attacker'] ?? g['line'] ?? '';
        if (named.length === 0) return null;
        const after = this.fight.diedNamed(s, named, block.at);
        if (after === s) return null;
        this.kills.noted(named);
        return after;
      }

      case 'mob-arrives-room':
        return this.room.mobArrives(s, g['attacker'], g['line']);

      case 'player-leaves-room':
        return playerLeaves(s, g['player']);

      /*
       * What is carried, and what is on the floor, between `i` commands.
       *
       * The server volunteers both, so keeping them true costs nothing — the
       * same reasoning as the realm roster and the room's occupants. A listing
       * remains authoritative and replaces what is here whenever one arrives.
       *
       * `player-gets` and `player-drops` each cover two different sentences:
       * `You took <item>` is this character, and `<name> picks up <item>` is
       * somebody else. The presence of the `player` capture is what separates
       * them, and getting that backwards would put another player's loot in
       * this character's pack.
       *
       * **This is an approximation and the next `i` corrects it.** Names are
       * compared with any leading article stripped, defensively — no capture
       * has shown the two sources disagreeing, and if one ever does, the cost
       * of *not* normalising is an item that can be picked up and never put
       * down. Anything else the two spellings disagree about survives until the
       * next listing, which replaces the lot.
       */
      /* Coins picked up count up their own denomination and leave the floor; see `coinsPickedUp`. */
      case 'user-gets-coins':
        return coinsPickedUp(s, figure(g['count']), g['coin']);

      case 'player-gets': {
        const item = g['item'];
        if (!item) return null;
        // Somebody else picked it up: gone from the floor, not into our pack.
        if (g['player'] !== undefined) return takenByAnother(s, item, figure(g['count']) ?? 1);
        const count = figure(g['count']) ?? 1;
        this.notePack(block.seq, item, true, count);
        /*
         * Off the floor by name and **by the count the sentence states**. The
         * name is still all the floor can be searched by, but the pile is no
         * longer all-or-nothing: the room prints `66 bone key` and taking one
         * leaves sixty-five, which is what the next `You notice` will say.
         * Before the count was split off the name never matched a counted
         * entry at all, so this was documented as an approximation that
         * cleared the entry and waited for the room to restate it.
         */
        return withoutRoomItem(withItem(s, item, count), item, count);
      }

      /* Bought: into the pack, the purse down by the quote, and the stock checked. */
      case 'user-buys':
        return this.ledger.bought(s, g, block.seq);

      /* `list`, in a shop: kept as the counter said it, each row checked against the stock. */
      case 'shop-list':
        return this.ledger.shopListed(s, rows ?? [], block.at);

      /* Sold: out of the pack and *not* onto the floor — the shop has it. */
      case 'user-sells':
        return this.ledger.sold(s, g, block.seq);

      /* A level bought at the guild: the price is gone from the purse. */
      case 'user-trains':
        return trained(s, g['price']);

      /* A banking round: the purse one way, the vault this room's `bank` named the other. */
      case 'user-deposits':
      case 'user-withdraws':
        return this.ledger.banked(
          s,
          figure(g['amount']),
          block.type === 'user-withdraws',
          block.at
        );

      /* `bank`, standing in one: the only authority for what that vault holds. */
      case 'bank-balance':
        return this.ledger.balanceStated(s, g, block.at);

      case 'player-drops': {
        const item = g['item'];
        if (!item) return null;
        if (g['player'] !== undefined)
          return withRoomItem(s, item, (name) => this.itemEntity(name), figure(g['count']) ?? 1);
        const dropped = figure(g['count']) ?? 1;
        this.notePack(block.seq, item, false, dropped);
        return withRoomItem(
          withoutItem(s, item, dropped),
          item,
          (name) => this.itemEntity(name),
          dropped
        );
      }

      /*
       * Hidden: out of the pack, and onto no list at all.
       *
       * `hid glov` answers `You hid padded gloves.` and the next `i` no longer
       * carries them (captured live, 2026-08-26) — so this is a drop as far as
       * the pack is concerned. It is *not* a drop as far as the room is
       * concerned: a hidden item is exactly what `You notice` does not show,
       * and putting it on the floor list would show an item nobody can pick up
       * without a search that may well fail — the capture's own `sea` found
       * nothing. Where it went is not modelled; that it is gone is.
       */
      case 'user-hides': {
        const item = g['item'];
        if (!item) return null;
        const hidden = figure(g['count']) ?? 1;
        this.notePack(block.seq, item, false, hidden);
        return withoutItem(s, item, hidden);
      }
      /*
       * The cleanup took a `Remove@Maint` item out of the pack: one instance
       * (`GMUDServer.DoCleanup` removes the stack an item at a time and prints
       * once per item), onto no floor — the server poofs it.
       */
      case 'user-item-returned': {
        const item = g['item'];
        if (!item) return null;
        this.notePack(block.seq, item, false, 1);
        return withoutItem(s, item, 1);
      }

      /*
       * Worn, wielded or lit — the item was already carried and has moved from
       * the pack into a slot.
       *
       * Parsed since phase 3 and read by nothing until now, because the
       * argument against reading it was that there was no *listing* to seed
       * what is worn from, and a readout with nothing to correct it only ever
       * drifts. The `i` listing turned out to be exactly that listing: it
       * annotates everything in use with its slot. So this is the same shape as
       * the roster, the room and the pack itself — a command establishes it and
       * the sentences the server volunteers keep it true.
       *
       * The sentence names no slot, so it comes from `slotOf`: this session's
       * listing, then what listings have printed for the item's `Worn` code
       * realm-wide, then the realm database's own reading of that code —
       * which is marked as the realm's word rather than the server's.
       */
      case 'user-equipped': {
        const item = g['item'];
        if (!item) return null;
        const where = this.slotOf(item);
        return withEquipped(s, item, true, where.slot, where.source);
      }

      /*
       * Taken off. Still carried — this is not a drop — so the entry stays and
       * only loses its slot. The *memory* of the slot is kept, which is what
       * lets putting it back on name the slot again with no `i` in between.
       */
      case 'user-removed': {
        const item = g['item'];
        if (!item) return null;
        return withEquipped(s, item, false, null);
      }

      /*
       * The readied light burnt down. Still readied, still carried, and giving
       * nothing — the `(Readied/0)` the listing would print, stated by the
       * sentence so `AutoLight` can ready the next one without waiting for an
       * `i`. See `withCharges`.
       */
      case 'light-out':
        return lightOut(s, g['item']);

      /*
       * The listing, which is authoritative and replaces the lot — and which is
       * also the only thing that ever names a slot, so it teaches as it
       * replaces. Everything learned here is what makes `You are now wearing
       * padded boots.` able to say `(Feet)` later without inventing it.
       */
      case 'user-inventory': {
        const carrying = g['items'];
        const carried =
          // "Nothing!" is the game saying the list is empty, not an item.
          carrying && !/^nothing!?$/i.test(carrying.trim())
            ? itemList(carrying).flatMap((entry) => parseCarriedEntries(entry))
            : [];
        for (const item of carried) {
          if (item.slot === null) continue;
          this.wornAt.set(bareName(item.name), item.slot);
          this.teachSlot(item.name, item.slot, block.at);
        }
        // The listing enumerates, so a denomination it does not mention is
        // zero, not unknown: see `coinsListed`.
        const coins = coinsListed(itemList(carrying).map((entry) => parseCoinEntry(entry)));
        return {
          ...s,
          inventory: {
            items: this.replayPack(block.seq, carried),
            /*
             * The keys, counted the same way the carried half is: `2 bone key`
             * is two keys and not one called "2 bone key". See
             * `parseKeyEntries` for the corpus behind it and for the reported
             * failure it caused — the router asking the realm for an item
             * named with a figure on the front, finding nothing, and calling a
             * door the character had the key to a wall.
             */
            keys: itemList(g['keys']).flatMap((entry) => parseKeyEntries(entry)),
            wealth: figure((g['wealth'] ?? '').replace(/,/g, '')),
            coins,
            encumbrance: figure(g['encumbrance']),
            encumbranceMax: figure(g['encumbranceMax']),
            encumbranceWord: g['encumbranceWord']?.trim() || null,
            // The listing landed: from here the pack is a fact rather than a
            // silence, and an exit that wants something in it can be judged.
            listedAt: block.at,
            // Re-joined at the commit point, like the gear and the sight: the
            // rows this listing's own names resolve to are not known here.
            rows: s.inventory.rows
          }
        };
      }

      /* `wealth`: the purse in one line, enumerated as the pack listing enumerates it. */
      case 'user-wealth':
        return wealthStated(s, g['coins']);

      /* ------------------------------------------------------- stealth */
      /*
       * Whether this character is moving unseen, which is what decides whether
       * the things in the next room notice it arrive.
       *
       * `Attempting to sneak...` is not yet sneaking — the server answers it
       * separately, and treating the attempt as the outcome is how a rule comes
       * to believe a character is hidden while it is walking into a lair in
       * plain sight. Only `Sneaking...` says so.
       */
      /* The fact and the receipt for the move it precedes: `StealthReceipt`. */
      case 'user-sneaking':
        return this.stealth.sneaked(s);

      // Heard on the way in (`Exits.cs:150-160`): the receipt goes too (todo 750).
      case 'user-not-sneaking':
        return this.stealth.broke(s);

      case 'user-sneak-failed':
      case 'user-cant-sneak':
      /*
       * `hide`'s failures, which on this build are honest: `HideCommand.cs`
       * appends `You don't think you are hidden.` on every branch that does
       * not set `Hiding`, the roll included. The bare `Attempting to hide...`
       * is left where `user-sneak-initiate` is — moving nothing — because
       * the walker must not skip its own `sn` on the strength of a hide, and
       * no capture holds the success line (read from source, 2026-09-12).
       */
      case 'user-hide-failed':
      case 'user-cant-hide':
        return seen(s);

      /*
       * The barrier work, which is the one of `BreakStealth()`'s thirty
       * callers **this client provokes itself** (see `StealthReceipt` for why
       * the others are read off the move instead).
       *
       * Every branch of `Door.cs` that moves a barrier calls it beside the
       * sentence and says nothing about it — opening (375), closing (193),
       * locking (218), picking (152) and unlocking with a key (247) — and
       * `Your skill fails you this time.` is the failed pick doing the same
       * (167, the only sender of that sentence in the server). `already` is
       * the exception the group is captured for: `The door was already open.`
       * is `TryOpenDoor` declining to act, and it is the one branch with no
       * `BreakStealth()` in it.
       *
       * Without this the walk had to wait a whole move to find out. Reported
       * 2026-09-11: a route picked and opened a locked door and then stepped
       * through it believing it was sneaking, because the only evidence
       * available — no `Sneaking...` on the step — arrives after the step.
       * The flag goes with the state for `direction-failed`'s reason: a
       * `Sneaking...` from before the door would otherwise be spent on the
       * move after it.
       */
      case 'door-changed': {
        const noted = doorChanged(s, this.barrierAim, g['barrier'], g['state']);
        if (g['already'] !== undefined) return noted;
        return this.stealth.broke(noted ?? s) ?? noted;
      }
      /*
       * A door this character did not touch: the exit the room listed is
       * re-noted in the server's own words (`closed door`), so `Barriers.shutAhead`
       * reads it as it would off a reprint. Only an exit the list printed — a
       * room whose exits were never read proves nothing, and a door the wire
       * never listed is not invented from a sentence about it.
       */
      case 'door-swings':
        return doorSwings(s, g['direction'], g['barrier'], g['state']);
      case 'skill-failed':
        return this.stealth.broke(s);

      /* --------------------------------------------------- afflictions */
      // Each pair is the server saying a condition began and ended; nothing
      // else moves a flag, so a cure the server answers with nothing leaves it.
      case 'user-blinded':
        return afflicted(s, 'blind', 'yes');
      case 'user-blind-ends':
        return afflicted(s, 'blind', 'no');
      case 'user-poisoned':
        return afflicted(s, 'poisoned', 'yes');
      case 'user-poison-ends':
        return afflicted(s, 'poisoned', 'no');
      case 'user-diseased':
        return afflicted(s, 'diseased', 'yes');
      case 'user-disease-ends':
        return afflicted(s, 'diseased', 'no');
      case 'user-held':
        return afflicted(s, 'held', 'yes');
      case 'user-held-ends':
        return afflicted(s, 'held', 'no');
      case 'user-confused':
        return afflicted(s, 'confused', 'yes');
      // A command thrown away is the one proof of confusion that needs no
      // table: `CheckConfusion` prints it only on a hit.
      case 'command-fumbled':
        return afflicted(s, 'confused', 'yes');

      /*
       * A cast confirmation naming this character as the recipient is the one
       * onset signal the wire frames and names, so it is what establishes a
       * buff: the per-spell onset sentences (`You feel protected!`) are realm
       * message data none of the realm databases on hand export, and cannot
       * be enumerated. `yourself` and `you` are the two spellings the server
       * uses for this character (its own cast, and a party member's); a
       * bystander's line names somebody else and is not about this character.
       *
       * The automation self-casts by name (`c bless soul`), and no capture
       * shows whether the confirmation then says `yourself` or the name — so
       * the character's own name is accepted as a third spelling of self
       * rather than found out the expensive way.
       */
      case 'spell-cast':
        return this.effects.cast(s, g, block.at);

      /*
       * The per-spell onset sentence, printed the instant a buff lands. Its
       * wording cannot be mapped to a spell name — realm message data no realm
       * database on hand exports — but it follows the cast confirmation, which
       * does name the spell, so the pair is **learned** from that adjacency.
       * Only this character's own casts teach it: a party member's onset lands
       * on their screen and is not seen here anyway, and the burst window keeps
       * an unrelated `You feel …!` (a room effect, a potion) from binding to
       * the last spell. Nothing about the published state changes.
       */
      case 'spell-onset':
        return this.effects.onset(s, block);

      /*
       * The spellcasting roll failed and nothing landed. Read so it is a fact
       * rather than silence — a failed self cast leaves the buff unregistered,
       * which is what keeps it due — and so a listener (`Blessings`) can retry
       * on the next round rather than waiting its retry floor out. Consumes the
       * pending self-cast note: an onset is not coming for a cast that failed.
       */
      case 'spell-failed':
        this.effects.failed(g['spell']);
        return null;

      /*
       * A wear-off ends the buff it names. Matched against what is actually
       * on the list — exactly, or through the realm's spell table so the
       * table's two spellings of one row (name and abbreviation) cannot make
       * one buff two. A wear-off naming nothing on the list is still a fact
       * (a debuff ending, a buff cast before this session) and changes
       * nothing.
       */
      case 'user-buff-expired':
        return this.effects.expired(s, g, block.at);

      /*
       * The `sp` / `pow` listing replaces the whole book — a listing is
       * authoritative, and it prints only what the character can actually
       * cast. The header's own word (`spells` against `powers`) restates the
       * resource kind, kept for the same reason the stat sheet's word is: a
       * realm whose prompt omits the mana field still says it here.
       */
      case 'spellbook':
        return spellbookListed(s, rows ?? [], g['book']);

      /*
       * The same listing, answering that there is nothing in the book.
       *
       * An **empty listing, not an absent one**. `spellbook` is null for
       * *never read* and the client keeps that distinction deliberately
       * (`Belongings`: "absent means never read, not the realm counts none"),
       * so a character that was asked and has none must end up at `[]` — else
       * asking a Warrior for its spells leaves the state saying the question
       * was never put (todo 15).
       *
       * `manaType` is read off the book that answered exactly as the listing
       * above reads it: the server sends this from the same command, so which
       * book was asked for is known whether or not it held anything.
       */
      case 'spellbook-empty':
        return spellbookEmpty(s, g['book']);

      /*
       * `abil` — GreaterMUD's ability listing, and the only thing on any of
       * the three realms that states a quest counter.
       *
       * The listing is authoritative and replaces what is there, like every
       * other listing here; nothing volunteers a counter between two of them,
       * so unlike the roster and the pack there is nothing to maintain it with
       * and the figure is only ever as fresh as the last `abil`. `at` is kept
       * and **drawn**, because a figure with no clock on it reads as current.
       *
       * A listing with not one readable row is nothing said, and says nothing:
       * that is the classifier having matched a block whose every row failed
       * its own qualifier, which is a bug rather than a fact about the
       * character, and overwriting a good listing with it would lose real
       * counters.
       */
      case 'user-abilities':
        return abilitiesListed(s, rows ?? [], block.at, this.belongings);

      /*
       * `stat all` — the server's own arithmetic, kept with what it was
       * computed from, so `statedNow` can drop each figure the moment its
       * inputs move rather than on a clock.
       */
      case 'user-stat-all':
        return statAll(s, rows ?? []);

      /*
       * `You have learned a new power way of the swan!` — appended so the
       * book stays current between listings, but only onto a book that has
       * been read: one spell appended to `null` would publish a book of one,
       * and a settings screen reading it would say the character knows
       * nothing else. The asking routine re-asks on this block either way,
       * and the listing that answers replaces the whole list.
       */
      case 'user-learns':
        return spellLearned(s, g['kind'], g['name']);

      /*
       * `read minor` -> `You add minor healing to your spellbook!`
       *
       * Two facts in one sentence, and they are independent: the book gained
       * an entry, and the scroll that taught it is gone. Either half can be
       * knowable while the other is not — a character who has never typed `sp`
       * has no book to append to, and a realm that cannot place the scroll
       * still saw the spell — so neither is made to wait on the other.
       *
       * **The sentence names the spell and never the item.** That makes the
       * second half a realm-data question rather than a parsing one: the
       * player typed `read minor`, a prefix the server resolved, and
       * `scroll of minor healing` appears in neither the command nor the
       * answer. Binding the command that provoked the line would have bound
       * the prefix. So the scroll is found by asking which carried item
       * *teaches this spell* (`scrollTeaching`, `sheet.ts`), which is a lookup.
       *
       * Where the realm cannot place either — a derivative realm, an item
       * outside the index, a scroll acquired before this client was watching
       * — the spell is still recorded and **nothing is removed**. The pack is
       * a maintained listing and the next `i` corrects it; a guess at which
       * item went would take a real one off the card, which is the failure
       * that is not self-correcting.
       */
      case 'user-reads-spell':
        return spellRead(s, g['name'], this.world, (scroll) =>
          this.notePack(block.seq, scroll, false, 1)
        );

      /*
       * A bare encumbrance line, which arrives on its own after picking
       * something up rather than only inside an `i` listing.
       */
      case 'user-encumbrance':
        return encumbranceStated(s, g);

      /*
       * `You gain 2 additional lives.` — counted onto what the sheet said, and
       * only then: a gain before any sheet has stated a total is a gain on an
       * unknown, and an unknown plus two is not two.
       */
      case 'user-gains':
        return livesGained(s, g);

      /*
       * `Your command had no effect.`
       *
       * The server's way of saying *the thing you named is not there*, and the
       * sentence names nothing itself — so the command is the only record of
       * what it was about, which is why `Expectations` remembers what the last
       * command named (`aimed`).
       *
       * Matched as a **prefix**, because that is how the server resolves a
       * target: `pu carrion` reaches `thin carrion beast`, and an exact
       * comparison would find nothing precisely when a name was abbreviated.
       *
       * This is the second half of the correction the experience line makes.
       * A monster this client killed leaves the room on the experience line; a
       * monster that left, was killed by somebody else, or was never really
       * there in the spelling this client wrote down leaves it here — and
       * without either, auto-combat attacked the same absent monster once a
       * round for as long as it was in the list.
       *
       * Nothing is invented: a command that named an item, a direction, or
       * nothing at all answers to no occupant and to nothing this character is
       * fighting, and changes nothing.
       */
      /*
       * `target-missing` is the same refusal with the name in the sentence —
       * `You don't see soul here.` — in the spelling the player typed, which
       * the server resolves by prefix exactly as `aimed` is matched below.
       */
      /*
       * The look was refused because the argument reached more than one thing,
       * so no wound sentence follows. The queued look has to go with it, or the
       * next one to arrive binds to it and puts one monster's condition on
       * another's bar. The sentence names nothing, so there is nothing else to
       * read off it.
       */
      case 'target-ambiguous':
        this.expect.shiftLook();
        return null;

      case 'target-missing':
      case 'command-no-effect': {
        // Same reasoning as `target-ambiguous`: a refused look is answered.
        if (block.type === 'target-missing') this.expect.shiftLook();
        const aimed =
          block.type === 'target-missing' ? mobKey(g['target'] ?? '') : this.expect.aimed;
        if (aimed === null || aimed.length === 0) return null;
        // The server's own matching rule, not a leading prefix: `du` reaches
        // `practice dummy`. See `nameAnswersTo`.
        const answers = (name: string): boolean => nameAnswersTo(mobKey(name), aimed);
        const gone = s.room.occupants.filter((who) => answers(who.name));
        const names = new Set(gone.map((who) => mobKey(who.name)));
        /*
         * **The room listing is not the gate.** It used to be — `gone.length
         * === 0` returned early — so a monster the room had *already* dropped
         * kept its place in `attackers` for ever, and that is the state a
         * client cannot get out of on its own: `fightIsRunning` (`Walker.ts`)
         * reads `attackers`, so the walk stops and books a failed leg, three
         * of which end the lap; `retaliation` re-proposes the attack on every
         * state change; and every one of them comes back here to be refused by
         * the same sentence that should have ended it. Measured 2026-09-02
         * (`2026-09-02_18-07-07_festus.mudcap.jsonl`, t=4865201): the room
         * block arrived with no `Also here:` at all, the rat that had lunged a
         * second earlier stayed on the books, and `pu angry giant rat` went out
         * three more times over the following forty seconds — into a room the
         * client had itself just listed as empty — with the lap stopped for the
         * whole of it.
         *
         * So the fight's own two fields are matched against the name directly.
         * Nothing is invented by that: a command that named an item, a
         * direction, or nothing at all answers to no monster this client is
         * fighting, exactly as it answers to no occupant.
         *
         * **And the trade, stated in both directions.** This sentence is the
         * generic *the command did nothing*, not a refusal that names a
         * target, so `aimed` is whatever the last command's argument was —
         * `rem cloak` while a `cloaked figure` swings would clear it, since
         * `nameAnswersTo` is prefix-or-word-start. The window is narrow: the
         * monster must be genuinely attacking, absent from `room.occupants`,
         * and share a name with an unrelated argument. And what it costs when
         * it happens is that `fightIsRunning` and `Recovery.fightIsHere` both
         * go quiet on a fight still running — one spent command, since being
         * attacked breaks a rest and the next blow re-files the attacker.
         * Against a deadlock nothing but a person can end, that is the cheaper
         * error, and it is the same *correction that corrects itself* argument
         * the experience line above makes.
         */
        const target =
          s.combat.target !== null && answers(s.combat.target) ? null : s.combat.target;
        // Something the server says is not there cannot be attacking this
        // character either — the same cleanup a death does, for the same
        // reason: a stale attacker is a corpse retaliation would swing at.
        const attackers = s.combat.attackers.filter((name) => !answers(name));
        if (
          gone.length === 0 &&
          target === s.combat.target &&
          attackers.length === s.combat.attackers.length
        ) {
          return null;
        }
        return {
          ...s,
          room: {
            ...s.room,
            occupants: s.room.occupants.filter((who) => !names.has(mobKey(who.name)))
          },
          combat:
            target === s.combat.target && attackers.length === s.combat.attackers.length
              ? s.combat
              : { ...s.combat, target, attackers, health: target === null ? null : s.combat.health }
        };
      }

      /* -------------------------------------------------------- combat */
      case 'combat-status': {
        const engaged = g['status'] === 'Engaged';
        // The looks queued during the fight go with it, as they always have;
        // the queue is the command path's, so it is cleared here, not there.
        if (!engaged) this.expect.clearLooks();
        return this.fight.status(s, engaged, block.at);
      }
      case 'mob-protects':
        return this.fight.guarded(s, g['guard'] ?? '', g['ward'] ?? '', block.at);

      /*
       * The answer to `look <mob>`, bound to the look it answers.
       *
       * The sentence names nothing, so an unbound one is dropped rather than
       * applied to whatever happens to be the current target: a player who
       * looked at the *other* monster in the room and had the band pinned onto
       * the one they are fighting would be shown a bar that is wrong in the
       * reassuring direction.
       */
      case 'mob-wounded': {
        const band = g['band'];
        const looked = this.expect.shiftLook();
        if (band === undefined || !isWoundBand(band) || looked === undefined) return null;
        return this.fight.wounded(s, band, looked, block.at);
      }

      /*
       * Who is hitting whom.
       *
       * `The <mob> ... you` is a monster's blow — the article is what separates
       * it from a player's in this server's phrasing — and `<name> ... you` is
       * somebody hitting this character. Anything else with this character as
       * the attacker names what it is fighting.
       */
      case 'mob-hits': {
        /*
         * And a monster swinging at this character has already seen it.
         *
         * `Mob.TryFindTarget` clears `Sneaking` and `Hiding` on whoever it
         * picks (`Mob.cs:1888`) and says nothing, so the blow is the only
         * evidence there is — and without it a character jumped mid-route
         * walked the rest of the way believing it was still unseen.
         */
        const blow = this.fight.blowOnMe(s, block.at, vouchedFor(s, g));
        return this.stealth.broke(blow) ?? blow;
      }

      /*
       * The same blow without ` for <n> damage!` behind it, which is also the
       * shape of any sentence about somebody standing here — so the realm is
       * asked whether the thing named would have swung. See `swingingAtMe`.
       */
      case 'mob-misses': {
        const attacker = swingingAtMe(s, vouchedFor(s, g));
        const blow = this.fight.blowOnMe(s, block.at, attacker);
        // Only a swing the realm will vouch for costs the stealth: this
        // pattern is loose enough to catch a sentence that is about nothing
        // more than something standing here, and that has seen nobody.
        return attacker === undefined ? blow : (this.stealth.broke(blow) ?? blow);
      }

      /*
       * This character swung and missed.
       *
       * Worth exactly one thing: it names the target. Before this the target
       * was learned only from a blow that *landed*, so a fight opened with a
       * run of misses had none — and the round verbs name what they swing at
       * precisely so that `kic` does not fall through to the server's
       * `LastTarget`, which after a kill is whatever else is in the room.
       */
      case 'user-misses':
        return this.fight.missed(s, block.at, g['target']);

      case 'user-hits': {
        const hit = this.fight.hit(
          s,
          block.at,
          g['target'],
          vouchedFor(s, g),
          figure(g['damage']) ?? 0,
          proc
        );
        // A party member's blow on a monster is what the leader is fighting;
        // a monster's blow on a member is the fight brought to the party; and
        // a stranger's blow on a monster is that monster spoken for.
        const engaged = engagedBy(hit ?? s, g['attacker'], g['target'], block.at) ?? hit;
        const threatened =
          threatenedBy(engaged ?? s, g['attacker'], g['target'], block.at) ?? engaged;
        return claimedBy(threatened ?? s, g['attacker'], g['target'], block.at) ?? threatened;
      }

      /*
       * A swing between two other parties says both of them are in this room,
       * whatever the last listing said — the maintained-listing shape again.
       * A monster's name arrives with its article, which is spelling and is
       * dropped; a name already listed is left exactly as it was.
       */
      case 'player-misses': {
        const attacker = g['attacker']?.replace(/^(?:The|A|An) /, '');
        const target = g['target'];
        let next = s;
        if (attacker) next = { ...next, room: this.room.withOccupant(next, attacker) };
        if (target) next = { ...next, room: this.room.withOccupant(next, target) };
        next = engagedBy(next, attacker, target, block.at) ?? next;
        next = threatenedBy(next, attacker, target, block.at) ?? next;
        next = claimedBy(next, attacker, target, block.at) ?? next;
        return next === s ? null : next;
      }

      /*
       * `<Name> moves to attack you!` — the opening of a PvP fight, a round
       * before any damage. Handled as a blow that has not landed yet: the
       * attacker joins `attackers` and the room, which is what raises the
       * critical alert and starts the hang-up clock. Aimed at anybody else it
       * is a fact about somebody else's fight and changes nothing here.
       */
      case 'player-attacks': {
        const attacker = g['attacker'];
        const target = g['target'];
        if (!attacker || !target) return null;
        // Aimed at somebody else it is still a fact about a party member's
        // fight — theirs as attacker, or brought to them as target.
        if (!/^you$/i.test(target)) {
          const engaged = engagedBy(s, attacker, target, block.at);
          const threatened = threatenedBy(engaged ?? s, attacker, target, block.at) ?? engaged;
          return claimedBy(threatened ?? s, attacker, target, block.at) ?? threatened;
        }
        return this.fight.blowOnMe(s, block.at, attacker);
      }

      /*
       * A player died in this room. They leave the occupant list and the
       * fight exactly as a killed monster does — a corpse is not an attacker,
       * and a rule swinging at `{target}` must not be handed one.
       */
      case 'player-dies':
        return playerDies(s, g['player']);

      /*
       * Coins landing on the floor are loot, and the room's item list is where
       * loot lives. Appended rather than merged: the next `You notice` replaces
       * the whole list, which is what makes the approximation safe.
       */
      case 'room-coins':
        return coinsDropped(s, figure(g['count']), g['coin']);

      /*
       * The server walked this character after its leader. A room is about to
       * arrive that no typed command asked for, and it is a room reached by a
       * *move* — so the same expectation a typed direction pushes is pushed
       * here, and the resolver gets to use the strongest signal it has.
       */
      case 'party-follows': {
        const direction = MOVE_COMMANDS[g['direction']?.trim().toLowerCase() ?? ''];
        if (!direction) return null;
        this.expect.pushMove(direction);
        return null;
      }

      /*
       * The room's light, which is two different facts wearing one sentence.
       *
       * `dimly lit` and `barely visible` are printed *after* `Obvious exits:`
       * (captures/009, captures/022), so the room they describe is already on
       * the books and this only annotates it.
       *
       * `very dark` and `pitch black` *are* the room block: no name, no
       * occupants, no exits follow, so nothing below would ever complete them.
       * Left alone, the character stood in a cavern with the arena's last
       * target and occupants still on the books — and hit nothing back for
       * thirty seconds, because a target "in progress" refuses retaliation.
       */
      case 'room-light':
        return this.room.light(s, g['light']);

      /*
       * `You are blind.` — the same shape as the two blinding lights above,
       * and for the opposite reason: there the room could not be described,
       * here the character cannot read it.
       *
       * It is the answer to whatever was last asked, and the corpus shows it
       * answering a bare Enter, a `look`, a `look <mob>`, a peek and a move
       * (see `patterns.ts`). Only the move changes anything, and it changes
       * everything: unconsumed it left `pendingMoves` above zero for the rest
       * of the session, and auto-combat does not hit back while a step is
       * unanswered. The light is *not* set — a blinded character is told this
       * in a torchlit hall as readily as in a cavern, and claiming `very dark`
       * from it would be inventing a fact about the room out of a fact about
       * the character.
       *
       * The condition itself is restated here as well as at its onset. The
       * server only prints this while it holds, and a `Cures` cast that the
       * server answered with nothing is exactly the case where the flag would
       * otherwise be stale.
       */
      case 'room-unseen': {
        const arrival = this.room.arrivedUnseen(s, 'blind');
        return afflicted(arrival ?? s, 'blind', 'yes') ?? arrival;
      }

      case 'room-description': {
        /*
         * Collected into the *draft*, and discarded with it. The description is
         * only a fact about a room once the room is complete, which is what
         * keeps this from becoming the mutable cross-room accumulator that
         * leaked fragments between rooms in `megamind-client`.
         */
        this.room.describe(block.text);
        // Not a state change: republishing here would show half a paragraph.
        return null;
      }

      /*
       * A line nothing read is still evidence about the buffs, two ways.
       *
       * Right after this character's own cast it is the spell's onset
       * sentence in a form no frame knows, and it is learned as that spell's
       * start. Otherwise, while buffs whose ending the client cannot
       * recognise are up, it may be one of them ending: with one such buff it
       * is taken to be, learned and acted on (the `st` sheet can still take
       * it back, see `EffectTracker.noteContradiction`); with several it is
       * held as a pending ending and the next sheet says which. Only a
       * sentence shaped like an effect — one sentence, no figure, nobody in
       * the room named — is considered at all, so an emote never becomes a
       * lesson; and a line of a listing the classifier is collecting is
       * refused before its shape is looked at, because `You have no keys.`
       * has the shape.
       */
      case 'unknown':
        return this.effects.unread(s, block.text, block.at, {
          listing: this.listingOpen,
          sheet: this.sheetOpen
        });

      default:
        return null;
    }
  }
}
