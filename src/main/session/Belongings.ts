/**
 * What this character owns, on disk: what each bank holds, and what was on its
 * back.
 *
 * One file per character, beside the options file with the memory and the
 * fights, because both of these are exactly as personal as those. `PlayerBook`
 * is keyed by realm because what somebody *wears* is a fact about them that
 * four characters should not each have to look up; these are the opposite —
 * Rand's savings are not Probe's, and neither is the kit on Rand's back.
 *
 * **Stamped with the realm it was banked on, and ignored when that changes.**
 * `BankBalance.shop` is the realm's own shop id, so the same number names a
 * different vault on a different realm — and the printed name that is the
 * fallback key is a place in a world that another realm need not have. The
 * file is kept and ignored rather than deleted, the rule `WorldMemory` follows
 * for the same reason: somebody who dials back gets it back, and throwing away
 * a record because a setting changed is not this client's call.
 *
 * The realm is the **address dialled** and not the world file, which is
 * `PlayerBook`'s rule and is right here for the stronger reason: the vault is
 * the server's, and two server entries that dial one address are one bank.
 *
 * **Restored, never reconciled.** What comes back is what the bank said and
 * when it said it — `BankBalance.at` is load-bearing, and a card that draws a
 * figure from last Tuesday beside the time it was true is honest in a way that
 * one drawn as current is not. Nothing here ages a balance out or guesses that
 * interest has moved it; a stale number that says it is stale is the whole
 * design of the field.
 *
 * **Writes are deferred and atomic** — temp file and rename, exactly as
 * `WorldMemory` and `YamlFile` do — because `remember` is called from inside
 * block handling, on the thread that is framing bytes and feeding a terminal.
 */
import type { MeasuredRate } from '../../shared/hunting';
import fs from 'node:fs';
import path from 'node:path';

import type { AbilitySums, BankBalance, KnownSpell } from '../../shared/character';
import { bankKey } from '../../shared/character';
import type { BelongingsSink, KeptLives, KeptRoom, StatsRecord } from '../../shared/belongings';
import type { CharacterIdentity } from '../../shared/reset';
import {
  asUnderway,
  NOTHING_UNDERWAY,
  sameUnderway,
  type Underway,
  type UnderwaySink
} from '../../shared/underway';
import { combatTallyFault, settleClocks, type CombatTally } from '../../shared/tally';
import type { Loadout, WornSlot } from '../../shared/gear';
import { isStashEntry, type Stash, type StashEntry } from '../../shared/stash';
import { isFledList, type FledEntry } from '../../shared/fled';
import { sameItem } from '../../shared/items';
import { errorMessage, faultWithin } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

interface BelongingsFile {
  version: 1;
  /** The address these were banked at and worn on. See the header. */
  realm: string;
  banks: BankBalance[];
  /**
   * Absent in a file written before the loadout was kept.
   *
   * Read as "nothing known" rather than refused: the balances in the same file
   * are still the only copy of what the banks said, and throwing them away over
   * a key that did not exist yet is the pre-v1 legacy rule read backwards. The
   * client is unreleased, so this is the one shape allowance made — and it is
   * about a *record the client writes*, not about the user's own YAML.
   */
  loadout?: WornSlot[];
  /** What the character hid and where. Absent is nothing hidden. */
  stash?: StashEntry[];
  /**
   * What the `sp` / `pow` listing last said, under the same absence
   * allowance as the loadout — with one distinction the loadout does not
   * need: **absent means never read, `[]` means read and empty.** The
   * settings screen turns on that difference, so an absent key must not be
   * normalised to an empty list.
   */
  spellbook?: KnownSpell[];
  /** Observed cast→wear-off seconds per spell (lowercased). See the sink. */
  spellDurations?: Record<string, number>;
  /** The monsters run from, and at what level. Absent is none. */
  fled?: FledEntry[];
  /** What hunting each spot paid, by spot key (todo 70). Absent is none. */
  huntRates?: Record<string, MeasuredRate>;
  /**
   * What `abil` last summed, under the same absence allowance as the
   * spellbook: **absent means never read, not "the realm counts none"**. The
   * quest book turns a step on that difference.
   */
  abilities?: AbilitySums;
  /**
   * Who this character was, so a reset can be noticed. Absent means never read.
   * See `src/shared/reset.ts`.
   */
  identity?: CharacterIdentity;
  /**
   * What the fighting has added up to, and when it was last handed over.
   * Absent means never kept. See `StatsRecord`.
   */
  stats?: StatsRecord;
  statsBase?: CombatTally;
  /** The room last stood in. Absent means none was ever placed. */
  room?: KeptRoom;
  /** The lives last read. Absent means never read. */
  lives?: KeptLives;
  /** The lap and the route the app last saw. Parsed by `asUnderway`; absent is nothing. */
  underway?: unknown;
}

export interface BelongingsOptions {
  /** Where this character's record lives. Created on demand. */
  file: string;
  /** The address dialled, as `realmAddress` folds it. */
  realm: string;
  /**
   * Reported rather than thrown: failing to read a balance file must not stop
   * a character connecting, and the failure is worth saying out loud because
   * the alternative is a client that silently forgets money.
   */
  notify?(message: string): void;
}

export class Belongings implements BelongingsSink, UnderwaySink {
  private banks: BankBalance[] = [];
  private loadout: WornSlot[] = [];
  private stash: Stash = [];
  private spellbook: KnownSpell[] | null = null;
  private durations: Record<string, number> = {};
  private fled: FledEntry[] = [];
  private huntRates = new Map<string, MeasuredRate>();
  /** Null is *never read*, never "the realm counts none". See the sink. */
  private abilities: AbilitySums | null = null;
  /** Null is *never read*. See `recallIdentity`. */
  private identity: CharacterIdentity | null = null;
  /** Null is *never kept*. See `recallStats`. */
  private stats: StatsRecord | null = null;
  /** Null is *never reset*. See `recallStatsBase`. */
  private statsBase: CombatTally | null = null;
  /** Null is *never placed*. See `recallRoom`. */
  private room: KeptRoom | null = null;
  /** Null is *never read*. See `recallLives`. */
  private lives: KeptLives | null = null;
  private underway: Underway = NOTHING_UNDERWAY;
  private timer: NodeJS.Timeout | null = null;
  /** When the armed timer fires, so a sooner request can replace a later one. */
  private due = 0;
  private dirty = false;
  /** Set by `close`: a change after it (a realm switch clearing what was underway) is written at once. */
  private closed = false;
  /** True once the file was found unreadable; nothing is written over it. */
  private suspended = false;

  constructor(private readonly options: BelongingsOptions) {
    this.load();
  }

  /** The address these balances were banked at, so a re-dial can be noticed. */
  get realm(): string {
    return this.options.realm;
  }

  recallBanks(): readonly BankBalance[] {
    return this.banks;
  }

  rememberBanks(banks: readonly BankBalance[]): void {
    if (this.suspended) return;
    if (sameBanks(this.banks, banks)) return;
    /*
     * Copied, not aliased. The caller hands over the array that is on
     * `CharacterState`, which is frozen by convention rather than by `const`
     * — and a store holding a reference into live state would write whatever
     * that state became between the change and the deferred save.
     */
    this.banks = banks.map((bank) => ({ ...bank }));
    if (this.banks.length > tuning().records.maxVaults) {
      this.banks.sort((a, b) => b.at - a.at);
      this.banks.length = tuning().records.maxVaults;
    }
    this.schedule();
  }

  recallLoadout(): Loadout {
    return this.loadout;
  }

  rememberLoadout(loadout: Loadout): void {
    if (this.suspended) return;
    if (sameLoadout(this.loadout, loadout)) return;
    // Copied for the reason the balances are: the caller hands over what it
    // derived from live state, and a store holding a reference into that would
    // write whatever it became between the change and the deferred save.
    this.loadout = loadout.map((worn) => ({ ...worn }));
    this.schedule();
  }

  recallStash(): Stash {
    return this.stash;
  }

  rememberStash(stash: Stash): void {
    // Held, not copied: `withHidden` and `withTaken` replace rather than mutate.
    if (this.suspended || stash === this.stash) return;
    this.stash = stash;
    this.schedule();
  }

  recallSpellbook(): readonly KnownSpell[] | null {
    return this.spellbook;
  }

  rememberSpellbook(spellbook: readonly KnownSpell[]): void {
    if (this.suspended) return;
    if (this.spellbook !== null && sameSpellbook(this.spellbook, spellbook)) return;
    // Copied for the reason the balances are: the caller hands over what is
    // on live state, and a held reference would write whatever it became.
    this.spellbook = spellbook.map((spell) => ({ ...spell }));
    this.schedule();
  }

  recallSpellDurations(): Readonly<Record<string, number>> {
    return this.durations;
  }

  recallFled(): readonly FledEntry[] {
    return this.fled;
  }

  rememberFled(entries: readonly FledEntry[]): void {
    if (this.suspended) return;
    this.fled = entries.map((entry) => ({ ...entry }));
    this.schedule();
  }

  recallHuntRates(): ReadonlyMap<string, MeasuredRate> {
    return this.huntRates;
  }

  rememberHuntRate(key: string, rate: MeasuredRate): void {
    if (this.suspended) return;
    this.huntRates.set(key, { ...rate });
    this.schedule();
  }

  recallAbilities(): AbilitySums | null {
    return this.abilities;
  }

  recallIdentity(): CharacterIdentity | null {
    return this.identity;
  }

  recallUnderway(): Underway {
    return this.underway;
  }

  rememberUnderway(underway: Underway): void {
    if (this.suspended || sameUnderway(this.underway, underway)) return;
    this.underway = underway;
    this.schedule();
  }

  recallStats(): StatsRecord | null {
    return this.stats;
  }

  rememberStats(tally: CombatTally): void {
    if (this.suspended) return;
    /*
     * Held as it is, not copied: every transform of a tally replaces rather
     * than mutates (`withBlow`, `withSample`, `settleClocks`), which is what
     * makes holding the reference safe, and copying 1,440 samples on every
     * blow would be the parse path paying for a rule it does not need.
     *
     * Written on its own, longer delay. The tally moves on every blow, and a
     * record rewritten every two seconds of a fight is sixty kilobytes a
     * second per character (measured 2026-09-18: 119 KB with a full series).
     * A crash costs at most that delay of totals; `close()` writes a clean
     * quit exactly, and a bank or a worn slot still lands on the short one.
     */
    this.stats = { savedAt: Date.now(), tally };
    this.schedule(tuning().records.statsWriteDelayMs);
  }

  recallStatsBase(): CombatTally | null {
    return this.statsBase;
  }

  rememberStatsBase(base: CombatTally): void {
    if (this.suspended) return;
    this.statsBase = base;
    this.schedule();
  }

  /**
   * Throws the whole record away, at the player's word.
   *
   * Everything in this file is *about a character* — a vault, a loadout, a
   * spellbook, measured durations, quest counters — so when the player says
   * this is not that character, all of it goes together. Nothing about the
   * *realm* is here to be lost: the map, the shops and the other players live
   * in their own files, and none of them stopped being true.
   *
   * Refused while suspended, which is the same refusal every write here makes:
   * the file would not parse, so it is the only copy of something this build
   * cannot read, and overwriting it with an empty record is exactly what the
   * suspension exists to prevent.
   */
  forget(): boolean {
    if (this.suspended) return false;
    this.banks = [];
    this.loadout = [];
    this.stash = [];
    this.spellbook = null;
    this.durations = {};
    this.fled = [];
    this.abilities = null;
    this.identity = null;
    this.stats = null;
    this.statsBase = null;
    this.room = null;
    this.lives = null;
    this.underway = NOTHING_UNDERWAY;
    this.schedule();
    return true;
  }

  recallRoom(): KeptRoom | null {
    return this.room;
  }

  rememberRoom(place: KeptRoom): void {
    if (this.suspended) return;
    const { map, room, confidence } = place;
    if (this.room?.map === map && this.room.room === room && this.room.confidence === confidence)
      return;
    this.room = { map, room, confidence };
    // Every step moves it, so it waits with the totals; `close()` writes the last one.
    this.schedule(tuning().records.statsWriteDelayMs);
  }

  /** The lives last read, for the ask before a dial. Null is *never read*, which is not low. */
  recallLives(): KeptLives | null {
    return this.lives;
  }

  rememberLives(count: number): void {
    if (this.suspended || this.lives?.count === count) return;
    this.lives = { count, at: Date.now() };
    this.schedule();
  }

  rememberIdentity(identity: CharacterIdentity): void {
    if (this.suspended) return;
    this.identity = { ...identity };
    this.schedule();
  }

  rememberAbilities(abilities: AbilitySums): void {
    if (this.suspended) return;
    // Copied for the reason the balances are: the caller hands over what is on
    // live state, and a held reference would write whatever it became.
    this.abilities = { ...abilities, sums: { ...abilities.sums } };
    this.schedule();
  }

  rememberSpellDuration(spell: string, seconds: number): void {
    if (this.suspended) return;
    const key = spell.trim().toLowerCase();
    if (key.length === 0 || !Number.isFinite(seconds) || seconds <= 0) return;
    const rounded = Math.round(seconds);
    if (this.durations[key] === rounded) return;
    // The newest measurement wins outright: a duration grows with the
    // caster's level, and an average would lag it in the direction that
    // recasts early — the wasteful direction, not the dangerous one, but
    // still the wrong number when a right one was just observed.
    this.durations[key] = rounded;
    this.schedule();
  }

  /** Writes anything outstanding and stops the timer. Safe to call twice. */
  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    /*
     * A clock still running is closed now: quitting is a moment the client
     * knows it was in the realm and nothing on the wire will describe, and a
     * record read back with the clock open has to close it at the last change
     * instead — hours short, if the character stood idle.
     */
    if (this.stats !== null && !this.suspended) {
      const at = Date.now();
      const settled = settleClocks(this.stats.tally, at);
      if (settled !== this.stats.tally) {
        this.stats = { savedAt: at, tally: settled };
        this.dirty = true;
      }
    }
    if (this.dirty) this.write();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.options.file)) return;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.options.file, 'utf8'));
      const fault = belongingsFault(parsed);
      if (fault !== null) {
        this.suspended = true;
        const fileName = path.basename(this.options.file);
        const notSaved = t('notices.world.belongings.notSaved');
        // The field, so a check made stricter is seen at once (todo 18).
        this.options.notify?.(
          fault === ''
            ? t('notices.world.belongings.invalidFile', { fileName, notSaved })
            : t('notices.world.belongings.invalidField', { fileName, field: fault, notSaved })
        );
        return;
      }
      // Read through `belongingsFault` just above.
      const file = parsed as BelongingsFile;
      // A different realm's vaults are not this realm's. Kept on disk, and
      // nothing is written back over them until the character dials home.
      if (file.realm !== this.options.realm) {
        this.suspended = true;
        return;
      }
      this.banks = file.banks;
      this.loadout = file.loadout ?? [];
      this.stash = file.stash ?? [];
      // Absent is *never read*, and stays null — not normalised to [].
      this.spellbook = file.spellbook ?? null;
      this.durations = file.spellDurations ?? {};
      this.fled = file.fled ?? [];
      this.huntRates = new Map(Object.entries(file.huntRates ?? {}));
      // Absent is *never read*, and stays null — the spellbook's rule.
      this.abilities = file.abilities ?? null;
      this.identity = file.identity ?? null;
      this.stats = file.stats ?? null;
      this.statsBase = file.statsBase ?? null;
      this.room = file.room ?? null;
      this.lives = file.lives ?? null;
      this.underway = asUnderway(file.underway);
    } catch (error) {
      /*
       * Suspended rather than started fresh: this is the only copy of what the
       * banks said, and a parse failure is not permission to overwrite it with
       * an empty list on the next deposit.
       */
      this.suspended = true;
      this.options.notify?.(
        t('notices.world.belongings.readError', {
          fileName: path.basename(this.options.file),
          message: errorMessage(error)
        })
      );
    }
  }

  private schedule(delayMs = tuning().records.belongingsWriteDelayMs): void {
    this.dirty = true;
    if (this.closed) {
      this.write();
      return;
    }
    const due = Date.now() + delayMs;
    // A timer already due sooner stands; a later one is brought forward.
    if (this.timer && due >= this.due) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, delayMs);
    // Never the reason the app stays open; `close()` is what guarantees the
    // last balance lands.
    this.timer.unref?.();
  }

  private write(): void {
    const payload: BelongingsFile = {
      version: 1,
      realm: this.options.realm,
      banks: this.banks,
      loadout: this.loadout,
      ...(this.stash.length > 0 ? { stash: [...this.stash] } : {}),
      // Omitted while never read, so the absence survives the round trip.
      ...(this.spellbook !== null ? { spellbook: this.spellbook } : {}),
      ...(Object.keys(this.durations).length > 0 ? { spellDurations: this.durations } : {}),
      ...(this.fled.length > 0 ? { fled: this.fled } : {}),
      ...(this.huntRates.size > 0 ? { huntRates: Object.fromEntries(this.huntRates) } : {}),
      // Omitted while never read, so the absence survives the round trip.
      ...(this.abilities !== null ? { abilities: this.abilities } : {}),
      ...(this.identity !== null ? { identity: this.identity } : {}),
      ...(this.stats !== null ? { stats: this.stats } : {}),
      ...(this.statsBase !== null ? { statsBase: this.statsBase } : {}),
      ...(this.room !== null ? { room: this.room } : {}),
      ...(this.lives !== null ? { lives: this.lives } : {}),
      ...(this.underway.lap === null && this.underway.route === null
        ? {}
        : { underway: this.underway })
    };
    const temporary = `${this.options.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, this.options.file);
      this.dirty = false;
    } catch (error) {
      this.options.notify?.(
        t('notices.world.belongings.saveError', {
          fileName: path.basename(this.options.file),
          message: errorMessage(error)
        })
      );
      // Left dirty, so the next balance tries again rather than the failure
      // quietly becoming permanent.
      fs.rmSync(temporary, { force: true });
    }
  }
}

/**
 * Whether two lists say the same thing, ignoring when they said it.
 *
 * `at` moves on every `bank` whether the figure changed or not, and writing
 * the file for a re-read that said the same number is a disk touched for
 * nothing. The time is still *kept* — the newer list is what gets written when
 * something else does change — because a card showing a stale figure beside a
 * fresh reading time would be the lie the field exists to prevent; it is only
 * not a reason to write on its own.
 */
function sameBanks(a: readonly BankBalance[], b: readonly BankBalance[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((held, at) => {
    const other = b[at];
    return (
      other !== undefined &&
      held.copper === other.copper &&
      held.shop === other.shop &&
      bankKey(held.name) === bankKey(other.name)
    );
  });
}

/**
 * Whether two loadouts say the same thing, ignoring when they said it.
 *
 * The same reason `sameBanks` exists: a listing restates every slot on every
 * `i`, and writing the file for a re-read that named the same kit is a disk
 * touched from the thread that is framing bytes.
 */
function sameLoadout(a: Loadout, b: Loadout): boolean {
  if (a.length !== b.length) return false;
  return a.every((worn, at) => {
    const other = b[at];
    return (
      other !== undefined &&
      worn.slot.toLowerCase() === other.slot.toLowerCase() &&
      sameItem(worn.item, other.item)
    );
  });
}

/**
 * Whether two books say the same thing. Order matters — the listing's order
 * is the server's own (by level, then name) and a reorder is a change worth
 * writing, not that one ever happens without a row changing too.
 */
function sameSpellbook(a: readonly KnownSpell[], b: readonly KnownSpell[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((spell, at) => {
    const other = b[at];
    return (
      other !== undefined &&
      spell.name === other.name &&
      spell.short === other.short &&
      spell.level === other.level &&
      spell.cost === other.cost
    );
  });
}

/**
 * What a spellbook was last seen to hold, without taking the file on.
 *
 * For the settings screen, which needs to offer the book as a picker while
 * the character may not even be connected. Read-only by construction — no
 * instance, no timer, nothing that could write — and it answers null for
 * everything null means above *plus* a file it cannot read or a realm other
 * than the one asked about: an unreadable record must widen the picker to
 * "not read yet", never narrow it to "knows nothing".
 */
export function peekSpellbook(file: string, realm: string): readonly KnownSpell[] | null {
  return peek(file, realm)?.spellbook ?? null;
}

/**
 * The room the record last placed the character in, read the same way, for a
 * tab drawn at launch before any dial. A file it cannot read places nothing
 * here; `connect` opens the record and reports it, once a window can hear.
 */
export function peekRoom(file: string, realm: string): KeptRoom | null {
  return peek(file, realm)?.room ?? null;
}

/** The lives the record last read, the same way, for the ask before a launch's first dial. */
export function peekLives(file: string, realm: string): KeptLives | null {
  return peek(file, realm)?.lives ?? null;
}

/** The record for `realm`, or null for a missing, unreadable or other realm's file. */
function peek(file: string, realm: string): BelongingsFile | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isBelongingsFile(parsed) && parsed.realm === realm ? parsed : null;
  } catch {
    return null;
  }
}

/** Parsed, not trusted: this file is on disk where anything may have edited it. */
function isBelongingsFile(value: unknown): value is BelongingsFile {
  return belongingsFault(value) === null;
}

/** The first field that does not read, `''` for the file itself, or null. See `combatTallyFault`. */
function belongingsFault(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '';
  const file = value as Partial<BelongingsFile>;
  const optional = (entry: unknown, reads: (entry: unknown) => boolean): boolean =>
    entry === undefined || reads(entry);
  const listOf =
    <T>(reads: (entry: unknown) => entry is T) =>
    (entry: unknown): boolean =>
      Array.isArray(entry) && entry.every(reads);
  if (file.version !== 1) return 'version';
  if (typeof file.realm !== 'string') return 'realm';
  if (!listOf(isBankBalance)(file.banks)) return 'banks';
  if (!optional(file.loadout, listOf(isWornSlot))) return 'loadout';
  if (!optional(file.stash, listOf(isStashEntry))) return 'stash';
  if (!optional(file.spellbook, listOf(isKnownSpell))) return 'spellbook';
  if (!optional(file.spellDurations, isDurationRecord)) return 'spellDurations';
  if (!optional(file.fled, isFledList)) return 'fled';
  if (!optional(file.huntRates, isHuntRates)) return 'huntRates';
  if (!optional(file.abilities, isAbilitySums)) return 'abilities';
  if (!optional(file.identity, isIdentity)) return 'identity';
  if (file.stats !== undefined) {
    const fault = faultWithin('stats', statsRecordFault(file.stats));
    if (fault !== null) return fault;
  }
  if (file.statsBase !== undefined) {
    const fault = faultWithin('statsBase', combatTallyFault(file.statsBase));
    if (fault !== null) return fault;
  }
  if (!optional(file.room, isKeptRoom)) return 'room';
  if (!optional(file.lives, isKeptLives)) return 'lives';
  return null;
}

/** A count of lives, a whole number from 0, and the clock it was read on. */
function isKeptLives(value: unknown): value is KeptLives {
  if (typeof value !== 'object' || value === null) return false;
  const { count, at } = value as Record<string, unknown>;
  return Number.isInteger(count) && (count as number) >= 0 && typeof at === 'number';
}

/** A room by its realm numbers, two whole numbers, and a confidence from 0 to 1. */
function isKeptRoom(value: unknown): value is KeptRoom {
  if (typeof value !== 'object' || value === null) return false;
  const { map, room, confidence } = value as Record<string, unknown>;
  if (!Number.isInteger(map) || !Number.isInteger(room)) return false;
  return typeof confidence === 'number' && confidence >= 0 && confidence <= 1;
}

/** Each spot's measured rate: four finite figures. */
function isHuntRates(value: unknown): value is Record<string, MeasuredRate> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((rate: unknown) => {
    if (typeof rate !== 'object' || rate === null) return false;
    const { perHour, minutes, level, at } = rate as Record<string, unknown>;
    return [perHour, minutes, level, at].every(
      (figure) => typeof figure === 'number' && Number.isFinite(figure)
    );
  });
}

/** The clock is what closes an interval the record left open, so a record without one is refused. */
function statsRecordFault(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Partial<StatsRecord>;
  if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return 'savedAt';
  return faultWithin('tally', combatTallyFault(record.tally));
}

/**
 * `complete` is what says whether an absent id is zero or unknown, so a row
 * missing it is not a listing this client can read back safely — the whole
 * point of the flag. Refused rather than defaulted.
 */
function isAbilitySums(value: unknown): value is AbilitySums {
  if (typeof value !== 'object' || value === null) return false;
  const sums = value as Partial<AbilitySums>;
  if (typeof sums.complete !== 'boolean' || typeof sums.at !== 'number') return false;
  if (typeof sums.sums !== 'object' || sums.sums === null) return false;
  return Object.values(sums.sums as Record<string, unknown>).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry)
  );
}

/** Every field nullable, `at` not: a record with no clock cannot be aged. */
function isIdentity(value: unknown): value is CharacterIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Partial<CharacterIdentity>;
  const word = (entry: unknown): boolean => entry === null || typeof entry === 'string';
  const number = (entry: unknown): boolean => entry === null || typeof entry === 'number';
  return (
    word(identity.race) &&
    word(identity.className) &&
    number(identity.level) &&
    number(identity.exp) &&
    typeof identity.at === 'number'
  );
}

function isKnownSpell(value: unknown): value is KnownSpell {
  if (typeof value !== 'object' || value === null) return false;
  const spell = value as Partial<KnownSpell>;
  return (
    typeof spell.name === 'string' &&
    spell.name.length > 0 &&
    (spell.short === null || typeof spell.short === 'string') &&
    (spell.level === null || typeof spell.level === 'number') &&
    (spell.cost === null || typeof spell.cost === 'number')
  );
}

function isDurationRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((seconds) => typeof seconds === 'number' && seconds > 0);
}

function isWornSlot(value: unknown): value is WornSlot {
  if (typeof value !== 'object' || value === null) return false;
  const worn = value as Partial<WornSlot>;
  return (
    typeof worn.slot === 'string' &&
    worn.slot.length > 0 &&
    typeof worn.item === 'string' &&
    worn.item.length > 0 &&
    typeof worn.at === 'number' &&
    Number.isFinite(worn.at)
  );
}

function isBankBalance(value: unknown): value is BankBalance {
  if (typeof value !== 'object' || value === null) return false;
  const bank = value as Partial<BankBalance>;
  return (
    (bank.shop === null || typeof bank.shop === 'number') &&
    typeof bank.name === 'string' &&
    bank.name.length > 0 &&
    typeof bank.copper === 'number' &&
    Number.isFinite(bank.copper) &&
    typeof bank.at === 'number' &&
    Number.isFinite(bank.at)
  );
}
