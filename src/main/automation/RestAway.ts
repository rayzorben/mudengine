/**
 * Not resting in the room that is about to fill — stepping next door first.
 *
 * A lair is dangerous for what it is about to contain, and every rest rule
 * before this one read only what the room held. Measured 2026-09-12: a
 * character won a fight, sat down at 20% in a room whose clock makes three
 * wererats every twenty seconds, and met them at 2%, twice. The clock is in
 * the realm's own data (`Rooms.Delay`, format 33). This refuses the rest
 * there, **peeks** into a neighbour the realm holds no lair in (`l <dir>`),
 * reads the peeked room as a different room, moves only into one that is
 * empty, rests there, and steps back when nothing else has the character.
 * See `mudengine-automation` § *A rest is taken next door to a lair*.
 */
import type { CommandQueue } from './CommandQueue';
import { fightIsHere } from './Recovery';
import { countThreats } from './RuleEngine';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig, CombatConfig, HealthConfig } from '../../shared/config';
import type { MobRule } from '../../shared/mobRules';
import { OPPOSITE, type Direction, type RoomId } from '../../shared/world';
import type { SessionModule } from './Module';

export interface RestAwayPlanner {
  here(): RoomId | null;
  /** The room's effective respawn clock in seconds; null for a room with no lair or no clock. */
  lairClock(room: RoomId): number | null;
  /** Adjacent rooms the realm holds that make no monsters, plain exits first. */
  neighbours(room: RoomId): { direction: Direction; to: RoomId; name: string }[];
  moveInFlight(): boolean;
  /** The walker marching. */
  walking(): boolean;
  /** A lap running, held or not: it plans its own leg from wherever the rest ends. */
  looping(): boolean;
  /** An escape in flight or awaiting its answer. */
  busy(): boolean;
}

export interface RestAwayEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/** What `consider` decided about this status line's rest. */
export type RestAwayVerdict = 'not-mine' | 'took-over' | 'rest-here';

type Phase =
  | { kind: 'idle' }
  | { kind: 'peeking'; from: RoomId; direction: Direction; to: RoomId; name: string; since: number }
  | { kind: 'moving'; from: RoomId; direction: Direction; to: RoomId; since: number }
  | { kind: 'resting'; from: RoomId; back: Direction };

const ACTION = 'rest away';

/** What a reload hands `RestAway`: its block, the master switch, and the monster rows. */
export type RestAwaySettings = Pick<AutomationConfig, 'health' | 'enabled'> & {
  combat: Pick<CombatConfig, 'mobRules'>;
};

export class RestAway implements SessionModule {
  private phase: Phase = { kind: 'idle' };
  /** Directions peeked from the room the character stands in that were not safe. */
  private tried = new Map<RoomId, Set<Direction>>();
  /** The lair the refusal was said in, so a listing repeat does not restate it. */
  private saidIn: RoomId | null = null;
  /** A lair with no safe neighbour, where resting was allowed and said once. */
  private allowedIn: RoomId | null = null;

  constructor(
    private settings: RestAwaySettings,
    private readonly queue: CommandQueue,
    private readonly planner: RestAwayPlanner,
    private readonly events: RestAwayEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(settings: RestAwaySettings): void {
    this.settings = settings;
  }

  private get config(): HealthConfig {
    return this.settings.health;
  }

  private get enabled(): boolean {
    return this.settings.enabled;
  }

  /** The monster rows, read as `Recovery` reads them, so the two refusals agree. */
  private get mobRules(): readonly MobRule[] {
    return this.settings.combat.mobRules;
  }

  reset(): void {
    this.phase = { kind: 'idle' };
    this.tried.clear();
    this.saidIn = null;
    this.allowedIn = null;
  }

  /**
   * Every status line, told whether `Recovery` would sit the character down
   * on it. `took-over` means the rest here is refused and this is stepping
   * out; `rest-here` means the room is a lair and no neighbour is safe, so
   * the rest may go ahead where it is, said once; `not-mine` is every other
   * room.
   */
  consider(state: CharacterState, wantsRest: boolean): RestAwayVerdict {
    if (!this.enabled || !this.config.restNextDoor) return 'not-mine';
    if (state.phase !== 'in-game') return 'not-mine';
    const here = this.planner.here();

    switch (this.phase.kind) {
      case 'peeking':
        return this.peeking(state, here);
      case 'moving':
        return this.moving(here);
      case 'resting':
        return this.resting(state, wantsRest, here);
      case 'idle':
        break;
    }

    if (!wantsRest || here === null) return 'not-mine';
    const clock = this.planner.lairClock(here);
    if (clock === null || clock > tuning().rest.lairClockMaxSeconds) return 'not-mine';
    if (this.allowedIn === here) return 'rest-here';
    // `Recovery` refuses these itself; nothing steps out of a fight either.
    if (fightIsHere(state) || countThreats(state, this.mobRules) > 0) return 'took-over';
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) {
      return 'took-over';
    }

    const tried = this.tried.get(here) ?? new Set<Direction>();
    const next = this.planner.neighbours(here).find((way) => !tried.has(way.direction));
    if (next === undefined) {
      this.allowedIn = here;
      this.events.notice?.(t('automation.restAway.noSafeRoom', { seconds: Math.round(clock) }));
      this.events.decided?.({
        at: this.now(),
        action: ACTION,
        because: t('automation.restAway.becauseClock', { seconds: Math.round(clock) }),
        acted: false,
        refused: t('automation.restAway.refusalNoSafeRoom')
      });
      return 'rest-here';
    }
    if (this.saidIn !== here) {
      this.saidIn = here;
      this.events.notice?.(
        t('automation.restAway.refusingHere', { seconds: Math.round(clock), name: next.name })
      );
    }
    this.queue.enqueue({
      command: `l ${next.direction}`,
      priority: 'probe',
      coalesceKey: 'rest:peek',
      expiresAt: this.now() + tuning().rest.peekMs,
      reason: t('automation.restAway.reasonPeek', { name: next.name })
    });
    this.phase = {
      kind: 'peeking',
      from: here,
      direction: next.direction,
      to: next.to,
      name: next.name,
      since: this.now()
    };
    return 'took-over';
  }

  /** The peek's answer: a room read as a different room, and whether anything is in it. */
  private peeking(state: CharacterState, here: RoomId | null): RestAwayVerdict {
    if (this.phase.kind !== 'peeking') return 'not-mine';
    const { from, direction, to, name, since } = this.phase;
    if (here !== from) {
      this.phase = { kind: 'idle' };
      return 'not-mine';
    }
    const peeked = state.peeked;
    if (peeked !== null && peeked.at >= since && peeked.direction === direction) {
      const present = peeked.room.occupants.map((who) => who.name);
      if (present.length === 0) {
        this.events.notice?.(t('automation.restAway.stepping', { direction, name }));
        this.queue.enqueue({
          command: direction,
          priority: 'movement',
          coalesceKey: 'rest:step',
          expiresAt: this.now() + tuning().rest.peekMs,
          reason: t('automation.restAway.reasonStep', { name })
        });
        this.phase = { kind: 'moving', from, direction, to, since: this.now() };
        return 'took-over';
      }
      this.markTried(from, direction);
      this.events.notice?.(t('automation.restAway.notSafe', { name, who: present.join(', ') }));
      this.phase = { kind: 'idle' };
      return 'took-over';
    }
    if (this.now() - since > tuning().rest.peekMs) {
      // Nothing answered the look: not proven safe, so not entered.
      this.markTried(from, direction);
      this.events.notice?.(t('automation.restAway.peekUnanswered', { name }));
      this.phase = { kind: 'idle' };
      return 'took-over';
    }
    return 'took-over';
  }

  private moving(here: RoomId | null): RestAwayVerdict {
    if (this.phase.kind !== 'moving') return 'not-mine';
    const { from, direction, to, since } = this.phase;
    if (here === to) {
      this.phase = { kind: 'resting', from, back: OPPOSITE[direction] };
      this.events.decided?.({
        at: this.now(),
        action: ACTION,
        because: t('automation.restAway.becauseStepped', { direction }),
        acted: true
      });
      return 'not-mine';
    }
    if (here !== null && here !== from) {
      // Landed somewhere else: the realm moved the character, or a door
      // refused; wherever this is, it is not the lair.
      this.phase = { kind: 'idle' };
      return 'not-mine';
    }
    if (this.now() - since > tuning().session.retreatPatienceMs) {
      this.markTried(from, direction);
      this.events.notice?.(t('automation.restAway.stepUnanswered', { direction }));
      this.phase = { kind: 'idle' };
      return 'took-over';
    }
    return 'took-over';
  }

  /**
   * Rested next door. Steps back only when nothing else has the character:
   * a lap plans its own leg from wherever it stands, and a walk is somebody
   * else's destination.
   */
  private resting(state: CharacterState, wantsRest: boolean, here: RoomId | null): RestAwayVerdict {
    if (this.phase.kind !== 'resting') return 'not-mine';
    const { back } = this.phase;
    if (wantsRest || state.vitals.resting) return 'not-mine';
    this.phase = { kind: 'idle' };
    if (this.planner.looping() || this.planner.walking() || this.planner.moveInFlight()) {
      return 'not-mine';
    }
    if (here === null || fightIsHere(state)) return 'not-mine';
    this.events.notice?.(t('automation.restAway.steppingBack', { direction: back }));
    this.queue.enqueue({
      command: back,
      priority: 'movement',
      coalesceKey: 'rest:step',
      expiresAt: this.now() + tuning().rest.peekMs,
      reason: t('automation.restAway.reasonBack')
    });
    return 'not-mine';
  }

  private markTried(room: RoomId, direction: Direction): void {
    const set = this.tried.get(room) ?? new Set<Direction>();
    set.add(direction);
    this.tried.set(room, set);
  }
}
