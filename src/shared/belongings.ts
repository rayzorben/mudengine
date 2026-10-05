/**
 * What a character keeps between sessions, and the seam it is kept through.
 *
 * Two facts, and they are here together because they are the same *kind* of
 * fact and want the same file: what a vault is holding, and what was in each
 * worn slot. Both are the character's own — not the realm's the way a monster's
 * health is, and not another player's the way `PlayerBook` is — and both die
 * with the socket unless something writes them down.
 *
 * - **A balance.** `bank` answers only for the counter the character is
 *   standing at, so a figure read in Godfrey is unreadable again until somebody
 *   walks back there. The Banks card, which exists to answer *how much have I
 *   got and where*, was empty on every launch until they did.
 * - **A loadout.** Dying takes everything off and leaves it in the pack, and at
 *   that moment `CarriedItem.slot` is null on every one of them, because a slot
 *   is where the *listing* said something sits and the listing no longer says.
 *   A character standing up after a death has a pack full of kit and nothing
 *   that knows which helm was on its head.
 *
 * **A sink, not a store**, for the reason `FightSink` and `RealmMemory` are:
 * the tracker is the parse path and may not acquire a file handle. It reports a
 * fact and recalls one; where the bytes live belongs to whoever wired it up.
 *
 * **Per character, not per realm.** This is the one record here that is not
 * shared: what is in Rand's vault is not in Probe's, and neither is the kit on
 * Rand's back. `PlayerBook` is realm-keyed because what somebody *wears* is a
 * fact about them; these are facts about the character reading them.
 *
 * Dependency-free like everything in `shared/`.
 */
import type { MeasuredRate } from './hunting';
import type { AbilitySums, BankBalance, KnownSpell } from './character';
import type { FledEntry } from './fled';
import type { Loadout } from './gear';
import type { Stash } from './stash';
import type { RoomReference } from './world';
import type { CharacterIdentity } from './reset';
import type { CombatTally } from './tally';
import { NO_UNDERWAY, type UnderwaySink } from './underway';

/**
 * The running totals as last handed over, and when. The moment is
 * load-bearing: a launch that ended without the socket closing leaves the
 * tally's clocks open, and the write is the last moment the client is known
 * to have been in the realm, so that is where `settleClocks` closes them.
 */
export interface StatsRecord {
  savedAt: number;
  tally: CombatTally;
}

/** A room the character's record keeps, with how sure the placement was. */
export interface KeptRoom extends RoomReference {
  confidence: number;
}

/** The lives the character last had, and when that was read. See `src/shared/lives.ts`. */
export interface KeptLives {
  count: number;
  at: number;
}

export interface BelongingsSink {
  /**
   * What the banks last said, from before this session.
   *
   * Read at `reset()` — every connection — rather than once at startup, which
   * is where `RealmPlayers.recall` is read and for the same reason: a reconnect
   * is a new session and has to be seeded like the first one.
   *
   * Empty is *nothing kept*, never *nothing banked*. The distinction is the one
   * the whole state model keeps, and here the comfortable reading is the wrong
   * one: a vault drawn as empty is a character told they have no savings they
   * in fact have.
   */
  recallBanks(): readonly BankBalance[];
  /**
   * A bank has spoken; keep what it said.
   *
   * Handed the **whole** list rather than the one entry that moved, because
   * that is what `withBankBalance` has already merged and re-deriving the merge
   * here would be a second copy of the rule that decides when two printed names
   * are one vault.
   */
  rememberBanks(banks: readonly BankBalance[]): void;
  /**
   * What was in each slot when the character last had it on.
   *
   * Read at `reset()` beside the balances, and onto `CharacterState.loadout`
   * — which is deliberately *not* `inventory.items`. What is worn **now** is a
   * fact only a listing can state; this is the memory of what *was*, and
   * restoring it into the pack view would draw a helm as being on a head it
   * came off two deaths ago.
   */
  recallLoadout(): Loadout;
  /** A listing has named a slot and what is in it. See {@link Loadout}. */
  rememberLoadout(loadout: Loadout): void;
  /** What this character hid and where, read at `reset()`. See `src/shared/stash.ts`. */
  recallStash(): Stash;
  /** A hide or a take moved it; keep the whole of it. */
  rememberStash(stash: Stash): void;
  /**
   * What the `sp` / `pow` listing last said this character knows.
   *
   * Null is *never read*, not *knows nothing* — the same distinction
   * `CharacterState.spellbook` keeps, and here it is what stops a settings
   * screen from disabling a cure because a book was never opened.
   */
  recallSpellbook(): readonly KnownSpell[] | null;
  /** A listing has said what the character knows; keep the whole of it. */
  rememberSpellbook(spellbook: readonly KnownSpell[]): void;
  /**
   * How long each of this character's own casts was observed to last, in
   * seconds, keyed by the spell's lowercased name.
   *
   * Measured — cast confirmation to wear-off frame — never derived from the
   * realm's `Dur` column, whose units nothing on hand establishes. Own casts
   * only: a party member's duration scales with *their* level and would be
   * remembered against the wrong caster.
   */
  recallSpellDurations(): Readonly<Record<string, number>>;
  /** A cast→wear-off pair has been observed; the newest measurement wins. */
  rememberSpellDuration(spell: string, seconds: number): void;
  /** The monsters this character ran from, and at what level. See `src/shared/fled.ts`. */
  recallFled(): readonly FledEntry[];
  /** The whole list as it stands after a run. */
  rememberFled(entries: readonly FledEntry[]): void;
  /** What hunting each spot paid this character, by spot key (todo 70). */
  recallHuntRates(): ReadonlyMap<string, MeasuredRate>;
  /** One spot's measured rate, as the hunt last measured it. */
  rememberHuntRate(key: string, rate: MeasuredRate): void;
  /**
   * What `abil` last summed for this character, with the clock it was read on.
   *
   * Null is *never read*, like the spellbook and unlike the loadout: the quest
   * book turns a step on the difference between "the realm counts none" and
   * "nobody has asked", and a restart must not turn the second into the first.
   *
   * This listing was deliberately **dropped** at `leaveRealm` until 2026-09-07,
   * on the reasoning that nothing on the wire reports a counter moving so a
   * kept figure only gets further from the truth. That is true and is not a
   * reason to forget it: the same is true of a bank balance, which is kept with
   * `at` beside it precisely so the card can draw a stale number *as stale*.
   * The quest book already draws the clock and names its source, so the honest
   * reading was available all along; what the drop actually cost was a quest
   * book that opened empty on every launch until somebody typed `abil`.
   */
  recallAbilities(): AbilitySums | null;
  /** A listing has stated the sums; keep the whole of it, clock included. */
  rememberAbilities(abilities: AbilitySums): void;
  /**
   * Which character this was, last time the wire said: race, class, level and
   * experience.
   *
   * Kept for one purpose — noticing that it is not this character any more.
   * A player who deletes a character and makes a new one keeps the name,
   * because the name is the login, so every record in this file is then about
   * somebody who no longer exists. Null is *never read*: an empty record has
   * nothing to disagree with.
   */
  recallIdentity(): CharacterIdentity | null;
  /** The wire has said who this is. See `src/shared/reset.ts`. */
  rememberIdentity(identity: CharacterIdentity): void;
  /**
   * What the fighting has added up to, from before this session.
   *
   * Read at `reset()` beside the balances, so the Combat Stats card and its
   * rate graph open where they were left rather than empty. Null is *never
   * kept*; the tally's own `since` says whether anything was ever counted.
   */
  recallStats(): StatsRecord | null;
  /** The tally moved; keep the whole of it, since every change is the newest fact. */
  rememberStats(tally: CombatTally): void;
  /**
   * The totals as they stood at the last reset of the Combat Stats card, which
   * the card subtracts (`sinceBaseline`). Null is *never reset*. Kept beside
   * the totals, so a baseline and the series it was taken on come back together.
   */
  recallStatsBase(): CombatTally | null;
  /** The card was reset: by its button, by a lap beginning, or by `@reset`. */
  rememberStatsBase(base: CombatTally): void;
  /**
   * The room this character last stood in, or null when none was ever placed.
   * Read at `reset()`, so a connection after a relaunch starts from it until
   * the server prints a room (`parse/lastRoom.ts`).
   */
  recallRoom(): KeptRoom | null;
  /** A room was placed; keep where. */
  rememberRoom(place: KeptRoom): void;
  /**
   * The sheet or a death said how many lives are left; keep the count. Read
   * before a dial, when the realm has not said it yet (`LowLivesHold`).
   */
  rememberLives(count: number): void;
  /**
   * Throws the whole record away, because the player says this is not the same
   * character.
   *
   * The one destructive call on this seam, and the only caller is a player
   * answering a prompt (`SessionManager.forgetCharacter`). Returns whether
   * there was anything to throw away — a record suspended over an unreadable
   * file answers false rather than pretending, because overwriting one is the
   * thing that record's whole failure handling exists to prevent.
   */
  forget(): boolean;
}

/**
 * The sink for a session with nowhere to write — every test, and the anonymous
 * case. Forgetting is better than refusing to play.
 */
export const NO_BELONGINGS: BelongingsSink = {
  recallBanks: () => [],
  rememberBanks: () => {},
  recallLoadout: () => [],
  rememberLoadout: () => {},
  recallStash: () => [],
  rememberStash: () => {},
  recallSpellbook: () => null,
  rememberSpellbook: () => {},
  recallSpellDurations: () => ({}),
  rememberSpellDuration: () => {},
  recallFled: () => [],
  rememberFled: () => {},
  recallHuntRates: () => new Map(),
  rememberHuntRate: () => {},
  recallAbilities: () => null,
  rememberAbilities: () => {},
  recallIdentity: () => null,
  rememberIdentity: () => {},
  recallStats: () => null,
  rememberStats: () => {},
  recallStatsBase: () => null,
  rememberStatsBase: () => {},
  recallRoom: () => null,
  rememberRoom: () => {},
  rememberLives: () => {},
  forget: () => false
};

/** The whole of a character's record, as the session holds it; each reader takes its own half. */
export type CharacterRecord = BelongingsSink & UnderwaySink;

/** `NO_BELONGINGS`, and nothing underway either. */
export const NO_RECORD: CharacterRecord = { ...NO_BELONGINGS, ...NO_UNDERWAY };
