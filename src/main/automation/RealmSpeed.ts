/**
 * How many times faster than the server's own clocks this realm runs
 * (GreaterMUD's `GameSpeedMultiplier`: orohost 5, paramud 1), read off a
 * fight's blows and off health rising out of a fight on the realm's tick
 * (`healthRose`). A blow after `speedQuietMs` of quiet opens a round at any
 * speed; a gap between openings up to `speedGapMostMs` in one room is counted
 * (a room shown starts again: the next room's rounds keep their own time), and
 * once `speedRounds` are seen the figure is the slowest whole speed whose round
 * the gaps are whole numbers of (`speedOf`); before then, the figure last
 * read on this server (`KeptSpeed`, `WorldBook`), else the server's own
 * speed; and where a stretch of gaps fits no speed, the figure already read.
 * One per session (`Errands`), read by the survey and every `RoundBeat`. See
 * `mudengine-automation` › parts/loops.md › *The survey runs on the realm's clocks*.
 */
import { tuning } from '../app/tuning';
import type { Block, BlockType } from '../../shared/blocks';
import { NOT_KEPT, type KeptSpeed } from '../../shared/hunting';

/** A blow either way, hit or miss: what a round is read off. */
export function isBlow(type: BlockType): boolean {
  return (
    type === 'user-hits' || type === 'user-misses' || type === 'mob-hits' || type === 'mob-misses'
  );
}

/** How the gaps are read: how many first, how far off a whole number of rounds a gap may be, and what share of the gaps must be. */
export interface SpeedFit {
  least: number;
  /** A share of the round. */
  slack: number;
  /** A share of the gaps. */
  share: number;
  /** The fastest speed that can be read: its round no shorter than the quiet that opens one. */
  fastest: number;
}

/**
 * The figure from the gaps between rounds, in ms, or null on too few or where
 * no speed explains `share` of them. A gap explained by a speed is a whole
 * number of its rounds, give or take `slack` of a round. A gap spans every
 * round in which nobody struck, so the round is what divides the gaps
 * (2026-10-06: orc rogues on orohost, 990 to 3020 ms apart, whose median of
 * 2,478 read 2 where the realm runs at 5). Every gap at speed 5 is also a whole
 * number of speed 10's rounds, so the figure is the slowest speed (an int, at
 * least 1: `GameSpeed.Multiplier`) that explains `share` of what the best
 * explains, and a faster one only where it explains gaps the slower does not.
 * Gaps of two rounds only at speed 4 or 6 read as 2 or 3; and with single-round
 * gaps a speed of 1/`slack` or more (7 at 0.15) reads one under.
 */
export function speedOf(
  gaps: readonly number[],
  serverRoundMs: number,
  fit: SpeedFit
): number | null {
  if (gaps.length < Math.max(1, fit.least)) return null;
  const explained: number[] = [];
  for (let speed = 1; speed <= fit.fastest; speed += 1) {
    const round = serverRoundMs / speed;
    explained.push(
      gaps.filter((gap) => {
        const rounds = Math.round(gap / round);
        return rounds >= 1 && Math.abs(gap - rounds * round) <= fit.slack * round;
      }).length
    );
  }
  const best = Math.max(0, ...explained);
  if (best < fit.share * gaps.length) return null;
  const slowest = explained.findIndex((count) => count >= fit.share * best);
  return slowest < 0 ? null : slowest + 1;
}

export class RealmSpeed {
  private lastBlowAt = Number.NEGATIVE_INFINITY;
  private opened: number | null = null;
  private gaps: number[] = [];
  /** The figure, worked out when a gap is counted rather than on every read. */
  private figure: number | null = null;
  /** The health on the last line, and when it last rose out of a fight, resting or standing. */
  private lastHp: number | null = null;
  private lastRise: { at: number; resting: boolean } | null = null;

  /** Where the figure is kept for the address dialled; nowhere until `useKept`. */
  private kept: KeptSpeed = NOT_KEPT;

  /** The address about to be dialled's store (`WorldBook`), handed over before `connect`. */
  useKept(kept: KeptSpeed): void {
    this.kept = kept;
  }

  /** Every block: a blow counts, and a room shown starts the rounds again. */
  onBlock(block: Pick<Block, 'type' | 'at'>): void {
    if (isBlow(block.type)) this.blow(block.at);
    else if (block.type === 'room-name') this.opened = null;
  }

  /** A blow at `at`: one that opens a round times the gap from the last opening. */
  blow(at: number): void {
    const { speedQuietMs, speedGapMostMs } = tuning().hunting;
    const opens = at - this.lastBlowAt > speedQuietMs;
    this.lastBlowAt = at;
    if (!opens) return;
    if (this.opened !== null && at - this.opened <= speedGapMostMs) this.count(at - this.opened);
    this.opened = at;
  }

  /**
   * A line's health. GreaterMUD runs one rest tick for the whole realm
   * (`TimedEventManager`): a resting character gains on every one, and the
   * standing gain (`DoHPTick`) comes on every second, so two rises are a whole
   * number of ticks apart: of the standing tick where both were standing, of
   * the rest tick where either end was resting. That gap is counted in rounds
   * beside the blows', up to `speedGapMostMs` in rounds. A caster killing in a
   * round or two leaves few blows to read (2026-10-06: none in 25 minutes on
   * orohost, where the standing tick came every 5.8 to 6.1 s). Counted by the
   * rest tick, a standing gap is always an even number of ticks, and at an even
   * speed half the speed would fit them all. A heal, a potion or gear with
   * health put on raises health off the tick; a rise in a fight, where a heal
   * is likeliest, is not counted and does not move the last rise.
   */
  healthRose(hp: number | null, resting: boolean, fighting: boolean, at: number): void {
    const before = this.lastHp;
    this.lastHp = hp;
    if (hp === null || before === null || hp <= before || fighting) return;
    const { roundSeconds, restTickSeconds, passiveTickSeconds, speedGapMostMs } = tuning().hunting;
    const last = this.lastRise;
    this.lastRise = { at, resting };
    if (last === null) return;
    const tick = resting || last.resting ? restTickSeconds : passiveTickSeconds;
    const gap = ((at - last.at) * roundSeconds) / tick;
    if (gap <= speedGapMostMs) this.count(gap);
  }

  /** One gap in ms of the realm's rounds: kept, and the figure worked out again. */
  private count(gap: number): void {
    const { speedQuietMs, speedKept, roundSeconds } = tuning().hunting;
    const { speedRounds, speedSlack, speedShare } = tuning().hunting;
    this.gaps.push(gap);
    if (this.gaps.length > speedKept) this.gaps.splice(0, this.gaps.length - speedKept);
    const serverRoundMs = roundSeconds * 1000;
    const fit = {
      least: speedRounds,
      slack: speedSlack,
      share: speedShare,
      fastest: Math.max(1, Math.floor(serverRoundMs / speedQuietMs))
    };
    const read = speedOf(this.gaps, serverRoundMs, fit);
    if (read !== null && read !== this.figure) this.kept.remember(read);
    this.figure = read ?? this.figure;
  }

  /** The realm's figure: until enough rounds are seen, the one kept for this server, else 1. */
  get multiplier(): number {
    return this.figure ?? this.kept.recall() ?? 1;
  }

  reset(): void {
    this.lastBlowAt = Number.NEGATIVE_INFINITY;
    this.opened = null;
    this.gaps = [];
    this.figure = null;
    this.lastHp = null;
    this.lastRise = null;
  }
}
