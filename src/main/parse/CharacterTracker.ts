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
  type ActiveBuff,
  type Stealth,
  ownAlignment
} from '../../shared/character';
import {
  derivedExperienceTable,
  withDerivedExperience,
  withRealmExperience,
  type ExperienceLevel,
  type ExperienceTable
} from '../../shared/experience';
import { readingOf, statlineMatcher, type StatlineReading } from '../../shared/statline';
import { attacksOnSight, classifyOccupant } from '../../shared/mobs';
import {
  gained,
  lost,
  parseCarriedEntries,
  parseCoinEntry,
  parseKeyEntries,
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
import { NO_SPELL_LORE, spellKey, wordsOf, type SpellLore } from '../../shared/spell-messages';
import { afflictionOnset, STATUS_LINE } from './patterns';
import type { Discovery } from '../../shared/memory';
import { NO_FIGHTS, type FightSink } from '../../shared/fights';
import { NO_BELONGINGS, type BelongingsSink } from '../../shared/belongings';
import { LEARN_SPELL_ABILITY } from '../../shared/abilities';
import { bareName, countedName, itemHitProcs, sameItem, WORN_SLOT } from '../../shared/items';
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

/**
 * The same, for a listing of **things**, which this server separates with
 * commas and never with `and`.
 *
 * `list` splits on ` and ` too, and that is wrong wherever an item's own name
 * contains the word: the shipped realm has two — `rope and grapple` and `black
 * and white serpent ring` — and the first is the item 157 of its exits are
 * gated on, so the router could never see one in a pack that held it. Both
 * appear in the corpus inside real listings, comma-separated
 * (`captures/044`: `… lyrist's companion (Back), black and white serpent ring
 * (Finger), jeweled main-gauche (Off-Hand) …`; `captures/119`: `You notice …
 * 2 rope and grapple, 2 mine pass, …`), and across all 218 captures **not one**
 * of the four listings this splits — 600 `You notice`, 25 `You are carrying`,
 * 17 key lines, and the coins inside them — uses ` and ` as a separator.
 *
 * `list` keeps the ` and ` for the listings measured the same way and left
 * alone: `Also here:` (1,240 lines), `Obvious exits:` (2,628) and the bare
 * purse sentence, which has one sample in the corpus and is prose, where a
 * final `and` is exactly what prose does. Widening a rule past its evidence in
 * either direction is the thing this file refuses.
 */
function itemList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
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

/** The `spells` group of a spell-message block: `|`-separated spell names. */
/**
 * A block that may sit between this character's blow and the proc it fired
 * without breaking the two apart.
 *
 * Exactly two things do, and both are the terminal rather than the realm: the
 * status line the server repaints in place after every write, and the blank
 * lines it pads with. Measured over all 581 procs in the recorded sessions of
 * 2026-09-06 — nothing else has ever appeared in that gap, and anything else
 * appearing there is another actor's line interleaved. See
 * `FightTracker.landed`.
 *
 * `unknown` is admitted **only when it carries no text**. An unclassified line
 * with words in it is somebody doing something — `Vulcan makes a complex
 * circling gesture!` is the start message of the cast that produced
 * captures/168's false candidate — and letting those through would give the
 * binding back the reach this exists to take away.
 */
function isProcHousekeeping(block: Block): boolean {
  if (block.type === 'status-line') return true;
  return block.type === 'unknown' && block.text.trim().length === 0;
}

/**
 * The last section `abil` prints, and therefore the proof it was all read.
 *
 * `Player.GetAllAbilitiesFormattedString` appends the five containers in a
 * fixed order and appends each heading whether or not the container holds
 * anything, so this word arriving is the listing saying it finished. It
 * matters because the quest counters live in that very section, and because
 * *absence* is only readable as zero in a listing that ran to its end.
 */
const LAST_ABILITY_SECTION = 'GrantedAbilities';

/**
 * The `abil` listing, read into one sum per ability id.
 *
 * Summed across the sections rather than kept per source, because the sum is
 * what the realm's own gates test — `checkability`, `checkabilityexact` and
 * `testability` each read `Player.GetAbility(id).Sum`, which adds the granted,
 * worn, spell, race and class containers together. `AC(2)` is printed twice by
 * a character wearing armour (50 from the race, 510 from the kit) and the
 * server's answer is 560.
 *
 * **A listing that stopped early is kept, not thrown away.** The rows that
 * arrived are rows the server printed and nothing about them is in doubt; what
 * a short listing cannot support is the *enumeration* — reading an id it never
 * named as zero — so `complete` carries that one judgement to the reader and
 * the reader falls back to what it had for the ids the listing is silent
 * about. Refusing the whole block was the first cut and it was wrong twice
 * over: it threw away counters the server had just stated, and it did so
 * without saying anything at all, which is a decision nobody can read.
 */
function readAbilityListing(rows: ReadonlyArray<Record<string, string>>): {
  sums: Record<number, number>;
  complete: boolean;
} {
  const sums: Record<number, number> = {};
  let complete = false;
  for (const row of rows) {
    const source = row['source'];
    if (source !== undefined) {
      if (source === LAST_ABILITY_SECTION) complete = true;
      continue;
    }
    const id = int(row['id']);
    const value = int(row['value']);
    if (id === null || value === null) continue;
    sums[id] = (sums[id] ?? 0) + value;
  }
  return { sums, complete };
}

function splitSpells(group: string | undefined): string[] {
  if (group === undefined) return [];
  return group
    .split('|')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Whether a line nothing recognised is shaped like an effect sentence: one
 * sentence, beginning with a capital and ending in a full stop or a bang,
 * carrying no figure and no speech, and short. Every start and stop in the
 * shipped table passes; a listing row, a status line, a damage line and a
 * `You say` do not. This is a gate on what may be *learned*, not a reader —
 * nothing is typed from it.
 */
export function looksLikeEffectSentence(text: string): boolean {
  if (!/^[A-Z][^\d"]*[.!]$/.test(text)) return false;
  return wordsOf(text).length <= 14;
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
   * Sentences nothing recognised, seen while buffs whose ending the client
   * does not know were up — each with the buffs it could have ended. An `st`
   * sheet resolves them: a suspect the sheet still lists is not it, and one
   * suspect left that the sheet has stopped listing is the buff the sentence
   * ended, which is then learned. Bounded, and aged out by
   * `tuning.spells.pendingStopMs`.
   */
  private pendingStops: Array<{ text: string; at: number; suspects: string[] }> = [];
  /**
   * Buffs a *learned* ending removed, by spell key, with when. A buff that
   * reappears unprompted inside `tuning.spells.stopContradictionMs` — the
   * `st` sheet still listing it, typically — is the wire saying the learned
   * sentence was not its ending, and the lesson is taken back.
   */
  private readonly recentlyStopped = new Map<string, number>();
  /**
   * Whether an `st` sheet would settle something: a sentence nothing
   * recognised has just been read as, or held as, the ending of a buff whose
   * start the sheet would print. Set here, taken by `takeSheetRequest`, and
   * acted on by `Routines` — the tracker records and never sends.
   */
  private sheetWanted = false;
  /**
   * The matcher built from what `pro` last said the prompt is, or null while
   * the tolerant pattern is the reader (`src/shared/statline.ts` builds it).
   * Kept across leaving the realm: it is a fact about the character, held
   * server-side, and the next `pro` replaces it.
   */
  private statlineMatcher: RegExp | null = null;
  /**
   * A prompt failed that matcher and `pro` has not been asked about it since.
   * Set here, taken by `takeStatlineRequest`, acted on by `Routines` — and
   * armed once per report, so a line that stays different costs one ask.
   */
  private statlineWanted = false;
  private statlineAsked = false;

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

  /**
   * Whether `Sneaking...` has been printed since the last move was committed.
   *
   * **This is the only thing on this realm that says a character is still
   * unseen**, and it is a fact about the *move*, not about the `sn` that asked
   * for it. `MoveCommand` prints the line on a successful move if and only if
   * the character is sneaking (`goodToGo && plyr.BoundTo.Sneaking`), so its
   * presence confirms stealth held and its absence says it broke.
   *
   * Reading it that way round is not a preference — it is the only reading
   * available. `Player.BreakStealth()` is called from about thirty places
   * (every door opened, bashed or picked, a trap, a hidden exit, `rest`,
   * `meditate`, equipping, buying, sharing, casting, walking into a wall) and
   * **it prints nothing at all**. The one sentence that announces stealth
   * ending, `You are no longer sneaking.`, comes from the `break` command
   * alone. So a client that waits to be told will wait for ever, which is
   * exactly what this one did: `stealth` went to `sneaking` on the first
   * `Sneaking...` and stayed there for the rest of the session, and
   * `Walker.sneakFirst` — which stands down while the character is already
   * sneaking — therefore never sent another `sn` after the first.
   *
   * The `sn` reply cannot serve instead, and this is the part that is easy to
   * get wrong: `SneakCommand` prints `Attempting to sneak...` on success **and
   * on the failure branch whose perception roll also fails**. The two are
   * byte-identical, so the reply is not evidence either way.
   */
  private sneakedThisMove = false;

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
    private players: RealmPlayers = NO_REALM_PLAYERS,
    /**
     * The realm's sentences for an effect landing and ending — the shipped
     * table and what this realm's wire has taught — and where a new one is
     * taught. Defaults to knowing none, which leaves the frames in
     * `patterns.ts` and the watchdog clock as the only readers of a buff's
     * life, exactly as before the table existed.
     */
    private readonly spellLore: SpellLore = NO_SPELL_LORE
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
      abilities: this.belongings.recallAbilities()
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
    this.pendingStops = [];
    this.recentlyStopped.clear();
    this.sheetWanted = false;
    this.statlineMatcher = null;
    this.statlineWanted = false;
    this.statlineAsked = false;
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
    // The buffs go with the realm, and so does every half-learned ending.
    this.pendingStops = [];
    this.recentlyStopped.clear();
    this.sheetWanted = false;
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
  /**
   * A move landed. Say whether this character is still unseen, and forget.
   *
   * Called from the two places a move is committed — the described arrival and
   * the dark one — for the reason `rememberTheWayBack` states about living
   * there: a walker step, a typed direction and a party follow all reach them
   * the same way. Unlike the trail, this refuses **nothing**: an unplaced room,
   * an ambiguous one and a teleport are all moves, and stealth breaks on a move
   * whether or not the client could work out where it landed.
   *
   * `seen` rather than `unknown` when the line did not come, because it is not
   * an absence of evidence: the server prints it on every sneaking move, so a
   * move without it is the server saying this character was visible. That is
   * also the direction this project's rule about unknown points — the
   * reassuring answer is the dangerous one, and here the reassuring answer is
   * `sneaking`.
   */
  private stealthAfterMove(): Stealth {
    const settled: Stealth = this.sneakedThisMove ? 'sneaking' : 'seen';
    this.sneakedThisMove = false;
    return settled;
  }

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
      items.push(this.itemEntity(name, count > 1 ? { count } : {}));
    }
    return { items, cash };
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
   * The same attacker, held to *whether the realm says it would swing at all*.
   *
   * Only for the loose miss frame. `mob-hits` carries ` for <n> damage!` and
   * is a blow beyond argument; `mob-misses` is `^The …you….` — deliberately
   * generous, because a monster's miss text is realm data and the shipped
   * realm ships 482 templates naming `you`, only 29 of which say ` at you`.
   * That frame is also the shape of an ordinary sentence about somebody
   * standing in the room.
   *
   * **Reported 2026-09-06 (todo 00), and the cost was not the one the frame's
   * own note predicted.** `ask wound mission` at the Temple Healer answered
   * `The wounded messenger looks you up and down.`; it classified as a miss,
   * `wounded messenger` was in `Also here:` so `nameInMessage` named it, and
   * auto-combat's retaliation — the one path that ignores `engage`, the
   * disposition and the ten evil points, because *something is already
   * swinging* — sent `aa wounded messenger` twice at a Lawful Good quest NPC.
   * `patterns.ts` says a false match costs "a bumped round clock and blow
   * count with **no attacker**, because nothing here names one"; that is true
   * of `The gods have punished you appropriately.`, whose subject is not in
   * the room, and false of every sentence about an occupant.
   *
   * So the realm's own answer to *would this have opened a fight* is asked
   * before a miss is booked as one. Three deliberate narrownesses:
   *
   * - **Only where the realm is sure.** `attacksOnSight` answers `null` for a
   *   monster it cannot place and for an alignment-dependent one before a
   *   `who` has said where this character stands, and `null` keeps the
   *   attribution — unknown is never the reassuring answer.
   * - **Never once provoked.** A passive monster fights back, so a name this
   *   character is already fighting, or that is already on `attackers`, is
   *   taken at its word.
   * - **A blow still counts.** The round clock and the blow count move with no
   *   attacker, which is exactly the cost the frame's note claims — and a
   *   monster that really is swinging is filed by its first landed blow, one
   *   round later. Dropping the attribution is recoverable; ten evil points
   *   charged to the character are not.
   */
  private swingingAtMe(s: CharacterState, attacker: string | undefined): string | undefined {
    if (attacker === undefined) return undefined;
    const key = mobKey(attacker);
    // Already in this fight, either way round: taken at its word.
    if (mobKey(s.combat.target ?? '') === key) return attacker;
    if (s.combat.attackers.some((name) => mobKey(name) === key)) return attacker;

    const who = s.room.occupants.find((entry) => mobKey(entry.name) === key);
    // Not a monster the room has placed — a player, an `unknown`, or somebody
    // no listing has named. None of those is the realm's to answer for.
    if (who === undefined || who.kind !== 'mob') return attacker;
    return attacksOnSight(who.disposition, ownAlignment(s)) === false ? undefined : attacker;
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

    /*
     * A move in the dark breaks stealth exactly as a lit one does, and the
     * server prints `Sneaking...` for it just the same — the line comes out of
     * `MoveCommand` before any room description, so it arrives whether or not
     * the room that follows can be seen or placed.
     */
    return { ...s, room, combat, stealth: this.stealthAfterMove() };
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
    /*
     * Whether this block is a weapon's chance-on-hit, decided **before** the
     * reducer and handed to both readers of it.
     *
     * The fight ledger and the accuracy table have to agree about the same
     * blow, and the verdict reads a memory the reducer is about to write — the
     * blow this character last landed. Deciding it once, here, is what keeps
     * the two answers from being asked either side of that write.
     */
    const proc = this.readsAsProc(block, before);
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
    const reduced = this.reduce(block, rows, proc);
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
    let next =
      reduced !== null && reduced.shopListing !== null && moved
        ? { ...reduced, shopListing: null }
        : reduced;
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
      const seen = next ?? this.state;
      if (seen.afflictions.blind === 'yes') {
        next = { ...seen, afflictions: { ...seen.afflictions, blind: 'no' } };
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
    const base = this.withDerivedExperience(next ?? this.state, before);
    const players = trackPlayers(base.players, block, base, before);
    /*
     * And what the fighting has added up to, folded from the same place and
     * for the same reason — see `trackTally`. It reads the engagement clock
     * off the *transition*, so it is given both states rather than only the
     * one the reducer produced.
     */
    const tally = trackTally(base.tally, block, base, before, proc);
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
   * Whether an `st` sheet has been wanted since this was last asked.
   *
   * A flag taken rather than an event fired, because the answer is wanted
   * once per burst of questions, not once per line: three emotes in a row
   * while one buff's ending is unknown are one sheet. Cleared by the taking.
   */
  takeSheetRequest(): boolean {
    const wanted = this.sheetWanted;
    this.sheetWanted = false;
    return wanted;
  }

  /** A prompt stopped matching what `pro` reported, so `pro` is worth asking again. Cleared by the taking. */
  takeStatlineRequest(): boolean {
    const wanted = this.statlineWanted;
    this.statlineWanted = false;
    return wanted;
  }

  /**
   * The figures off a prompt: by the matcher `pro`'s report built where there
   * is one and the line fits it, else by the tolerant pattern. `exact` is
   * null with no matcher; `length` is how much of `text` the prompt is, so a
   * caller drawing over it knows where the echo begins. Pure — the feed reads
   * a prompt through this the moment it arrives, ahead of the block; the
   * `status-line` case is what arms the re-ask on a lapse.
   */
  readPrompt(
    text: string
  ): { read: StatlineReading; exact: boolean | null; length: number } | null {
    if (this.statlineMatcher) {
      const match = this.statlineMatcher.exec(text);
      if (match)
        return { read: readingOf(match.groups ?? {}), exact: true, length: match[0].length };
    }
    const match = STATUS_LINE.exec(text);
    if (!match) return null;
    const g = match.groups ?? {};
    const state = g['stateA'] ?? g['stateB'];
    const extra = statusFields(g['fields']);
    return {
      read: {
        hp: int(g['hp']),
        hpMax: int(g['hpMax']),
        mana: int(g['mana']),
        manaMax: int(g['manaMax']),
        exp: extra.exp ?? null,
        need: extra.need ?? null,
        wealth: extra.wealth ?? null,
        state: state === 'Resting' ? 'resting' : state === 'Meditating' ? 'meditating' : null
      },
      exact: this.statlineMatcher ? false : null,
      length: match[0].length
    };
  }

  /**
   * The next level's price, off a prompt carrying both `Exp=` and `Need=`.
   *
   * `%X` is `GetTotalExpNeededForLevel(Level + 1) - Experience`, so the sum
   * is the realm's own row for the level above — restated on every prompt,
   * which is what turns `EXPERIENCE_CONFIRMED_TO` from a ceiling into a
   * record as a character climbs. Only while something is still owed:
   * `Need=0` is the realm saying the next level is affordable, and `exp + 0`
   * would price it at whatever the character happens to hold. Nothing is
   * rebuilt while the table already holds the row.
   */
  private tableWithPrompt(s: CharacterState, read: StatlineReading): ExperienceTable | null {
    const level = s.progress.level;
    if (level === null || read.exp === null || read.need === null || read.need <= 0) {
      return s.progress.expTable;
    }
    const row: ExperienceLevel = {
      level: level + 1,
      experience: read.exp + read.need,
      source: 'realm'
    };
    const held = s.progress.expTable?.rows.find((entry) => entry.level === row.level);
    if (held?.source === 'realm' && held.experience === row.experience) return s.progress.expTable;
    return withRealmExperience(s.progress.expTable, [row]);
  }

  /**
   * The `st` sheet is the authoritative listing of what is up.
   *
   * The server prints each active effect's own onset sentence at the foot of
   * the sheet — `You feel ferocious!`, `You are using pressure points!` —
   * and Paramud adds a countdown (`You feel safe from evil! (90s)`). Read
   * with the same rule every listing in this client follows: it establishes
   * the list and the broadcasts maintain it. A buff whose start sentence is
   * known and is not on the sheet has ended without a sentence this client
   * read, and goes; one whose start nobody knows cannot be judged and stays
   * for its clock. The sheet's own lines have already arrived as
   * `spell-onset` blocks and added whatever was missing, so this half only
   * removes and times.
   *
   * It is also where a pending ending is settled: a suspect the sheet still
   * lists was not ended by the sentence, and one suspect left that the sheet
   * has positively dropped is the buff the sentence ended.
   */
  private readSheet(s: CharacterState, text: string, at: number): ActiveBuff[] {
    const up = new Set<string>();
    const timers = new Map<string, number>();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const timed = /^(?<line>.+?)\s*\((?<seconds>\d+)s\)$/.exec(line);
      const sentence = timed?.groups?.['line'] ?? line;
      const seconds = timed ? Number(timed.groups?.['seconds']) : null;
      for (const name of this.spellsBegunBy(sentence)) {
        up.add(spellKey(name));
        if (seconds !== null && Number.isFinite(seconds)) {
          timers.set(spellKey(name), at + seconds * 1000);
        }
      }
    }

    const kept: ActiveBuff[] = [];
    for (const buff of s.buffs) {
      const names = this.buffNames(buff);
      const listed = names.some((name) => up.has(spellKey(name)));
      if (!listed && this.knowsStart(buff)) continue;
      const expiresAt = names
        .map((name) => timers.get(spellKey(name)))
        .find((v) => v !== undefined);
      // The server's statement, so it overwrites any earlier `expiresAt`.
      kept.push(expiresAt === undefined ? { ...buff } : { ...buff, expiresAt });
    }
    this.settlePending(up, at);
    return kept;
  }

  /** Every spell a sheet line says is up: the table's starts, then the learned onset map. */
  private spellsBegunBy(sentence: string): string[] {
    const hit = this.spellLore.match(sentence);
    const names =
      hit !== null && hit.starts.length > 0 && hit.stops.length === 0 ? [...hit.starts] : [];
    const effect = /^You feel (?<effect>[\w' -]+?)!$/.exec(sentence)?.groups?.['effect'];
    const learned = effect ? this.buffEffects.get(effect.trim().toLowerCase()) : undefined;
    if (learned !== undefined && !names.some((name) => this.namesOneSpell(name, learned))) {
      names.push(learned);
    }
    return names;
  }

  private settlePending(up: ReadonlySet<string>, at: number): void {
    this.pendingStops = this.pendingStops.filter((pending) => {
      if (at - pending.at > tuning().spells.pendingStopMs) return false;
      pending.suspects = pending.suspects.filter((name) => !up.has(spellKey(name)));
      if (pending.suspects.length === 0) return false;
      if (pending.suspects.length > 1) return true;
      const name = pending.suspects[0]!;
      // Learned only on a positive statement: the sheet knows this buff's
      // start and has stopped printing it. A buff the sheet cannot speak
      // about keeps the sentence waiting.
      if (this.spellLore.startOf(name) === null) return true;
      this.spellLore.learn(name, 'stop', pending.text, pending.at);
      return false;
    });
  }

  /**
   * A buff established with no cast in front of it, right after a learned
   * ending removed the same buff, is the wire saying the ending was wrong.
   * A recast comes in through its own cast frame and never reaches here.
   */
  private noteContradiction(names: readonly string[], at: number): void {
    for (const name of names) {
      const stoppedAt = this.recentlyStopped.get(spellKey(name));
      if (stoppedAt === undefined) continue;
      this.recentlyStopped.delete(spellKey(name));
      if (at - stoppedAt <= tuning().spells.stopContradictionMs) {
        this.spellLore.unlearn(name, 'stop');
      }
    }
  }

  /**
   * Buffs that have ended. A cast confirmation and its ending are a measured
   * duration — the only statement of one this client trusts, the realm's
   * `Dur` column being in units nothing on hand establishes — but only where
   * the ending was *recognised*: a sentence learned this instant is a
   * conclusion, and a duration measured from it would be one too. Own casts
   * only: a party member's duration scales with their level. The pending
   * endings drop these as suspects, because whatever ended them was not the
   * sentence nothing recognised.
   */
  private buffsEnded(ended: readonly ActiveBuff[], at: number, recognised: boolean): void {
    for (const buff of ended) {
      if (recognised && buff.by === null) {
        const seconds = (at - buff.appliedAt) / 1000;
        if (seconds > 0) this.belongings.rememberSpellDuration(buff.spell, seconds);
      }
      const names = this.buffNames(buff);
      for (const pending of this.pendingStops) {
        pending.suspects = pending.suspects.filter(
          (name) => !names.some((held) => this.namesOneSpell(held, name))
        );
      }
    }
    this.pendingStops = this.pendingStops.filter((pending) => pending.suspects.length > 0);
  }

  private withBuff(s: CharacterState, buff: ActiveBuff): CharacterState {
    const kept = s.buffs.filter((held) => !this.buffMatches(held, this.buffNames(buff)));
    // A list-size bound, not a knob: nothing legitimate holds this many.
    return { ...s, buffs: [...kept.slice(-15), buff] };
  }

  /** The spell and every other it might be. */
  private buffNames(buff: ActiveBuff): string[] {
    return [buff.spell, ...(buff.candidates ?? [])];
  }

  private buffMatches(buff: ActiveBuff, names: readonly string[]): boolean {
    return this.buffNames(buff).some((held) =>
      names.some((name) => this.namesOneSpell(held, name))
    );
  }

  /**
   * Whether two spellings name one spell — exactly, or through the realm's
   * spell table so its two spellings of one row (name and abbreviation)
   * cannot make one buff two.
   */
  private namesOneSpell(a: string, b: string): boolean {
    if (spellKey(a) === spellKey(b)) return true;
    const rowA = this.world?.spellNamed(a) ?? null;
    const rowB = this.world?.spellNamed(b) ?? null;
    return rowA !== null && rowB !== null && rowA.id === rowB.id;
  }

  private knowsStart(buff: ActiveBuff): boolean {
    return this.buffNames(buff).some(
      (name) =>
        this.spellLore.startOf(name) !== null ||
        [...this.buffEffects.values()].some((learned) => this.namesOneSpell(learned, name))
    );
  }

  private knowsStop(buff: ActiveBuff): boolean {
    return this.buffNames(buff).some((name) => this.spellLore.stopOf(name) !== null);
  }

  /** Whether this character's own listing says it can cast the spell. */
  private knowsSpell(s: CharacterState, name: string): boolean {
    return (s.spellbook ?? []).some(
      (known) =>
        this.namesOneSpell(known.name, name) ||
        (known.short !== null && spellKey(known.short) === spellKey(name))
    );
  }

  /** Whether a sentence names this character, anybody in the room or anybody in the party. */
  private namesSomebody(s: CharacterState, text: string): boolean {
    const names = [
      s.name,
      ...s.room.occupants.map((who) => who.name),
      ...s.party.members.map((member) => member.name)
    ];
    const lower = text.toLowerCase();
    return names.some((name) => {
      if (name === null || name.trim().length === 0) return false;
      const needle = name.trim().toLowerCase();
      const at = lower.indexOf(needle);
      if (at < 0) return false;
      const before = at === 0 ? ' ' : lower[at - 1]!;
      const after = lower[at + needle.length] ?? ' ';
      return !/[a-z0-9']/.test(before) && !/[a-z0-9]/.test(after);
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
  /**
   * Re-seeds only the four fields the belongings record supplies, because the
   * record has just been thrown away.
   *
   * `reset()` beside it does this and everything else — the room, the roster,
   * the phase, the trail — which is right for a new connection and wrong here:
   * the character is standing somewhere, and what changed is a *file*. So this
   * is the same four lines as `reset()`'s seeding, applied in place.
   */
  forgetBelongings(): void {
    this.state = {
      ...this.state,
      banks: this.belongings.recallBanks().map((bank) => ({ ...bank })),
      loadout: this.belongings.recallLoadout().map((worn) => ({ ...worn })),
      spellbook: this.belongings.recallSpellbook()?.map((spell) => ({ ...spell })) ?? null,
      abilities: this.belongings.recallAbilities()
    };
  }

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

  /**
   * Whether an unattributed damage line is a chance-on-hit off this
   * character's own gear.
   *
   * The sentence a proc prints is the spell's own message data with the target
   * and the number substituted in — `A shining spark strikes cave worm for 3
   * damage!` — and there is **no attacker in it to read**. Booking it to
   * `Damage.others` was therefore a guess, and the guess that costs this
   * character credit for the kill it is about to make; reported 2026-09-06
   * with the Combat card reading `Dealt: 48 / Party/Others: 3` in a room the
   * character was alone in.
   *
   * Three things have to hold, and each is evidence rather than taste:
   *
   * 1. **The sentence named nobody.** `A` is an article and articles are never
   *    attackers, so `Classifier` leaves the group out. A line that *does* name
   *    somebody is that somebody's, whatever else is true.
   * 2. **The realm says this character wields something that fires one.**
   *    `Items.Abil-n` carries `PercentSpell` immediately before `CastsSp`
   *    (`itemHitProcs`), which is the pair `ItemType.cs` refuses to rewrite
   *    into a `use` — a `shimmering longsword` is a forty-per-cent chance of
   *    `silvery mace`, and its power of 1–3 is the 1, 2 and 3 the spark line
   *    carries. This is the only thing on the client that can attribute the
   *    blow at all.
   * 3. **It is the line the server wrote with this character's own last blow**
   *    — same monster, nothing but the repainted prompt in between, and that
   *    blow still has procs left to give. A proc is composed into the same
   *    write as the blow that fired it: all 581 in the recorded sessions of
   *    2026-09-06 arrive with nothing else in the gap, median 3 ms behind.
   *    This is the gate that keeps a party member's article-led spell out —
   *    `A withering blast of dragonfire sears storm giant king for 163
   *    damage!` (captures/168) names nobody and lands on the monster this
   *    character last hit, and is Vulcan's, four lines and two other players
   *    later. `parse.procWindowMs` bounds the other end, where a blow is
   *    followed by silence and then an unattributed line. **How many** is the
   *    realm's answer too: a round can carry several such lines, and the
   *    count of procs the equipped kit can fire is the ceiling on how many of
   *    them are this character's.
   *
   * All of it, so it declines rather than guesses: no realm loaded, an item
   * the index does not carry, or a pack nothing has listed all leave the blow
   * exactly where it was.
   */
  private readsAsProc(block: Block, state: CharacterState): boolean {
    if (block.type !== 'user-hits') return false;
    const groups = block.groups ?? {};
    // A line that names an attacker is that attacker's, and `you` as the
    // target is a blow on this character rather than one it dealt.
    if (groups['attacker'] !== undefined) return false;
    const target = groups['target'];
    if (target === undefined || /^you$/i.test(target)) return false;
    const allowance = state.inventory.items.reduce(
      (total, held) => total + (held.equipped ? itemHitProcs(held).length : 0),
      0
    );
    return allowance > 0 && this.fight.justStruck(target, block.at, allowance);
  }

  private reduce(
    block: Block,
    rows?: Array<Record<string, string>>,
    /** See `readsAsProc`. Only the `user-hits` case reads it. */
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
        /*
         * Read by the matcher built from what `pro` reported wherever there
         * is one and the line fits it, else by the tolerant pattern the rule
         * typed it with (`readPrompt`). A prompt the exact matcher refuses is
         * the line having changed under the client — another client's `set`,
         * or a suffix the template never stated — and is worth one `pro` per
         * report to find out which; `Routines` sends it. The rule that typed
         * this block is the tolerant pattern, so a null here would be the rule
         * and the reader disagreeing about one line: nothing is claimed.
         */
        const prompt = this.readPrompt(block.text);
        if (!prompt) return null;
        if (prompt.exact === false && !this.statlineAsked) {
          this.statlineWanted = true;
          this.statlineAsked = true;
        }
        const read = prompt.read;
        // A realm that puts the maximum in the prompt says it on every line;
        // one that does not leaves what the stat sheet said alone.
        const hpMax = read.hpMax ?? s.vitals.hpMax;
        const manaMax = read.manaMax ?? s.vitals.manaMax;
        const key = g['manaType'];
        const manaType: 'MA' | 'KAI' | null =
          key === 'MA' || key === 'M'
            ? 'MA'
            : key === 'KAI' || key === 'K'
              ? 'KAI'
              : s.vitals.manaType;
        const agreed = prompt.exact === true;
        return {
          ...s,
          phase: 'in-game',
          statline:
            this.statlineMatcher === null || s.statline.exact === agreed
              ? s.statline
              : { ...s.statline, exact: agreed },
          /*
           * Nobody arrives in the realm sneaking.
           *
           * `leaveRealm` leaves `unknown` behind because "seen" would be a
           * claim about a realm the character is no longer in; walking back
           * into one settles it, and the server settles it the same way —
           * `Player.Sneaking` is not carried across a login. Only on the
           * *transition*, because this case runs on every status line and
           * `sneak` sets `sneaking` mid-session.
           */
          stealth: s.phase === 'in-game' ? s.stealth : 'seen',
          lastStatusAt: block.at,
          vitals: {
            ...s.vitals,
            hp: read.hp,
            mana: read.mana,
            hpMax,
            manaMax,
            manaType,
            resting: read.state === 'resting',
            meditating: read.state === 'meditating'
          },
          progress: {
            ...s.progress,
            exp: read.exp ?? s.progress.exp,
            // `%X` is an unclamped subtraction and goes negative once the next
            // level is affordable; what is *owed* is then nothing, as `exp`
            // reports it. The raw figure still gates the table row.
            expNeeded: read.need === null ? s.progress.expNeeded : Math.max(0, read.need),
            expTable: this.tableWithPrompt(s, read),
            // The first status line is when the session's clock starts: it is
            // the moment the realm is provably on the other end.
            realmEnteredAt: s.progress.realmEnteredAt ?? block.at
          },
          inventory: read.wealth !== null ? { ...s.inventory, wealth: read.wealth } : s.inventory
        };
      }

      /*
       * `pro`'s `Statusline:` row: what the prompt is, and so what reads it.
       * `full` and a template no matcher can be built from leave the tolerant
       * pattern as the reader, with `exact` null to say so; `SessionManager`
       * says which out loud. The same report twice changes nothing.
       */
      case 'user-statline': {
        const reported = g['statline']?.trim() ?? '';
        if (reported.length === 0 || s.statline.reported === reported) return null;
        this.statlineMatcher = statlineMatcher(reported);
        this.statlineAsked = false;
        return { ...s, statline: { reported, exact: null } };
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
          buffs: this.readSheet(s, block.text, block.at),
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
        /*
         * And both of these break stealth, silently, which is the whole
         * difficulty with tracking it (see `sneakedThisMove`).
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
        this.sneakedThisMove = false;
        return s.stealth === 'seen' ? null : { ...s, stealth: 'seen' };

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

      case 'room-items': {
        /*
         * One comma-separated line mixing things and coins, exactly as the
         * pack listing does — so it is split the same way, on commas and
         * **not** on `and`: `You notice … 2 rope and grapple, 2 mine pass …`
         * is one item and not two (`captures/119`). See `itemList`. Coins fold
         * into `room.cash` rather than joining the item list: `18 gold` among
         * the items lands in the paste of what is lying here and reads as
         * something to `get` by name.
         */
        const floor = this.floorListing(g['items']);
        this.room.items(floor.items);
        // A listing is authoritative and replaces what is there — including
        // saying there are no coins, which a fold could not.
        this.room.cash(floor.cash);
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
        const floor = this.floorListing(g['items']);
        return { ...s, room: { ...s.room, hidden: floor.items, hiddenCash: floor.cash } };
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
         * And whether the character is still unseen, computed here for the
         * reason `combat` below is: ahead of the early returns, so every way
         * out of this case agrees about it and none of them can forget.
         *
         * It has to be read *before* the returns for a second reason the fight
         * does not have — `stealthAfterMove` clears the flag, so calling it at
         * each return would make the first one that fired the only one that
         * worked.
         */
        const stealth = movedSomehow ? this.stealthAfterMove() : s.stealth;

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
          return { ...s, room, stealth };
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
            return { ...s, room, combat, stealth };
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
            this.room.discard();
            return { ...s, room, stealth };
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
        // `combat` and `stealth` are both computed above, ahead of the early
        // returns, so every way out of this case agrees about the fight and
        // about whether this character is still unseen.
        return { ...s, room, combat, stealth };
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
        if (g['player'] !== undefined) return withoutRoomItem(s, item, int(g['count']) ?? 1);
        const count = int(g['count']) ?? 1;
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
       * `You hand over 1200 copper farthings to train to the next level!` — a
       * purchase in every sense that matters here: the server states an exact
       * figure in copper, the unit `Wealth:` normalises into, and the money is
       * gone. Read for the same reason `user-buys` is, and it was the last way
       * money left the purse that nothing moved.
       *
       * `vocabulary.test.ts` exempted this type for three phases as *"the price
       * of a level; wealth is re-read from the next listing"*. Nothing forces
       * that listing: two trains in a guild left the maintained purse 2,200
       * copper high for the rest of the walk back to Godfrey, and the Deposit
       * All button then asked the vault for money the character did not have —
       * which this server refuses in **silence**, so neither the player nor the
       * client had anything to read (`logs/2026-09-04_20-39-52_festus`, 1000 +
       * 1200 against a `Wealth:` that fell by exactly 2200).
       *
       * The level half of the receipt is `Routines`' — it asks `exp`, because a
       * level is what makes *Exp. needed* wrong. This is the other half.
       */
      case 'user-trains': {
        const price = int(g['price']);
        return price === null ? null : withSpend(s, -price);
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
          return withRoomItem(s, item, (name) => this.itemEntity(name), int(g['count']) ?? 1);
        const dropped = int(g['count']) ?? 1;
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
            ? itemList(carrying).flatMap((entry) => parseCarriedEntries(entry))
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
          for (const entry of itemList(carrying)) {
            const coin = parseCoinEntry(entry);
            if (coin) coins[coin.denomination] = coin.count;
          }
        }
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
            wealth: int((g['wealth'] ?? '').replace(/,/g, '')),
            coins,
            encumbrance: int(g['encumbrance']),
            encumbranceMax: int(g['encumbranceMax']),
            encumbranceWord: g['encumbranceWord']?.trim() || null,
            // The listing landed: from here the pack is a fact rather than a
            // silence, and an exit that wants something in it can be judged.
            listedAt: block.at
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
      /*
       * `Sneaking...` is printed by `MoveCommand` on a successful move and
       * only while the character actually is sneaking, so it is both the fact
       * and the receipt for the move it precedes. The flag is what
       * `stealthAfterMove` reads when that move commits; see its declaration
       * for why the absence of this line is the only thing that can say
       * stealth broke.
       */
      case 'user-sneaking':
        this.sneakedThisMove = true;
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
        const candidates = splitSpells(g['spells']);
        const cast = this.lastSelfCast;
        const followsCast = cast !== null && block.at - cast.at <= tuning().spells.onsetWindowMs;

        /*
         * No table entry: the `You feel …!` frame alone. Everything it can
         * teach comes from the cast it follows — the effect word for the `st`
         * timer, and the whole sentence as that spell's start, so the next
         * time it is printed with no cast in front of it (a potion, the `st`
         * sheet) the buff is still recognised.
         */
        if (candidates.length === 0) {
          if (followsCast) {
            if (effect) this.buffEffects.set(effect, cast.spell);
            this.spellLore.learn(cast.spell, 'start', block.text.trim(), block.at);
            this.lastSelfCast = null;
          }
          return null;
        }

        /*
         * The table names the spells this sentence begins. A cast a moment
         * ago naming one of them settles which — and the cast frame has
         * already put that buff on the list, so this only adds it where the
         * frame refused because the realm's row called the spell instant: the
         * table has just said it lasts, and the table is the server's own
         * statement about this very spell.
         */
        const named = followsCast
          ? candidates.find((candidate) => this.namesOneSpell(candidate, cast.spell))
          : undefined;
        if (followsCast && named !== undefined) {
          if (effect) this.buffEffects.set(effect, cast.spell);
          this.lastSelfCast = null;
          if (s.buffs.some((buff) => this.buffMatches(buff, [cast.spell]))) return null;
          return this.withBuff(s, { spell: cast.spell, by: null, appliedAt: cast.at });
        }

        /*
         * Unprompted: the `st` sheet restating what is up, a potion, an
         * item, or a cast whose frame this client does not read. Already on
         * the list is the common case (the sheet) and changes nothing — the
         * cast's own `appliedAt` is the honest one. Otherwise the buff is
         * established from the sentence itself, named for the one candidate
         * the spellbook knows where that settles it and the first otherwise,
         * with the rest kept as candidates rather than thrown away: `You feel
         * lucky!` is five spells, and a reader asking whether bless is up
         * must be answered yes whichever of the five it really is.
         */
        if (s.buffs.some((buff) => this.buffMatches(buff, candidates))) return null;
        const inBook = candidates.filter((candidate) => this.knowsSpell(s, candidate));
        const spell = inBook.length === 1 ? inBook[0]! : candidates[0]!;
        const rest = candidates.filter((candidate) => candidate !== spell);
        this.noteContradiction(candidates, block.at);
        return this.withBuff(s, {
          spell,
          by: null,
          appliedAt: block.at,
          ...(rest.length > 0 ? { candidates: rest } : {})
        });
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
        const names = splitSpells(g['spells']);
        if (names.length === 0 && spell) names.push(spell);
        if (names.length === 0) return null;
        /*
         * **A wear-off ends whatever its own start turned on**, which for four
         * spells is a *condition* rather than a buff (todo 02, 2026-09-06,
         * reported as *"it doesnt detect blind wearing off"*).
         *
         * `The effects of the mummy's breath wears off!` is the stop sentence
         * of spell 84 in `spell-messages.csv`, whose **start** is `You are
         * blind!`. The onset therefore reached `afflictions.blind` through
         * `user-blinded` and the ending reached here — where nothing on
         * `buffs` matched `breathes`, so the case returned null and the flag
         * stayed `yes` for the rest of the session. Captured in the report:
         * the condition wore off, the character read three rooms in a row, and
         * `Walker` then held a seventeen-step route with *Blind; waiting here
         * until you can see again.*
         *
         * The table already pairs the two sentences, which is the whole of the
         * user's *"start and stop spells should know what effects they are
         * adding and removing"*: ask it what this ending stops, ask it what
         * those spells start, and ask `patterns.ts` what such a sentence turns
         * **on**. One statement of each onset pattern, read from both ends.
         *
         * `blind` is not the only one it answers — the table pairs `You are
         * blind and dizzy!` with `You are no longer blind and dizzy.` and
         * `You are blinded by the sand!` with `You can see again.` (a full
         * stop, which `user-blind-ends` does not match) — and it is silent
         * for every buff whose start is ordinary flavour text, which is all
         * of them but these.
         */
        let next = s;
        for (const name of names) {
          const start = this.spellLore.startOf(name);
          const condition = start === null ? null : afflictionOnset(start);
          if (condition === null) continue;
          next = afflicted(next, condition, 'no') ?? next;
        }
        const ended = next.buffs.filter((buff) => this.buffMatches(buff, names));
        // A wear-off naming nothing on the list is still a fact — a debuff
        // ending, or a buff cast before this session — and may have turned a
        // condition off above even when it ends no buff.
        if (ended.length === 0) return next === s ? null : next;
        this.buffsEnded(ended, block.at, true);
        return { ...next, buffs: next.buffs.filter((buff) => !ended.includes(buff)) };
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
      case 'user-abilities': {
        const { sums, complete } = readAbilityListing(rows ?? []);
        if (Object.keys(sums).length === 0) return null;
        const abilities = { sums, complete, at: block.at };
        // Written down as well as published: a listing costs a command, and a
        // client that asked for one and then forgot it on the way out is a
        // client that asks again every launch.
        this.belongings.rememberAbilities(abilities);
        return { ...s, abilities };
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
        return this.fight.blowOnMe(s, block.at, this.vouchedFor(s, g));

      /*
       * The same blow without ` for <n> damage!` behind it, which is also the
       * shape of any sentence about somebody standing here — so the realm is
       * asked whether the thing named would have swung. See `swingingAtMe`.
       */
      case 'mob-misses':
        return this.fight.blowOnMe(s, block.at, this.swingingAtMe(s, this.vouchedFor(s, g)));

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
          int(g['damage']) ?? 0,
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
        if (attacker) next = { ...next, room: this.withOccupant(next, attacker) };
        if (target) next = { ...next, room: this.withOccupant(next, target) };
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

      /*
       * A line nothing read is still evidence about the buffs, two ways.
       *
       * Right after this character's own cast it is the spell's onset
       * sentence in a form no frame knows, and it is learned as that spell's
       * start. Otherwise, while buffs whose ending the client cannot
       * recognise are up, it may be one of them ending: with one such buff it
       * is taken to be, learned and acted on (the `st` sheet can still take
       * it back, see `noteContradiction`); with several it is held as a
       * pending ending and the next sheet says which. Only a sentence shaped
       * like an effect — one sentence, no figure, nobody in the room named —
       * is considered at all, so a listing row or an emote never becomes a
       * lesson.
       */
      case 'unknown': {
        const text = block.text.trim();
        if (!looksLikeEffectSentence(text) || this.namesSomebody(s, text)) return null;
        const cast = this.lastSelfCast;
        if (cast !== null && block.at - cast.at <= tuning().spells.onsetWindowMs) {
          this.spellLore.learn(cast.spell, 'start', text, block.at);
          this.lastSelfCast = null;
          return null;
        }
        const suspects = s.buffs.filter((buff) => !this.knowsStop(buff));
        if (suspects.length === 0) return null;
        // Either way the sheet is worth asking for, if it can speak: a
        // suspect whose start it would print is one it can confirm gone, or
        // still up — which is the contradiction that takes a lesson back.
        this.sheetWanted ||= suspects.some((buff) => this.knowsStart(buff));
        if (suspects.length === 1) {
          const buff = suspects[0]!;
          this.spellLore.learn(buff.spell, 'stop', text, block.at);
          this.recentlyStopped.set(spellKey(buff.spell), block.at);
          this.buffsEnded([buff], block.at, false);
          return { ...s, buffs: s.buffs.filter((held) => held !== buff) };
        }
        this.pendingStops.push({
          text,
          at: block.at,
          suspects: suspects.map((buff) => buff.spell)
        });
        // A list-size bound, not a knob: a sheet resolves these long before.
        if (this.pendingStops.length > 20) this.pendingStops.shift();
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
 * Somebody **outside the party** was seen hitting, missing or opening on a
 * monster: that monster is spoken for, which is the fact `combat.joinFights`
 * (MegaMUD's *PoliteAttacks*) reads before opening on it.
 *
 * The same volunteered sentences `engagedBy` reads, for everybody `engagedBy`
 * ignores. Never this character, never a party member (theirs is `engaged`,
 * and joining a member's fight is assisting), and never anything the room
 * lists as a monster — a monster's blow on a monster is a fight between two
 * things nobody owns. The target is never a person: a player being hit is
 * that player's PvP fight, not a claim. An attacker the room has *not* listed
 * still claims: the sentence names a capitalised somebody swinging at a
 * monster, and the cost of reading a named NPC as a person is a fight
 * politely not joined, where the cost of the other error is stealing a kill.
 * Keyed by `mobKey` of the monster with its article dropped, as
 * `player-misses` already spells it. Null when nothing changed.
 */
function claimedBy(
  s: CharacterState,
  attacker: string | undefined,
  target: string | undefined,
  at: number
): CharacterState | null {
  if (!attacker || !target || /^you$/i.test(attacker) || /^you$/i.test(target)) return null;
  const who = attacker.trim().replace(/^(?:The|A|An) /, '');
  const own = s.name?.toLowerCase() ?? null;
  if (own !== null && who.toLowerCase() === own) return null;
  if (s.party.members.some((entry) => entry.name.toLowerCase() === who.toLowerCase())) return null;
  const listed = s.room.occupants.find((there) => there.name.toLowerCase() === who.toLowerCase());
  if (listed !== undefined && listed.kind === 'mob') return null;
  const mob = target
    .trim()
    .replace(/^(?:The|A|An) /, '')
    .replace(/[.!]+$/, '');
  if (
    s.room.occupants.some(
      (there) => there.kind === 'player' && there.name.toLowerCase() === mob.toLowerCase()
    )
  ) {
    return null;
  }
  const key = mobKey(mob);
  const held = s.combat.claimed[key];
  if (held && held.by === who && held.at === at) return null;
  return {
    ...s,
    combat: { ...s.combat, claimed: { ...s.combat.claimed, [key]: { by: who, at } } }
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
