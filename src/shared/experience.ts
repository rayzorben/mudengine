/**
 * What a level costs, and which level this character has actually paid for.
 *
 * The realm answers `exp` with two things: a one-line summary and, on its own,
 * a **table** of what each level costs. Both are read, because the summary
 * alone cannot answer the question a player standing at a guild is asking.
 * `Exp: 75547 Level: 3 Exp needed for next level: 0 (27133) [278%]` says the
 * next level is *free* — which is true and useless: this character has enough
 * experience for level 5 and is 9,726 short of level 6, and none of those three
 * numbers is on that line.
 *
 * ## Two sources, and the wire always wins
 *
 * The table is per-character — it is the base progression scaled by the race
 * and the class — so there are two ways to know it:
 *
 * - **The realm's own table**, printed by `exp`. Authoritative, and a *window*:
 *   ten rows, from one level below the character's to eight above. Rows
 *   accumulate as the window moves.
 * - **The realm database**, from the race's and the class's `ExpTable`
 *   percentages. Available before the character has asked anything, which is
 *   the whole point of it.
 *
 * **And on GreaterMUD there is no table at all.** `exp` there answers with the
 * summary line and nothing else — 0 tables across every recorded `orohost`
 * session against 3 in one Paradigm session — so on the realm this client now
 * ships as its default the *only* row the wire ever states is the next level's
 * price, and the other nine are the client's or nobody's. That is why the two
 * sources are merged rather than one of them switching the other off.
 *
 * **Provenance is per row**, because a table is routinely part one and part the
 * other: the realm states ten rows at a time and the summary line states a
 * single one, so a label on the whole table could only be wrong about half of
 * it. A realm row wins its level outright, and a realm row that *contradicts* a
 * derived one discards every derived row in the table — the derivation is one
 * chain from one seed, and a chain that is wrong once is not to be trusted
 * where it happens to agree.
 *
 * ## Where the arithmetic comes from
 *
 * Measured, not remembered. Two characters' tables were recorded from the wire
 * (`~/.config/mudengine/logs`, 2026-09-01 and 2026-09-03, both on Paradigm):
 *
 * | | race | class | level 2 |
 * |---|---|---|---|
 * | Gaunt One Mystic | 120 | 420 | 6400 |
 * | Kang Paladin | 150 | 490 | 7400 |
 *
 * `(100 + race + class) × 10` gives both exactly, and MMUD-Explorer's own
 * `frmExpCalc` composes its chart number the same way (`ExpTable + 100` for the
 * class, plus the race's) — two independent statements of one formula. The
 * corpus corroborates the base: `captures/115` has a character on a realm where
 * the pair contributes nothing, and its level 2 costs exactly `1000`.
 *
 * Every level after the second is the one below it times a ratio that steps
 * every second level — `10/5`, then `11/6` twice, `12/7` twice, `13/8` twice —
 * **floored at each step**, which is what makes the chain reproduce the wire's
 * numbers rather than merely approximate them. Ten values of one table and
 * twelve of the other, all twenty-two exact.
 *
 * And it is not one server's arithmetic. Four more readings from **GreaterMUD**
 * (`orohost`, 2026-08-26 to 08-28) land on the same chain: a Kang Mystic seeded
 * at 2850 is charged 32,842 for level 6 and a Half-Ogre Mystic seeded at 2800
 * is charged 55,309 for level 7, both exact. Two more characters in the corpus
 * (`captures/004` at level 11, `captures/020` at 12) have their printed
 * requirement reproduced by a whole-percent table of 215.
 *
 * ## How far up it holds — and it does not hold far
 *
 * **The chain is confirmed to level 13 and falsified above it.** The same
 * Half-Ogre Mystic whose level 7 it gets exactly is charged **40,195,899** for
 * level 29, where the chain says 99,835,591; `captures/012` prints a level-19
 * requirement no percentage reproduces at all, and `captures/087` a level-49
 * one an order of magnitude below. Three independent falsifications, one of
 * them on a realm whose seed the same session states.
 *
 * So `EXPERIENCE_CONFIRMED_TO` is where the derivation stops, and above it this
 * client derives **nothing** and says so on the card. A ten-level window of
 * numbers that are right is worth more than a full chart that is wrong from
 * level 14 up, and a player at level 28 is one `exp` away from the realm's own
 * answer. This is an exemption with a date on it: a recorded table above level
 * 13 either extends the constant or replaces the ladder.
 *
 * The seed has its own limit, and it is the realm database rather than the
 * arithmetic. `orohost` runs a realm whose class table matches no `.mdb` on
 * this machine — its Warrior and its Priest are priced 15 and 30 below the
 * nearest file, while every race and the Mystic agree — so a derived seed there
 * is wrong for some characters and right for others. That is the case the
 * per-row provenance and the contradiction rule below exist for: the card marks
 * what it worked out, and the first row the realm states settles it.
 */

/** Where a number came from. Shown on the card, never inferred. */
export type ExperienceSource = 'realm' | 'database';

/** What one level costs, and which half of the client said so. */
export interface ExperienceLevel {
  level: number;
  /** Total experience needed to reach it — a threshold, never an increment. */
  experience: number;
  /**
   * Per **row**, not per table.
   *
   * `exp` prints ten rows at a time and its one-line summary states a single
   * one, so a table is routinely part realm and part derivation, and a label on
   * the whole of it could only be wrong about half its contents. The card marks
   * the derived rows; a reader can see exactly which numbers the realm has
   * confirmed.
   */
  source: ExperienceSource;
}

/** What a character's levels cost, ascending, with no gaps claimed. */
export interface ExperienceTable {
  rows: readonly ExperienceLevel[];
}

/**
 * How many levels of table the realm prints, and this client derives.
 *
 * The realm's own `exp` prints ten rows, from one level below the character's
 * to eight above; a derived table is generated across exactly that window so
 * the two are directly comparable, and so the extrapolation never runs further
 * than the wire is about to check.
 */
export const EXPERIENCE_WINDOW = 10;

/**
 * The highest level `experienceChart` may be trusted to, and it is a claim with
 * a date on it (2026-09-03).
 *
 * Every recorded table stops at 13 and every reading above it disagrees with
 * the ladder — see the header. Deriving past this would put a confidently wrong
 * number on the card for exactly the characters least able to check it by eye,
 * and the check costs one `exp`.
 */
export const EXPERIENCE_CONFIRMED_TO = 13;

/**
 * Experience required to reach `level` for a character on `percent`.
 *
 * Chained from level 2 with a floor at every step, because that is what the
 * wire's numbers are: `floor(previous × ratio)`, not `floor(base × ratio^n)`.
 * The two differ by single digits from level 5 up, and the wire is exact.
 */
export function experienceChart(percent: number, upto: number): ExperienceLevel[] {
  const rows: ExperienceLevel[] = [];
  if (!Number.isFinite(percent) || percent <= 0) return rows;
  let value = Math.floor(percent * 10);
  if (upto >= 2) rows.push({ level: 2, experience: value, source: 'database' });
  for (let level = 3; level <= upto; level += 1) {
    /*
     * The ratio steps every second level — 10/5, 11/6, 11/6, 12/7, 12/7 — so
     * the numerator is 10 at level 3 and gains one every two levels after.
     */
    const step = 10 + Math.ceil((level - 3) / 2);
    value = Math.floor((value * step) / (step - 5));
    rows.push({ level, experience: value, source: 'database' });
  }
  return rows;
}

/**
 * The window of a derived table for a character at `level`.
 *
 * Same shape as the realm's own listing: one level below, eight above. Level 1
 * is never a row — it costs nothing and the realm does not print it — and
 * nothing above `EXPERIENCE_CONFIRMED_TO` is a row either, so a character past
 * that gets **null** rather than a short table trailing off mid-window. Half a
 * window would read as the realm's table with rows missing; nothing reads as
 * what it is, and the card asks.
 */
export function derivedExperienceTable(percent: number, level: number): ExperienceTable | null {
  if (!Number.isInteger(level) || level < 1) return null;
  const first = Math.max(2, level - 1);
  if (first > EXPERIENCE_CONFIRMED_TO) return null;
  const last = Math.min(level + EXPERIENCE_WINDOW - 2, EXPERIENCE_CONFIRMED_TO);
  const chart = experienceChart(percent, last);
  if (chart.length === 0) return null;
  return { rows: chart.filter((row) => row.level >= first) };
}

/**
 * The table with what the realm has just stated folded in.
 *
 * A realm row wins its level outright. And a realm row that **contradicts** a
 * derived one takes every other derived row with it: the derivation is one
 * chain from one seed, so a single wrong value says the seed or the ladder is
 * wrong, and the rows that still happen to agree are agreeing by luck. What is
 * left is what the realm itself has said, which is always enough to answer the
 * question the card is for.
 */
export function withRealmExperience(
  table: ExperienceTable | null,
  stated: readonly { level: number; experience: number }[]
): ExperienceTable | null {
  const rows = stated.filter((row) => Number.isInteger(row.level) && row.level >= 2);
  if (rows.length === 0) return table;

  const held = new Map<number, ExperienceLevel>();
  for (const row of table?.rows ?? []) held.set(row.level, row);

  const contradicted = rows.some((row) => {
    const before = held.get(row.level);
    return (
      before !== undefined && before.source === 'database' && before.experience !== row.experience
    );
  });
  if (contradicted)
    for (const [level, row] of [...held]) if (row.source === 'database') held.delete(level);

  for (const row of rows) held.set(row.level, { ...row, source: 'realm' });
  return { rows: [...held.values()].sort((a, b) => a.level - b.level) };
}

/**
 * The table with a freshly derived window folded **under** what the realm said.
 *
 * The obvious alternative — stop deriving the moment any row is the realm's —
 * was what this did, and it is wrong on the realm this client defaults to.
 * GreaterMUD's `exp` prints no table, so its one realm row is the summary
 * line's; freezing there left a chart of a single row for the session, which is
 * the readout this whole file exists to replace.
 *
 * So the two are merged, and the merge is self-checking rather than stateful:
 *
 * - **A derived row that contradicts one the realm has stated falsifies the
 *   chain**, and nothing is added — not this time and not on any later block,
 *   because the contradicting realm row is still there to refuse it. That is
 *   the freeze, kept, without a flag to remember it by.
 * - **A derived row that contradicts an earlier derived one is a new seed** — a
 *   character rerolled onto another race or class — and replaces every row the
 *   old chain worked out.
 * - **A realm row is never overwritten.** Derived rows fill the levels the wire
 *   has not spoken about, and only those.
 */
export function withDerivedExperience(
  table: ExperienceTable | null,
  derived: ExperienceTable
): ExperienceTable | null {
  if (derived.rows.length === 0) return table;

  const held = new Map<number, ExperienceLevel>();
  for (const row of table?.rows ?? []) held.set(row.level, row);

  for (const row of derived.rows) {
    const before = held.get(row.level);
    if (before?.source === 'realm' && before.experience !== row.experience) return table;
  }

  const reseeded = derived.rows.some((row) => {
    const before = held.get(row.level);
    return before?.source === 'database' && before.experience !== row.experience;
  });
  if (reseeded) {
    for (const [level, row] of [...held]) if (row.source === 'database') held.delete(level);
  }

  let added = false;
  for (const row of derived.rows) {
    if (held.has(row.level)) continue;
    held.set(row.level, row);
    added = true;
  }
  if (!added && !reseeded) return table;
  return { rows: [...held.values()].sort((a, b) => a.level - b.level) };
}

/**
 * Where this character actually stands.
 *
 * `level` is what the realm has granted; `earned` is the highest level the
 * experience already pays for, and the two differ for as long as somebody puts
 * off a trip to the guild. `next` is the first level not yet paid for, which is
 * the level the experience being made is actually going towards.
 *
 * Null for anything the table cannot answer — this is a readout, and an
 * invented number here reads as a level somebody has not got.
 */
export interface ExperienceStanding {
  /** The level the realm has granted, from the status line or the sheet. */
  level: number;
  /** The highest level this much experience has paid for. Never below `level`. */
  earned: number;
  /** The first level not yet paid for, or null past the end of the table. */
  next: number | null;
  /** Experience still owed for `next`, or null where `next` is. */
  needed: number | null;
  /** Whether experience is already being made towards a level beyond the next. */
  ahead: boolean;
  /**
   * Where the row that priced `next` came from, so a readout can say.
   *
   * Carried rather than left to the caller because the caller cannot work it
   * out: it has a number and no way back to the row. A figure this client
   * derived, drawn beside figures the server sent, is the thing the per-row
   * provenance exists to prevent — and the two cards that draw this are the
   * ones a player actually reads.
   */
  nextSource: ExperienceSource | null;
  /** Where the row that established `earned` came from. `null` when it is `level`. */
  earnedSource: ExperienceSource | null;
}

/**
 * What is still owed for the next level, and whether the client worked it out.
 *
 * **The realm's own figure wins wherever it answers the same question**, which
 * is whenever the character is not ahead of its level: `Exp needed for next
 * level` is the server's arithmetic, it is restated on every `exp`, and on a
 * realm whose prompt carries `Need=` it is restated several times a second.
 * Preferring a derived number over that inverts the rule that where the wire
 * and this client's reading disagree, the wire wins — and the case is not
 * hypothetical: `orohost` prices two of its classes differently from every
 * realm database on this machine, so the derived seed there is wrong for some
 * characters and the wire is right for all of them.
 *
 * The table is used for the case the realm's figure cannot answer — a character
 * standing on experience it has not trained for, where `Exp needed for next
 * level` is `0` and the level actually being earned towards is further up — and
 * what comes back then is marked.
 *
 * Shared by both cards so the two cannot come to different answers about the
 * same character.
 */
export function experienceOwed(
  stated: number | null,
  standing: ExperienceStanding | null
): { value: number | null; derived: boolean } {
  if (standing === null) return { value: stated, derived: false };
  if (!standing.ahead && stated !== null) return { value: stated, derived: false };
  return { value: standing.needed, derived: standing.nextSource === 'database' };
}

export function experienceStanding(
  level: number | null,
  exp: number | null,
  table: ExperienceTable | null
): ExperienceStanding | null {
  if (level === null || exp === null || table === null || table.rows.length === 0) return null;

  let earned = level;
  let earnedSource: ExperienceSource | null = null;
  for (const row of table.rows) {
    if (row.level > earned && exp >= row.experience) {
      earned = row.level;
      earnedSource = row.source;
    }
  }
  /*
   * The next level is the first one the table prices above what is held. A
   * table whose window has been outrun says nothing rather than guessing at the
   * row past its end.
   */
  const next = table.rows.find((row) => row.experience > exp);
  return {
    level,
    earned,
    next: next?.level ?? null,
    needed: next === undefined ? null : next.experience - exp,
    ahead: earned > level,
    nextSource: next?.source ?? null,
    earnedSource
  };
}
