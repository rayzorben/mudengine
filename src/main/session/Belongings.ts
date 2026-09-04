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
import fs from 'node:fs';
import path from 'node:path';

import type { BankBalance, KnownSpell } from '../../shared/character';
import { bankKey } from '../../shared/character';
import type { BelongingsSink } from '../../shared/belongings';
import type { Loadout, WornSlot } from '../../shared/gear';
import { sameItem } from '../../shared/items';
import { errorMessage } from '../../shared/values';
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

export class Belongings implements BelongingsSink {
  private banks: BankBalance[] = [];
  private loadout: WornSlot[] = [];
  private spellbook: KnownSpell[] | null = null;
  private durations: Record<string, number> = {};
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) this.write();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.options.file)) return;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.options.file, 'utf8'));
      if (!isBelongingsFile(parsed)) {
        this.suspended = true;
        this.options.notify?.(
          t('notices.world.belongings.invalidFile', { fileName: path.basename(this.options.file) })
        );
        return;
      }
      // A different realm's vaults are not this realm's. Kept on disk, and
      // nothing is written back over them until the character dials home.
      if (parsed.realm !== this.options.realm) {
        this.suspended = true;
        return;
      }
      this.banks = parsed.banks;
      this.loadout = parsed.loadout ?? [];
      // Absent is *never read*, and stays null — not normalised to [].
      this.spellbook = parsed.spellbook ?? null;
      this.durations = parsed.spellDurations ?? {};
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

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, tuning().records.belongingsWriteDelayMs);
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
      // Omitted while never read, so the absence survives the round trip.
      ...(this.spellbook !== null ? { spellbook: this.spellbook } : {}),
      ...(Object.keys(this.durations).length > 0 ? { spellDurations: this.durations } : {})
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
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isBelongingsFile(parsed)) return null;
    if (parsed.realm !== realm) return null;
    return parsed.spellbook ?? null;
  } catch {
    return null;
  }
}

/** Parsed, not trusted: this file is on disk where anything may have edited it. */
function isBelongingsFile(value: unknown): value is BelongingsFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<BelongingsFile>;
  if (file.version !== 1 || typeof file.realm !== 'string') return false;
  if (!Array.isArray(file.banks)) return false;
  if (file.loadout !== undefined && !Array.isArray(file.loadout)) return false;
  if (file.loadout !== undefined && !file.loadout.every(isWornSlot)) return false;
  if (file.spellbook !== undefined && !Array.isArray(file.spellbook)) return false;
  if (file.spellbook !== undefined && !file.spellbook.every(isKnownSpell)) return false;
  if (file.spellDurations !== undefined && !isDurationRecord(file.spellDurations)) return false;
  return file.banks.every(isBankBalance);
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
