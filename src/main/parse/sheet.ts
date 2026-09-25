/**
 * What the character *is*: its vitals, its progression and its afflictions —
 * the status line, the stat sheet, experience and lives, the spellbook and
 * the conditions.
 *
 * The sheet cluster out of `CharacterTracker` (`mudengine-wire` › *Five
 * clusters live outside the tracker*), todo 721: each case in `reduce` keeps
 * its line and calls one function here. What needs no memory is `state in →
 * state out`; `StatusLine` owns the matcher `pro` built. What the buffs have
 * taught is its helper's, `effects.ts` (`EffectTracker`).
 */
import {
  NO_COMBAT,
  type Affliction,
  type Afflictions,
  type CharacterState,
  type KnownSpell
} from '../../shared/character';
import {
  derivedExperienceTable,
  withDerivedExperience,
  withRealmExperience,
  type ExperienceLevel,
  type ExperienceTable
} from '../../shared/experience';
import { readingOf, statlineMatcher, type StatlineReading } from '../../shared/statline';
import type { BelongingsSink } from '../../shared/belongings';
import { LEARN_SPELL_ABILITY } from '../../shared/abilities';
import { bareName } from '../../shared/items';
import { readStatAll, statedBasis } from '../../shared/stated';
import type { Block } from '../../shared/blocks';
import { figure } from '../../shared/values';
import type { WorldGraph } from '../world/WorldGraph';
import { withCharges, withoutItem } from './inventory';
import { STATUS_LINE } from './patterns';

type Groups = Block['groups'];
type Rows = ReadonlyArray<Record<string, string>>;

/** The realm as a read scroll reads it: the spell's row, and which carried item teaches it. */
export type ScrollWorld = Pick<WorldGraph, 'spellNamed' | 'itemsNamed'>;
/** The realm as the experience table reads it: what a race and class pay per level. */
export type ExperienceWorld = Pick<WorldGraph, 'experiencePercent'>;

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
function readAbilityListing(rows: Rows): {
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
    const id = figure(row['id']);
    const value = figure(row['value']);
    if (id === null || value === null) continue;
    sums[id] = (sums[id] ?? 0) + value;
  }
  return { sums, complete };
}

/** One affliction flag moved, or null when the server said what was already known. */
export function afflicted(
  s: CharacterState,
  which: keyof Afflictions,
  value: Affliction
): CharacterState | null {
  if (s.afflictions[which] === value) return null;
  return { ...s, afflictions: { ...s.afflictions, [which]: value } };
}

/** `user-health`: the cheap way to learn a maximum. */
export function healthStated(s: CharacterState, g: Groups): CharacterState | null {
  /*
   * `health` reports current *and* maximum on one line.
   *
   * The status line carries no maximum and the stat sheet costs a whole
   * screen, so this is the cheap way to learn one — and the only one a
   * rule can afford to run often. Both numbers are taken: they arrive
   * together and are therefore consistent with each other, which two
   * separate readings would not be.
   */
  const hp = figure(g['hp']);
  const hpMax = figure(g['hpMax']);
  if (hp === null && hpMax === null) return null;
  return {
    ...s,
    vitals: { ...s.vitals, hp: hp ?? s.vitals.hp, hpMax: hpMax ?? s.vitals.hpMax }
  };
}

/** `user-rests`: resting or meditating, as the sentence said. */
export function rested(s: CharacterState, state: string | undefined): CharacterState {
  return {
    ...s,
    vitals: {
      ...s.vitals,
      resting: state === 'resting',
      meditating: state === 'meditating'
    }
  };
}

/** `user-mortally-wounded`: on the ground. The same state when it already was. */
export function droppedWounded(s: CharacterState): CharacterState {
  return s.mortallyWounded ? s : { ...s, mortallyWounded: true };
}

/**
 * `user-dies`: the state the death leaves. What it forgets — the queue, the
 * fight, the trail — is the tracker's.
 *
 * `combat` is emptied rather than the room: the temple's own block is two
 * lines away and will replace the room outright, and clearing it here
 * would blank the map for those two lines.
 */
export function died(s: CharacterState, at: number): CharacterState {
  // Death strips what was cast: the temple room two lines away holds a
  // character with none of its blessings, and a list kept through it
  // would stop every recast until each fallback clock ran out.
  return {
    ...s,
    inCombat: false,
    combat: NO_COMBAT,
    buffs: [],
    // The death ends the state the drop began: a character in the temple
    // is standing, and the status line two lines away will say so anyway.
    // Cleared here so nothing is held between the two (todo 20).
    mortallyWounded: false,
    // Where it died, kept for the kit lying there (`GearRecovery`): the
    // room the character was standing in when the sentence arrived.
    lastDeath: {
      map: s.room.map,
      number: s.room.number,
      name: s.room.name,
      at
    }
  };
}

/** `user-lives`: the absolute the server restated, or null when it did not move. */
export function livesStated(s: CharacterState, said: string | undefined): CharacterState | null {
  const lives = figure(said);
  if (lives === null || lives === s.progress.lives) return null;
  return { ...s, progress: { ...s.progress, lives } };
}

/** `user-gains`: lives counted onto what the sheet said, and only then. */
export function livesGained(s: CharacterState, g: Groups): CharacterState | null {
  if (!/^additional lives$/.test(g['what'] ?? '')) return null;
  const gained = figure(g['count']);
  if (gained === null || s.progress.lives === null) return null;
  return { ...s, progress: { ...s.progress, lives: s.progress.lives + gained } };
}

/** `user-levels`: the new level, and the maxima it made wrong. */
export function levelled(s: CharacterState, said: string | undefined): CharacterState | null {
  const level = figure(said);
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

/** `user-experience`: `exp`'s answer, and the next level's price with it. */
export function experienceStated(s: CharacterState, g: Groups): CharacterState {
  const level = figure(g['level']);
  /*
   * The parenthesised figure is the **price of the next level**, and it
   * is one row of the table for free: `Exp: 228060 Level: 10 Exp needed
   * for next level: 125343 (353403)` — the difference is exactly what is
   * owed (captures/007, and three more in the corpus say the same). It
   * was captured and discarded for as long as this pattern has existed.
   */
  const required = figure(g['required']);
  const stated: ExperienceLevel[] =
    level !== null && required !== null
      ? [{ level: level + 1, experience: required, source: 'realm' }]
      : [];
  return {
    ...s,
    progress: {
      ...s.progress,
      exp: figure(g['exp']),
      level,
      expNeeded: figure(g['needed']),
      expTable: withRealmExperience(s.progress.expTable, stated)
    }
  };
}

/** `user-experience-table`: the rows the realm stated, or null for a table of none. */
export function experienceTable(s: CharacterState, rows: Rows): CharacterState | null {
  const stated: ExperienceLevel[] = [];
  for (const row of rows) {
    const level = figure(row['level']);
    const experience = figure(row['experience']);
    if (level === null || experience === null) continue;
    stated.push({ level, experience, source: 'realm' });
  }
  if (stated.length === 0) return null;
  return {
    ...s,
    progress: { ...s.progress, expTable: withRealmExperience(s.progress.expTable, stated) }
  };
}

/**
 * `user-gain-experience`: the figure counted onto the progress `before` held.
 * `after` is the fight's reading of the same line (`FightTracker.died`), and
 * its progress is not kept: the kill is the fight's, the figure the sheet's.
 */
export function experienceGained(
  after: CharacterState,
  before: CharacterState,
  said: string | undefined
): CharacterState {
  const gained = figure(said) ?? 0;
  return {
    ...after,
    progress: {
      ...before.progress,
      exp: before.progress.exp === null ? null : before.progress.exp + gained,
      expNeeded:
        before.progress.expNeeded === null ? null : Math.max(0, before.progress.expNeeded - gained),
      expThisSession: before.progress.expThisSession + gained
    }
  };
}

/**
 * `player-status`: the stat sheet's figures over `s`, which already carries
 * what the sheet said is up (`EffectTracker.listed`). The stat sheet is where
 * maxima come from; the status line has none.
 */
export function statSheet(s: CharacterState, g: Groups): CharacterState {
  return {
    ...s,
    name: g['first'] ?? s.name,
    fullName: g['first'] ? [g['first'], g['last'] ?? ''].join(' ').trim() : s.fullName,
    race: g['race'] ?? s.race,
    className: g['class'] ?? s.className,
    vitals: {
      ...s.vitals,
      hpMax: figure(g['hpMax']) ?? s.vitals.hpMax,
      manaMax: figure(g['manaMax']) ?? s.vitals.manaMax,
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
      level: figure(g['level']) ?? s.progress.level,
      lives: figure(g['lives']) ?? s.progress.lives,
      /*
       * The sheet states the running total, and on this realm it is the
       * *only* thing that does: experience is otherwise read from the
       * status line's `Exp=` field, which the live Paradigm server does
       * not send. Vaelor's sheet said `Exp: 34603` while `progress.exp`
       * stayed null — the number was on screen and the client threw it
       * away (measured live, 2026-08-27).
       */
      exp: figure(g['exp']) ?? s.progress.exp,
      strength: figure(g['strength']) ?? s.progress.strength,
      picklocks: figure(g['picklocks']) ?? s.progress.picklocks,
      // What a blow's size turns on, which `FightLog` records without.
      martialArts: figure(g['martialArts']) ?? s.progress.martialArts,
      magicRes: figure(g['magicRes']) ?? s.progress.magicRes,
      // The rest of the sheet, for the Self card — parsed since the
      // sheet was, kept since 2026-09-03.
      intellect: figure(g['intellect']) ?? s.progress.intellect,
      willpower: figure(g['willpower']) ?? s.progress.willpower,
      agility: figure(g['agility']) ?? s.progress.agility,
      health: figure(g['health']) ?? s.progress.health,
      charm: figure(g['charm']) ?? s.progress.charm,
      perception: figure(g['perception']) ?? s.progress.perception,
      stealthSkill: figure(g['stealth']) ?? s.progress.stealthSkill,
      thievery: figure(g['thievery']) ?? s.progress.thievery,
      traps: figure(g['traps']) ?? s.progress.traps,
      tracking: figure(g['tracking']) ?? s.progress.tracking,
      spellcasting: figure(g['spellcasting']) ?? s.progress.spellcasting,
      armourClass: figure(g['ac']) ?? s.progress.armourClass,
      damageResist: figure(g['dr']) ?? s.progress.damageResist,
      cp: figure(g['cp']) ?? s.progress.cp
    }
  };
}

/**
 * `user-abilities`: the listing, written down as well as published — a
 * listing costs a command, and a client that asked for one and then forgot it
 * on the way out is a client that asks again every launch. Null for a listing
 * with not one readable row.
 */
export function abilitiesListed(
  s: CharacterState,
  rows: Rows,
  at: number,
  record: Pick<BelongingsSink, 'rememberAbilities'>
): CharacterState | null {
  const { sums, complete } = readAbilityListing(rows);
  if (Object.keys(sums).length === 0) return null;
  const abilities = { sums, complete, at };
  record.rememberAbilities(abilities);
  return { ...s, abilities };
}

/** `user-stat-all`: the server's arithmetic, with what it was computed from. */
export function statAll(s: CharacterState, rows: Rows): CharacterState | null {
  const stated = readStatAll(rows, statedBasis(s));
  return stated === null ? null : { ...s, stated };
}

/** The resource the book that answered is spent from: `powers` are Kai, `spells` mana. */
function bookResource(s: CharacterState, book: string | undefined): 'MA' | 'KAI' | null {
  return book === 'powers' ? 'KAI' : book === 'spells' ? 'MA' : s.vitals.manaType;
}

/** Whether a book already lists a spell by this name. */
function listsSpell(book: readonly KnownSpell[], name: string): boolean {
  return book.some((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

/** `spellbook`: the listing, replacing the whole book. */
export function spellbookListed(
  s: CharacterState,
  rows: Rows,
  book: string | undefined
): CharacterState {
  const spellbook: KnownSpell[] = [];
  for (const row of rows) {
    const name = row['name']?.trim();
    if (!name) continue;
    spellbook.push({
      name,
      short: row['short']?.trim() || null,
      level: figure(row['level']),
      cost: figure(row['cost'])
    });
  }
  return {
    ...s,
    spellbook,
    vitals: { ...s.vitals, manaType: bookResource(s, book) }
  };
}

/** `spellbook-empty`: a book that was read and holds nothing, `[]` and never null. */
export function spellbookEmpty(s: CharacterState, book: string | undefined): CharacterState {
  return {
    ...s,
    spellbook: [],
    vitals: { ...s.vitals, manaType: bookResource(s, book) }
  };
}

/** `user-learns`: one entry appended, onto a book a listing has read. */
export function spellLearned(
  s: CharacterState,
  kind: string | undefined,
  named: string | undefined
): CharacterState | null {
  const name = named?.trim();
  if (!name || (kind !== 'power' && kind !== 'spell')) return null;
  if (s.spellbook === null) return null;
  if (listsSpell(s.spellbook, name)) return null;
  return {
    ...s,
    spellbook: [...s.spellbook, { name, short: null, level: null, cost: null }]
  };
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
function scrollTeaching(
  world: ScrollWorld | undefined,
  state: CharacterState,
  spellId: number
): string | null {
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
 * `user-reads-spell`: the book gains an entry and the scroll is gone, each on
 * its own evidence. `spent` is the pack's bookkeeping (`CharacterTracker`'s
 * `packChanges`), told of the scroll before it leaves the state.
 */
export function spellRead(
  s: CharacterState,
  named: string | undefined,
  world: ScrollWorld | undefined,
  spent: (scroll: string) => void
): CharacterState | null {
  const name = named?.trim();
  if (!name) return null;
  /*
   * The realm's own row, which is both halves' key: its id finds the
   * scroll, and its columns fill in the short word, level and cost that
   * a book appended a spell at a time would otherwise be missing until
   * the next listing. Null is *this realm does not name it*, which is a
   * real answer for a derivative and never an error.
   */
  const spell = world?.spellNamed(name) ?? null;
  let next = s;

  const scroll = spell === null ? null : scrollTeaching(world, s, spell.id);
  if (scroll !== null) {
    spent(scroll);
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
  if (book !== null && !listsSpell(book, known)) {
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

/** `user-encumbrance`: the bare load line, which arrives on its own after a pick-up. */
export function encumbranceStated(s: CharacterState, g: Groups): CharacterState | null {
  const carried = figure(g['carried']);
  const max = figure(g['max']);
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

/** `light-out`: the readied light gives nothing now. Null when nothing moved. */
export function lightOut(s: CharacterState, item: string | undefined): CharacterState | null {
  if (!item) return null;
  const next = withCharges(s, item, 0);
  return next === s ? null : next;
}

/**
 * The experience table, worked out from the realm data when nothing else has.
 *
 * Folded after the reducer rather than in a case, for the reason `trackPlayers`
 * and `trackTally` are: its three inputs — the race, the class and the level —
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
export function derivedExperience(
  state: CharacterState,
  before: CharacterState,
  world: ExperienceWorld | undefined
): CharacterState {
  const table = state.progress.expTable;
  const level = state.progress.level;
  if (
    state.race === before.race &&
    state.className === before.className &&
    level === before.progress.level &&
    table === before.progress.expTable
  )
    return state;

  if (!world || state.race === null || state.className === null || level === null) return state;
  const percent = world.experiencePercent(state.race, state.className);
  if (percent === null) return state;
  const derived = derivedExperienceTable(percent, level);
  if (derived === null) return state;
  const merged = withDerivedExperience(table, derived);
  if (merged === table) return state;
  return { ...state, progress: { ...state.progress, expTable: merged } };
}

/**
 * A prompt read: its figures, whether `pro`'s matcher agreed (null with no
 * matcher), and how much of the line the prompt is.
 */
export interface PromptReading {
  read: StatlineReading;
  exact: boolean | null;
  length: number;
}

/**
 * The status line, read by the template `pro` reported where there is one.
 *
 * Owns the matcher, a fact about the character held server-side, and the flag
 * that asks about a lapse once per report; neither goes on leaving the realm,
 * only at `forget` — a new connection. `mudengine-wire` › *The status line is
 * a template, and the matcher is built from what `pro` reports*.
 */
export class StatusLine {
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

  /** A new connection: nothing `pro` said about the last one holds. */
  forget(): void {
    this.statlineMatcher = null;
    this.statlineWanted = false;
    this.statlineAsked = false;
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
  readPrompt(text: string): PromptReading | null {
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
        hp: figure(g['hp']),
        hpMax: figure(g['hpMax']),
        mana: figure(g['mana']),
        manaMax: figure(g['manaMax']),
        exp: extra.exp ?? null,
        need: extra.need ?? null,
        wealth: extra.wealth ?? null,
        state: state === 'Resting' ? 'resting' : state === 'Meditating' ? 'meditating' : null
      },
      exact: this.statlineMatcher ? false : null,
      length: match[0].length
    };
  }

  /** `status-line`: the in-game discriminator, and every figure the prompt carries. */
  prompt(s: CharacterState, block: Block): CharacterState | null {
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
    const key = block.groups['manaType'];
    const manaType: 'MA' | 'KAI' | null =
      key === 'MA' || key === 'M' ? 'MA' : key === 'KAI' || key === 'K' ? 'KAI' : s.vitals.manaType;
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
      /*
       * Up again — and the status line is the proof, not a clock.
       *
       * A character on the ground is refusing everything until its health
       * is back above zero, and this is the one line that states the
       * figure. Cleared on a *stated* positive reading only: `read.hp`
       * null is a prompt that carried no health, which says nothing about
       * whether the character is standing (todo 20).
       */
      mortallyWounded: read.hp !== null && read.hp > 0 ? false : s.mortallyWounded,
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

  /** `user-statline`: `pro`'s `Statusline:` row, and the matcher built from it. */
  reported(s: CharacterState, statline: string | undefined): CharacterState | null {
    const reported = statline?.trim() ?? '';
    if (reported.length === 0 || s.statline.reported === reported) return null;
    this.statlineMatcher = statlineMatcher(reported);
    this.statlineAsked = false;
    return { ...s, statline: { reported, exact: null } };
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
}
