/**
 * What the client believes about the character and the room it is standing in.
 *
 * Derived entirely from parsed blocks — the client never asks the server a
 * question to populate this, it only listens. Everything is nullable and
 * timestamped, because at any moment most of it is *unknown* rather than zero:
 * a freshly connected client knows nothing, and a level-1 warrior genuinely has
 * no mana. Rendering an unknown as `0` is how a HUD lies.
 *
 * Dependency-free: the main process derives it, the renderer draws it.
 */
import type { Sight } from './light';
import type { Alignment } from './alignment';
import type { Loadout } from './gear';
import type { AlignmentCost, MobDisposition } from './mobs';
import type {
  CurrencyEntity,
  ExitEntity,
  ItemEntity,
  MobEntity,
  NpcEntity,
  PlayerEntity
} from './entities';
import type { ExperienceTable } from './experience';
import type { RoomCommand, WorldLair, WorldShop, WorldSpell } from './world';
import type { WoundBand } from './wounds';
import { NO_PLAYERS, type PlayerRegistry } from './players';
import { NO_TALLY, type CombatTally } from './tally';

/**
 * Where the session is in the login sequence.
 *
 * The status line is the discriminator — nothing else reliably separates "at a
 * menu" from "in the realm", which is why both reference clients ended up
 * keying on it.
 */
export type SessionPhase =
  /** Connected, nothing recognised yet. */
  | 'unknown'
  /** A login or menu prompt has been seen. */
  | 'authenticating'
  /** A status line has been seen: we are in the game. */
  | 'in-game';

/**
 * Whether this character is moving unseen.
 *
 * Its own state rather than a boolean on `Vitals`, because it has three
 * meaningful values and a boolean can only hold two: `sneaking` and `seen` are
 * both things the server has *said*, and `unknown` is the ordinary case of
 * nobody having tried. A rule that guards on "am I sneaking" must not fire
 * because nothing has happened yet.
 *
 * It matters for play: sneaking is what decides whether the things in the next
 * room notice you arrive.
 */
export type Stealth = 'unknown' | 'sneaking' | 'seen';

/**
 * Whether the server has said a condition is on this character.
 *
 * Three-state like `Stealth`, and for the same reason: `unknown` is nobody
 * having said, which is the state at every login and is not `no`. `yes` is the
 * onset sentence (`You are blind.`), `no` the one that ends it (`You can see
 * again!`); nothing else moves either, so a cure that the server answers with
 * nothing leaves the flag where it was — honest, and the reason `Cures` casts
 * once per onset rather than once per status line.
 */
export type Affliction = 'unknown' | 'yes' | 'no';

/** The four conditions the corpus has sentences for, on and off. */
export interface Afflictions {
  blind: Affliction;
  poisoned: Affliction;
  diseased: Affliction;
  /** Paralysed or held — `Your legs are paralyzed!`, `You are held by …!` — ended by `You can move again!`. */
  held: Affliction;
}

export const NO_AFFLICTIONS: Afflictions = {
  blind: 'unknown',
  poisoned: 'unknown',
  diseased: 'unknown',
  held: 'unknown'
};

/**
 * A duration spell the wire has confirmed on this character.
 *
 * Established by the cast confirmation — `You cast bless on yourself!`,
 * `Naji casts bless on you!` — which is the one onset signal the wire frames
 * and names: the per-spell onset sentences (`You feel protected!`) are realm
 * message data that none of the three realm databases on hand export, so they
 * cannot be enumerated and are deliberately not matched. Ended by the wear-off
 * frames (`user-buff-expired`), by dying, or by leaving the realm.
 *
 * **No duration is carried, because the wire never states one.** The realm's
 * own `Dur` column is in units nothing has measured, so how long a buff is
 * trusted to last is configuration (`BlessingConfig.fallbackSeconds`) — the
 * player's knowledge, exactly as a threshold is — and `Blessings` compares it
 * against `appliedAt`. A wear-off the client can read ends the buff sooner and
 * more honestly than any clock.
 */
export interface ActiveBuff {
  /** The spell's name as the cast confirmation printed it. */
  spell: string;
  /** Who cast it — a party member's name — or null when this character did. */
  by: string | null;
  /** Epoch ms of the cast confirmation. */
  appliedAt: number;
  /**
   * When the buff will end, epoch ms, where the server has *stated* it — the
   * Paramud `st` sheet's `You feel safe from evil! (90s)` timer, attributed to
   * this buff through the learned onset map. Absent on a realm whose `st` does
   * not print a countdown (MajorMUD, GreaterMUD), where the watchdog is the
   * only clock. It is the server's own statement, not the unmeasured `Dur`
   * column, so `Blessings` prefers it: a recast then goes out within a second
   * of the real expiry rather than on a watchdog that may be minutes off.
   */
  expiresAt?: number;
}

/**
 * One row of the `sp` / `pow` listing — a spell or power this character
 * knows, in the realm's own words. The listing is authoritative: a `sp`
 * replaces the whole list, and `You have learned a new power …!` appends
 * between listings. Every field but the name is the row's own column and
 * nullable, because a row learned from the level-up line has only a name.
 */
export interface KnownSpell {
  /** The full name, which is what a cast command sends. */
  name: string;
  /** The realm's own casting word (`swan`, `mihe`). */
  short: string | null;
  /** The level column — the level the spell asks for, not this character's. */
  level: number | null;
  /** The mana or kai column. */
  cost: number | null;
}

/**
 * Which member of the family the server on the other end belongs to.
 *
 * Read off the wire rather than configured: the menu prompt says
 * `[MAJORMUD]:` or `[PARADIGM]:`, and GreaterMUD's welcome names itself. The
 * parser is written to be realm-agnostic — every frame it matches was widened
 * against the capture corpus until it read all three — so this is a fact for
 * a rule or a card to branch on where the realms genuinely differ (the party
 * listing's ranks, the prompt's optional fields), not a switch the patterns
 * turn on. Null until the wire has said.
 */
export type RealmFamily = 'majormud' | 'greatermud' | 'paradigm';

export interface Vitals {
  hp: number | null;
  /** Null when the class has none at all, which is not the same as zero. */
  mana: number | null;
  /** `MA` for casters, `KAI` for monks. */
  manaType: 'MA' | 'KAI' | null;
  /** From the stat sheet; the status line does not carry maxima. */
  hpMax: number | null;
  manaMax: number | null;
  resting: boolean;
  meditating: boolean;
}

/**
 * One exit.
 *
 * The game does not always give a bare direction: a real capture from the local
 * server is `Obvious exits: north, east, closed gate west`, where the west exit
 * carries its own obstacle description. Keeping the direction separate from the
 * qualifier means Phase 4 can path on `west` while the HUD can still say *why*
 * it is not simply walkable.
 */
export interface RoomExit {
  /** Normalised compass direction, or the raw text when it is not one. */
  direction: string;
  /** `closed gate`, `door`, and the like. Null for a plain exit. */
  note: string | null;
}

/**
 * One thing standing in the room, and which of the two kinds it is.
 *
 * `Also here:` is one comma-separated line and it mixes players and monsters
 * with nothing in the grammar to separate them. Working out which is which is
 * what makes the rest possible — a client that cannot tell cannot auto-attack
 * anything without risking starting a fight with a person, and cannot count
 * "how many things are about to hit me" at all.
 *
 * Three sources answer it, in this order, and none of them is a guess about the
 * *shape* of the word:
 *
 * 1. **The realm roster.** A name a `who` listing gave is a player, full stop.
 * 2. **The listing's own annotations.** `*` and `(Hidden)` are printed only for
 *    players and ` (Charmed)` only for monsters (`Player.cs`), so any of the
 *    three settles it outright.
 * 3. **The realm data.** A name the `Monsters` table carries is a monster, and
 *    it brings a disposition with it.
 *
 * Only when all three say nothing does the capitalisation heuristic decide, and
 * it decides *cautiously*: lower case is taken as a monster with no disposition
 * — which is exactly what the `mobs` guard field has always meant — and a
 * capitalised stranger stays `unknown`, because a named NPC and a player who
 * has not been listed yet look identical and neither is safe to swing at.
 */
export interface RoomOccupant {
  /** The name as the listing spelled it, with the annotations taken off. */
  name: string;
  /**
   * The realm's whole row for it, where this is a monster the realm can place.
   *
   * **The classification above is what is load-bearing and it stays**: the
   * three-state `kind` is why the client does not swing at a capitalised
   * stranger, and partitioning the room into `mobs` / `npcs` / `players` alone
   * would have nowhere to put `unknown`. So the entity hangs off the occupant
   * rather than replacing it — hydrated once in main, at the moment the room
   * completed, which is what lets a card show a monster's health and drops and
   * lets an automation choose a target by them without asking anybody.
   *
   * Absent for a player, for `unknown`, and for a monster the realm cannot
   * name — the last of which is not an error but the ordinary case on a
   * derivative realm.
   */
  mob?: MobEntity;
  /** The person's record, where the roster or the registry knows them. */
  player?: PlayerEntity;
  /** The realm's resident for this room, where `Rooms.NPC` names this one. */
  npc?: NpcEntity;
  /**
   * Player, monster, or nothing said either way.
   *
   * `unknown` is a real answer and not a stand-in for `mob`. It is what a
   * capitalised name nobody has listed is, and treating those as monsters is
   * how a client comes to attack a person.
   */
  kind: 'player' | 'mob' | 'unknown';
  /**
   * Whether it starts fights, when the realm data names it. See `shared/mobs`.
   *
   * Null for a player, for a monster the realm cannot place, and on a realm
   * file built before dispositions were indexed.
   */
  disposition: MobDisposition | null;
  /** True when the realm data's rows for this name disagree about that. */
  uncertain: boolean;
  /**
   * Whether attacking it costs this character ten evil points.
   *
   * A fact about the realm's alignment column rather than about the monster's
   * behaviour — `Mob.GetEPCostForAttacking` charges for a `Good` or
   * `LawfulGood` target and nothing for any other. Separate from `disposition`
   * because a `LawfulGood` guard afoot and the same guard on a gate behave
   * differently and cost the same. `sometimes` when the rows sharing this name
   * disagree, which is the case that keeps the refusal from swallowing the
   * commonest monster in the realm.
   */
  costly: AlignmentCost;
  /** `(Charmed)` — a monster under somebody's control. */
  charmed: boolean;
  /** `(Hidden)` — a player who is hiding. */
  hidden: boolean;
  /** `*` — the realm charges no experience to attack this player. */
  free: boolean;
}

/**
 * The four phrases the server prints about a room's light, dimmest last.
 *
 * A graded scale, not a flag: the realm data records a light *level* per room
 * (−999 … +1000) and a lit torch demonstrably moves the phrase up a rung —
 * `1/607 Sewer Tunnel` (level −175) reads `barely visible` in the dark and
 * `dimly lit` with a pearl lit (measured live, 2026-08-27). Which level
 * produces which phrase has **not** been sampled, so nothing here encodes a
 * threshold; the phrase is what the server said and the level is what the
 * realm file recorded, and they are kept as two separate facts.
 */
export const ROOM_LIGHTS = ['dimly lit', 'barely visible', 'very dark', 'pitch black'] as const;

export type RoomLight = (typeof ROOM_LIGHTS)[number];

/**
 * The phrases that arrive **instead of** a room block rather than alongside one.
 *
 * `dimly lit` and `barely visible` are printed *after* `Obvious exits:` and
 * annotate a room the client has already read. The other two are the whole
 * block: no name, no description, no occupants, no exits — so nothing else
 * will ever complete that room and the arrival has to be handled where the
 * light line is.
 *
 * `pitch black` was missing for a phase, and its absence was worse than
 * blindness: the client went on reporting the room it had been in *before*,
 * with a full exit list and no ambiguity. Ninety-five rooms in the shipped
 * realm print it.
 */
export const BLINDING_LIGHTS: readonly RoomLight[] = ['very dark', 'pitch black'];

/** Whether this phrase came instead of a room block. */
export function isBlinding(light: string | null | undefined): light is RoomLight {
  return light !== null && light !== undefined && BLINDING_LIGHTS.includes(light as RoomLight);
}

export interface Room {
  name: string | null;
  /**
   * The prose paragraph under the name, joined into one string.
   *
   * It has no marker of its own — it is simply whatever the server prints
   * between the name and the lines that do have markers — so it is collected
   * into the room *draft* and discarded with the draft if the room never
   * completes. Null when the server sent none, which happens in brief mode.
   */
  description: string | null;
  /**
   * The ways out, joined to where each one goes.
   *
   * `ExitEntity` rather than `RoomExit`: the wire prints a direction and
   * sometimes a note, and the realm knows the destination, what the passage
   * demands and which item opens it. Joining them in main is what lets a card
   * draw an obstacle badge and name a key without a round trip. The wire still
   * leads — an exit the realm does not know keeps its direction with a null
   * destination, and one the realm knows that the server did not print is not
   * added.
   */
  exits: ExitEntity[];
  /**
   * Everything on the `Also here:` line, mobs and players alike — and which is
   * which. See {@link RoomOccupant}.
   */
  occupants: RoomOccupant[];
  /**
   * What is on the floor, hydrated.
   *
   * Was `string[]`, and that was the shape that made the Room card ask main
   * over IPC what the realm knew about each name *after* it had already drawn
   * once without the answer — and that left `AutoLoot` unable to ask what
   * anything weighed or was worth.
   */
  items: ItemEntity[];
  /**
   * Coins on the floor. Null is *nothing has said*, never zero.
   *
   * Its own field rather than a row in `items`, for the reason the pack's
   * coins are their own field: `18 gold` in the item list lands in the
   * encumbrance count and in the paste of what is lying here.
   */
  cash: CurrencyEntity | null;
  /**
   * What a `search` turned up here, which the room itself does not list.
   *
   * Its own list rather than folded into `items`, because the two are not the
   * same floor. A search's finds **stay concealed** — a bare Enter afterwards
   * reprints the room with no `You notice` line at all — so folding them in
   * would have the card claim they are lying in the open, and would replace the
   * open floor with them into the bargain. The difference is also actionable:
   * hidden coins refuse a bare `get` and want the quantity (see
   * `room-hidden-items`), which is what `AutoLoot` reads it for.
   *
   * Emptied by walking out, like the rest of the room, and by
   * `Your search revealed nothing.` — a search is a listing and a listing is
   * authoritative.
   */
  hidden: ItemEntity[];
  /** Coins a `search` turned up. Null is *nothing has said*, never zero. */
  hiddenCash: CurrencyEntity | null;
  /** From `Location: map,room` in the profile, when it has been seen. */
  map: number | null;
  number: number | null;
  /**
   * How the location was arrived at, and how much to trust it.
   * `null` when the room has not been matched to the realm data at all.
   */
  resolvedBy:
    | 'coordinates'
    | 'movement'
    | 'neighbour'
    | 'unique-name'
    | 'exit-signature'
    | 'dead-reckoning'
    | null;
  confidence: number;
  /** Rooms still consistent with the evidence, when it is ambiguous. */
  ambiguous: number;
  /**
   * The rooms the evidence still allowed, and what each was ruled out by.
   *
   * Kept so the client can *show its working*. "You are at 1,219" and "you are
   * at one of four places called Guild Street and I picked this one because you
   * walked south" are very different claims, and only the second can be argued
   * with — which matters, because a confidently wrong location sends the
   * pathfinder somewhere else entirely.
   *
   * Bounded: a name shared by thirty rooms is interesting as a count, not as a
   * list.
   */
  candidates: RoomCandidate[];
  /**
   * What the server last said about this room's light, or null when it said
   * nothing — which is the ordinary case, because a normally lit room prints
   * no phrase at all.
   *
   * Kept because it is the difference between "the move produced nothing" and
   * "the move produced a room the character cannot see": `Walker` reported the
   * first for the second and blamed the server for a silence that never
   * happened.
   */
  light: RoomLight | null;

  // --- what the realm knows, attached the moment the room resolved --------
  //
  // Every one of these was an IPC round trip made by a React effect after the
  // card had already drawn without the answer. They are facts about the room
  // the client already had in memory, and the only reason they crossed the
  // wire on demand is that the room was a bag of strings when they were added.
  /** The shop this room holds, where the realm records one. */
  shop?: WorldShop | null;
  /** What the realm says can spawn here. */
  lair?: WorldLair | null;
  /** The words this room answers to, from its own script. */
  commands?: RoomCommand[];
  /** The spell the realm casts on whoever stands here. */
  spell?: WorldSpell | null;
  /**
   * The realm's own light level, which is a **different claim** from `light`:
   * that is the phrase the server printed, this is what the data records.
   */
  lightLevel?: number;
  /** The creature the realm ties to this room — `Rooms.NPC`. */
  npc?: NpcEntity | null;
}

/** One room the evidence allowed, for the resolution trace. */
export interface RoomCandidate {
  map: number;
  room: number;
  name: string;
  /** True for the one that was chosen. */
  chosen: boolean;
}

/**
 * One thing the character is carrying, and where it is.
 *
 * The name and the slot are separate fields because the two sources that talk
 * about an item write it two ways: an `i` listing annotates anything worn or
 * wielded with the slot it sits in (`padded boots (Feet)`), while every
 * sentence about it — dropping it, selling it, putting it on — writes the bare
 * name. Keeping the annotation glued to the name is what made a drop match
 * nothing; keeping it as a field means both spellings are still available and
 * neither has to be reconstructed.
 *
 * `slot` is the listing's own word, never one this client invented. The realm
 * database does record a `Worn` code per item, but it is a *number* — 1, 2, 5 —
 * and the words the listing prints for each are not written down anywhere we
 * have read. Mapping the two by eye would put a made-up label under a heading
 * that looks like the server's, which is the reassuring guess this project
 * refuses everywhere else. So a slot is known once a listing has named it, and
 * is null until then.
 */
/**
 * One thing in the pack — **the same entity as everything else**.
 *
 * `CarriedItem` was its own shape (name, slot, in-use, charges) and
 * `ItemEntity` is that plus what the realm knows about the kind, so this is an
 * alias rather than a second type: the pack, the floor, a shop's shelf and a
 * monster's drop table are one thing seen in four places, and holding four
 * shapes is how the Carrying card came to be unable to say what anything
 * weighed while the Reference card beside it could.
 *
 * The wire half is unchanged and is what every existing reader uses:
 *
 * - `slot` is where the listing said it sits — `Head`, `Weapon Hand` — or,
 *   for an item this session has never seen listed worn, where listings have
 *   said items of its `Worn` code sit (`shared/lore.ts`, learned realm-wide).
 *   Null while it is merely carried, and also while it is worn somewhere no
 *   listing has named yet, which is why it is not the same question as
 *   `equipped`.
 * - `slotSource: 'realm'` means **no listing has ever named it** and the word
 *   is the realm database's own answer for that code. Kept apart because the
 *   two are not the same claim: a listing's word is the server's, the realm's
 *   is this client's reading of a number, and the card says which so a heading
 *   that looks like the server's cannot quietly fill with words it never
 *   printed.
 * - `equipped` is worn, wielded or lit — in use rather than in the pack.
 * - `charges` is uses left where the listing stated one (`glowing pearl
 *   (Readied/0)`). Not a slot: the number after the slash is how much of a
 *   torch or a pearl is left, and the server treats a spent one as *absent*
 *   (`use glowing pearl` → `You don't have glowing pearl.`, captured live
 *   2026-08-27). Null where no listing has stated one.
 */
export type CarriedItem = ItemEntity;

/**
 * The five kinds of coin the realm's listings name, richest first.
 *
 * Richest first because that is the order the server prints them in — `2 runic
 * coins, 16 platinum pieces, 353 gold crowns, 450 silver nobles` — and a row
 * that reordered them would be a second vocabulary for a fact the server has
 * already put in an order.
 */
export const DENOMINATIONS = ['runic', 'platinum', 'gold', 'silver', 'copper'] as const;

export type Denomination = (typeof DENOMINATIONS)[number];

/**
 * How many of each the listing named.
 *
 * **Null is not zero here either.** A denomination the listing did not mention
 * is one nobody has said anything about, and a fresh session knows nothing at
 * all; neither is `0 runic`, and neither is drawn.
 *
 * Coins are ordinary inventory — the listing prints them exactly as it prints a
 * helm — and they are deliberately *not* `CarriedItem`s: putting `9 copper
 * farthings` in the item list would put it in the encumbrance count and in the
 * paste of what somebody is carrying, where it is not an item anybody means.
 */
export type Coins = Readonly<Record<Denomination, number | null>>;

export const NO_COINS: Coins = {
  runic: null,
  platinum: null,
  gold: null,
  silver: null,
  copper: null
};

export interface Inventory {
  items: CarriedItem[];
  keys: string[];
  /**
   * What the realm says the purse is worth, in copper.
   *
   * The server's own arithmetic and never this client's: `Wealth:` **is** a
   * normalised total of the coins, confirmed seven ways in the corpus —
   * `28 gold crowns` → `2800`, `12 platinum pieces` → `120000`, and
   * `65 runic coins, 51 platinum pieces, 118 gold crowns` → `65521800`, which
   * is exact at 1 000 000 / 10 000 / 100. Nothing here recomputes it; it is one
   * more thing the listing states, and like every maintained listing it is the
   * figure from the last one until the next.
   */
  wealth: number | null;
  /** How many of each coin, as the listing counted them. See {@link Coins}. */
  coins: Coins;
  encumbrance: number | null;
  encumbranceMax: number | null;
  /**
   * The word the server puts after the figures — `Encumbrance: 0/2400 - None
   * [0%]` — kept verbatim because it is the server's own grading and the
   * thresholds behind it are unsampled; `@enc` answers with it.
   */
  encumbranceWord: string | null;
}

/**
 * How long a session has to have run before an experience rate means anything.
 *
 * Under this, `expThisSession` divided by the elapsed time is dominated by
 * whatever happened in the first few seconds and swings by orders of magnitude
 * between status lines. Stated once: the Vitals card and the `@exp` answer to
 * another client read the same two fields, and each had its own guess at this
 * number — 60s in one file and 120s in the other, so between the two the client
 * told a peer a rate its own card would not show.
 */
export const EXP_RATE_SETTLE_MS = 120_000;

export interface Progress {
  level: number | null;
  exp: number | null;
  expNeeded: number | null;
  /**
   * Lives left, off the stat sheet's `Lives/CP:` and counted up by `You gain
   * N additional lives.` Parsed since the sheet was, stored since 2026-08-29
   * — `@lives` is what wanted it, and a fact the parser produced and nothing
   * kept is a fact the client did not have.
   */
  lives: number | null;
  /**
   * What each level costs this character, from `exp` or from the realm data.
   *
   * Null until one of the two has said. It is a property of the *character* —
   * the base progression scaled by its race and class — so it survives leaving
   * the realm, and `ExperienceTable.source` records which half said it. See
   * `src/shared/experience.ts` for both, and for why the realm always wins.
   *
   * `expNeeded` above cannot answer for it: the realm reports 0 the moment the
   * next level is affordable, which is true and says nothing about the level
   * after — and a character that has not trained in a while is several levels
   * past the one the realm has granted.
   */
  expTable: ExperienceTable | null;
  /** Gained since the session started, so a session's rate can be shown. */
  expThisSession: number;
  /**
   * When the first status line of this session arrived — the denominator of
   * the experience rate. Stamped once and kept across a disconnect, because
   * `expThisSession` is too: a rate whose halves reset separately lies.
   */
  realmEnteredAt: number | null;
  /**
   * Two skills off the stat sheet that decide what a door costs to go
   * through: the realm's `Door [1000 picklocks/strength]` takes either. Null
   * until a sheet has said; a route with neither known treats a difficult
   * door as the wall it probably is.
   */
  strength: number | null;
  picklocks: number | null;
  /**
   * Two more skills off the same sheet, kept because they are what a blow's
   * size turns on and `FightLog` records damage with nothing to explain it by.
   *
   * `martialArts` decides an unarmed character's damage and `magicRes` how much
   * of a spell lands, so a Mystic's numbers are unreadable without them. Guard
   * fields, so a rule can say "do not melee this until martial arts is up".
   */
  martialArts: number | null;
  magicRes: number | null;
  /**
   * The rest of the sheet, kept since 2026-09-03 because the Self card is
   * the first surface to draw it — a fact the parser produced and nothing
   * kept was a fact the client did not have. Every one is nullable and null
   * until a sheet has said; none is ever drawn as zero.
   *
   * `charm` also decides what a shop charges: the server knocks
   * `(charm − 50) ÷ 5` percent off the marked-up price (`BuyCommand.TryToBuy`),
   * which is how the supplies errand prices a purchase before walking to it.
   * `stealthSkill` is the sheet's `Stealth:` figure and deliberately not
   * `stealth`, which on this state is whether the character is *currently*
   * hidden.
   */
  intellect: number | null;
  willpower: number | null;
  agility: number | null;
  health: number | null;
  charm: number | null;
  perception: number | null;
  stealthSkill: number | null;
  thievery: number | null;
  traps: number | null;
  tracking: number | null;
  spellcasting: number | null;
  armourClass: number | null;
  damageResist: number | null;
  /** `Lives/CP:` — the second figure, the realm's combat points. */
  cp: number | null;
}

/*
 * The alignment vocabulary lives in `./alignment` and is re-exported here.
 *
 * It is part of the character model as far as every caller is concerned, so
 * moving the file must not move anybody's import. It moved because it was the
 * *value* `players.ts` imported from here while this file imports `NO_PLAYERS`
 * from there — a cycle that left `EMPTY_CHARACTER.players` undefined for
 * whichever module the bundler evaluated second. `./alignment` has the whole
 * account.
 */
export { ALIGNMENTS, isHostile } from './alignment';
export type { Alignment } from './alignment';

/**
 * Somebody else in the realm.
 *
 * `alignment` and `title` come from a `who` listing and are **null when not
 * known**, which is the ordinary case for somebody who has walked in since the
 * last one: the arrival broadcast carries a name and nothing else. Null is not
 * `Neutral` — guessing an alignment is exactly the guess that gets somebody
 * killed on a PvP realm, so the card says "unknown" and means it.
 */
export interface Adventurer {
  name: string;
  alignment: Alignment | null;
  /** The class-and-rank string, e.g. `Apprentice`. */
  title: string | null;
  /** Trailing status letters the listing carries, e.g. `S` for sleeping. */
  flags: string | null;
  /**
   * The gang the listing names behind the title (`Squire  of EyeExploredDora`),
   * or the one a `look` at them printed in parentheses. From a listing, null
   * means the row named none — a full row states the whole fact; on a
   * provisional entry it means nobody has said.
   */
  gang: string | null;
  /** True while this is only known from an arrival broadcast. */
  provisional: boolean;
}

/**
 * The fight this character is in.
 *
 * `inCombat` was a boolean, which answers "am I fighting" and nothing else —
 * and every decision worth automating needs the other half: *what*, and *what
 * is hitting me*. A rule that says "run below 30%" is a rule anybody can
 * write; a rule that says "attack what is already attacking me" needs this.
 *
 * Assembled from the combat blocks the classifier already produces. Nothing new
 * is asked of the server and no new pattern is guessed at — the shapes here are
 * the ones a live capture produced.
 *
 * **Every field is honest about absence.** A fight whose target has not been
 * named — because the character was attacked and has not swung back — has a
 * null target, not an empty string standing in for one.
 */
/**
 * Who has worn a monster down, and by how much.
 *
 * Split rather than totalled because the two halves answer different questions.
 * `mine` is what this character has contributed, which is what decides whether
 * the kill — and the experience — is going to be theirs. `others` is what the
 * rest of the room has contributed, which is what decides whether a fight that
 * looks winnable is winnable *because* four other people are in it.
 */
export interface Damage {
  /** Dealt by this character. */
  mine: number;
  /** Dealt by everybody else in the room, added together. */
  others: number;
}

/**
 * How the thing this character is fighting is holding up.
 *
 * **The server never states a monster's health.** Not in a status line, not on
 * a hit, not on a death. The one sentence it will volunteer is the wound band
 * in the answer to `look <mob>` (`src/shared/wounds.ts`), and that is a fifth of
 * a bar wide. Everything else here is arithmetic: a maximum from the realm data
 * or from what previous fights taught, minus the damage lines the stream
 * carries.
 *
 * So this is an **estimate, and says which parts of it are known.** `source`
 * names where the maximum came from and is null when nothing knows one, at
 * which point `remaining` is null too — an unknown monster gets a damage tally
 * and the server's own word for its condition, not a bar drawn against a number
 * that was made up.
 */
export interface TargetHealth {
  /** The monster, as `mobKey` spells it: lowercased, article stripped. */
  name: string;
  /**
   * Maximum health to draw a bar against, or null when nothing knows one.
   *
   * From the realm data where it names this monster, and otherwise from what
   * previous fights against it taught. Never guessed.
   */
  max: number | null;
  /** Where `max` came from. Null when there is none. */
  source: 'realm' | 'learned' | null;
  /**
   * The realm data's own span, when several of its rows share this name.
   *
   * Five monsters are called `cocoon` and they run from 100 to 250 health. A
   * name cannot choose between them, so the card says so rather than printing
   * one of the five as though it were the answer. `max` is the high end; see
   * `WorldMob`.
   */
  span: [number, number] | null;
  /** Damage dealt to it this fight, split by who dealt it. */
  damage: Damage;
  /**
   * What is believed left, 0–1, or null when no maximum is known.
   *
   * Not simply `1 - damage/max`: a monster regenerates while the fight runs and
   * nothing announces it, so an estimate built from damage alone only ever
   * falls and drifts further below the truth the longer a fight lasts. Each
   * `look` re-anchors it to the band the server reported and the arithmetic
   * carries on from there.
   */
  remaining: number | null;
  /**
   * The last thing the server itself said about it, from a `look`.
   *
   * The only hard reading available, and the only information at all about a
   * monster nothing can put a maximum on. Kept beside `remaining` rather than
   * folded into it because they say different things: `remaining` is where the
   * arithmetic has got to, and this is what was actually observed.
   */
  observed: WoundBand | null;
}

export interface Combat {
  /** From the status line's `*Combat Engaged*`. The server's own word for it. */
  engaged: boolean;
  /**
   * What this character last swung at.
   *
   * Null until it swings: being attacked does not tell you what you are
   * fighting, only what is fighting you, and those differ the moment a second
   * monster joins in.
   */
  target: string | null;
  /**
   * The realm's whole row for what is being fought, where it can place it.
   *
   * **Beside `target` rather than replacing it**, which is the decision
   * `TargetHealth` already records and for the identical reason: `target` is a
   * *name*, it is a rule guard field, and a rule that swings at `{target}`
   * must go on working whether or not anything can say what it is swinging at.
   *
   * What this adds is everything a decision wants and a name cannot carry —
   * how much health it has, what it resists, whether it is undead, what it
   * drops, and whether it casts something on death. Null for a player, for a
   * monster the realm cannot name, and before this character has swung.
   */
  targetEntity: MobEntity | null;
  /**
   * Everything that has hit or swung at this character in the current fight,
   * most recent first.
   *
   * A list rather than one name, because being fought by three things is the
   * situation that decides whether to run — and it is exactly the situation a
   * single `attacker` field hides.
   *
   * **Names, deliberately, and not entities.** Anything hitting this character
   * is in this room whatever the last listing said, so the tracker puts it
   * into `room.occupants` — where it now arrives with its `mob` entity
   * attached. A second hydrated copy here would be the same fact kept twice,
   * and the two would disagree the moment one listing corrected the other.
   */
  attackers: string[];
  /**
   * How the target is holding up, or null when there is no target to judge.
   *
   * Beside `target` rather than replacing it: `target` is a *name*, it is a
   * rule guard field, and a rule that swings at `{target}` must go on working
   * whether or not anything can put a number on what it is swinging at.
   */
  health: TargetHealth | null;
  /** Epoch ms of the last blow either way, for mid-round timing. */
  lastBlowAt: number | null;
  /** Blows exchanged in this fight, for a card that says how it is going. */
  blows: number;
}

export const NO_COMBAT: Combat = {
  engaged: false,
  target: null,
  targetEntity: null,
  attackers: [],
  health: null,
  lastBlowAt: null,
  blows: 0
};

/**
 * Somebody travelling with this character.
 *
 * The party roster is **the only place another character's health is visible**,
 * and it costs one command rather than a second connection — which makes it the
 * most valuable thing on this server for a client running four characters.
 *
 * Health and mana are fractions, like everything else here, so one number holds
 * at every level. Mana is null for a class that has none, which is not the same
 * as zero: the roster omits the column entirely for a warrior.
 */
export interface PartyMember {
  name: string;
  className: string | null;
  /** 0–1, or null if the roster did not say. */
  health: number | null;
  /** Null when the class has none at all. */
  mana: number | null;
  /** Where they stand in the formation. */
  /** MajorMUD's listing has a middle rank as well; GreaterMUD's has two. */
  rank: 'front' | 'mid' | 'back' | null;
  /** What they are doing, or null when nothing has said. See `PartyActivity`. */
  activity: PartyActivity | null;
  /**
   * Whether the invitation is still outstanding.
   *
   * The realm calls a party *following*, so `invite` is an offer and not a
   * party: the listing prints `[Invited]` where the health, the flag and the
   * rank would be, and nothing else about the row differs. It is a fact about
   * the person rather than three absent fields — somebody no listing has
   * reached yet and somebody who has not answered are different states, and
   * drawing them the same way says the invitation was accepted.
   */
  invited: boolean;
  /**
   * The absolute figures, when this member's own client answered `@health`.
   *
   * The party listing gives a **percentage** and nothing else, which is the
   * right shape for a bar and the wrong one for deciding whether a heal will
   * cover the gap: 30% of 4,434 and 30% of 62 are the same bar and different
   * emergencies. `@health` is the only thing on this server that says the
   * numbers about somebody else, and it costs a telepath rather than a
   * command.
   *
   * Null until a reply has arrived, and **not** cleared by a listing: a
   * percentage does not contradict a pair of numbers, it is coarser than one.
   * The reply also sets `health` and `mana`, so a member whose client answers
   * fills the same bar the listing would have.
   */
  vitals: { hp: number; hpMax: number; mana: number | null; manaMax: number | null } | null;
}

/**
 * What the roster's status flag says a party member is doing.
 *
 * The listing prints a single letter between the health and the rank, and it is
 * the only thing on this server that reports another character's condition at
 * all — a member sitting down is one that is not about to answer a heal or a
 * step, which is the fact a party of four is run on.
 *
 * `R` is resting: capture 122 shows a character's own prompt carrying
 * `(Resting)` while its row carries `R`. `M` is meditating, the kai classes'
 * form of the same thing, seen live on 2026-08-27.
 *
 * **An unrecognised letter keeps its letter and claims nothing.** `P` sits on
 * every member of a five-strong party mid-fight in both of capture 039's
 * listings and nothing on the wire says what it stands for; a plausible
 * expansion here would be a condition the card states in the server's own voice
 * without the server having said it.
 */
export type PartyActivity =
  { state: 'resting' } | { state: 'meditating' } | { state: 'unknown'; flag: string };

/**
 * The letter as printed, read for what has actually been established.
 *
 * Compared case-insensitively and kept case-exact: every listing seen prints it
 * upper case, so a lower-case one is a realm's variation on a flag that has been
 * established rather than a flag that has not — but an unrecognised letter is
 * reported exactly as it arrived, since that is all there is to go on.
 */
export function partyActivity(flag: string | undefined): PartyActivity | null {
  if (flag === undefined || flag.length === 0) return null;
  const letter = flag.toUpperCase();
  if (letter === 'R') return { state: 'resting' };
  if (letter === 'M') return { state: 'meditating' };
  return { state: 'unknown', flag };
}

export interface Party {
  /**
   * Who this character is following, or null when leading or alone.
   *
   * The realm calls a party *following*: `invite` offers and `join` accepts,
   * and what the server reports is who follows whom.
   */
  following: string | null;
  /** Everyone in it, including this character. Empty when there is no party. */
  members: PartyMember[];
  /**
   * What each member was last seen fighting, keyed by the member's name as the
   * server printed it, with the monster as the room spelled it and when.
   *
   * From the sentences the server volunteers about *other* people's blows —
   * `<Name> moves to attack <mob>!`, a hit or a miss naming both sides — which
   * the tracker already reads for the room. Kept beside the roster rather than
   * on the member because a listing replaces the members and knows nothing
   * about fights; the assist reads it through `following`, and only while the
   * monster is still in the room and the sighting is fresh.
   */
  engaged: Record<string, { target: string; at: number }>;
  /**
   * The monster last seen attacking each member, keyed like `engaged` and from
   * the same volunteered sentences read the other way round — the attacker a
   * member's name follows in a blow or a swing (`The aged earth dragon claws
   * Joe for 50 damage!`, captures 040/041). `engaged` is the member's own
   * fight; this is the fight brought *to* them, which need not be the same
   * monster — and the member being pummelled without swinging back is exactly
   * the one `automation.party.defendParty` exists for. Never a player on
   * either end: a person attacking a member is that member's PvP fight, not a
   * thing this client joins.
   */
  threatened: Record<string, { target: string; at: number }>;
}

export const NO_PARTY: Party = { following: null, members: [], engaged: {}, threatened: {} };

/**
 * A room nobody has read yet.
 *
 * A factory rather than a frozen constant because `Room` holds four arrays and
 * a caller that took a shared one would append another room's exits to it.
 *
 * It lives here rather than in the tracker because `EMPTY_CHARACTER` states the
 * same shape a few lines below and the two **have to move together** — a field
 * added to `Room` and to one of them fails at neither compile time nor run
 * time; it simply arrives undefined on whichever path did not get it. That is
 * the closed-union failure this codebase keeps being bitten by, wearing a
 * different hat, and `EMPTY_CHARACTER` now reads its room from here so there is
 * only one list.
 */
export function emptyRoom(): Room {
  return {
    name: null,
    description: null,
    exits: [],
    occupants: [],
    items: [],
    cash: null,
    hidden: [],
    hiddenCash: null,
    map: null,
    number: null,
    resolvedBy: null,
    confidence: 0,
    ambiguous: 0,
    candidates: [],
    light: null
  };
}

/**
 * One line of the counter's own `list`, as the counter quoted it.
 *
 *     shortbow                      25          20 gold crowns (You can't use)
 *
 * The price is kept as the **words the server printed** — a denomination, not
 * copper — because the realm file quotes base prices in copper and the
 * counter quotes in coin, and a number this client converted would be one the
 * shop can disagree with; `quotedInCopper` in `coins.ts` converts for a
 * comparison, never for display. The note is the counter's judgment for this
 * character's class and race, which the realm file cannot hold and which
 * decides whether the line is worth reading at all.
 */
export interface ShopListedItem {
  name: string;
  /** How many are on the shelf, or null where the listing printed none. */
  quantity: number | null;
  /** `20 gold crowns`, `Free` — verbatim. */
  price: string;
  /** `You can't use`, or null when the counter said nothing against it. */
  note: string | null;
}

/**
 * What the counter said when this character asked `list`, in this room.
 *
 * The realm file is the lead and the counter is the authority: stock rotates,
 * a shop sells out, and a derivative edits the table — so this outranks the
 * shipped stock wherever the two name the same thing, and it is cleared the
 * moment the character completes another room, because a quotation is about
 * the shop it was made in. `at` is when it arrived; a quote is not refreshed
 * by standing still.
 */
export interface ShopListing {
  items: ShopListedItem[];
  at: number;
}

/**
 * What the last gang listing said, as a listing rather than as its rows.
 *
 * The members themselves go to the player registry, where they outlive any one
 * listing; this is the fact *about* the listing, which the rows cannot state.
 *
 * `short` is the header's count when it disagreed with the rows that parsed,
 * and null when they agreed. The server builds that count by incrementing
 * alongside each row it prints, so the two are equal by construction and a gap
 * means this client failed to read a row — a member missing from the card with
 * nothing saying so, which is the silent shrink the party roster already has
 * scar tissue from. Kept so the card can say the listing was short instead of
 * quietly drawing fewer people than the gang has.
 */
export interface GangListing {
  /** The gang the header named, or null where it named none. */
  gang: string | null;
  /** How many rows were read. */
  expected: number;
  /** The header's count where it disagreed with the rows read; null when it agreed. */
  short: number | null;
  at: number;
}

/**
 * What one bank last said it holds for this character.
 *
 * **Not part of the purse.** `Inventory.wealth` is what the character is
 * carrying; this is what a vault is holding, and the two move in opposite
 * directions on the same command. A bank is also not one number: a character
 * banks in several towns, and `bank` answers only for the one it is standing
 * in.
 *
 * `shop` is the realm's own shop id, and it is the key. The printed name is
 * not: the same vault is `Bank of Godfrey` on the wire, `The Bank of Godfrey
 * (#8)` on MajorMUD and `Bank of Godfrey` in the realm data, so merging by
 * name would list one bank twice for a character who has banked on both. The
 * id is absent on GreaterMUD, which prints no `(#N)` — hence null, and hence
 * the name as the fallback key, case-folded with any leading `The` gone.
 *
 * `at` is when this figure was last made true, and it is load-bearing rather
 * than decorative. A `bank` states it; a deposit or a withdrawal made in the
 * same room then *maintains* it, which is the standing shape here and is what
 * `CharacterTracker.creditVault` does — the sentence names no bank, but the
 * `bank` that answered in this room did, and the room has not changed. What
 * nothing can maintain is another session, another character, or interest, so
 * a balance is still a reading from a moment that may already have moved. A
 * card shows the time beside the figure so a stale number reads as stale
 * instead of as current.
 */
export interface BankBalance {
  /** The realm's shop id where the header printed one; null on a realm that does not. */
  shop: number | null;
  /** As the header spelled it, with any leading `The` removed. */
  name: string;
  /** On deposit, in copper. Zero is an emptied vault; a bank never asked is simply absent. */
  copper: number;
  /** When the bank stated it. */
  at: number;
}

/**
 * Folds a bank's printed name to something two realms can be compared on.
 *
 * The fallback key, used only where the header printed no shop id. `Bank of
 * Godfrey` and `The Bank of Godfrey` are one vault, and the realms disagree on
 * the article exactly as they disagree on the id — so the same normalisation
 * `bareName` does for an item is done here for a place. Deliberately *not*
 * `bareName` itself: that also strips a trailing parenthesis, which for a bank
 * is the shop id and is lifted by the pattern rather than discarded.
 */
export function bankKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .trim();
}

export interface CharacterState {
  phase: SessionPhase;
  /** See `RealmFamily`. */
  realm: RealmFamily | null;
  name: string | null;
  /**
   * Both names off the stat sheet — `Name: Festus Marcus` — for a surface
   * that titles itself with the whole of it. `name` stays the first, which is
   * what every listing and every sentence uses.
   */
  fullName: string | null;
  race: string | null;
  className: string | null;
  vitals: Vitals;
  room: Room;
  progress: Progress;
  inventory: Inventory;
  /**
   * Who else is in the realm.
   *
   * Seeded by a `who` listing and then *maintained* by the arrival and
   * departure broadcasts, which cost nothing: the server volunteers them, and
   * asking again would spend from the same command budget everything else
   * shares. An entry added that way is `provisional` until a listing confirms
   * what it is.
   */
  online: Adventurer[];
  /** The counter's own `list` for the room the character is in, or null. */
  shopListing: ShopListing | null;
  /** What the last `bg` said about this character's gang, or null before one. */
  gangListing: GangListing | null;
  /**
   * What each bank has said it holds, one entry per bank that has answered.
   *
   * **Merged, never replaced** — and that is the inversion worth noticing,
   * because every other listing on this state is authoritative and replaces
   * what was there. This one is authoritative about *one* bank: `bank`
   * reports the vault the character is standing in and says nothing whatever
   * about the others, so replacing the array would empty every other bank on
   * the strength of a command that never mentioned them.
   *
   * Empty until a bank has answered. A vault never visited is absence, not a
   * balance of zero — the distinction the whole state keeps, and here the
   * comfortable reading is the wrong one twice over: an unasked bank drawn as
   * empty is a character told they have no savings they in fact have.
   */
  banks: BankBalance[];
  /**
   * What was in each worn slot, kept across a death and across a session.
   *
   * **Not what is worn now** — that is `inventory.items`, where `equipped` and
   * `slot` say it. This is the memory of what *was*, and the two diverge at
   * exactly the moment it is wanted: dying takes everything off and leaves it
   * in the pack, and at that moment `slot` is null on every item, because a
   * slot is where the *listing* said something sits and the listing no longer
   * says.
   *
   * Seeded at `reset()` from the character's own record (`Belongings`) like
   * the balances above, and re-learned from every listing after that. Empty
   * before anything has been seen worn; a slot is never emptied by an item
   * coming off, only replaced by something else going into it — which is how
   * swapping a helm by hand quietly re-teaches it. See `shared/gear.ts`.
   */
  loadout: Loadout;
  /**
   * What the character sees by, worked out from the race, the kit and the
   * pack — `src/shared/light.ts`. Null until the realm has named the race or
   * a listing has read the pack, because a sight worked out from nothing is a
   * number that says the character can see in the dark when nobody has said.
   * Recomputed by the tracker at the one place a state is committed, the way
   * `loadout` is.
   */
  sight: Sight | null;
  /**
   * Everything known about other players, kept between sightings.
   *
   * `online` above is *who is in the realm now* and is replaced wholesale by
   * the next listing; this is what has been learned about each of them and
   * survives their walking out of the room. See `src/shared/players.ts` for why
   * the two are separate rather than one richer roster: the roster is a
   * listing the server maintains and this is an accumulation the client keeps,
   * and merging them would mean every `who` erased the accumulation.
   *
   * Seeded from, and kept in, the realm's player book (`PlayerBook`): the
   * facts about each of them outlive the session and are shared by every
   * character dialling the same realm. What is this session's own — whether
   * *it* has seen them online, whether they are in *its* party — is not.
   */
  players: PlayerRegistry;
  /**
   * Whether a fight is on.
   *
   * Kept as its own field beside `combat.engaged` because they answer different
   * questions: the server's `*Combat Engaged*` marker is authoritative and
   * arrives on a status line, and blows can land before or after it. Guards and
   * the HUD read this; `combat` describes the fight it is in.
   */
  inCombat: boolean;
  combat: Combat;
  /**
   * What this character's fighting has added up to — the Combat Stats card.
   *
   * Beside `combat` rather than inside it, because `combat` is emptied every
   * time a fight ends (`NO_COMBAT`) and this is the thing that must survive
   * that. Reset by `leaveRealm`, like everything else that stops being true
   * when a character is no longer in the realm.
   */
  tally: CombatTally;
  party: Party;
  /** Whether this character is moving unseen. See `Stealth`. */
  stealth: Stealth;
  /** What the server has said is wrong with this character. See `Affliction`. */
  afflictions: Afflictions;
  /**
   * The duration spells the wire has confirmed on this character, newest last.
   *
   * A record of casts and wear-offs, not a claim of effect: a buff the server
   * ended with a sentence the client cannot read (the per-spell custom
   * endings — `Your skin returns to normal.` — are unenumerable realm message
   * data) stays here until the configured fallback clock or a death removes
   * it. `Blessings` is the reader.
   */
  buffs: ActiveBuff[];
  /**
   * What the `sp` / `pow` listing said this character knows — null until one
   * has been read, which is not the same as an empty book. Null is what a
   * settings screen shows as "not read yet" rather than "knows nothing";
   * `Belongings` seeds it from the last session on the same realm.
   */
  spellbook: KnownSpell[] | null;
  /** Epoch ms of the last status line, i.e. the last confirmed heartbeat. */
  lastStatusAt: number | null;
  /** Epoch ms of the last change to any of the above. */
  updatedAt: number | null;
}

export const EMPTY_CHARACTER: CharacterState = {
  phase: 'unknown',
  realm: null,
  name: null,
  fullName: null,
  race: null,
  className: null,
  vitals: {
    hp: null,
    mana: null,
    manaType: null,
    hpMax: null,
    manaMax: null,
    resting: false,
    meditating: false
  },
  room: emptyRoom(),
  players: NO_PLAYERS,
  progress: {
    level: null,
    exp: null,
    expNeeded: null,
    lives: null,
    expTable: null,
    expThisSession: 0,
    realmEnteredAt: null,
    strength: null,
    picklocks: null,
    martialArts: null,
    magicRes: null,
    intellect: null,
    willpower: null,
    agility: null,
    health: null,
    charm: null,
    perception: null,
    stealthSkill: null,
    thievery: null,
    traps: null,
    tracking: null,
    spellcasting: null,
    armourClass: null,
    damageResist: null,
    cp: null
  },
  inventory: {
    items: [],
    keys: [],
    wealth: null,
    coins: NO_COINS,
    encumbrance: null,
    encumbranceMax: null,
    encumbranceWord: null
  },
  online: [],
  shopListing: null,
  gangListing: null,
  banks: [],
  loadout: [],
  sight: null,
  inCombat: false,
  combat: NO_COMBAT,
  tally: NO_TALLY,
  party: NO_PARTY,
  stealth: 'unknown',
  afflictions: NO_AFFLICTIONS,
  buffs: [],
  spellbook: null,
  lastStatusAt: null,
  updatedAt: null
};

/** Fraction 0–1, or null when either side is unknown. */
export function ratio(current: number | null, max: number | null): number | null {
  if (current === null || max === null || max <= 0) return null;
  return Math.min(1, Math.max(0, current / max));
}

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How alarming a vital is.
 *
 * `unknown` is a first-class level, not a stand-in for `ok`. Until the stat
 * sheet has been seen the status line carries no maximum, so there is no
 * fraction to compare and nothing honest to say about it — and painting a bar
 * red because a maximum has not arrived yet is worse than saying nothing.
 */
export type VitalLevel = 'unknown' | 'ok' | 'caution' | 'critical';

/**
 * Where a meter turns yellow and where it turns red, as fractions of maximum.
 *
 * Fractions rather than points, so the thresholds scale with the character: 25%
 * is 7 HP at level one and 750 at level fifty, and both are the same amount of
 * trouble. `megamind-client` got this half right — its `hangIfBelow` was a
 * percentage of maximum, but its healing trigger was a hard-coded `health < 25`
 * that means "almost dead" early on and "a scratch" later.
 */
export interface VitalThresholds {
  /** At or below this fraction of maximum, the meter warns. */
  caution: number;
  /** At or below this fraction, it alarms. Never above `caution`. */
  critical: number;
}

/**
 * Classify a vital against its thresholds.
 *
 * Comparison is `<=` on purpose: a threshold of 0.25 means "25% is already
 * critical", which is how a player reads it. Both bounds are treated as
 * fractions of the maximum, so this is the one place the scaling lives.
 */
export function vitalLevel(
  current: number | null,
  max: number | null,
  thresholds: VitalThresholds
): VitalLevel {
  const fraction = ratio(current, max);
  if (fraction === null) return 'unknown';
  // `critical` is clamped to `caution` at load, but a caller passing literals
  // should still get the more urgent of the two rather than the earlier test.
  if (fraction <= Math.min(thresholds.critical, thresholds.caution)) return 'critical';
  if (fraction <= thresholds.caution) return 'caution';
  return 'ok';
}

/**
 * The gang the realm roster names for one character, or `undefined` for unsaid.
 *
 * Three answers, not two, and the third is the point: a name the roster has
 * never listed, or listed only from an arrival broadcast, is **unknown** —
 * `undefined` — while a row a listing wrote in full and left without a gang
 * has none, which is a real `null`. Collapsing the two would let a client
 * decide somebody is not in its gang on the strength of never having asked,
 * and the standing rule is that unknown is never the reassuring answer.
 *
 * Here rather than in `remotes.ts` because it is a fact about the roster, and
 * three readers want it: the permission gate in `Remotes.evidenceAbout`, the
 * Gang card, and the flyout that says why somebody is getting through.
 */
export function gangOnRoster(
  state: CharacterState,
  name: string | null
): string | null | undefined {
  if (name === null) return undefined;
  const entry = state.online.find((row) => row.name.toLowerCase() === name.trim().toLowerCase());
  if (entry === undefined) return undefined;
  if (entry.gang !== null) return entry.gang;
  return entry.provisional ? undefined : null;
}

/**
 * This character's own gang, per the roster — `undefined` while nothing has said.
 *
 * Its own row is on the same listing every other row is, which is what makes a
 * comparison possible without a self-`look` (whether that prints the gang has
 * never been observed, and is not needed).
 */
export function ownGang(state: CharacterState): string | null | undefined {
  return gangOnRoster(state, state.name);
}

/**
 * Has this name **joined** this character's party?
 *
 * Here rather than in either caller because it is the party half of one
 * permission gate, and the gate has two readers: `Remotes.evidenceAbout`, which
 * answers the `@` command, and the Player flyout's Access face, which tells the
 * player whether it will be answered. `AutoCombat.quarry`'s lesson is that two
 * halves of one gate in two files agree exactly until one of them is edited.
 *
 * **An invitation is not membership.** `invited` marks an offer nobody has
 * accepted — the listing prints `[Invited]` where the health and the flag would
 * be — so a row carrying it is not counted. That closes half of the objection
 * that retired the old `party` permission *ground*: if an offer counted,
 * `invite` would be the gesture by which anybody handed themselves this
 * character's party remotes.
 *
 * **It does not close the other half, and that is stated rather than glossed.**
 * `withJoined` puts a full member on the roster for `<name> started to follow
 * you.` without asking whether this character ever invited them, and on this
 * realm following somebody is how a party is joined — so if the server honours
 * an uninvited `follow`, that verb is the same gesture one word along. Nobody
 * has asked the wire; `npm run probe:party -- --pair soul,yang` is where to.
 * What bounds the cost meanwhile is the shipped grant, which is two facts
 * about this character's own body (`RemotesConfig.party`).
 *
 * Two-state, unlike `gangOnRoster`. A gang is learned from a `who` row that may
 * never have been read, so *nobody has said* is a real state there; the party
 * roster is this client's own listing, established by `party` and kept true by
 * the sentences the server volunteers, so a name not on it is a name not in the
 * party.
 */
export function joinedTheParty(state: CharacterState, name: string | null): boolean {
  if (name === null) return false;
  const key = name.trim().toLowerCase();
  if (key.length === 0) return false;
  return state.party.members.some((member) => !member.invited && member.name.toLowerCase() === key);
}

/**
 * How the realm ranks this character, from the roster's own row for it.
 *
 * The `who` listing is the only place it appears — the stat sheet does not
 * carry it — so this is null until one has arrived, which is the ordinary state
 * for the first few seconds of a session and is why every consumer treats null
 * as *unknown* rather than as neutral. Here beside `ownGang` because four
 * readers want it — the rule engine's threat count, auto-combat's pick, the
 * hang-up watch and the roster notices — and two of them had grown their own
 * copy of these four lines.
 */
export function ownAlignment(state: CharacterState): Alignment | null {
  if (state.name === null) return null;
  const mine = state.name.toLowerCase();
  return state.online.find((entry) => entry.name.toLowerCase() === mine)?.alignment ?? null;
}
