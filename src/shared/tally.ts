/**
 * What this character's fighting has added up to, since it entered the realm.
 *
 * The MegaMUD accuracy window's question — *how am I actually doing* — asked of
 * the only evidence there is, which is the stream. Two rules shape all of it:
 *
 * - **Only what the wire tells apart, or the realm does.** MegaMUD's window has
 *   rows for weapon procs, off-hand hits and four spell slots; those are *its
 *   own configuration* rather than anything the server says. What this server
 *   distinguishes on a landed blow is `You surprise <verb> …` from
 *   `You critically <verb> …` from `You <verb> …` from `You cast <spell> at …`,
 *   and that is what is counted. A row invented for the rest would be a
 *   confident zero.
 * - **And `proc` is the exemption that dissolved** (2026-09-06). This file used
 *   to name the weapon-proc row as the example of one the wire cannot tell
 *   apart, which was true of the *sentence* and never of the client: the realm
 *   states which item fires a chance-on-hit and `Damage` was booking every one
 *   of them to the rest of the room. An exemption is a claim with a date on it;
 *   the realm data that dissolves this one was already shipped.
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
 * The tally main keeps is **monotonic** for as long as the character is the
 * same character: it outlives the socket and the launch (`Belongings` keeps
 * it, `settleClocks` closes what a gap left open), and only a reset noticed
 * and confirmed empties it. The Reset control is a *baseline* the reader
 * subtracts (`sinceBaseline`), which is what lets one published figure serve
 * both "since I arrived" and "since I pressed the button" without main holding
 * a second copy of everything or a round trip to clear it.
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
 *
 * `proc` is the one kind no frame states. A weapon's chance-on-hit prints the
 * spell's own message with the target and the number substituted in and names
 * **nobody** — `A shining spark strikes cave worm for 3 damage!` — so it is
 * read from the realm's item row and the round it landed in rather than off
 * the line. See `CharacterTracker.readsAsProc`.
 */
export type BlowKind = 'melee' | 'critical' | 'backstab' | 'spell' | 'proc';

export const BLOW_KINDS: readonly BlowKind[] = ['melee', 'critical', 'backstab', 'spell', 'proc'];

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

/** Cumulative experience at a moment, for the rate over a window (todo 08). */
export interface ExperienceSample {
  at: number;
  experience: number;
}

/** The windows the Combat Stats card's rate graph may cover, in hours. */
export const STATS_WINDOW_HOURS = [1, 2, 4, 8, 24] as const;
export const DEFAULT_STATS_HOURS = 2;
export const STATS_GRAPHS = ['bars', 'line'] as const;
export type StatsGraph = (typeof STATS_GRAPHS)[number];
export const DEFAULT_STATS_GRAPH: StatsGraph = 'bars';

export function isStatsGraph(value: unknown): value is StatsGraph {
  return typeof value === 'string' && (STATS_GRAPHS as readonly string[]).includes(value);
}

/** A stretch spent off the realm: from leaving it to arriving again. */
export interface AwaySpell {
  from: number;
  to: number;
}

export interface CombatTally {
  /**
   * Epoch ms the scope began — the first thing counted, or the first arrival
   * in the realm — or null before either. Set once per series: a baseline
   * whose `since` differs is from another record (another realm, or one
   * thrown away) and cannot be subtracted from this one.
   */
  since: number | null;
  /**
   * Epoch ms the tally last moved: a blow, a coin, a fight or a visit
   * beginning or ending. The moment a baseline dates the scope from.
   */
  at: number | null;
  /**
   * Cumulative experience, sampled as it moves (`withSample`): one sample per
   * `parse.statsSampleMs`, the newest updated in place until its slot is
   * spent, `parse.statsSamplesKept` kept. What the rate graph is drawn from;
   * everything else on the card is a running total.
   */
  samples: readonly ExperienceSample[];
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
  /**
   * Milliseconds this character has stood in the realm, over the visits that
   * have **ended** — the rates' denominator, and what makes a tally that
   * outlives the socket honest: a night spent disconnected is not an hour
   * the character earned nothing in. Opened when the phase reaches `in-game`,
   * closed when it leaves, and by `settleClocks` when the socket does.
   */
  onlineMs: number;
  /** When the visit now running began, or null while not in the realm. */
  onlineSince: number | null;
  /**
   * The stretches spent off the realm inside the samples' window, oldest
   * first, so the rate graph leaves a night offline blank rather than draw
   * it as an hour at nothing — the rule the rates keep through `onlineMs`,
   * applied to the series. `withArrival` closes one; `rateSeries` reads them.
   */
  away: readonly AwaySpell[];
  /** When the character left the realm, or null while in it and before the first visit. */
  leftAt: number | null;
}

export const NO_TALLY: CombatTally = {
  since: null,
  at: null,
  samples: [],
  dealt: {
    melee: NO_BLOWS,
    critical: NO_BLOWS,
    backstab: NO_BLOWS,
    spell: NO_BLOWS,
    proc: NO_BLOWS
  },
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
  engagedSince: null,
  onlineMs: 0,
  onlineSince: null,
  away: [],
  leftAt: null
};

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
  const since = baseline.at ?? baseline.since;
  const engaged = clockSince(
    { settled: now.engagedMs, since: now.engagedSince },
    { settled: baseline.engagedMs, since: baseline.engagedSince },
    since
  );
  const online = clockSince(
    { settled: now.onlineMs, since: now.onlineSince },
    { settled: baseline.onlineMs, since: baseline.onlineSince },
    since
  );
  return {
    since,
    at: now.at,
    /*
     * Relative to the baseline, like every figure below: the reset moment
     * becomes the first sample at nothing, and what was sampled before it is
     * not this scope's to draw.
     */
    samples: [
      ...(since === null ? [] : [{ at: since, experience: 0 }]),
      ...now.samples
        .filter((sample) => baseline.at === null || sample.at > baseline.at)
        .map((sample) => ({ at: sample.at, experience: sample.experience - baseline.experience }))
    ],
    dealt: {
      melee: blowsBetween(now.dealt.melee, baseline.dealt.melee),
      critical: blowsBetween(now.dealt.critical, baseline.dealt.critical),
      backstab: blowsBetween(now.dealt.backstab, baseline.dealt.backstab),
      spell: blowsBetween(now.dealt.spell, baseline.dealt.spell),
      proc: blowsBetween(now.dealt.proc, baseline.dealt.proc)
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
    engagedMs: engaged.settled,
    engagedSince: engaged.since,
    onlineMs: online.settled,
    onlineSince: online.since,
    // The stretches away that reach into the scope, cut at the reset.
    away:
      since === null
        ? now.away
        : now.away
            .filter((spell) => spell.to > since)
            .map((spell) => ({ from: Math.max(spell.from, since), to: spell.to })),
    leftAt: now.leftAt
  };
}

/** A running total of intervals: the settled ones, and when the open one began. */
interface Clock {
  settled: number;
  since: number | null;
}

/**
 * A clock read from a baseline.
 *
 * The settled figure cannot simply be subtracted: an interval open when the
 * baseline was taken and closed since carries its whole length into the
 * settled total, and the part before the reset was not this scope's, so the
 * baseline's own open part comes off too. An interval still open is clamped
 * to the reset, or the first reading after a reset during a long fight would
 * report more engaged time than the scope has existed for.
 */
function clockSince(now: Clock, baseline: Clock, resetAt: number | null): Clock {
  const openAtBaseline =
    baseline.since !== null && baseline.since !== now.since && resetAt !== null
      ? Math.max(0, resetAt - baseline.since)
      : 0;
  return {
    settled: now.settled - baseline.settled - openAtBaseline,
    since: now.since === null ? null : Math.max(now.since, resetAt ?? now.since)
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
/**
 * The tally with its experience sampled at `at`.
 *
 * The newest sample is updated in place while it is younger than `everyMs`,
 * so the series is one point per slot however many kills land in it, and the
 * oldest goes when `keep` is reached. Called on every experience line, so the
 * last point is always current.
 */
export function withSample(
  tally: CombatTally,
  at: number,
  everyMs: number,
  keep: number
): CombatTally {
  const last = tally.samples.at(-1);
  const point = { at, experience: tally.experience };
  let samples: ExperienceSample[];
  if (last !== undefined && at - last.at < Math.max(1, everyMs)) {
    samples = [...tally.samples.slice(0, -1), { at: last.at, experience: tally.experience }];
  } else {
    samples = [...tally.samples, point];
  }
  const cap = Math.max(1, Math.trunc(keep));
  if (samples.length > cap) samples = samples.slice(samples.length - cap);
  return { ...tally, samples };
}

/** The cumulative experience the samples state for a moment: the last one at or before it, or null before the first. */
export function experienceAt(samples: readonly ExperienceSample[], at: number): number | null {
  let found: number | null = null;
  for (const sample of samples) {
    if (sample.at > at) break;
    found = sample.experience;
  }
  return found;
}

/**
 * Experience an hour, per bin, across `[from, to)`: the difference the
 * samples state across each bin over the part of it spent in the realm.
 * Null for a bin the samples cannot speak for — before the first one — and
 * for one spent wholly away, so neither an empty hour before the fight began
 * nor a night offline is drawn as a rate of nothing.
 */
export function rateSeries(
  samples: readonly ExperienceSample[],
  from: number,
  to: number,
  bins: number,
  away: readonly AwaySpell[] = []
): Array<number | null> {
  const count = Math.max(1, Math.trunc(bins));
  if (to <= from) return new Array<number | null>(count).fill(null);
  const width = (to - from) / count;
  const out: Array<number | null> = [];
  for (let index = 0; index < count; index += 1) {
    const start = from + index * width;
    const end = start + width;
    const before = experienceAt(samples, start);
    const after = experienceAt(samples, end);
    const present = width - awayWithin(away, start, end);
    if (before === null || after === null || present <= 0) {
      out.push(null);
      continue;
    }
    out.push(((after - before) / present) * 3_600_000);
  }
  return out;
}

/** How much of `[start, end)` the spells cover. */
function awayWithin(away: readonly AwaySpell[], start: number, end: number): number {
  let covered = 0;
  for (const spell of away) {
    covered += Math.max(0, Math.min(spell.to, end) - Math.max(spell.from, start));
  }
  return covered;
}

/**
 * The tally on arriving in the realm: the stretch away since `leftAt` closed
 * and kept while it reaches into the last `keepMs` — the samples' own window,
 * since the spells exist to be read beside them.
 */
export function withArrival(tally: CombatTally, at: number, keepMs: number): CombatTally {
  const spells =
    tally.leftAt === null || tally.leftAt >= at
      ? tally.away
      : [...tally.away, { from: tally.leftAt, to: at }];
  return { ...tally, away: spells.filter((spell) => spell.to >= at - keepMs), leftAt: null };
}

export function engagedFor(tally: CombatTally, now: number): number {
  const open = tally.engagedSince === null ? 0 : Math.max(0, now - tally.engagedSince);
  return tally.engagedMs + open;
}

/** Time in the realm including the visit still running — `engagedFor`'s shape. */
export function onlineFor(tally: CombatTally, now: number): number {
  const open = tally.onlineSince === null ? 0 : Math.max(0, now - tally.onlineSince);
  return tally.onlineMs + open;
}

/**
 * Every open interval closed at `at`, for a moment nothing on the wire will
 * describe: the socket closing, or a record read back from a launch that
 * ended without one. A clock left running across the gap would count the
 * hours the client sat disconnected as time in the realm, or in a fight.
 */
export function settleClocks(tally: CombatTally, at: number): CombatTally {
  if (tally.engagedSince === null && tally.onlineSince === null) return tally;
  return {
    ...tally,
    engagedMs:
      tally.engagedMs + (tally.engagedSince === null ? 0 : Math.max(0, at - tally.engagedSince)),
    engagedSince: null,
    onlineMs:
      tally.onlineMs + (tally.onlineSince === null ? 0 : Math.max(0, at - tally.onlineSince)),
    onlineSince: null,
    // And the stretch away begins, if a visit just ended.
    leftAt: tally.onlineSince === null ? tally.leftAt : at
  };
}

const COUNTS = [
  'missed',
  'turned',
  'dodged',
  'sneakTried',
  'sneakFailed',
  'coins',
  'kills',
  'experience',
  'engagedMs',
  'onlineMs'
] as const;

/** Parsed, not trusted: a tally read back from disk, where anything may have edited it. */
export function isCombatTally(value: unknown): value is CombatTally {
  if (typeof value !== 'object' || value === null) return false;
  const tally = value as Record<string, unknown>;
  const moment = (entry: unknown): boolean => entry === null || isCount(entry);
  if (!moment(tally['since']) || !moment(tally['at'])) return false;
  if (!moment(tally['engagedSince']) || !moment(tally['onlineSince'])) return false;
  if (!moment(tally['leftAt'])) return false;
  if (!COUNTS.every((key) => isCount(tally[key]))) return false;
  if (!Array.isArray(tally['samples']) || !tally['samples'].every(isSample)) return false;
  if (!Array.isArray(tally['away']) || !tally['away'].every(isAwaySpell)) return false;
  if (!isBlowTally(tally['taken'])) return false;
  const dealt = tally['dealt'];
  if (typeof dealt !== 'object' || dealt === null) return false;
  return BLOW_KINDS.every((kind) => isBlowTally((dealt as Record<string, unknown>)[kind]));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAwaySpell(value: unknown): value is AwaySpell {
  if (typeof value !== 'object' || value === null) return false;
  const spell = value as Partial<AwaySpell>;
  return isCount(spell.from) && isCount(spell.to);
}

function isSample(value: unknown): value is ExperienceSample {
  if (typeof value !== 'object' || value === null) return false;
  const sample = value as Partial<ExperienceSample>;
  return isCount(sample.at) && isCount(sample.experience);
}

function isBlowTally(value: unknown): value is BlowTally {
  if (typeof value !== 'object' || value === null) return false;
  const blows = value as Partial<BlowTally>;
  return (
    isCount(blows.hits) &&
    isCount(blows.damage) &&
    (blows.least === null || isCount(blows.least)) &&
    (blows.most === null || isCount(blows.most))
  );
}

/**
 * The rate per hour of a total, over the scope that produced it.
 *
 * **The denominator is the scope's own clock** — the time this character has
 * stood in the realm since the scope began (`onlineFor`), the same stretch
 * the card's duration badge draws — so a rate is answerable from the first
 * second and a reader can check it against the two figures above it. Pressing
 * Reset re-bases that clock, which is how *since I started* becomes *since I
 * pressed the button* without a second mechanism. Wall-clock time since
 * `since` was the denominator until the tally outlived the socket (2026-09-17,
 * todo 06): a night spent disconnected is not an hour the character earned
 * nothing in.
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
export function ratePerHour(total: number, elapsedMs: number, floorMs = 0): number | null {
  if (elapsedMs <= 0 || elapsedMs < floorMs) return null;
  return (total / elapsedMs) * 3_600_000;
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

/**
 * Every point of damage this character has dealt, whatever kind of blow it
 * was — a weapon's proc included, because those points came off the monster
 * like every other point. (It said *three kinds* while there were four.)
 */
export function damageDealt(tally: CombatTally): number {
  return BLOW_KINDS.reduce((total, kind) => total + tally.dealt[kind].damage, 0);
}

/** And every blow of it that landed. */
export function hitsDealt(tally: CombatTally): number {
  return BLOW_KINDS.reduce((total, kind) => total + tally.dealt[kind].hits, 0);
}

/**
 * How much of the time in the realm was spent in a fight.
 *
 * The only slice of MegaMUD's time analysis this client can state: the server
 * announces engagement and announces nothing about resting, walking or idling
 * that could be added up the same way. One honest figure beats four where three
 * are invented — see the card, which says what the rest of the time was *not*
 * accounted as rather than splitting it.
 */
export function engagedShare(tally: CombatTally, now: number): number | null {
  const elapsed = onlineFor(tally, now);
  if (elapsed <= 0) return null;
  return Math.min(1, engagedFor(tally, now) / elapsed);
}
