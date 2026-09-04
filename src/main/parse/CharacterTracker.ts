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
 * rather than corrupting the next.
 */
import {
  bankKey,
  DENOMINATIONS,
  EMPTY_CHARACTER,
  emptyRoom,
  isBlinding,
  NO_COMBAT,
  NO_PARTY,
  type Denomination,
  type Adventurer,
  type CarriedItem,
  type CharacterState,
  type Room,
  type RoomExit,
  type RoomLight,
  type RoomOccupant,
  NO_AFFLICTIONS,
  type Afflictions,
  type Affliction,
  type KnownSpell,
  type RealmFamily,
  type ActiveBuff
} from '../../shared/character';
import {
  derivedExperienceTable,
  withDerivedExperience,
  withRealmExperience,
  type ExperienceLevel
} from '../../shared/experience';
import { classifyOccupant } from '../../shared/mobs';
import {
  gained,
  lost,
  parseCarriedEntries,
  parseCoinEntry,
  withBankBalance,
  withEquipped,
  withOwnEquipment,
  withItem,
  withoutItem,
  withSpend,
  withoutRoomItem,
  withRoomItem,
  withCharges
} from './inventory';
import { resolveByDeadReckoning, resolveFromCoordinates, resolveRoom } from '../world/resolve';
import type { WorldGraph } from '../world/WorldGraph';
import type { Direction, RoomId, TrailStep, WorldRoom } from '../../shared/world';
import { mobKey, nameAnswersTo, roomId } from '../../shared/world';
import type { Block } from '../../shared/blocks';
import { NO_LORE, type MobLore } from '../../shared/lore';
import type { Discovery } from '../../shared/memory';
import { NO_FIGHTS, type FightSink } from '../../shared/fights';
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import { LEARN_SPELL_ABILITY } from '../../shared/abilities';
import { bareName, sameItem, WORN_SLOT } from '../../shared/items';
import { learnLoadout } from '../../shared/gear';
import { isWoundBand } from '../../shared/wounds';
import { FightTracker, playerDies } from './combat';
import { Expectations, MOVE_COMMANDS, type LapsedClaim } from './expectations';
import { RoomDraft } from './draft';
import { ATTACK_COMMANDS, commandOf } from '../../shared/commands';
import { wireExit, wireItem } from '../../shared/entities';
import type { CurrencyEntity, ExitEntity, ItemEntity } from '../../shared/entities';
import { addCoins } from '../../shared/coins';
import { playerEntity, playerKey } from '../../shared/players';
import { noteRemoteCall, trackPlayers } from './players';
import { trackTally } from './tally';
import { NO_TALLY } from '../../shared/tally';
import {
  rosterFrom,
  withArrival,
  withFollowing,
  withInvited,
  withJoined,
  withLeft,
  withEquipment,
  withGangJoined,
  withGangLeft,
  withGangListing,
  withLookedAt,
  withoutPlayer,
  withPartyListing,
  withRemoteVitals,
  withRank,
  withResting
} from './presence';
import {
  absorbFacts,
  allOffline,
  NO_PLAYERS,
  NO_REALM_PLAYERS,
  toFacts,
  type PlayerFacts,
  type PlayerRegistry,
  type RealmPlayers
} from '../../shared/players';
import { tuning } from '../app/tuning';
import {
  abilitySum,
  carriedLights,
  NIGHT_VISION_ABILITY,
  ROOM_LIGHT_ABILITY,
  sameSight,
  sightOf,
  wornVision
} from '../../shared/light';

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
 * The prompt's optional fields, read for what the client recognises.
 *
 * `Need=`, `Exp=` and `Wealth=` are switched on by the player and appear in
 * whichever order and with whichever separator they chose; `: Need n XP` is
 * one realm's spelling of the first. Anything else is skipped, not refused.
 */
function statusFields(fields: string | undefined): {
  need?: number;
  exp?: number;
  wealth?: number;
} {
  if (!fields) return {};
  const out: { need?: number; exp?: number; wealth?: number } = {};
  const need = /(?:Need=|: ?Need )(\d+)/i.exec(fields);
  const exp = /\bExp=(\d+)/i.exec(fields);
  const wealth = /\b(?:Wealth|CASH)=(\d+)/i.exec(fields);
  if (need?.[1]) out.need = Number(need[1]);
  if (exp?.[1]) out.exp = Number(exp[1]);
  if (wealth?.[1]) out.wealth = Number(wealth[1]);
  return out;
}

/** Blank room, used both at reset and when a new one starts. */
function int(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
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
  ['down', 'd']
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

/** Splits a comma/`and` separated list, dropping articles the game prefixes. */
function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/,| and /)
    .map((entry) => entry.trim().replace(/\.$/, ''))
    .filter((entry) => entry.length > 0);
}

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

  /** The room being assembled; promoted to `state.room` when exits arrive. */
  private readonly room = new RoomDraft();

  /**
   * The vault the character is standing in, as the last `bank` in this room
   * named it — and null everywhere else.
   *
   * This is what lets a deposit and a withdrawal *maintain* a balance instead
   * of leaving it stale, and it is the standing shape: a command establishes
   * the figure, and the sentences the server volunteers keep it true until the
   * next command restates it. `You deposit N copper farthings.` names no bank,
   * so on its own it can only be attributed by guessing at the room — which is
   * the guess this whole area refuses. `Your balance at Bank of Godfrey is:`
   * names one outright, and it was said *here*, so the next deposit is this
   * vault's.
   *
   * Cleared the moment the room changes, in `apply()` beside `shopListing` and
   * for the same reason: walk to the next town's bank without asking and there
   * is no vault to credit, which is absence rather than the wrong answer.
   */
  private vault: { shop: number | null; name: string } | null = null;

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
   * Whose `look` is currently being read, from the `[ Name ]` line that opens
   * one. The equipment block below it carries no name of its own, and the
   * server's spelling here is already resolved from whatever was typed.
   */
  private lookedAt: string | null = null;
  /**
   * This character's own most recent duration-spell cast, for learning what
   * the per-spell onset sentence that follows it is called.
   *
   * The onset (`You feel safe from evil!`) names an effect the realm's message
   * table would map to `protection from evil`, and none of the realm databases
   * on hand export that table — but the onset arrives the instant after the
   * cast confirmation, which does name the spell, so the pair is learned from
   * that adjacency. Session-scoped: a buff is re-cast every session and the
   * `st` timer is a live read, so nothing has to persist.
   */
  private lastSelfCast: { spell: string; at: number } | null = null;
  /** Learned `onset effect (lower) → spell name`, so the `st` timer can be attributed. */
  private buffEffects = new Map<string, string>();

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
  /** The confirmed moves behind this character. See the `trail` getter. */
  private backtrail: TrailStep[] = [];

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
    private readonly onDiscovery?: (discovery: Discovery) => void,
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
    private players: RealmPlayers = NO_REALM_PLAYERS
  ) {
    // Classification asks the realm's monster table and the roster, so a blow
    // that puts its attacker in the room comes back here to do it.
    this.fight = new FightTracker({
      lore,
      fights,
      withOccupant: (state, name) => this.withOccupant(state, name)
    });
    this.state = { ...this.state, players: absorbFacts(NO_PLAYERS, players.recall()) };
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

  /**
   * Records an outbound command: what the fight may be about to bind, and what
   * the next room may be the answer to. The command path's memory is
   * `Expectations`; the one thing decided here is what only this class can —
   * whether a typed word is a way out of the room the character is standing in.
   *
   * Returns whether the command was queued as a **move**, so a caller can tell
   * a step from everything else without a second copy of the command table.
   */
  observeCommand(command: string): boolean {
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
    this.fight.noteCommand(
      named !== null && ATTACK_COMMANDS.has(named) && argument.length > 0 && !atBarrier
        ? argument
        : null
    );
    return this.expect.observeCommand(command, {
      inGame: this.state.phase === 'in-game',
      atMenu: this.state.phase === 'authenticating',
      typedExit: (text) => this.directionOfTypedExit(text),
      occupantNamed: (typed) => this.occupantNamed(typed)
    });
  }

  /**
   * The occupant a typed argument reaches, in the spelling the room printed.
   *
   * The server resolves a command's argument against the room, so the client
   * has to as well or it files facts about `du` while the card is showing
   * `practice dummy`. `nameAnswersTo` is the rule, read out of the server's own
   * `Misc.IsMatch`.
   *
   * **Exact wins outright.** The C# compares `==` first at every call site and
   * *clears* the candidates it had already accumulated, so a room holding both
   * `rat` and `giant rat` resolves a typed `rat` to `rat` — even though
   * `giant rat` also answers to it and may be listed first.
   *
   * Null when nothing answers: the typed text is then kept as the player wrote
   * it, because the server has confirmed the thing exists and a listing this
   * client has not seen is not a reason to invent a different name.
   */
  private occupantNamed(typed: string): string | null {
    const key = mobKey(typed);
    if (key.length === 0) return null;
    const occupants = this.state.room.occupants;
    const exact = occupants.find((who) => mobKey(who.name) === key);
    if (exact) return exact.name;

    const matched = occupants.filter((who) => nameAnswersTo(mobKey(who.name), key));
    if (matched.length === 0) return null;

    /*
     * `LookCommand` collapses an ambiguity by *kind* before it gives up:
     * exactly one matching player wins outright, else exactly one matching
     * monster. Anything else is `Please be more specific.` and no answer.
     *
     * This client only cares about the monster, but the player branch has to
     * be modelled or the wrong one is picked: a room with the player `Ratface`
     * and one `giant rat` resolves a typed `rat` to **the player**, and a look
     * at a player prints no wound sentence at all. Binding the rat there would
     * leave a look queued against a sentence that never comes, which the next
     * wound line would then answer — one monster's condition on another's bar.
     */
    const players = matched.filter((who) => who.kind === 'player');
    if (players.length === 1) return players[0]?.name ?? null;
    const mobs = matched.filter((who) => who.kind === 'mob');
    if (mobs.length === 1) return mobs[0]?.name ?? null;
    /*
     * Genuinely ambiguous, or ambiguous only because this client cannot tell
     * what a name is (`kind` is `unknown` for a capitalised stranger). Either
     * way the server is about to refuse, and `target-ambiguous` will drop the
     * queue entry. Returning the first match would name a monster the answer
     * is not about.
     */
    return null;
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
   * exists for. The tracker has always honoured it; `SessionManager.markFor`
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

  /**
   * The last few moves the character is known to have made, oldest first.
   *
   * See `TrailStep`. This is *where we came from*, and it is here rather than
   * in `Walker` because the tracker is the only thing that knows: it holds the
   * expectation queue that says a move was asked for, and it does the room
   * resolution that says where the move landed. Every move goes through this
   * one place — a walker step, a typed direction, a party follow — so the trail
   * does not care who was driving, which is the whole of the difference from
   * the walker's own history.
   *
   * Bounded by `tuning.walk.recentSteps`. Cleared by `reset()` — a new
   * connection — and by a death, because the realm moves a dead character to
   * its area's temple along no edge and the trail out of the room it died in
   * leads back to whatever killed it.
   */
  get trail(): readonly TrailStep[] {
    return this.backtrail;
  }

  /**
   * The way back out of `here`, when the last confirmed move landed here.
   *
   * The strongest answer an escape can have: an exit *known* to lead somewhere
   * this character was standing, alive, moments ago — as against an exit the
   * realm data says exists, which is only known to lead somewhere.
   *
   * Null when the character is not standing where the newest move left it: the
   * opposite of a step taken from somewhere else leads somewhere else. That is
   * a real refusal rather than a formality, because a retreat that has already
   * run once is exactly the case — see `SessionManager.escape`, which walks
   * further down the trail before it gives up on retracing.
   */
  wayBackFrom(here: RoomId): TrailStep | null {
    const last = this.backtrail.at(-1);
    return last !== undefined && last.to === here ? last : null;
  }

  reset(): void {
    // A new session, not a new realm: what the realm knows about the other
    // players is seeded back in, everyone offline until this session sees them.
    this.state = {
      ...structuredClone(EMPTY_CHARACTER),
      players: absorbFacts(NO_PLAYERS, this.players.recall()),
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
      spellbook: this.belongings.recallSpellbook()?.map((spell) => ({ ...spell })) ?? null
    };
    this.room.discard();
    this.expect.forget();
    // A new connection is a new journey. Nothing on the old trail is known to
    // be one room from where the character is standing now.
    this.backtrail = [];
    // Discarded rather than settled: a reset is a new session, and a fight that
    // was in progress has an unknown outcome. Learning from it would record a
    // survival that never happened.
    this.fight.forget();
    this.packChanges = [];
    // A new session must not file an equipment block against whoever the last
    // one was looking at when the socket closed.
    this.lookedAt = null;
    // And it is standing in no bank until one answers.
    this.vault = null;
    this.lastSelfCast = null;
    this.buffEffects.clear();
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
  leaveRealm(): boolean {
    this.expect.dropHint();
    if (this.state.phase === 'unknown' && this.state.room.name === null) return false;
    this.state = {
      ...this.state,
      phase: 'unknown',
      room: emptyRoom(),
      inCombat: false,
      // A fight cannot continue through a closed socket, and a remembered
      // target would be the first thing a rule swung at on reconnecting.
      combat: NO_COMBAT,
      /*
       * And the running totals go with it. They are *this visit's* fighting:
       * an engagement clock left open across a closed socket would count the
       * hours the client sat disconnected as time spent in combat, and a rate
       * would be read off marks with a night in the middle of them.
       */
      tally: NO_TALLY,
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
       * Everyone is marked offline and **nobody is forgotten**. `online` above
       * is a listing about a realm this character has left, so it goes; the
       * registry is what was learned about those people, and "when did I last
       * see them, and where" is a question asked precisely about somebody who
       * is no longer there. Clearing it here would put the client back in the
       * state the registry exists to end.
       */
      players: allOffline(this.state.players, Date.now()),
      lastStatusAt: null
    };
    this.room.discard();
    this.expect.forget();
    // A socket that closed mid-fight says nothing about whether the monster
    // lived, so nothing is learned from it. Recording a survival here would put
    // a floor under an entry on the strength of a disconnection.
    this.fight.forget();
    // The balances stay — they are what the banks said. Standing in one does
    // not survive a closed socket.
    this.vault = null;
    return true;
  }

  /**
   * Which of the two kinds each entry of `Also here:` is.
   *
   * The realm data is reached through `this.world`, which is why this lives on
   * the tracker rather than beside the pure classifier: `classifyOccupant` is
   * dependency-free and takes a lookup, and the graph is a main-process thing.
   *
   * A character with no realm at all — the anonymous session, every unit test
   * that does not pass one — still gets a useful answer: the roster and the
   * listing's own annotations both work without it, and the capitalisation
   * heuristic is what the `mobs` guard field has always been.
   */
  private classify(entries: readonly string[], roster: readonly Adventurer[]): RoomOccupant[] {
    const players = new Set(roster.map((entry) => entry.name.toLowerCase()));
    const world = this.world;
    return entries.map((entry) =>
      classifyOccupant(entry, {
        players,
        mob: (name) => {
          const known = world?.mob(name);
          return known === undefined
            ? undefined
            : {
                disposition: known.disposition,
                uncertain: known.uncertain,
                costly: known.costly
              };
        }
      })
    );
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
  /**
   * A move landed, and both ends of it are known. Write it down.
   *
   * The one place *where we came from* is recorded, called from the one place a
   * room block is committed — so a step the walker sent, a direction the player
   * typed and a party follow all reach it the same way, which is the whole
   * point of it living here (see `TrailStep`).
   *
   * Four things must hold, and each is a refusal rather than a default:
   *
   * - **A move was expected.** `moved` is the direction off the expectation the
   *   arriving room consumed. A room block nobody asked for — the server's own
   *   courtesy reprint, a look — moved nothing.
   * - **It was a compass move.** A teleport is queued as a move with no
   *   direction, and it arrives along no edge: there is no opposite to state.
   * - **Both ends are placed.** An unresolved or ambiguous room is not a room
   *   to claim a way back to. Refuse rather than guess.
   * - **The ends differ.** A move the server refused can still be answered with
   *   a room block for where the character already stands, and `n` recorded as
   *   leading from a room to itself would make `s` the way out of it.
   */
  private rememberTheWayBack(s: CharacterState, room: Room, moved: Direction | null): void {
    if (moved === null) return;
    if (room.map === null || room.number === null) return;
    if (s.room.map === null || s.room.number === null) return;
    const from = roomId(s.room.map, s.room.number);
    const to = roomId(room.map, room.number);
    if (from === to) return;
    this.backtrail.push({ from, direction: moved, to });
    if (this.backtrail.length > tuning().walk.recentSteps) this.backtrail.shift();
  }

  private attachRealm(room: Room): void {
    const world = this.world;
    if (world === undefined || room.map === null || room.number === null) return;
    const placed = world.get(room.map, room.number);
    if (placed === undefined) return;

    room.shop = placed.shop === undefined ? null : (world.shop(placed.shop) ?? null);
    room.lair = world.lair(placed);
    if (placed.commands !== undefined) room.commands = placed.commands;
    room.spell = placed.spell === undefined ? null : world.spellById(placed.spell);
    if (placed.light !== undefined) room.lightLevel = placed.light;
    room.npc = world.buildNpcEntity(placed);
    // Now that the room is placed, its exits can say where they go.
    room.exits = world.buildExitEntities(room.exits, placed);
  }

  /**
   * A thing on the floor or in the pack, joined to the realm's row.
   *
   * One call site for the join so a floor item and a carried one cannot come
   * out differently shaped. A character with no realm at all still gets a
   * whole entity — `source: 'wire'` — which is the dual-source rule and the
   * reason this can be called unconditionally.
   */
  private itemEntity(
    name: string,
    observed: Parameters<WorldGraph['buildItemEntity']>[1] = {}
  ): ItemEntity {
    const world = this.world;
    return world === undefined ? wireItem(name, observed) : world.buildItemEntity(name, observed);
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
  private hydrate(occupants: RoomOccupant[], s: CharacterState): RoomOccupant[] {
    const world = this.world;
    return occupants.map((occupant) => {
      if (occupant.kind === 'mob') {
        if (world === undefined) return occupant;
        return {
          ...occupant,
          mob: world.buildMobEntity(occupant.name, { charmed: occupant.charmed === true })
        };
      }
      if (occupant.kind === 'player') {
        const key = playerKey(occupant.name);
        const listed = s.online.find((entry) => playerKey(entry.name) === key) ?? null;
        return {
          ...occupant,
          player: playerEntity(occupant.name, {
            record: s.players[key] ?? null,
            roster: listed,
            hidden: occupant.hidden === true,
            free: occupant.free === true,
            inParty: s.party.members.some((member) => playerKey(member.name) === key),
            // The worn kit a `look` printed, priced by the realm where it can.
            equip: (item) => this.itemEntity(item.name, { slot: item.slot, equipped: true })
          })
        };
      }
      // `unknown` is left alone on purpose: a named NPC and a person nobody
      // has listed look identical, and attaching either entity to one would
      // be the reassuring guess this classification exists to refuse.
      return occupant;
    });
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
   * The carried item the realm says teaches a spell, or null.
   *
   * `Items.Abil-n` holds `LearnSp` with the `Spells` row id in the value
   * beside it — 223 items on the shipped realm — so this is a lookup rather
   * than a guess, and it is the only thing that can connect
   * `You add minor healing to your spellbook!` back to the scroll that was
   * read, since the sentence names no item.
   *
   * Names go through `bareName` for `itemsNamed`'s sake: the index is keyed by
   * the realm's own name and a listing annotates what is in use. Null wherever
   * the answer is not certain — no realm loaded, an item the index does not
   * carry, or a name the realm has never heard of — because the caller's other
   * half stands on its own and an unnecessary removal does not correct itself.
   */
  private scrollTeaching(state: CharacterState, spellId: number): string | null {
    const world = this.world;
    if (!world) return null;
    const names = state.inventory.items.map((held) => bareName(held.name));
    const known = world.itemsNamed(names);
    for (const name of names) {
      const teaches = known[name]?.abilities?.some(
        ([id, value]) => id === LEARN_SPELL_ABILITY && value === spellId
      );
      if (teaches === true) return name;
    }
    return null;
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
   * The attacker a combat line names, held to what the client can vouch for.
   *
   * A name the room or the realm resolved is taken as read. One the classifier
   * guessed from grammar — the leading capitalised word of a line with no
   * article — is taken only if the realm roster or this room already knows
   * it: `Rend surprise chops you` names a player the `who` listing has, while
   * `Acid burns you for 1 damage!` (captured live, `npm run probe:stealth`)
   * names nobody, and a blow from nobody is counted and attributed to no one
   * rather than putting "Acid" in `attackers` for a rule to swing at.
   */
  private vouchedFor(s: CharacterState, g: Record<string, string>): string | undefined {
    const attacker = g['attacker'];
    if (attacker === undefined || g['guessed'] !== 'attacker') return attacker;
    const key = attacker.toLowerCase();
    const known =
      s.online.some((entry) => entry.name.toLowerCase() === key) ||
      s.room.occupants.some((who) => who.name.toLowerCase() === key) ||
      s.party.members.some((member) => member.name.toLowerCase() === key);
    return known ? attacker : undefined;
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
  private withOccupant(state: CharacterState, name: string): Room {
    const key = mobKey(name);
    if (key.length === 0) return state.room;
    if (state.room.occupants.some((who) => mobKey(who.name) === key)) return state.room;
    const [entry] = this.classify([name], state.online);
    if (entry === undefined) return state.room;
    return { ...state.room, occupants: [...state.room.occupants, entry] };
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
  private arrivedUnseen(s: CharacterState, unseen: 'dark' | 'blind'): CharacterState | null {
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
    const landed = promised ? this.world?.byId(roomId(promised.map, promised.number)) : null;
    const arrived =
      landed !== null && landed !== undefined && landed.light !== undefined && landed.light < 0
        ? landed
        : null;

    this.room.discard();
    // An arrival nothing described: the looks and the unmodelled command were
    // about the room just left.
    this.expect.clearLooks();
    this.expect.takeUnmodelled(false);
    const combat =
      s.combat.attackers.length > 0 || s.combat.target !== null
        ? { ...s.combat, attackers: [], target: null, health: null }
        : s.combat;

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
     * every rung of `SessionManager.wayOut` went quiet at once and the escape
     * had to refuse. The way in was the single thing the client did know, and
     * it was being thrown away here.
     */
    this.attachRealm(room);
    this.rememberTheWayBack(s, room, expectation.direction);

    return { ...s, room, combat };
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
    const world = this.world;
    return occupants.map((who) => {
      const fresh = classifyOccupant(who.name, {
        players,
        mob: (name) => {
          const known = world?.mob(name);
          return known === undefined
            ? undefined
            : {
                disposition: known.disposition,
                uncertain: known.uncertain,
                costly: known.costly
              };
        }
      });
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
      // The data already knows this way out. Every ordinary step lands here.
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
   * Reports a shop selling something the realm data does not list it as
   * stocking.
   *
   * Narrow, like every other discovery, and for the same reason — this writes
   * to a character's permanent record:
   *
   * - **The room has to be known**, and has to be a shop the realm has stock
   *   for. Against a shop the data says nothing about, "not listed" is not a
   *   finding; it is the absence of data, and every purchase would produce one.
   * - **Names are compared the way items are compared everywhere else**, so an
   *   article or an equipment slot cannot make a listed item look unlisted.
   */
  private noticeStock(state: CharacterState, item: string | undefined): void {
    if (!this.onDiscovery || !this.world || !item) return;
    const { map, number: roomNumber } = state.room;
    if (map === null || roomNumber === null) return;

    const id = roomId(map, roomNumber);
    const here = this.world.byId(id);
    if (!here?.shop) return;
    const shop = this.world.shop(here.shop);
    // No stock recorded is not "stocks nothing": it is a shop the realm data
    // cannot speak for, and every purchase there would otherwise be a finding.
    if (!shop) return;
    if (shop.items.some((stocked) => sameItem(stocked.name, item))) return;

    this.onDiscovery({
      reason: 'unknown-stock',
      from: id,
      fromName: shop.name.length > 0 ? shop.name : here.name,
      command: item.trim(),
      to: null,
      name: item.trim(),
      exits: [],
      at: Date.now()
    });
  }

  /**
   * Moves the standing vault's balance by `copper`, and writes it down.
   *
   * Returns the state untouched when there is no vault (no `bank` has been
   * answered in this room) or when the vault is not one this character has a
   * figure for — the first is the ordinary case of banking without asking
   * first, and the second cannot happen while `this.vault` is only ever set
   * from the block that also records the balance, but is checked rather than
   * assumed because a `BankBalance` created here from nothing would be a
   * balance invented out of a single deposit.
   */
  private creditVault(s: CharacterState, copper: number, at: number): CharacterState {
    const standing = this.vault;
    if (standing === null || copper === 0) return s;
    const key = bankKey(standing.name);
    const held =
      (standing.shop === null ? undefined : s.banks.find((b) => b.shop === standing.shop)) ??
      s.banks.find((b) => bankKey(b.name) === key);
    if (held === undefined) return s;
    const next = withBankBalance(s, {
      ...held,
      copper: Math.max(0, held.copper + copper),
      at
    });
    this.belongings.rememberBanks(next.banks);
    return next;
  }

  /**
   * Applies one block. Returns true if anything changed, so the caller can
   * avoid republishing state on every unremarkable line — which, during a
   * combat burst, is most of them.
   */
  /**
   * The experience table, worked out from the realm data when nothing else has.
   *
   * Folded here rather than in a case, for the reason `trackPlayers` and
   * `trackTally` are: its three inputs — the race, the class and the level —
   * are set by four different blocks, and a line in each of them is four
   * chances to forget one.
   *
   * **It never overwrites a row the realm stated, and a row that contradicts one
   * stops it adding anything at all** — `withDerivedExperience` is where that
   * lives, and why it merges rather than switching itself off: GreaterMUD's
   * `exp` prints no table, so on the realm this client defaults to the wire
   * only ever states one row and freezing on it left a chart of one.
   *
   * The guard is exact rather than cautious: nothing that feeds the sum has
   * moved, so the sum cannot have changed. That matters because this runs on
   * every block, and a status line arrives several times a second.
   */
  private withDerivedExperience(state: CharacterState, before: CharacterState): CharacterState {
    const table = state.progress.expTable;
    const level = state.progress.level;
    if (
      state.race === before.race &&
      state.className === before.className &&
      level === before.progress.level &&
      table === before.progress.expTable
    )
      return state;

    const world = this.world;
    if (!world || state.race === null || state.className === null || level === null) return state;
    const percent = world.experiencePercent(state.race, state.className);
    if (percent === null) return state;
    const derived = derivedExperienceTable(percent, level);
    if (derived === null) return state;
    const merged = withDerivedExperience(table, derived);
    if (merged === table) return state;
    return { ...state, progress: { ...state.progress, expTable: merged } };
  }

  apply(block: Block, rows?: Array<Record<string, string>>): boolean {
    const before = this.state;
    const reduced = this.reduce(block, rows);
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
    if (moved) this.vault = null;
    const next =
      reduced !== null && reduced.shopListing !== null && moved
        ? { ...reduced, shopListing: null }
        : reduced;
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
    const base = this.withDerivedExperience(next ?? this.state, before);
    const players = trackPlayers(base.players, block, base, before);
    /*
     * And what the fighting has added up to, folded from the same place and
     * for the same reason — see `trackTally`. It reads the engagement clock
     * off the *transition*, so it is given both states rather than only the
     * one the reducer produced.
     */
    const tally = trackTally(base.tally, block, base, before);
    if (!next) {
      if (base === this.state && players === this.state.players && tally === this.state.tally)
        return false;
      this.state = { ...base, players, tally, updatedAt: block.at };
      this.rememberPlayers(before.players, players);
      return true;
    }
    this.state = { ...base, players, tally, updatedAt: block.at };
    this.rememberPlayers(before.players, players);
    /*
     * What is worn, written down, from the one place a new state is committed
     * — the same placement `rememberPlayers` has and for the same reason: a
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
      this.rememberSight();
    }
    /*
     * The realm's row for what is being fought, joined from the one place a
     * new state is committed — the placement `rememberPlayers` and the gear
     * already have, and for the reason stated there: a line in each of the
     * dozen combat cases that can move the target is a dozen chances to
     * forget one.
     *
     * Only when the *name* changed. A status line arrives several times a
     * second through a whole fight and none of them changes what a giant rat
     * is; re-resolving on each would be a lookup per prompt for one answer.
     */
    if (this.state.combat.target !== before.combat.target) this.resolveTarget();
    // The book, written down from the same single commit point as the gear.
    if (this.state.spellbook !== before.spellbook && this.state.spellbook !== null)
      this.belongings.rememberSpellbook(this.state.spellbook);
    return this.state !== before;
  }

  /**
   * The realm's whole row for what this character is swinging at.
   *
   * Null for a player, for a monster the realm cannot place, and when there is
   * no target — all three of which are ordinary, and none of which is an
   * error. A player is deliberately not built into a `MobEntity` here: the
   * classification that tells a person from a monster lives on the room's
   * occupants, and inventing a monster row for somebody would be the
   * reassuring guess this client refuses everywhere else.
   */
  private resolveTarget(): void {
    const world = this.world;
    const name = this.state.combat.target;
    if (name === null || world === undefined) {
      if (this.state.combat.targetEntity !== null) {
        this.state = { ...this.state, combat: { ...this.state.combat, targetEntity: null } };
      }
      return;
    }
    // A person is not a monster. The room's own classification is the
    // authority on which this is, and it has already been made.
    const occupant = this.state.room.occupants.find((there) => mobKey(there.name) === mobKey(name));
    if (occupant?.kind === 'player') {
      this.state = { ...this.state, combat: { ...this.state.combat, targetEntity: null } };
      return;
    }
    const built = world.buildMobEntity(name, { charmed: occupant?.charmed === true });
    // A wire-only entity carries nothing the name did not already say, so it
    // is not worth publishing — `null` is the honest answer for a monster the
    // realm cannot place, and the card already says so.
    const entity = built.source === 'wire' ? null : built;
    this.state = { ...this.state, combat: { ...this.state.combat, targetEntity: entity } };
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
   * The `st` sheet's buff timers, applied to the buffs they name.
   *
   * `You feel safe from evil! (90s)` states when `protection from evil` ends,
   * but only the learned onset map (`buffEffects`) knows *which* buff `safe
   * from evil` is. An unlearned effect is left alone — refusing to guess,
   * because attributing a countdown to the wrong shield is worse than none —
   * and a countdown for a buff not on the list is ignored the same way. The
   * server's statement, so it overwrites any earlier `expiresAt`.
   */
  private applyBuffTimers(buffs: readonly ActiveBuff[], text: string, at: number): ActiveBuff[] {
    const stated = new Map<string, number>();
    for (const match of text.matchAll(/You feel (?<effect>[\w' -]+?)! \((?<seconds>\d+)s\)/g)) {
      const effect = match.groups?.['effect']?.trim().toLowerCase();
      const seconds = Number(match.groups?.['seconds']);
      const spell = effect ? this.buffEffects.get(effect) : undefined;
      if (spell !== undefined && Number.isFinite(seconds)) {
        stated.set(spell.toLowerCase(), at + seconds * 1000);
      }
    }
    if (stated.size === 0) return buffs.map((buff) => ({ ...buff }));
    return buffs.map((buff) => {
      const expiresAt = stated.get(buff.spell.toLowerCase());
      return expiresAt === undefined ? { ...buff } : { ...buff, expiresAt };
    });
  }

  /**
   * What the character sees by, recomputed where the pack or the race moved.
   *
   * The race's night vision comes off the realm's race table and the rest off
   * the pack's own entities, so this is the same join the loadout is and sits
   * beside it. Nothing before the first listing: a sight worked out from an
   * empty pack and an unnamed race would say the character sees in the dark
   * by nothing, which is a number `AutoLight` would act on.
   */
  private rememberSight(): void {
    const s = this.state;
    const race = s.race === null ? null : (this.world?.raceAbilities(s.race) ?? null);
    if (race === null && s.inventory.items.length === 0) {
      if (s.sight !== null) this.state = { ...s, sight: null };
      return;
    }
    const vision =
      (race === null
        ? 0
        : abilitySum(race, NIGHT_VISION_ABILITY) + abilitySum(race, ROOM_LIGHT_ABILITY)) +
      wornVision(s.inventory.items);
    const sight = sightOf(vision, carriedLights(s.inventory.items), race !== null);
    if (sameSight(s.sight, sight)) return;
    this.state = { ...s, sight };
  }

  /**
   * Note that somebody sent an `@` command. See `noteRemoteCall`.
   *
   * On the tracker because the registry lives on `CharacterState` and this is
   * what owns it; `Remotes` proposes and never reaches into state itself.
   */
  noteRemoteCall(from: string, raw: string, at: number): boolean {
    const before = this.state.players;
    const players = noteRemoteCall(before, from, raw, at);
    if (players === before) return false;
    this.state = { ...this.state, players, updatedAt: at };
    this.rememberPlayers(before, players);
    return true;
  }

  /**
   * Every record a block changed goes to the realm's book.
   *
   * By identity: `observe` returns the same record when nothing about it
   * changed, so a registry that differs names exactly the records worth telling
   * the realm about, and the walk is over the registry only on a block that
   * changed it. The book merges and decides for itself whether anything in the
   * record was news to the realm — a record that changed only in what is this
   * session's own (`inParty`, an `@` command) is not.
   */
  private rememberPlayers(before: PlayerRegistry, after: PlayerRegistry): void {
    if (before === after) return;
    /*
     * Only from inside the realm. Nothing at a login menu produces a player —
     * but this record is written to disk and read back by every character on
     * the realm, and the one place a password is typed is that menu, so the
     * guard sits at the point of capture rather than as a second redaction:
     * the rule `WorldMemory` keeps for the other realm-wide record.
     */
    if (this.state.phase !== 'in-game') return;
    for (const [key, record] of Object.entries(after)) {
      if (before[key] !== record) this.players.remember(toFacts(record));
    }
  }

  /**
   * What another session on this realm learned, folded in.
   *
   * Returns whether anything changed, so the caller can republish. Never
   * written back: the book is where it came from, and a session that
   * remembered what it was just told would hand it straight back to every
   * other session, forever.
   */
  /**
   * The realm the next connection dials, when it is not the character's own.
   *
   * A character can be dialled at a saved realm from the palette, and what is
   * learned there belongs to *that* realm's book. Takes effect at `reset()`,
   * which every connection runs: the registry is seeded from the new realm, and
   * what was seeded from the old one goes with the session it was seeded for.
   */
  useRealm(players: RealmPlayers): void {
    this.players = players;
  }

  /**
   * Where the next connection's own record is kept.
   *
   * Beside `useRealm` and for its reasons: a vault and a kit are both the
   * *server's*, so a character dialled at a saved realm from the palette must
   * not be shown the savings or the slots it has somewhere else. Takes effect
   * at `reset()`, which every connection runs.
   */
  useBelongings(belongings: BelongingsSink): void {
    this.belongings = belongings;
  }

  absorbPlayers(batch: readonly PlayerFacts[]): boolean {
    const players = absorbFacts(this.state.players, batch);
    if (players === this.state.players) return false;
    this.state = { ...this.state, players, updatedAt: Date.now() };
    return true;
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

  /**
   * Whether a name the server printed is this character's own.
   *
   * Compared against the name the *server* resolved — a look at `vae` answers
   * `[ Vaelor ]` — rather than against what was typed, so a prefix is not a
   * different person. Null while nobody has said what this character is called,
   * which is the honest answer: unknown is not "yes".
   */
  private isSelf(name: string | null): boolean {
    const own = this.state.name;
    return own !== null && name !== null && own.toLowerCase() === name.trim().toLowerCase();
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
  private forgetCharacter(realm: RealmFamily | null): CharacterState {
    const s = this.state;
    this.room.discard();
    // Nothing outstanding can be answered from the menu, and a room arriving
    // after the next login must not be resolved against a move typed before it.
    this.expect.forget();
    // A fight interrupted by walking out has an unknown outcome; learning from
    // it would record a survival that never happened.
    this.fight.forget();
    this.packChanges = [];
    this.lookedAt = null;
    this.vault = null;
    return {
      ...structuredClone(EMPTY_CHARACTER),
      realm,
      phase: 'authenticating',
      // Everyone offline and nobody forgotten: the listing described a realm
      // this character has left, and the registry is what was learned about
      // those people, which is precisely what outlives their being here.
      players: allOffline(s.players, Date.now()),
      banks: s.banks.map((bank) => ({ ...bank })),
      loadout: s.loadout.map((worn) => ({ ...worn }))
    };
  }

  private reduce(block: Block, rows?: Array<Record<string, string>>): CharacterState | null {
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

      case 'login-welcome': {
        // GreaterMUD's welcome names the server; kept only where the menu has
        // not named the data, which is the more specific of the two.
        const realm =
          s.realm === null && /greatermud/i.test(g['realm'] ?? '') ? 'greatermud' : s.realm;
        if (g['name']) return { ...s, name: g['name'], realm, phase: 'authenticating' };
        return realm === s.realm ? null : { ...s, realm };
      }

      /* -------------------------------------------------------- status */
      case 'user-health': {
        /*
         * `health` reports current *and* maximum on one line.
         *
         * The status line carries no maximum and the stat sheet costs a whole
         * screen, so this is the cheap way to learn one — and the only one a
         * rule can afford to run often. Both numbers are taken: they arrive
         * together and are therefore consistent with each other, which two
         * separate readings would not be.
         */
        const hp = int(g['hp']);
        const hpMax = int(g['hpMax']);
        if (hp === null && hpMax === null) return null;
        return {
          ...s,
          vitals: { ...s.vitals, hp: hp ?? s.vitals.hp, hpMax: hpMax ?? s.vitals.hpMax }
        };
      }

      case 'status-line': {
        // The in-game discriminator. Everything else about phase is a guess;
        // this is the server telling us directly.
        const hp = int(g['hp']);
        const mana = int(g['mana']);
        const state = g['stateA'] ?? g['stateB'];
        // A realm that puts the maximum in the prompt says it on every line;
        // one that does not leaves what the stat sheet said alone.
        const hpMax = int(g['hpMax']) ?? s.vitals.hpMax;
        const manaMax = int(g['manaMax']) ?? s.vitals.manaMax;
        const key = g['manaType'];
        const manaType: 'MA' | 'KAI' | null =
          key === 'MA' || key === 'M'
            ? 'MA'
            : key === 'KAI' || key === 'K'
              ? 'KAI'
              : s.vitals.manaType;
        const extra = statusFields(g['fields']);
        return {
          ...s,
          phase: 'in-game',
          lastStatusAt: block.at,
          vitals: {
            ...s.vitals,
            hp,
            mana,
            hpMax,
            manaMax,
            manaType,
            resting: state === 'Resting',
            meditating: state === 'Meditating'
          },
          progress: {
            ...s.progress,
            exp: extra.exp ?? s.progress.exp,
            expNeeded: extra.need ?? s.progress.expNeeded,
            // The first status line is when the session's clock starts: it is
            // the moment the realm is provably on the other end.
            realmEnteredAt: s.progress.realmEnteredAt ?? block.at
          },
          inventory:
            extra.wealth !== undefined ? { ...s.inventory, wealth: extra.wealth } : s.inventory
        };
      }

      /* `You are now resting.` arrives before the status line that carries the flag. */
      case 'user-rests':
        return {
          ...s,
          vitals: {
            ...s.vitals,
            resting: g['state'] === 'resting',
            meditating: g['state'] === 'meditating'
          }
        };

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
       * from a room, now, that may have somebody else in it.
       *
       * `combat` is emptied rather than the room: the temple's own block is two
       * lines away and will replace the room outright, and clearing it here
       * would blank the map for those two lines.
       */
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
        this.backtrail = [];
        // Death strips what was cast: the temple room two lines away holds a
        // character with none of its blessings, and a list kept through it
        // would stop every recast until each fallback clock ran out.
        return { ...s, inCombat: false, combat: NO_COMBAT, buffs: [] };
      }

      /*
       * `You have 8 lives left.` — the server restating the figure at the one
       * moment it changes, which is exactly the maintained-listing shape: the
       * stat sheet's `Lives/CP:` establishes it, this keeps it true for free.
       *
       * Unlike `You gain N additional lives.` above, this is an absolute and
       * needs no prior total: the server counted for us.
       */
      case 'user-lives': {
        const lives = int(g['lives']);
        if (lives === null || lives === s.progress.lives) return null;
        return { ...s, progress: { ...s.progress, lives } };
      }

      /* The guild said so; the next `exp` will agree. */
      case 'user-levels': {
        const level = int(g['level']);
        if (level === null || level === s.progress.level) return null;
        /*
         * A level changes the maxima, and the stat sheet that stated them is
         * now wrong: the first play session reported 165% health for the rest
         * of the evening. Unknown is honest, and every threshold here reads
         * unknown as "do not act" — until the next `st` or `health` says.
         */
        return {
          ...s,
          progress: { ...s.progress, level },
          vitals: { ...s.vitals, hpMax: null, manaMax: null }
        };
      }

      case 'user-experience': {
        const level = int(g['level']);
        /*
         * The parenthesised figure is the **price of the next level**, and it
         * is one row of the table for free: `Exp: 228060 Level: 10 Exp needed
         * for next level: 125343 (353403)` — the difference is exactly what is
         * owed (captures/007, and three more in the corpus say the same). It
         * was captured and discarded for as long as this pattern has existed.
         */
        const required = int(g['required']);
        const stated: ExperienceLevel[] =
          level !== null && required !== null
            ? [{ level: level + 1, experience: required, source: 'realm' }]
            : [];
        return {
          ...s,
          progress: {
            ...s.progress,
            exp: int(g['exp']),
            level,
            expNeeded: int(g['needed']),
            expTable: withRealmExperience(s.progress.expTable, stated)
          }
        };
      }

      /*
       * The table itself — what each level in the window costs. The realm's own
       * word, so it wins wherever a derivation disagreed; `withRealmExperience`
       * has what that costs the rest of the table.
       */
      case 'user-experience-table': {
        const stated: ExperienceLevel[] = [];
        for (const row of rows ?? []) {
          const level = int(row['level']);
          const experience = int(row['experience']);
          if (level === null || experience === null) continue;
          stated.push({ level, experience, source: 'realm' });
        }
        if (stated.length === 0) return null;
        return {
          ...s,
          progress: { ...s.progress, expTable: withRealmExperience(s.progress.expTable, stated) }
        };
      }

      case 'user-gain-experience': {
        const gained = int(g['exp']) ?? 0;
        // Something died, and the fight says which thing and takes it out of
        // the room and the attacker list — see `FightTracker.died`.
        const after = this.fight.died(s, block.at);
        return {
          ...after,
          progress: {
            ...s.progress,
            exp: s.progress.exp === null ? null : s.progress.exp + gained,
            expNeeded:
              s.progress.expNeeded === null ? null : Math.max(0, s.progress.expNeeded - gained),
            expThisSession: s.progress.expThisSession + gained
          }
        };
      }

      case 'user-profile': {
        const map = int(g['map']);
        const number = int(g['room']);
        if (map === null || number === null) return null;
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

      case 'player-status': {
        // The stat sheet is where maxima come from; the status line has none.
        return {
          ...s,
          // Paramud's `st` prints a countdown after each active buff; the
          // batch swallows those lines, so they are read out of the sheet text
          // and attributed through the learned onset map. See `applyBuffTimers`.
          buffs: this.applyBuffTimers(s.buffs, block.text, block.at),
          name: g['first'] ?? s.name,
          fullName: g['first'] ? [g['first'], g['last'] ?? ''].join(' ').trim() : s.fullName,
          race: g['race'] ?? s.race,
          className: g['class'] ?? s.className,
          vitals: {
            ...s.vitals,
            hpMax: int(g['hpMax']) ?? s.vitals.hpMax,
            manaMax: int(g['manaMax']) ?? s.vitals.manaMax,
            /*
             * The sheet's own word for the resource — `Kai:` against `Mana:`
             * — which is the same fact the prompt's `KAI=`/`MA=` states, and
             * the sheet says it even on a realm whose prompt omits the field.
             * It is what decides whether the spellbook is asked for with
             * `spells` or `powers`.
             */
            manaType:
              g['resourceWord'] === 'Kai'
                ? 'KAI'
                : g['resourceWord'] === 'Mana'
                  ? 'MA'
                  : s.vitals.manaType
          },
          progress: {
            ...s.progress,
            level: int(g['level']) ?? s.progress.level,
            lives: int(g['lives']) ?? s.progress.lives,
            /*
             * The sheet states the running total, and on this realm it is the
             * *only* thing that does: experience is otherwise read from the
             * status line's `Exp=` field, which the live Paradigm server does
             * not send. Vaelor's sheet said `Exp: 34603` while `progress.exp`
             * stayed null — the number was on screen and the client threw it
             * away (measured live, 2026-08-27).
             */
            exp: int(g['exp']) ?? s.progress.exp,
            strength: int(g['strength']) ?? s.progress.strength,
            picklocks: int(g['picklocks']) ?? s.progress.picklocks,
            // What a blow's size turns on, which `FightLog` records without.
            martialArts: int(g['martialArts']) ?? s.progress.martialArts,
            magicRes: int(g['magicRes']) ?? s.progress.magicRes,
            // The rest of the sheet, for the Self card — parsed since the
            // sheet was, kept since 2026-09-03.
            intellect: int(g['intellect']) ?? s.progress.intellect,
            willpower: int(g['willpower']) ?? s.progress.willpower,
            agility: int(g['agility']) ?? s.progress.agility,
            health: int(g['health']) ?? s.progress.health,
            charm: int(g['charm']) ?? s.progress.charm,
            perception: int(g['perception']) ?? s.progress.perception,
            stealthSkill: int(g['stealth']) ?? s.progress.stealthSkill,
            thievery: int(g['thievery']) ?? s.progress.thievery,
            traps: int(g['traps']) ?? s.progress.traps,
            tracking: int(g['tracking']) ?? s.progress.tracking,
            spellcasting: int(g['spellcasting']) ?? s.progress.spellcasting,
            armourClass: int(g['ac']) ?? s.progress.armourClass,
            damageResist: int(g['dr']) ?? s.progress.damageResist,
            cp: int(g['cp']) ?? s.progress.cp
          }
        };
      }

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

      case 'room-items': {
        /*
         * One comma-separated line mixing things and coins, exactly as the
         * pack listing does — so it is split the same way. Coins fold into
         * `room.cash` rather than joining the item list: `18 gold` among the
         * items lands in the paste of what is lying here and reads as
         * something to `get` by name.
         */
        const entries = list(g['items']);
        const items: ItemEntity[] = [];
        let cash: CurrencyEntity | null = null;
        for (const entry of entries) {
          const coin = parseCoinEntry(entry);
          if (coin !== null) {
            cash = addCoins(cash, coin.denomination, coin.count);
            continue;
          }
          items.push(this.itemEntity(entry));
        }
        this.room.items(items);
        // A listing is authoritative and replaces what is there — including
        // saying there are no coins, which a fold could not.
        this.room.cash(cash);
        return null;
      }

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
      case 'room-hidden-items': {
        const entries = list(g['items']);
        const items: ItemEntity[] = [];
        let cash: CurrencyEntity | null = null;
        for (const entry of entries) {
          const coin = parseCoinEntry(entry);
          if (coin !== null) {
            cash = addCoins(cash, coin.denomination, coin.count);
            continue;
          }
          items.push(this.itemEntity(entry));
        }
        return { ...s, room: { ...s.room, hidden: items, hiddenCash: cash } };
      }

      /*
       * `Your search revealed nothing.` — the same listing, empty.
       *
       * A search is a listing and a listing is authoritative, so this clears
       * what the last one found. Only the **bare** search: the directional
       * form (`You notice nothing different to the north`) is a question about
       * an exit and says nothing about the floor, and `Walker` sends one at
       * every `Hidden/Searchable` edge it is refused by.
       */
      case 'user-search-failed': {
        if (g['direction'] !== undefined) return null;
        if (s.room.hidden.length === 0 && s.room.hiddenCash === null) return null;
        return { ...s, room: { ...s.room, hidden: [], hiddenCash: null } };
      }

      case 'room-also-here':
        this.room.occupants(this.hydrate(this.classify(list(g['who']), s.online), s));
        return null;

      case 'room-exits': {
        // Exits complete a room. Everything before this was provisional.
        const exits = list(g['exits']).map(parseExit);
        const room = this.room.complete(this.exitEntities(exits, null));

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
            const destination = exit ? this.world.byId(roomId(exit.map, exit.room)) : null;
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
        if (expectation !== null) this.expect.shift();
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
          this.room.discard();
          return null;
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
          this.room.discard();
          return { ...s, room };
        }

        const teleported = this.world && room.name ? this.expect.takeTeleport() : null;
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
            this.room.discard();
            return { ...s, room, combat };
          }
        }

        if (this.world && room.name) {
          const previous =
            s.room.map !== null && s.room.number !== null
              ? roomId(s.room.map, s.room.number)
              : null;

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
          const sameRoomAgain =
            anchor !== undefined &&
            anchor !== null &&
            anchor.name.trim().toLowerCase() === room.name.trim().toLowerCase();

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
            this.room.discard();
            return { ...s, room };
          }

          const located = resolveRoom(this.world, {
            name: room.name,
            exits: exits.map((exit) => exit.direction as Direction),
            previous,
            moved
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

          this.notice(s.room, room, moved ?? said, located.candidates.length);
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
        this.rememberTheWayBack(s, room, moved);

        this.room.discard();
        // `combat` is the leave-behind computed above, ahead of the early
        // returns, so every way out of this case agrees about the fight.
        return { ...s, room, combat };
      }

      case 'who-list': {
        /*
         * A listing is authoritative: it replaces the roster outright rather
         * than merging, because somebody absent from it has left. The room is
         * re-read against the new roster too — `Also here:` routinely arrives
         * before the first listing — which is the one thing here that needs
         * the realm table, so it stays with the tracker while the roster's
         * reading lives in `presence.ts`.
         */
        const roster = rosterFrom(rows);
        if (roster.length === 0) return null;
        return {
          ...s,
          online: roster,
          room: { ...s.room, occupants: this.reclassify(s.room.occupants, roster) }
        };
      }

      /* ------------------------------------------------------ presence */
      /*
       * Realm-wide announcements, and **not room occupancy** — `room.occupants`
       * comes from `Also here:` and nothing else. Somebody entering the realm
       * is nowhere near this room, and putting them in it is how a client
       * decides to run from a person on the other side of the map.
       *
       * Maintained from what the server volunteers.
       *
       * A `who` costs a command from the same budget everything else shares, so
       * re-asking to stay current is the expensive way to learn something the
       * server is already announcing. These keep the roster true between
       * listings; what they cannot supply is an alignment, so an arrival is
       * marked provisional rather than guessed at. Guessing one is exactly the
       * guess that gets somebody killed here.
       */
      case 'player-enters':
        return withArrival(s, g['player']);

      case 'player-look':
        /*
         * The `[ Name ] (Gang)` line opens a look at somebody, and the
         * equipment block follows it. Held so that block can be filed against
         * the name the *server* resolved, rather than against whatever was
         * typed — see `withEquipment`.
         */
        this.lookedAt = g['name'] ?? null;
        return withLookedAt(s, g['name'], g['gang']);

      case 'player-equipment': {
        /*
         * Somebody else's kit names slots too, and a slot word is a fact about
         * the realm rather than about who is wearing it — so the block teaches
         * the same table the character's own listing does. `<empty>` is a bare
         * slot, not an item (see `withEquipment`), and a charge count is not a
         * slot (`Readied/79`).
         */
        for (const row of rows ?? []) {
          const item = row['item']?.trim();
          const slot = row['slot']?.trim().replace(/\/\d+$/, '');
          if (item && slot && item !== '<empty>') this.teachSlot(item, slot, block.at);
        }

        /*
         * A look at **this character** is a listing about this character, and
         * for three phases it was the only one whose slots went nowhere:
         * `l vaelor` printed `silver ring   (Finger)` and the card went on
         * saying `in use`, because the block was read only for the slot table
         * and for the *other* player's record. The fact was on the wire,
         * matched by a rule, and dropped for the one character it was about.
         *
         * So it goes to the pack instead of to the registry. Instead, and not
         * as well: `trackPlayers` files everybody the roster lists **except**
         * self, precisely so a name in the console does not open a panel about
         * the person reading it — and this path reached `observe` directly,
         * which put this character in the registry the moment it looked at
         * itself. The roster entry `player-look` makes is right and stays: this
         * character *is* in the realm, and its own row is on the same roster.
         */
        if (this.isSelf(this.lookedAt)) {
          for (const row of rows ?? []) {
            const item = row['item']?.trim();
            const slot = row['slot']?.trim().replace(/\/\d+$/, '');
            if (item && slot && item !== '<empty>') this.wornAt.set(bareName(item), slot);
          }
          return withOwnEquipment(s, rows);
        }
        return withEquipment(s, this.lookedAt, rows, block.at);
      }

      /*
       * `bg`: the gang's whole membership, including the members who are not
       * logged in — the only listing on this server that names either.
       *
       * It lands in the registry rather than on the roster, because these are
       * facts about people rather than a statement of who is in the realm; see
       * `withGangListing`.
       */
      case 'gang-roster':
        return withGangListing(s, g['gang'], g['count'], rows, block.at);

      /*
       * Somebody joined or left this character's gang. A listing establishes
       * the membership and these keep it true for free — the maintained-listing
       * shape, and here the thing being maintained is a *permission*: the gang
       * grant answers `@` commands for whoever shares the gang, so a departure
       * has to take effect now rather than at the next `who`.
       */
      case 'gang-joined':
        return withGangJoined(s, g['player'], block.at);

      case 'gang-left':
        return withGangLeft(s, g['player'], g['gang'], block.at);

      /*
       * `gb` answered by a character in no gang. It settles the one thing the
       * Gang card cannot otherwise distinguish: `ownGang` is `undefined` while
       * nobody has said and `null` for a stated absence, and the difference is
       * what the card draws as "type who" versus "there is nothing to
       * configure". A `who` row settles it too, but this arrives first.
       */
      case 'gang-none':
        return s.gangListing?.gang === null
          ? null
          : { ...s, gangListing: { gang: null, expected: 0, short: null, at: block.at } };

      case 'player-exits':
      case 'player-disconnects':
        return withoutPlayer(s, g['player']);

      /*
       * The party roster.
       *
       * The one place another character's health is visible, and it costs a
       * command rather than a second connection. A listing is authoritative and
       * replaces what was there: somebody absent from it has left.
       */
      case 'party-roster':
      case 'party-alone':
        return withPartyListing(s, rows, block.type === 'party-alone');

      /*
       * Another player's client answering `@health`.
       *
       * `Syntax telepaths: {HP=4434/4434,MA=516/516}` (captures/123) and
       * `/Sackhunter {HP=600/600}` (captures/055). It is the only thing on this
       * server that states another character's numbers rather than a
       * percentage, and it costs a telepath rather than a command from the
       * budget walking and fighting spend from.
       *
       * **Kept for anybody, and put on the Party card only for a member.** The
       * two are different questions and used to be conflated: a reply from a
       * stranger was dropped entirely, because the only place to put it was the
       * party roster and inventing a member out of a chat message would put
       * somebody on the Party card who never joined. The player registry is not
       * the roster, so the numbers are kept there for everybody and the roster
       * is still only touched for somebody actually in it.
       */
      case 'conversation-telepath':
      case 'conversation-directed':
      case 'conversation-local':
      case 'conversation-gossip':
      case 'conversation-broadcast':
      case 'conversation-auction':
      case 'conversation-gangpath':
        return withRemoteVitals(s, g['player'], g['message'], block.at);

      case 'party-following':
        return withFollowing(s, g['leader']);

      /*
       * Membership, announced rather than asked for.
       *
       * These keep the roster *approximately* true between listings, the same
       * way arrival broadcasts keep the realm roster true — but they carry no
       * health, so a member added this way has none until the next `party`.
       * Null is the honest answer and the card says so.
       */
      /*
       * An invitation this character sent.
       *
       * `invite` offers and `join` accepts, so this is not a party yet — but it
       * is the moment the player is watching for an answer, and the card had
       * nothing to say about it: the invitee appeared only once they accepted,
       * and the listing in between was read as a party of one. The offer goes on
       * the roster marked as such; `party-joined` turns the same entry into a
       * member and `party-left` takes it off when the offer is withdrawn.
       *
       * The outgoing sentence only. The incoming one names a `leader` — the
       * person who invited *this* character — and being invited is not being in
       * a party: nothing has been accepted, and the roster that would say so is
       * the leader's.
       */
      case 'party-invited':
        return withInvited(s, g['player']);

      case 'party-joined':
        return withJoined(s, g['leader'], g['player']);

      case 'party-left':
        return withLeft(s, g['leader'] !== undefined, g['player']);

      case 'party-rank-changed':
        return withRank(s, g['player'] ?? s.name ?? undefined, g['rank']);

      /*
       * Somebody sitting down, which the roster prints as a flag.
       *
       * The standing shape again: `party` establishes who is resting and this
       * keeps it true for free until the next listing. The sentence is said
       * about anybody in the room, so it counts only for a member the roster
       * has — and there is **nothing that says a rest has ended**, on the wire
       * or in 214 captures, so a listing is the only thing that clears it. That
       * is the safe direction: a member believed to be resting is one this
       * client will not assume has answered.
       */
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
      case 'player-arrives-room': {
        const player = g['player'];
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
      case 'mob-arrives-room': {
        const named = g['attacker'] ?? trimVerb(g['line'] ?? '');
        if (named.length === 0) return null;
        if (s.room.occupants.some((who) => mobKey(who.name) === mobKey(named))) return null;
        const [arrival] = this.classify([named], s.online);
        if (arrival === undefined) return null;
        return { ...s, room: { ...s.room, occupants: [...s.room.occupants, arrival] } };
      }

      case 'player-leaves-room': {
        const player = g['player'];
        if (!player || !s.room.occupants.some((who) => who.name === player)) return null;
        return {
          ...s,
          room: { ...s.room, occupants: s.room.occupants.filter((who) => who.name !== player) }
        };
      }

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
      /*
       * Coins off the floor go to wealth. The realm counts in copper
       * (`Wealth: 0 copper farthings`) and its coins are decimal — ten of one
       * make the next — so the running figure is kept in copper and the next
       * `i` listing corrects it. The floor's coin entry goes with them.
       */
      case 'user-gets-coins': {
        const count = int(g['count']) ?? 0;
        const coin = g['coin'] ?? '';
        const word = coin.split(' ')[0]?.toLowerCase() ?? '';
        const denomination = DENOMINATIONS.find((name) => name === word);
        const room = {
          ...s.room,
          items: s.room.items.filter(
            (entry) => !entry.name.toLowerCase().includes(word || '\u0000')
          )
        };
        /*
         * The denomination that was picked up goes up by one lot, and nothing
         * is converted.
         *
         * It used to add `count × COIN_IN_COPPER[coin]` to `wealth`, and that
         * table was wrong: measured against the corpus the ladder is 1 / 10 /
         * 100 / 10 000 / 1 000 000, not the ×10 rungs it held — so every
         * platinum piece picked up understated the purse by ten times and every
         * runic coin by a hundred. The table is gone rather than corrected,
         * because with the counts kept the client has no reason to convert
         * anything: `Wealth:` is the server's own arithmetic and the next
         * listing states it.
         *
         * A denomination nothing has counted yet stays uncounted. Adding to an
         * unknown would claim the pick-up was the whole purse — which is the
         * same refusal the old code already made about an unknown `wealth`.
         */
        if (denomination === undefined) return { ...s, room };
        const known = s.inventory.coins[denomination];
        if (known === null) return { ...s, room };
        return {
          ...s,
          room,
          inventory: {
            ...s.inventory,
            coins: { ...s.inventory.coins, [denomination]: known + count }
          }
        };
      }

      case 'player-gets': {
        const item = g['item'];
        if (!item) return null;
        // Somebody else picked it up: gone from the floor, not into our pack.
        if (g['player'] !== undefined) return withoutRoomItem(s, item);
        const count = int(g['count']) ?? 1;
        this.notePack(block.seq, item, true, count);
        /*
         * Off the floor by name, which is an approximation the floor list
         * cannot improve on: the room says `padded gloves` once however many
         * lie there, so taking one of two clears the entry and the next
         * `You notice` puts the other back.
         */
        return withoutRoomItem(withItem(s, item, count), item);
      }

      /*
       * Something bought in a shop the realm data has stock for.
       *
       * This is the shop half of the realm memory, and it is answerable
       * *without* a capture of the `list` output — which is what had blocked
       * it. The buying sentence is already parsed (`You just bought a lantern
       * for 4 copper farthings.`), the room already resolves, and the realm
       * data already says which shop the room holds and what it stocks. If the
       * shop just sold something the data does not list, the data is out of
       * date and that is worth writing down.
       *
       * It records and does not correct: nothing here edits the realm file, for
       * the same reason a learned exit is not fed to the pathfinder.
       */
      case 'user-buys': {
        const item = g['item'];
        if (!item) return null;
        this.noticeStock(s, item);
        const bought = int(g['quantity']) ?? 1;
        this.notePack(block.seq, item, true, bought);
        /*
         * And it is *carried* now. Buying and selling move an item between the
         * shop and the pack exactly as taking and dropping move it between the
         * floor and the pack, and the listing that seeds the pack is the same
         * `i` in both cases — so leaving these out meant a shop trip left the
         * Carrying card describing the character as it was before the trip.
         */
        /*
         * And the purse went down by exactly what the server quoted. The line
         * states copper, which is the unit `Wealth:` normalises into, so there
         * is nothing to convert — see `withSpend`.
         */
        const carried = withItem(s, item, bought) ?? s;
        const price = int(g['price']);
        return price === null ? carried : (withSpend(carried, -price) ?? carried);
      }

      /*
       * `list`, in a shop — the command the realm data exists to make
       * unnecessary, and the authority when somebody types it anyway.
       *
       * Every line is checked against what the realm says this shop stocks, so
       * a shop selling something the data has never heard of is written to the
       * character's record. This is the shop half of the memory as it was
       * originally asked for: *"in a known shop and does a list, and there is an
       * item that is unknown, add it."*
       *
       * Nothing else is done with it. The listing is the shop's own truth for
       * one moment, and the realm data is what the client plans against; a card
       * that showed one and labelled it the other would be the confident wrong
       * answer this project refuses everywhere else.
       */
      case 'shop-list': {
        for (const row of rows ?? []) this.noticeStock(s, row['item']);
        /*
         * Kept, as the counter said it. The realm file is the lead — the Shop
         * face already shows what the data says is sold here before anybody
         * asks — and the counter is the authority: its `(You can't use)` is a
         * judgment about *this* character that the file cannot hold, and its
         * price is in coin where the file's is in copper. Cleared when another
         * room completes (`applyRoomChange`): a quotation belongs to the shop
         * it was made in.
         */
        const items = (rows ?? [])
          .map((row) => ({
            name: row['item']?.trim() ?? '',
            quantity: int(row['quantity']),
            price: row['price']?.trim() ?? '',
            note: row['note']?.trim() || null
          }))
          .filter((item) => item.name.length > 0 && item.price.length > 0);
        if (items.length === 0) return null;
        return { ...s, shopListing: { items, at: block.at } };
      }

      case 'user-sells': {
        const item = g['item'];
        if (!item) return null;
        /*
         * Sold, so no longer carried — and *not* on the floor: the shop has it.
         * That is the difference from a drop, and getting it wrong would put an
         * item in the room's list that nobody in the room can pick up.
         */
        const sold = int(g['count']) ?? 1;
        this.notePack(block.seq, item, false, sold);
        const kept = withoutItem(s, item, sold) ?? s;
        const paid = int(g['price']);
        return paid === null ? kept : (withSpend(kept, paid) ?? kept);
      }

      /*
       * A banking round moves two figures in opposite directions, and the
       * sentence states only one of them.
       *
       *     [HP=334/KAI=27]:deposit 310335
       *     You deposit 310335 copper farthings.
       *     [HP=334/KAI=27]:You withdrew 310335 copper farthings.
       *
       * The purse half is unconditional: the amount is in the sentence and the
       * purse is this character's, whatever room it happened in.
       *
       * The **vault** half is the maintained-listing shape, and it is the shape
       * rather than a guess because of `this.vault`. The sentence names no
       * bank; the `bank` that answered *in this room* named one outright, and
       * the room has not changed since or `apply()` would have cleared it. So
       * the figure the bank stated is moved by the amount the server just said
       * it moved, which is arithmetic on two facts rather than an attribution
       * of one fact to a room that may not resolve. With no `bank` asked here,
       * there is no vault and the balance is left exactly as it was, stale and
       * openly so — which is what it was before this existed.
       *
       * Clamped at zero on the withdrawal side for the same reason `withSpend`
       * clamps: a balance that has gone negative is a reading that drifted, and
       * a negative vault on a card is a bug wearing a number.
       */
      case 'user-deposits':
      case 'user-withdraws': {
        const amount = int(g['amount']);
        if (amount === null) return null;
        // Deposit: out of the purse, into the vault. Withdrawal: the reverse.
        const toPurse = block.type === 'user-withdraws' ? amount : -amount;
        const moved = withSpend(s, toPurse) ?? s;
        const banked = this.creditVault(moved, -toPurse, block.at);
        return banked === s ? null : banked;
      }

      /*
       * `bank`, standing in one. The vault states what it holds, and it is the
       * only authority for that figure — nothing else on the wire mentions it.
       *
       * Merged rather than assigned: this names one bank and is silent about
       * every other, so `withBankBalance` leaves the rest alone. See the field
       * for why the shop id is the key and the printed name only the fallback.
       */
      case 'bank-balance': {
        const name = g['bank']?.trim();
        const copper = int(g['copper']);
        if (!name || copper === null) return null;
        const shop = int(g['shop']);
        const next = withBankBalance(s, { shop, name, copper, at: block.at });
        /*
         * And this is the room it was said in, so a deposit or a withdrawal
         * made here has an account to move. Cleared by `apply()` on the first
         * block that puts the character anywhere else.
         */
        this.vault = { shop, name };
        /*
         * Written down here rather than by whoever watches state change,
         * because this is the only block that produces a balance and the merged
         * list is already in hand. The same shape as `onDiscovery` above: a
         * fact reported, with the file handle somebody else's.
         */
        this.belongings.rememberBanks(next.banks);
        return next;
      }

      case 'player-drops': {
        const item = g['item'];
        if (!item) return null;
        if (g['player'] !== undefined)
          return withRoomItem(s, item, (name) => this.itemEntity(name));
        const dropped = int(g['count']) ?? 1;
        this.notePack(block.seq, item, false, dropped);
        return withRoomItem(withoutItem(s, item, dropped), item, (name) => this.itemEntity(name));
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
        const hidden = int(g['count']) ?? 1;
        this.notePack(block.seq, item, false, hidden);
        return withoutItem(s, item, hidden);
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
      case 'light-out': {
        const item = g['item'];
        if (!item) return null;
        const next = withCharges(s, item, 0);
        return next === s ? null : next;
      }

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
            ? list(carrying).flatMap((entry) => parseCarriedEntries(entry))
            : [];
        for (const item of carried) {
          if (item.slot === null) continue;
          this.wornAt.set(bareName(item.name), item.slot);
          this.teachSlot(item.name, item.slot, block.at);
        }
        /*
         * The listing is authoritative, and it *enumerates* — so a denomination
         * it does not mention is **zero**, not unknown.
         *
         * That is the one place coins depart from "null is not zero", and the
         * departure is what makes the maintained shape work at all: the pack
         * listing establishes the counts and the pick-up sentences keep them
         * true until the next one, which they can only do from a number. Before
         * any listing every count is null — nobody has said — and a pick-up
         * then leaves it null rather than claiming the coins picked up were the
         * whole purse. Zero is still never *drawn*; the row shows what is there.
         */
        const coins: Record<Denomination, number | null> = {
          runic: 0,
          platinum: 0,
          gold: 0,
          silver: 0,
          copper: 0
        };
        if (carrying) {
          for (const entry of list(carrying)) {
            const coin = parseCoinEntry(entry);
            if (coin) coins[coin.denomination] = coin.count;
          }
        }
        return {
          ...s,
          inventory: {
            items: this.replayPack(block.seq, carried),
            keys: list(g['keys']),
            wealth: int((g['wealth'] ?? '').replace(/,/g, '')),
            coins,
            encumbrance: int(g['encumbrance']),
            encumbranceMax: int(g['encumbranceMax']),
            encumbranceWord: g['encumbranceWord']?.trim() || null
          }
        };
      }

      /*
       * `wealth` — the purse in one line, and the cheapest seed there is.
       *
       * Captured live 2026-08-28: `You have 22 platinum pieces, 50 gold crowns,
       * 3 silver nobles, 4 copper farthings.` against a `Wealth: 225034` from
       * the same session — 220 000 + 5 000 + 30 + 4 on the measured ladder.
       *
       * It enumerates, exactly as the `i` listing does, so an unnamed
       * denomination is **zero** and the same maintained shape holds: this
       * establishes the counts and the pick-up sentences keep them true until
       * the next one.
       *
       * **The total is left alone.** `Wealth:` is the server's own arithmetic
       * over these five numbers, and computing it here would be the client
       * doing a sum it has no reason to do and could get wrong on a realm that
       * renamed a coin.
       *
       * **Every part must be a coin, or the line is nothing.** The pattern
       * matches `<number> <words>` because the noun is realm data, so this is
       * where a sentence of the same shape about something else is refused
       * rather than becoming a purse.
       */
      case 'user-wealth': {
        const parts = list(g['coins']);
        if (parts.length === 0) return null;
        const counted = parts.map((entry) => parseCoinEntry(entry));
        if (counted.some((coin) => coin === null)) return null;
        const coins: Record<Denomination, number | null> = {
          runic: 0,
          platinum: 0,
          gold: 0,
          silver: 0,
          copper: 0
        };
        for (const coin of counted) coins[coin!.denomination] = coin!.count;
        return { ...s, inventory: { ...s.inventory, coins } };
      }

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
      case 'user-sneaking':
        return s.stealth === 'sneaking' ? null : { ...s, stealth: 'sneaking' };

      case 'user-not-sneaking':
      case 'user-sneak-failed':
      case 'user-cant-sneak':
        return s.stealth === 'seen' ? null : { ...s, stealth: 'seen' };

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
      case 'spell-cast': {
        const spell = g['spell']?.trim();
        const caster = g['caster'];
        const target = g['target']?.toLowerCase();
        if (!spell || caster === undefined) return null;
        // The pre-cast announcement (`moves to cast … upon …`), not the
        // confirmation: the cast can still fizzle, and a buff recorded here
        // is a shield believed up for the whole fallback clock while it may
        // never have landed. The confirmation frame follows if it did.
        if (g['announced'] !== undefined) return null;
        // An amount makes it an instant heal or blow, not a duration spell.
        if (g['amount'] !== undefined) return null;
        const own = s.name?.toLowerCase() ?? null;
        /*
         * A cast with no `on <target>` frame is a **self** cast — `You cast
         * protection from evil, and Festus is surrounded in a white glow!` —
         * so an absent target from `You` is this character. A named target
         * must still be this character (`yourself`, `you`, or its own name);
         * a party member's buff wears off on their screen, not this one's.
         */
        const isSelf =
          target === undefined
            ? caster === 'You'
            : target === 'yourself' || target === 'you' || (own !== null && target === own);
        if (!isSelf) return null;
        // Remember it, so the onset that follows can be learned against it.
        this.lastSelfCast = { spell, at: block.at };
        /*
         * Only what the realm calls a duration spell, where the realm can
         * say: an instant cure tracked as a buff would sit on the list for
         * ever, since no wear-off is coming. A spell the realm cannot name is
         * kept — refusing it would untrack every buff on a derivative realm —
         * and its life is bounded by the configured fallback clock.
         */
        const known = this.world?.spellNamed(spell) ?? null;
        if (known !== null && known.duration === undefined) return null;
        const kept = s.buffs.filter((buff) => buff.spell.toLowerCase() !== spell.toLowerCase());
        // A list-size bound, not a knob: nothing legitimate holds this many.
        return {
          ...s,
          buffs: [
            ...kept.slice(-15),
            { spell, by: caster === 'You' ? null : caster, appliedAt: block.at }
          ]
        };
      }

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
      case 'spell-onset': {
        const effect = g['effect']?.trim().toLowerCase();
        const cast = this.lastSelfCast;
        if (effect && cast && block.at - cast.at <= tuning().spells.onsetWindowMs) {
          this.buffEffects.set(effect, cast.spell);
          this.lastSelfCast = null;
        }
        return null;
      }

      /*
       * The spellcasting roll failed and nothing landed. Read so it is a fact
       * rather than silence — a failed self cast leaves the buff unregistered,
       * which is what keeps it due — and so a listener (`Blessings`) can retry
       * on the next round rather than waiting its retry floor out. Consumes the
       * pending self-cast note: an onset is not coming for a cast that failed.
       */
      case 'spell-failed': {
        const spell = g['spell']?.trim().toLowerCase();
        if (spell && this.lastSelfCast?.spell.toLowerCase() === spell) this.lastSelfCast = null;
        return null;
      }

      /*
       * A wear-off ends the buff it names. Matched against what is actually
       * on the list — exactly, or through the realm's spell table so the
       * table's two spellings of one row (name and abbreviation) cannot make
       * one buff two. A wear-off naming nothing on the list is still a fact
       * (a debuff ending, a buff cast before this session) and changes
       * nothing.
       */
      case 'user-buff-expired': {
        const spell = g['spell']?.trim();
        if (!spell) return null;
        const named = this.world?.spellNamed(spell) ?? null;
        const ended: typeof s.buffs = [];
        const buffs = s.buffs.filter((buff) => {
          const held = this.world?.spellNamed(buff.spell) ?? null;
          const matches =
            buff.spell.toLowerCase() === spell.toLowerCase() ||
            (named !== null && held !== null && held.id === named.id);
          if (matches) ended.push(buff);
          return !matches;
        });
        if (buffs.length === s.buffs.length) return null;
        /*
         * A cast confirmation and its wear-off frame are a measured duration
         * — the only statement of one this client trusts, the realm's `Dur`
         * column being in units nothing on hand establishes. Own casts only:
         * a party member's duration scales with *their* level, and would be
         * remembered against the wrong caster. `Blessings` reads it back as
         * the watchdog behind endings the client cannot read.
         */
        for (const buff of ended) {
          if (buff.by !== null) continue;
          const seconds = (block.at - buff.appliedAt) / 1000;
          if (seconds > 0) this.belongings.rememberSpellDuration(buff.spell, seconds);
        }
        return { ...s, buffs };
      }

      /*
       * The `sp` / `pow` listing replaces the whole book — a listing is
       * authoritative, and it prints only what the character can actually
       * cast. The header's own word (`spells` against `powers`) restates the
       * resource kind, kept for the same reason the stat sheet's word is: a
       * realm whose prompt omits the mana field still says it here.
       */
      case 'spellbook': {
        const spellbook: KnownSpell[] = [];
        for (const row of rows ?? []) {
          const name = row['name']?.trim();
          if (!name) continue;
          spellbook.push({
            name,
            short: row['short']?.trim() || null,
            level: int(row['level']),
            cost: int(row['cost'])
          });
        }
        const book = g['book'];
        return {
          ...s,
          spellbook,
          vitals: {
            ...s.vitals,
            manaType: book === 'powers' ? 'KAI' : book === 'spells' ? 'MA' : s.vitals.manaType
          }
        };
      }

      /*
       * `You have learned a new power way of the swan!` — appended so the
       * book stays current between listings, but only onto a book that has
       * been read: one spell appended to `null` would publish a book of one,
       * and a settings screen reading it would say the character knows
       * nothing else. The asking routine re-asks on this block either way,
       * and the listing that answers replaces the whole list.
       */
      case 'user-learns': {
        const kind = g['kind'];
        const name = g['name']?.trim();
        if (!name || (kind !== 'power' && kind !== 'spell')) return null;
        if (s.spellbook === null) return null;
        if (s.spellbook.some((entry) => entry.name.toLowerCase() === name.toLowerCase()))
          return null;
        return {
          ...s,
          spellbook: [...s.spellbook, { name, short: null, level: null, cost: null }]
        };
      }

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
       * *teaches this spell* (`scrollTeaching`), which is a lookup.
       *
       * Where the realm cannot place either — a derivative realm, an item
       * outside the index, a scroll acquired before this client was watching
       * — the spell is still recorded and **nothing is removed**. The pack is
       * a maintained listing and the next `i` corrects it; a guess at which
       * item went would take a real one off the card, which is the failure
       * that is not self-correcting.
       */
      case 'user-reads-spell': {
        const name = g['name']?.trim();
        if (!name) return null;
        /*
         * The realm's own row, which is both halves' key: its id finds the
         * scroll, and its columns fill in the short word, level and cost that
         * a book appended a spell at a time would otherwise be missing until
         * the next listing. Null is *this realm does not name it*, which is a
         * real answer for a derivative and never an error.
         */
        const spell = this.world?.spellNamed(name) ?? null;
        let next = s;

        const scroll = spell === null ? null : this.scrollTeaching(s, spell.id);
        if (scroll !== null) {
          this.notePack(block.seq, scroll, false, 1);
          next = withoutItem(next, scroll, 1);
        }

        /*
         * Appended on `user-learns`' terms and for its reason: only onto a book
         * a listing has read, because one spell appended to `null` would
         * publish a book of one and a settings screen reading it would say the
         * character knows nothing else.
         */
        const book = next.spellbook;
        const known = spell?.name ?? name;
        if (book !== null && !book.some((e) => e.name.toLowerCase() === known.toLowerCase())) {
          next = {
            ...next,
            spellbook: [
              ...book,
              {
                name: known,
                short: spell?.short ?? null,
                level: spell?.level ?? null,
                cost: spell?.mana ?? null
              }
            ]
          };
        }
        return next === s ? null : next;
      }

      /*
       * A bare encumbrance line, which arrives on its own after picking
       * something up rather than only inside an `i` listing.
       */
      case 'user-encumbrance': {
        const carried = int(g['carried']);
        const max = int(g['max']);
        if (carried === null) return null;
        return {
          ...s,
          inventory: {
            ...s.inventory,
            encumbrance: carried,
            encumbranceMax: max,
            encumbranceWord: g['encumbranceWord']?.trim() || s.inventory.encumbranceWord
          }
        };
      }

      /*
       * `You gain 2 additional lives.` — counted onto what the sheet said, and
       * only then: a gain before any sheet has stated a total is a gain on an
       * unknown, and an unknown plus two is not two.
       */
      case 'user-gains': {
        if (!/^additional lives$/.test(g['what'] ?? '')) return null;
        const gained = int(g['count']);
        if (gained === null || s.progress.lives === null) return null;
        return { ...s, progress: { ...s.progress, lives: s.progress.lives + gained } };
      }

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
      case 'mob-hits':
      case 'mob-misses':
        return this.fight.blowOnMe(s, block.at, this.vouchedFor(s, g));

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
          this.vouchedFor(s, g),
          int(g['damage']) ?? 0
        );
        // A party member's blow on a monster is what the leader is fighting;
        // a monster's blow on a member is the fight brought to the party.
        const engaged = engagedBy(hit ?? s, g['attacker'], g['target'], block.at) ?? hit;
        return threatenedBy(engaged ?? s, g['attacker'], g['target'], block.at) ?? engaged;
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
        if (attacker) next = { ...next, room: this.withOccupant(next, attacker) };
        if (target) next = { ...next, room: this.withOccupant(next, target) };
        next = engagedBy(next, attacker, target, block.at) ?? next;
        next = threatenedBy(next, attacker, target, block.at) ?? next;
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
          return threatenedBy(engaged ?? s, attacker, target, block.at) ?? engaged;
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
      case 'room-coins': {
        /*
         * `18 gold drop to the ground.` — a broadcast that maintains the floor
         * between looks, the same shape every listing here follows. It used to
         * push the string `18 gold` into `room.items`, which put coins in the
         * encumbrance count and offered them as something to `get` by name.
         */
        const count = int(g['count']);
        const word = g['coin']?.trim().toLowerCase() ?? '';
        // The drop line names the bare denomination (`18 gold`) where a
        // listing names the realm's own noun (`18 gold crowns`), so the first
        // word is what both have in common — the pack's rule, applied here.
        const denomination = DENOMINATIONS.find((name) => name === word);
        if (count === null || denomination === undefined) return null;
        return {
          ...s,
          room: { ...s.room, cash: addCoins(s.room.cash, denomination, count) }
        };
      }

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
      case 'room-light': {
        const light = (g['light'] ?? null) as RoomLight | null;
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
        const arrival = this.arrivedUnseen(s, 'blind');
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

      default:
        return null;
    }
  }
}

/** One affliction flag moved, or null when the server said what was already known. */
function afflicted(
  s: CharacterState,
  which: keyof Afflictions,
  value: Affliction
): CharacterState | null {
  if (s.afflictions[which] === value) return null;
  return { ...s, afflictions: { ...s.afflictions, [which]: value } };
}

/**
 * A party member was seen hitting, missing or opening on something: what they
 * are fighting, for `automation.party.assistLeader`. Only a member — anybody
 * else's fight is a fact about the room and nothing more — and only a target
 * that is not this character and not a person, because a leader swinging at a
 * player is not a fight this client joins. Null when nothing changed.
 */
function engagedBy(
  s: CharacterState,
  attacker: string | undefined,
  target: string | undefined,
  at: number
): CharacterState | null {
  if (!attacker || !target || /^you$/i.test(attacker) || /^you$/i.test(target)) return null;
  const who = attacker.trim();
  const member = s.party.members.find((entry) => entry.name.toLowerCase() === who.toLowerCase());
  if (!member || member.invited) return null;
  const mob = target.trim().replace(/[.!]+$/, '');
  if (
    s.room.occupants.some(
      (there) => there.kind === 'player' && there.name.toLowerCase() === mob.toLowerCase()
    )
  ) {
    return null;
  }
  const held = s.party.engaged[member.name];
  if (held && held.target === mob && held.at === at) return null;
  return {
    ...s,
    party: { ...s.party, engaged: { ...s.party.engaged, [member.name]: { target: mob, at } } }
  };
}

/**
 * Something was seen hitting, missing or opening on a party member: the fight
 * brought *to* the party, for `automation.party.defendParty`. The same
 * volunteered sentences `engagedBy` reads, the other way round — and a member
 * being pummelled without swinging back, which `engaged` never records, is
 * exactly the case defending exists for. Never a player on either end: a
 * person attacking a member is that member's PvP fight, and a member's own
 * swing is `engagedBy`'s fact. Null when nothing changed.
 */
function threatenedBy(
  s: CharacterState,
  attacker: string | undefined,
  target: string | undefined,
  at: number
): CharacterState | null {
  if (!attacker || !target || /^you$/i.test(attacker) || /^you$/i.test(target)) return null;
  const who = target.trim().replace(/[.!]+$/, '');
  const member = s.party.members.find((entry) => entry.name.toLowerCase() === who.toLowerCase());
  if (!member || member.invited) return null;
  const mob = attacker.trim();
  if (
    s.room.occupants.some(
      (there) => there.kind === 'player' && there.name.toLowerCase() === mob.toLowerCase()
    ) ||
    s.party.members.some((entry) => entry.name.toLowerCase() === mob.toLowerCase())
  ) {
    return null;
  }
  const held = s.party.threatened[member.name];
  if (held && held.target === mob && held.at === at) return null;
  return {
    ...s,
    party: {
      ...s.party,
      threatened: { ...s.party.threatened, [member.name]: { target: mob, at } }
    }
  };
}
