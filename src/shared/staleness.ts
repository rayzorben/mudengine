/**
 * What a sentence off the wire made out of date, and the command that says it
 * again.
 *
 * The client holds facts a command established and the server's own broadcasts
 * maintain — the standing shape everywhere here. Some sentences maintain
 * nothing and instead **invalidate**: they say a number the client is holding
 * has just changed without saying what it changed to. `Welcome to level 7!` is
 * the plain case — the experience needed for the next level, the maximum hit
 * points and the mana are all different from that line onward, and nothing in
 * the stream will ever correct them, so *Exp. needed* and *Will level in* read
 * against the previous level for the rest of the session.
 *
 * So this is the third column of that table: **what a sentence made stale**,
 * declared as data rather than as a chain of `if`s beside the code that asks.
 * `Routines` reads it and proposes the refresh to `CommandQueue`; nothing here
 * sends anything, and nothing here decides *whether* to — a fact being stale
 * is a fact, and asking is an action.
 *
 * In `shared/` and dependency-free, like the rest: the block vocabulary is
 * shared, and a table keyed by it belongs beside the vocabulary rather than
 * inside one process.
 */
import type { BlockType } from './blocks';

/**
 * A fact the client holds that exactly one command re-establishes.
 *
 * Closed, and the union has two halves that move together — the word and the
 * command it names in `REFRESH` — which `src/shared/__tests__/staleness.test.ts`
 * asserts, for the reason `GUARD_FIELDS` records: a member in the type and not
 * in the table type-checks and then refreshes nothing.
 *
 * The spellbook is deliberately **not** here. Its command is `spells` or
 * `powers` depending on the class and the client learns which from the
 * server's own refusal, so there is no fixed command to name; `Routines` keeps
 * that one where the correction it came from lives.
 */
export type StaleFact =
  /** `st` — the maxima, the six attributes, the skills, `Lives/CP`. */
  | 'sheet'
  /** `exp` — experience made, and how much is needed for the next level. */
  | 'experience'
  /**
   * `? exp` — the table of what each level costs, one below to eight above.
   * orohost's `exp` prints only the summary line, and past level 13 nothing
   * works the table out (`EXPERIENCE_CONFIRMED_TO`), so this is the only
   * place a price beyond the next level comes from.
   */
  | 'chart'
  /** `i` — what is carried, and the purse `Wealth:` states. */
  | 'pack';

/**
 * The command that says each fact again, and the intent it coalesces onto.
 *
 * The keys are the ones the entry probe already builds (`probe:${command}`),
 * so a refresh and an entry probe for the same command are **one** intent
 * rather than two spellings of it — coalesce by intent is the whole rule, and
 * two `st`s queued a second apart is a command spent to be told what the first
 * one is already on its way back with.
 */
export const REFRESH: Record<StaleFact, { command: string; coalesceKey: string }> = {
  sheet: { command: 'st', coalesceKey: 'probe:st' },
  experience: { command: 'exp', coalesceKey: 'probe:exp' },
  chart: { command: '? exp', coalesceKey: 'probe:? exp' },
  pack: { command: 'i', coalesceKey: 'probe:i' }
};

/**
 * Which facts each sentence invalidated.
 *
 * Only sentences that state a change **and not its result**. A listing is not
 * here: it *is* the answer. Nor is anything the maintained-listing shape
 * already keeps true for free — a coin picked up counts itself up, and asking
 * `i` for it would spend from the budget walking and fighting spend from.
 *
 * - **`user-levels`** (`Welcome to level 7!`) — the sheet, because the maximum
 *   hit points and mana are rolled on the level, and the experience and the
 *   chart, because the figure for the *next* level is a different number and
 *   this realm's status line carries no `Need=` to maintain it.
 * - **`user-trains`** — the same three, plus the **pack**: the sentence states a
 *   price handed over (`You hand over 250 copper farthings…`), so the purse
 *   `Wealth:` and the copper count are both wrong from that line, and nothing
 *   else says so. Both sentences rather than one, because they are two facts —
 *   a train that was refused prints neither, and a level reached by a kill
 *   prints only the welcome.
 * - **`user-dies`** — the pack: the death dropped it and the purse
 *   (`Player.Killed`), the tracker empties both, and only a listing says what
 *   loyal or cursed item stayed. And the sheet: the armour class, damage resist
 *   and magic resistance went with the gear, and `GearRecovery` reads the
 *   armour class to tell a stripped character from a dressed one (2026-10-06).
 * - **`user-stats-assigned`** — the sheet, and only the sheet. It is the exit
 *   from the stat-assignment screen, which rewrites six attributes and
 *   recalculates the maximum hit points (`AssignStatsState`, `SetStats` then
 *   `BaseMaxHP = CalcMaxHP()`); it spends character points and no coin, and
 *   the experience curve is untouched.
 */
export const STALE_AFTER = {
  'user-levels': ['sheet', 'experience', 'chart'],
  'user-trains': ['sheet', 'experience', 'chart', 'pack'],
  'user-dies': ['pack', 'sheet'],
  'user-stats-assigned': ['sheet']
} as const satisfies Partial<Record<BlockType, readonly StaleFact[]>>;

/** A sentence that makes a fact stale: a closed union, so whatever words the ask gets is a switch over it. */
export type StaleSentence = keyof typeof STALE_AFTER;

export function isStaleSentence(type: BlockType): type is StaleSentence {
  return Object.hasOwn(STALE_AFTER, type);
}

/** What this sentence made stale — empty for the ones that made nothing stale. */
export function staleAfter(type: BlockType): readonly StaleFact[] {
  return isStaleSentence(type) ? STALE_AFTER[type] : [];
}

/**
 * The block each fact's command is answered with (todo 835): an answer is an
 * answer whatever it says, so an `st` with no health in it still reads the sheet.
 */
export const READ: Record<StaleFact, BlockType> = {
  sheet: 'player-status',
  experience: 'user-experience',
  chart: 'user-experience-table',
  pack: 'user-inventory'
};

/** The facts a block of this type answers. */
export function readBy(type: BlockType): StaleFact[] {
  return (Object.keys(READ) as StaleFact[]).filter((fact) => READ[fact] === type);
}

/** What entering the realm must read, or the client plays the session on unknowns. */
export const REQUIRED: readonly StaleFact[] = ['sheet', 'pack'];

/** The required facts among the commands `asked` that nothing has read yet. */
export function unread(asked: readonly string[], read: ReadonlySet<StaleFact>): StaleFact[] {
  return REQUIRED.filter((fact) => !read.has(fact) && asked.includes(REFRESH[fact].command));
}
