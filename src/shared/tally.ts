/**
 * What this character's fighting has added up to, since it entered the realm.
 *
 * The MegaMUD accuracy window's question — *how am I actually doing* — asked of
 * the only evidence there is, which is the stream. Two rules shape all of it:
 *
 * - **Only what the wire tells apart.** MegaMUD's window has rows for weapon
 *   procs, off-hand hits and four spell slots; those are *its own
 *   configuration* rather than anything the server says. What this server
 *   distinguishes on a landed blow is `You surprise <verb> …` from
 *   `You critically <verb> …` from `You <verb> …` from `You cast <spell> at …`,
 *   and that is what is counted. A row invented for the rest would be a
 *   confident zero.
 * - **A backstab is `surprise`, and it was here all along.** This file used to
 *   say the corpus held no frame for MegaMUD's `BS:` row. It holds five
 *   captures of it (2026-09-02): `bs buttah` → `*Combat Engaged*` → `You
 *   surprise punch Buttah for 37 damage!`, in captures/001, 008, 009, 011,
 *   013 and 022. The claim was never checked against a grep.
 * - **Absence is absence.** `least`/`most` are null until something has landed,
 *   and a rate is null until the scope has measured some time. A readout that
 *   renders an unmeasured average as `0.0` is the same lie a vital painted red
 *   for want of a number is.
 *
 * The tally main keeps is **monotonic** for the life of a realm session. The
 * Reset control is a *baseline* the reader subtracts (`sinceBaseline`), which
 * is what lets one published figure serve both "since I arrived" and "since I
 * pressed the button" without main holding a second copy of everything or a
 * round trip to clear it.
 *
 * Dependency-free like everything in `shared/`.
 */

/**
 * The kinds of landed blow this server's own text distinguishes.
 *
 * Read off the frame, never off a verb list: combat text is realm *data* —
 * three-line templates stored per weapon, per monster and per spell — so
 * `slice`, `punch`, `skewer` and `hurl your chakram at` are all the same kind
 * of event wearing different words. What is fixed is the adverb and the cast.
 */
export type BlowKind = 'melee' | 'critical' | 'backstab' | 'spell';

export const BLOW_KINDS: readonly BlowKind[] = ['melee', 'critical', 'backstab', 'spell'];

/** What one kind of blow has amounted to. */
export interface BlowTally {
  /** How many landed. */
  hits: number;
  /** Total damage across them. */
  damage: number;
  /** The smallest single blow, or null until one has landed. */
  least: number | null;
  /** And the largest. */
  most: number | null;
}

export const NO_BLOWS: BlowTally = { hits: 0, damage: 0, least: null, most: null };

export interface CombatTally {
  /** Epoch ms this tally started counting, or null before anything happened. */
  since: number | null;
  /** Epoch ms of the most recent thing counted. */
  at: number | null;
  /** What landed on something else, by kind. */
  dealt: Record<BlowKind, BlowTally>;
  /**
   * This character's swings that did not land.
   *
   * Counted apart from the kinds rather than inside one, because a miss says
   * nothing about which kind of blow it would have been — there is no such
   * thing as a critical that missed. It is the third share of the same total,
   * which is exactly how MegaMUD's own window read it: Miss, Hit and Crit as
   * percentages of every swing.
   */
  missed: number;
  /** What landed on this character. */
  taken: BlowTally;
  /**
   * Attacks aimed at this character that did no damage and that the server
   * gave **no reason** for.
   *
   * **Not "dodged".** The server prints `The large lashworm lunges at you!`
   * and never says whether that was a miss, a parry, or a swing it chose not
   * to score. What is certain is that something swung and nothing was lost.
   * Where it *does* say, the blow is counted in `dodged` instead, which is
   * what makes this figure honest rather than merely cautious.
   */
  turned: number;
  /**
   * Attacks the server said this character dodged.
   *
   * MegaMUD's `Dodge:` row, and the wire does state it: `but you dodge!`,
   * `but you dodge it!`, `but you dodge out of the way!` and `but you dodge
   * the attack!` — 362 lines across the corpus. These were all being counted
   * as `turned`, which understated the one thing about them that is a fact
   * about the *character* rather than about the swing.
   */
  dodged: number;
  /**
   * `Attempting to sneak...`, and the ones the server refused on the spot.
   *
   * MegaMUD's `Sneak:` row. The attempt and the outcome are two separate
   * sentences and the failure arrives glued to the attempt (`Attempting to
   * sneak...You don't think you're sneaking.`), so both are countable and the
   * share between them is a real success rate rather than an inference.
   *
   * `You make a sound as you enter the room!` is deliberately **not** folded
   * in: that is a sneak *lost on a move*, a different event with a different
   * denominator, and adding it here would put two questions under one
   * percentage.
   */
  sneakTried: number;
  sneakFailed: number;
  /**
   * Coins picked up, normalised to copper.
   *
   * MegaMUD's `Collected:` row. Only what the server said was picked up
   * (`You picked up 17 copper farthings`) — never a difference between two
   * readings of `Wealth:`, which moves when anything is bought, sold, banked
   * or dropped and would report spending as income.
   */
  coins: number;
  /** Monsters this client watched die in a fight it was in. */
  kills: number;
  /** Experience the server said was gained. */
  experience: number;
  /**
   * Milliseconds the server said this character was engaged, over the fights
   * that have **ended**.
   *
   * From `*Combat Engaged*` to `*Combat Off*`, which is the server's own word
   * for it rather than a guess from the gaps between blows. The fight still
   * running is `engagedSince` and is added at the point of reading, so a figure
   * on screen during a long fight does not sit still for the length of it.
   */
  engagedMs: number;
  /** When the fight now running began, or null when none is. */
  engagedSince: number | null;
}

export const NO_TALLY: CombatTally = {
  since: null,
  at: null,
  dealt: { melee: NO_BLOWS, critical: NO_BLOWS, backstab: NO_BLOWS, spell: NO_BLOWS },
  missed: 0,
  taken: NO_BLOWS,
  turned: 0,
  dodged: 0,
  sneakTried: 0,
  sneakFailed: 0,
  coins: 0,
  kills: 0,
  experience: 0,
  engagedMs: 0,
  engagedSince: null
};

/**
 * A stored reading of the totals, read back as one.
 *
 * The Reset baseline lives in `localStorage`, which is a boundary like any
 * other: a value written by an older build, a hand edit or a half-written
 * write all arrive here. Parsed field by field rather than cast, and a shape
 * that is not one answers null — which the card reads as *no baseline*, the
 * one answer that is never wrong.
 */
export function readTally(value: unknown): CombatTally | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number => {
    const found = raw[key];
    return typeof found === 'number' && Number.isFinite(found) ? found : 0;
  };
  const stamp = (key: string): number | null => {
    const found = raw[key];
    return typeof found === 'number' && Number.isFinite(found) ? found : null;
  };
  const blows = (from: unknown): BlowTally => {
    if (typeof from !== 'object' || from === null) return NO_BLOWS;
    const row = from as Record<string, unknown>;
    const one = (key: string): number =>
      typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : 0;
    const edge = (key: string): number | null =>
      typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : null;
    return { hits: one('hits'), damage: one('damage'), least: edge('least'), most: edge('most') };
  };
  const dealtRaw = (raw['dealt'] ?? {}) as Record<string, unknown>;
  return {
    since: stamp('since'),
    at: stamp('at'),
    dealt: {
      melee: blows(dealtRaw['melee']),
      critical: blows(dealtRaw['critical']),
      backstab: blows(dealtRaw['backstab']),
      spell: blows(dealtRaw['spell'])
    },
    missed: num('missed'),
    taken: blows(raw['taken']),
    turned: num('turned'),
    dodged: num('dodged'),
    sneakTried: num('sneakTried'),
    sneakFailed: num('sneakFailed'),
    coins: num('coins'),
    kills: num('kills'),
    experience: num('experience'),
    engagedMs: num('engagedMs'),
    engagedSince: stamp('engagedSince')
  };
}

/**
 * Which kind of blow a landed line was.
 *
 * The line is everything between `You` and `for N damage!`, which is what the
 * `user-hits` pattern captures.
 *
 * `surprise` is tested first because it names *which attack was made* while
 * `critically` only says how well it landed — a backstab that crits is still a
 * backstab, and it is the rarer fact. No line in the corpus carries both
 * words, so the order is a judgement bounded by evidence rather than a reading
 * of one; if a realm ever prints one, this is the answer that keeps the `BS`
 * row true. `critically` comes next for the same reason it always did: a
 * critical cast — never seen, but the realm's templates are data — should read
 * as a critical rather than be hidden inside the spells.
 */
export function blowKind(line: string | undefined): BlowKind {
  const text = (line ?? '').toLowerCase();
  if (/\bsurprise\b/.test(text)) return 'backstab';
  if (/\bcritical(?:ly)?\b/.test(text)) return 'critical';
  if (/^cast\b/.test(text.trim())) return 'spell';
  return 'melee';
}

/** One more landed blow, folded into a running total. */
export function withBlow(tally: BlowTally, damage: number): BlowTally {
  return {
    hits: tally.hits + 1,
    damage: tally.damage + damage,
    least: tally.least === null ? damage : Math.min(tally.least, damage),
    most: tally.most === null ? damage : Math.max(tally.most, damage)
  };
}

/** The difference between two readings of the same total. */
function blowsBetween(now: BlowTally, then: BlowTally): BlowTally {
  const hits = now.hits - then.hits;
  return {
    hits,
    damage: now.damage - then.damage,
    /*
     * The extremes cannot be subtracted — the smallest blow since the reset is
     * not `now.least - then.least`, and nothing in a running total records it.
     * Kept whole while anything has landed since, which overstates the *range*
     * and never the count or the average, and is the honest direction: the
     * alternative is a range that reads as narrower than it was.
     */
    least: hits > 0 ? now.least : null,
    most: hits > 0 ? now.most : null
  };
}

/**
 * The tally as it reads from a baseline — what the Reset control produces.
 *
 * Main publishes one monotonic total and the reader subtracts a reading it
 * took earlier. That is what lets Reset be instant, survive a re-render, and
 * cost neither a round trip nor a second accumulator in main; a baseline from
 * a session that has since restarted is discarded by the caller, which is why
 * `since` comes off the baseline rather than being invented here.
 *
 * `since` is also the rates' denominator, so pressing Reset re-bases them in
 * the same act — which is what makes *how am I doing right now* a question the
 * reader asks rather than one the client answers behind their back.
 */
export function sinceBaseline(now: CombatTally, baseline: CombatTally | null): CombatTally {
  if (baseline === null) return now;
  return {
    since: baseline.at ?? baseline.since,
    at: now.at,
    dealt: {
      melee: blowsBetween(now.dealt.melee, baseline.dealt.melee),
      critical: blowsBetween(now.dealt.critical, baseline.dealt.critical),
      backstab: blowsBetween(now.dealt.backstab, baseline.dealt.backstab),
      spell: blowsBetween(now.dealt.spell, baseline.dealt.spell)
    },
    missed: now.missed - baseline.missed,
    taken: blowsBetween(now.taken, baseline.taken),
    turned: now.turned - baseline.turned,
    dodged: now.dodged - baseline.dodged,
    sneakTried: now.sneakTried - baseline.sneakTried,
    sneakFailed: now.sneakFailed - baseline.sneakFailed,
    coins: now.coins - baseline.coins,
    kills: now.kills - baseline.kills,
    experience: now.experience - baseline.experience,
    engagedMs: now.engagedMs - baseline.engagedMs,
    /*
     * Clamped to the reset, so a fight that was already running when the
     * button was pressed contributes only the part after it. Without the
     * clamp the first reading after a reset during a long fight would report
     * more engaged time than the scope has existed for.
     */
    engagedSince:
      now.engagedSince === null ? null : Math.max(now.engagedSince, baseline.at ?? now.engagedSince)
  };
}

/**
 * Engaged time including the fight still running.
 *
 * `engagedMs` closes an interval only when the server says `*Combat Off*`, so
 * during a fight it is the *previous* fights' total and stands still. Every
 * reader wants both halves, and adding them at the point of reading is what
 * keeps the stored figure a sum of settled facts.
 */
export function engagedFor(tally: CombatTally, now: number): number {
  const open = tally.engagedSince === null ? 0 : Math.max(0, now - tally.engagedSince);
  return tally.engagedMs + open;
}

/**
 * The rate per hour of a total, over the scope that produced it.
 *
 * **The denominator is the scope's own clock** — `since` to now, the same
 * stretch the card's duration badge draws — so a rate is answerable from the
 * first second and a reader can check it against the two figures above it.
 * Pressing Reset moves `since`, which is how *since I started* becomes *since
 * I pressed the button* without a second mechanism.
 *
 * It replaced a rolling sixteen-minute window of readings, which was the
 * better idea and the broken implementation. Marks were taken at most once a
 * minute, and a mark arriving inside that minute **replaced** the last one —
 * so with one mark in the array the anchor and the leading edge were the same
 * reading, the anchor advanced with every block, and the gap never reached a
 * minute. Measured 2026-09-03: a stream of blocks five seconds apart left the
 * window at one mark and a span of zero for twenty minutes, so `Exp. rate`,
 * `Kill rate` and `Income rate` all read `—` for the entire time a character
 * was actually fighting. The window only ever worked for a character gaining
 * nothing more often than once a minute.
 *
 * **`floorMs` is the minimum span, and dropping it was the one thing worth
 * keeping from the window.** The old doc said it in as many words — *a rate
 * extrapolated from a few seconds of a good round would say a character is
 * making four million an hour* — and the first version of this refused only on
 * a zero span. `since` is set by the first block that moves the tally and the
 * card re-renders on the next status line, so the first reading divided by tens
 * of milliseconds: 66 experience 300ms in drew `792,000/hr`, and through
 * `levelIn` it drew **`Will level in 0:00:09`** — which is the figure somebody
 * decides *keep going or go and train* on, wrong exactly while it is newest.
 *
 * Null below that, and where there is no scope at all: an hourly figure
 * extrapolated from nothing is not a small error, it is a made-up number.
 */
export function ratePerHour(
  total: number,
  since: number | null,
  now: number,
  floorMs = 0
): number | null {
  if (since === null) return null;
  const ms = now - since;
  if (ms <= 0 || ms < floorMs) return null;
  return (total / ms) * 3_600_000;
}

/** Every swing this character made, landed or not — the denominator MegaMUD used. */
export function swings(tally: CombatTally): number {
  return (
    tally.dealt.melee.hits + tally.dealt.critical.hits + tally.dealt.backstab.hits + tally.missed
  );
}

/** Every swing aimed at this character that did no damage, however it failed. */
export function turnedAside(tally: CombatTally): number {
  return tally.turned + tally.dodged;
}

/** A share of a whole, or null when the whole is nothing — never `0%`. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** The mean of a total over a count, or null when nothing was counted. */
export function mean(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

/**
 * Damage dealt per combat round.
 *
 * The round is the server's own five-second pulse and the client never sees a
 * round boundary, so this is total damage over engaged time expressed in
 * rounds — which is what MegaMUD's own figure was. Null when nothing has been
 * fought: a DPR of zero is a claim about a character that has not swung.
 */
export function perRound(tally: CombatTally, now: number, roundMs: number): number | null {
  const engaged = engagedFor(tally, now);
  if (engaged <= 0 || roundMs <= 0) return null;
  return damageDealt(tally) / (engaged / roundMs);
}

/** Every point of damage this character has dealt, across the three kinds. */
export function damageDealt(tally: CombatTally): number {
  return BLOW_KINDS.reduce((total, kind) => total + tally.dealt[kind].damage, 0);
}

/** And every blow of it that landed. */
export function hitsDealt(tally: CombatTally): number {
  return BLOW_KINDS.reduce((total, kind) => total + tally.dealt[kind].hits, 0);
}

/**
 * How much of the scope was spent in a fight.
 *
 * The only slice of MegaMUD's time analysis this client can state: the server
 * announces engagement and announces nothing about resting, walking or idling
 * that could be added up the same way. One honest figure beats four where three
 * are invented — see the card, which says what the rest of the time was *not*
 * accounted as rather than splitting it.
 */
export function engagedShare(tally: CombatTally, now: number): number | null {
  if (tally.since === null) return null;
  const elapsed = now - tally.since;
  if (elapsed <= 0) return null;
  return Math.min(1, engagedFor(tally, now) / elapsed);
}
