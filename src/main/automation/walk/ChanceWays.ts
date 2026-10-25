/**
 * A room command that lands only some of the time (format 73): `dig grave`
 * puts the character in Musty Grottos on 7% of digs, the carriage at its
 * town on 85%. A try that moves nobody prints the realm's answer and a
 * prompt, so the step's deadline arrives with the character where it began,
 * and the command is said again. Where another way exists the tries stop at
 * `movement.chanceTries` times the expected count and the walk plans round
 * it; where it is the only way they never stop (the user, 2026-10-24).
 *
 * A try can take the item the way wants (the shovel breaks on 2%): after
 * each try that could have, the pack is listed, and a way whose item is gone
 * is fetched again before it is tried again. A ship's passage lands after
 * its spells run out, and the rooms it is waited in are the walk working.
 * The why is `mudengine-automation` › `parts/walking.md`.
 */
import type { CharacterState } from '../../../shared/character';
import { gatesWords } from '../../../shared/gateWords';
import { REFRESH } from '../../../shared/staleness';
import { roomAddress, type RoomId, type Route, type RouteStep } from '../../../shared/world';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { CommandQueue } from '../CommandQueue';
import type { WalkClock } from './clock';
import type { WalkerEvents, WalkInFlight } from './ports';

export type ChanceWaysEvents = Pick<WalkerEvents, 'notice' | 'replan' | 'stateNow' | 'fetchAgain'>;

export interface ChanceWaysWalk extends Pick<
  WalkInFlight,
  'walking' | 'quiet' | 'stepWhenFree' | 'kind' | 'destination' | 'detour'
> {
  /** The journey planned again from `here` (`Walker.onward`). */
  onward(state: CharacterState, here: RoomId): void;
  /** How many tries a chance way gets before a way round is taken (`movement.chanceTries`). */
  chanceTries(): number;
}

/** Whether a step lands only on some tries: a chance landing or a draw. */
export function byChance(step: RouteStep): boolean {
  return (step.requirement?.tries ?? 1) > 1;
}

/** The items a step's gates want carried, which a try that breaks one leaves the way without. */
function carried(step: RouteStep): number[] {
  return (step.requirement?.gates ?? []).flatMap((gate) =>
    gate.kind === 'carry' ? [gate.item] : []
  );
}

export class ChanceWays {
  /** The tries said at one way, keyed by its room and command so a replan keeps the count. */
  private tries: { key: string; count: number } | null = null;
  /** The way found to be the only way there, so it is not asked again. */
  private onlyWay: string | null = null;
  /** A listing asked after a try that may have taken an item, and when. */
  private listing: { step: RouteStep; askedAt: number; waits: number } | null = null;

  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: ChanceWaysEvents,
    private readonly walk: ChanceWaysWalk,
    private readonly clock: Pick<WalkClock, 'afterHold' | 'clear'>
  ) {}

  /**
   * The step's deadline with the character still where it began: a try that
   * moved nobody. True where this answered it.
   */
  stayed(step: RouteStep, state: CharacterState): boolean {
    if (!byChance(step) || roomAddress(state.room) !== step.from) return false;
    this.clock.clear();
    const key = `${step.from}|${step.command ?? ''}`;
    const count = this.tries?.key === key ? this.tries.count + 1 : 1;
    this.tries = { key, count };
    const limit = Math.ceil(this.walk.chanceTries() * (step.requirement?.tries ?? 1));
    const round = count >= limit ? this.wayRound(step, key) : null;
    if (round !== null) {
      this.tries = null;
      if (!this.walk.quiet()) {
        this.events.notice?.(t('automation.walk.chanceGaveUp', { command: step.command, count }));
      }
      // The way round itself: a plan drawn again would take the cheaper chance way.
      this.walk.detour(round, state);
      return true;
    }
    if ((step.requirement?.breaks?.length ?? 0) > 0 && carried(step).length > 0) {
      this.askPack(step);
      return true;
    }
    this.again(count === 1 ? step : null);
    return true;
  }

  /**
   * Where a ship's passage is waited out: the room the board put the
   * character in, a beat at a time until the spells land it; and a room whose
   * own spell is the way, where it stands. True where `here` is one.
   */
  waitsOut(step: RouteStep, here: RoomId): boolean {
    const waits = step.requirement?.waits;
    if (waits === undefined || !waits.in.includes(here)) return false;
    this.clock.clear();
    if (step.requirement?.kind === 'room-spell' && this.waitedEnough(step)) return true;
    if (!this.walk.quiet()) {
      this.events.notice?.(
        step.requirement?.kind === 'room-spell'
          ? t('automation.walk.roomSpellWaiting', { room: step.name, ticks: waits.ticks })
          : t('automation.walk.passageWaiting', { command: step.command })
      );
    }
    // The spells' own ticks, and as long again, before the walk plans from here.
    const ms = waits.ticks * tuning().walk.passageTickMs * 2;
    this.clock.afterHold(ms, () => {
      const state = this.events.stateNow?.();
      const at = state === undefined ? null : roomAddress(state.room);
      if (state !== undefined && at !== null && this.walk.walking()) this.walk.onward(state, at);
    });
    return true;
  }

  /**
   * A room's spell waited for as a chance way is tried: past `chanceTries`
   * waits, each twice the ticks expected, the way round where there is one.
   * True where the walk took it; an only way is waited for until it lands.
   */
  private waitedEnough(step: RouteStep): boolean {
    const key = `${step.from}|${step.to}`;
    const count = this.tries?.key === key ? this.tries.count + 1 : 1;
    this.tries = { key, count };
    const state = this.events.stateNow?.();
    if (count <= this.walk.chanceTries() || state === undefined) return false;
    const round = this.wayRound(step, key);
    if (round === null) return false;
    this.tries = null;
    if (!this.walk.quiet()) {
      this.events.notice?.(t('automation.walk.roomSpellGaveUp', { room: step.name, count }));
    }
    this.walk.detour(round, state);
    return true;
  }

  /**
   * The way to the journey's end from here without this step's way, or null
   * where it is the only way: asked once per way, since an only way is tried
   * until it lands and the answer does not change while it is.
   */
  private wayRound(step: RouteStep, key: string): Route | null {
    if (this.onlyWay === key) return null;
    const to = this.walk.destination()?.to;
    if (to === undefined || this.events.replan === undefined) return null;
    const round = this.events.replan(to, this.walk.kind(), {
      from: step.from,
      direction: step.direction
    });
    if (typeof round !== 'string' && !round.blocked && round.steps.length > 0) return round;
    this.onlyWay = key;
    return null;
  }

  /** The command said again after a beat; `first` is said once, at the first try that did not land. */
  private again(first: RouteStep | null = null): void {
    if (first !== null && !this.walk.quiet()) {
      const expected = Math.round(first.requirement?.tries ?? 1);
      this.events.notice?.(t('automation.walk.chanceTry', { command: first.command, expected }));
    }
    this.clock.afterHold(tuning().walk.holdMs, () => {
      if (this.walk.walking()) this.walk.stepWhenFree();
    });
  }

  /** The pack listed before the next try, since this one may have taken what the way wants. */
  private askPack(step: RouteStep): void {
    const askedAt = Date.now();
    this.listing = { step, askedAt, waits: 0 };
    this.queue.enqueue({
      ...REFRESH.pack,
      priority: 'probe',
      decision: 'walk-chance-try',
      expiresAt: askedAt + tuning().queue.unreadRetryMs,
      reason: t('automation.walk.reasonChancePack')
    });
    this.whenListed();
  }

  private whenListed(): void {
    this.clock.afterHold(tuning().walk.holdMs, () => {
      const listing = this.listing;
      const state = this.events.stateNow?.();
      if (listing === null || state === undefined || !this.walk.walking()) return;
      const listedAt = state.inventory.listedAt;
      const fresh = listedAt !== null && listedAt >= listing.askedAt;
      if (!fresh && listing.waits * tuning().walk.holdMs < tuning().queue.unreadRetryMs) {
        listing.waits += 1;
        this.whenListed();
        return;
      }
      this.listing = null;
      const gone = carried(listing.step).filter((item) => !state.inventory.rows.includes(item));
      if (!fresh || gone.length === 0) {
        this.again();
        return;
      }
      this.fetch(listing.step, gone, state);
    });
  }

  /** What the try took, fetched again, and the journey walked on from there. */
  private fetch(step: RouteStep, gone: readonly number[], state: CharacterState): void {
    const to = this.walk.destination()?.to;
    const missing = gatesWords(
      (step.requirement?.gates ?? []).filter(
        (gate) => gate.kind === 'carry' && gone.includes(gate.item)
      ),
      t
    );
    if (!this.walk.quiet()) {
      this.events.notice?.(t('automation.walk.chanceItemGone', { command: step.command, missing }));
    }
    this.tries = null;
    if (to !== undefined && this.events.fetchAgain?.(gone, to, this.walk.kind()) === true) return;
    this.walk.onward(state, step.from);
  }
}
