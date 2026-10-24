/**
 * A room command on the route (`go hole`, `put white fang in slot`) whose own
 * check the realm runs before it moves anybody: `nomonsters`, a level, an
 * item, a roll (todo 65, out of `Walker` from the start). A failed check
 * prints the textblock's message, or nothing, and a prompt
 * (`Player.HandleCommand`, `TextBlockPart.cs:838`), so no room is coming.
 *
 * One retry per step, after a beat, for a check that can pass a second time;
 * then the way is written down as refused and the journey planned again from
 * the room it stands in. The why is `mudengine-automation` ›
 * `parts/walking.md`.
 */
import type { CharacterState } from '../../../shared/character';
import type { GateKind } from '../../../shared/gates';
import { roomAddress, type RoomId, type RouteStep } from '../../../shared/world';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { countMobs } from '../RuleEngine';
import type { WalkClock } from './clock';
import type { CommandQueue } from '../CommandQueue';
import { byChance, ChanceWays, type ChanceWaysEvents, type ChanceWaysWalk } from './ChanceWays';
import type { WalkerEvents, WalkInFlight } from './ports';

/**
 * Whether this step is a room script with conditions, and so whether landing
 * somewhere else is a surprise the plan already allowed for: a script's
 * *landing* depends on a branch (`WorldGraph.linkPortals`; live, `9/1291`'s
 * portal put a character at rank 4 two maps away), and the router takes the
 * landing it has. A condition that stops the move outright leaves the
 * character where it was: `RoomCommands` answers that.
 */
export function scriptGated(step: RouteStep): boolean {
  return (
    (step.requirement?.gates?.length ?? 0) > 0 ||
    byChance(step) ||
    step.requirement?.waits !== undefined
  );
}

/** Whether the realm runs this step's command only in a room no monster stands in. */
function wantsEmptyRoom(step: RouteStep): boolean {
  return (step.requirement?.gates ?? []).some((gate) => gate.kind === 'empty-room');
}

/**
 * The checks that can answer differently a moment later: the room emptying or
 * filling, and a roll. A level, class, item or alignment check gives the same
 * answer, and the router has already priced it against the character.
 */
const CAN_PASS_LATER: Record<GateKind, boolean> = {
  level: false,
  class: false,
  race: false,
  standing: false,
  alignment: false,
  carry: false,
  lack: false,
  floor: false,
  ability: false,
  'spell-off': false,
  lives: false,
  copper: false,
  roll: true,
  'empty-room': true,
  'monster-here': true,
  occupied: true
};

function worthRetrying(step: RouteStep): boolean {
  return (step.requirement?.gates ?? []).some((gate) => CAN_PASS_LATER[gate.kind]);
}

export type RoomCommandsEvents = Pick<WalkerEvents, 'notice' | 'refused' | 'stateNow'> &
  ChanceWaysEvents;

export interface RoomCommandsWalk
  extends Pick<WalkInFlight, 'walking' | 'quiet' | 'step' | 'stepWhenFree'>, ChanceWaysWalk {}

export class RoomCommands {
  /**
   * The step already retried once: a second refusal of it gives the way up.
   * Keyed on the step itself, so a replan or a landing needs no reset.
   */
  private retried: RouteStep | null = null;
  private readonly chance: ChanceWays;

  constructor(
    queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: RoomCommandsEvents,
    private readonly walk: RoomCommandsWalk,
    private readonly clock: Pick<WalkClock, 'afterHold' | 'clear'>
  ) {
    this.chance = new ChanceWays(queue, events, walk, clock);
  }

  /** Where a ship's passage is waited out, which is the step working (`ChanceWays.waitsOut`). */
  waitsOut(step: RouteStep, here: RoomId): boolean {
    return this.chance.waitsOut(step, here);
  }

  /**
   * In place of the step, once every hold has had its say: a monster still
   * standing in the room means auto-combat's rules left it alone (or it is
   * off), so `nomonsters` refuses. Spending the command would only print the
   * realm's `You cannot do that right now!`; the refusal is taken now.
   * Returns whether it answered the send.
   */
  refuseBeforeSending(step: RouteStep, state: CharacterState): boolean {
    if (!wantsEmptyRoom(step) || countMobs(state.room.occupants) === 0) return false;
    this.refuse(step, state);
    return true;
  }

  /** `room-command-refused` off the wire, for the step in flight. */
  onRefused(): void {
    const step = this.walk.step();
    const state = this.events.stateNow?.();
    if (step === undefined || state === undefined || !scriptGated(step)) return;
    this.refuse(step, state);
  }

  /**
   * The step's deadline with nothing back, for a gated room command still
   * standing where it began: 94 of gmud's 453 `nomonsters` name no message,
   * and fail with a bare prompt. True when this answered the deadline.
   */
  refusedAtDeadline(): boolean {
    const step = this.walk.step();
    const state = this.events.stateNow?.();
    if (step === undefined || state === undefined || !scriptGated(step)) return false;
    if (roomAddress(state.room) !== step.from) return false;
    // A try that moved nobody is a chance way's ordinary answer.
    if (this.chance.stayed(step, state)) return true;
    this.refuse(step, state);
    return true;
  }

  private refuse(step: RouteStep, state: CharacterState): void {
    if (this.retried !== step && worthRetrying(step)) {
      this.retried = step;
      // The step's own deadline goes too, or it would be read as the second refusal.
      this.clock.clear();
      if (!this.walk.quiet()) {
        this.events.notice?.(t('automation.walk.roomCommandRetry', { command: step.command }));
      }
      this.clock.afterHold(tuning().walk.holdMs, () => {
        if (this.walk.walking()) this.walk.stepWhenFree();
      });
      return;
    }
    /*
     * Written down through the one refused-edge set the navigation engine
     * reads, then planned again: the route goes another way or says there is
     * none. A check that can pass later is kept out of for a while only; a
     * level, class or item check for the session.
     */
    this.events.refused?.(step.from, step.direction, worthRetrying(step) ? 'for-now' : 'checked');
    this.walk.onward(state, step.from);
  }
}
