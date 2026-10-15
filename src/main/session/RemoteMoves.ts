/**
 * Remotes that move this character on another player's word. `@stop` and
 * `@rego` (todo 15) are the player's own Stop and Play: the stop names its
 * sender as the reason, and the resume takes the distance it measures as
 * agreed. Only what a `@stop` stopped is resumed, while it is still stopped
 * for that reason. `@loop` (todo 16) starts the loop a path file, name or
 * start room picks out (`matchLoopIn`) as the palette starts one, or resumes
 * the lap it names. `@goto` (todo 17) and `@comeback-room` walk to a room as
 * the player's own route does. `@path` (todo 32) says where the character is
 * going, in the words `@loop` and `@goto` read back. See
 * `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { personStop } from '../automation/personStop';
import type { RemoteEvents, StoppedByRemote } from '../automation/Remotes';
import type { CarriedLap } from '../../shared/underway';
import {
  matchLoopIn,
  readStop,
  splitStop,
  type Loop,
  type LoopProgress,
  type RoomMatch
} from '../../shared/loops';
import type { Movement, MovementKind, MovementStart } from '../../shared/movement';
import type { MoveAnswer, PathReport } from '../../shared/remotes';
import type { NoticeSink } from '../../shared/decisionSettings';
import type { WalkProgress } from '../../shared/walk';
import { roomId, type RoomId, type RoomReference, type Route } from '../../shared/world';

/** The session's own doors a remote stop and resume go through. */
export interface RemoteMovesSession {
  readonly movement: Movement;
  readonly walker: { readonly progress: WalkProgress };
  readonly loops: { readonly progress: LoopProgress; readonly place: CarriedLap | null };
  stopMoving(by: string | null): void;
  startMoving(loopName: string | null, confirmed: number | null): MovementStart;
  startLoop(loop: Loop): MovementStart;
  /** The player's own route, the supply list consulted first; the refusal, or null. */
  walkRoute(route: Route): string | null;
}

/** The loops `@loop` picks from: this character's own, then the shelf (todo 32). */
export interface RemoteLoops {
  own(): readonly Loop[];
  shelf(): readonly Loop[];
}

/** Where a room is and the way there from here (`Errands`). */
export interface RemoteRooms {
  matchStop(stop: { name: string; at: RoomReference | null }): RoomMatch;
  planFromHere(to: RoomId): Route | string;
  /** The steps from here through `rooms` in order, or null where a leg cannot be planned. */
  stepsThrough(rooms: readonly RoomId[]): number | null;
}

const OK: MoveAnswer = { kind: 'ok' };
const FAILED: MoveAnswer = { kind: 'failed' };

export class RemoteMoves {
  /** Who sent the last `@stop` that stopped something. */
  private stoppedBy: string | null = null;

  constructor(
    private readonly session: RemoteMovesSession,
    private readonly rooms: RemoteRooms,
    private readonly notice: NoticeSink,
    private readonly loops: RemoteLoops
  ) {}

  /** What `Remotes` asks: `@status` and the remotes that move this character. */
  readonly events: Required<
    Pick<
      RemoteEvents,
      'progress' | 'path' | 'stopMoving' | 'resumeMoving' | 'startLoop' | 'goTo' | 'comeBack'
    >
  > = {
    progress: () => ({
      walk: this.session.walker.progress,
      loop: this.session.loops.progress,
      stopped: this.waiting()
    }),
    path: () => this.path(),
    stopMoving: (from) => this.stop(from),
    resumeMoving: (from) => this.resume(from),
    startLoop: (from, request) => this.loop(from, request),
    goTo: (from, request) => this.goTo(from, request),
    comeBack: (from, map, room) => this.comeBack(from, { map, room })
  };

  private stop(from: string): boolean {
    const { kind, moving } = this.session.movement;
    if (kind === null || !moving) {
      this.notice(t('session.remotes.stopNothing', { who: from }), 'remote-moves');
      return false;
    }
    this.session.stopMoving(from);
    this.stoppedBy = from;
    return true;
  }

  private resume(from: string): boolean {
    const stopped = this.waiting();
    if (stopped === null) {
      this.notice(t('session.remotes.regoNothing', { who: from }), 'remote-moves');
      return false;
    }
    const answer = this.resumeAgreed(null);
    if ('started' in answer) {
      this.stoppedBy = null;
      this.notice(
        t('session.remotes.regoResumed', { who: from, name: stopped.name }),
        'remote-moves'
      );
      return true;
    }
    this.notice(
      t('session.remotes.regoRefused', { who: from, name: stopped.name, reason: whyNot(answer) }),
      'remote-moves'
    );
    return false;
  }

  private loop(from: string, request: string): MoveAnswer {
    const lap = this.session.loops.place?.loop;
    const pools = [this.loops.own(), lap === undefined ? [] : [lap], this.loops.shelf()];
    const match = matchLoopIn(pools, request);
    switch (match.kind) {
      case 'none':
        this.notice(t('session.remotes.loopNone', { who: from, request }), 'remote-moves');
        return { kind: 'unknown', request, candidates: [] };
      case 'several': {
        const names = match.loops.map((loop) => loop.name);
        this.notice(
          t('session.remotes.loopSeveral', {
            who: from,
            request,
            count: names.length,
            names: names.join('; ')
          }),
          'remote-moves'
        );
        return { kind: 'unknown', request, candidates: names };
      }
      case 'one':
        return this.startNamed(from, match.loop) ? OK : FAILED;
      default: {
        const never: never = match;
        return never;
      }
    }
  }

  /**
   * Starts `loop` as the palette does, saying who asked and what it took over
   * from; the lap already stopped, named again, resumes its kept place with
   * the distance taken as agreed, as `@rego`'s does.
   */
  private startNamed(from: string, loop: Loop): boolean {
    const replacing = this.running();
    const { kind, moving } = this.session.movement;
    const kept = kind === 'loop' && !moving && this.session.loops.progress.name === loop.name;
    const answer = kept ? this.resumeAgreed(loop.name) : this.session.startLoop(loop);
    if (!('started' in answer)) {
      this.notice(
        t('session.remotes.loopRefused', { who: from, name: loop.name, reason: whyNot(answer) }),
        'remote-moves'
      );
      return false;
    }
    this.notice(
      replacing === null
        ? t('session.remotes.loopStarted', { who: from, name: loop.name })
        : t('session.remotes.loopReplaced', { who: from, name: loop.name, was: replacing }),
      'remote-moves'
    );
    return true;
  }

  /** Play on a remote's word: the distance measured is taken as agreed in the same turn. */
  private resumeAgreed(loopName: string | null): MovementStart {
    const answer = this.session.startMoving(loopName, null);
    // Measured and agreed in one turn, so the second answer cannot ask again.
    return 'confirm' in answer ? this.session.startMoving(loopName, answer.confirm.steps) : answer;
  }

  private goTo(from: string, request: string): MoveAnswer {
    const match = this.rooms.matchStop(readStop(request));
    switch (match.kind) {
      case 'none':
        this.notice(t('session.remotes.gotoNone', { who: from, request }), 'remote-moves');
        return { kind: 'unknown', request, candidates: [] };
      case 'several': {
        const addresses = match.rooms.map(({ map, room }) => roomId(map, room));
        this.notice(
          t('session.remotes.gotoSeveral', {
            who: from,
            request,
            count: addresses.length,
            addresses: addresses.join(', ')
          }),
          'remote-moves'
        );
        return { kind: 'unknown', request, candidates: addresses };
      }
      case 'one': {
        const replacing = this.running();
        const walk = this.walkTo(match.at);
        if (typeof walk === 'string') {
          this.notice(
            t('session.remotes.gotoRefused', { who: from, request, reason: walk }),
            'remote-moves'
          );
          return FAILED;
        }
        const room = { who: from, ...walk, address: roomId(match.at.map, match.at.room) };
        this.notice(
          replacing === null
            ? t('session.remotes.gotoWalking', room)
            : t('session.remotes.gotoReplaced', { ...room, was: replacing }),
          'remote-moves'
        );
        return OK;
      }
      default: {
        const never: never = match;
        return never;
      }
    }
  }

  /**
   * `@path`: the lap (running, or stopped with its place kept) by its path
   * file and name, counted to the lap's end; a trip off the lap, or a route,
   * counted to where it goes. Null is `{none}`.
   */
  private path(): PathReport | null {
    const { kind, moving, resumable } = this.session.movement;
    const walk = this.session.walker.progress;
    const left = walk.status === 'walking' || resumable ? walk.total - walk.done : null;
    if (kind === 'route' && (moving || resumable)) {
      return { path: written(walk), title: null, to: null, why: null, steps: left, end: 'go' };
    }
    const place = this.session.loops.place;
    if (kind !== 'loop' || place === null) return null;
    const lap = place.loop;
    const named =
      lap.pathFile === undefined
        ? { path: lap.name, title: null }
        : { path: lap.pathFile, title: lap.name };
    const { hold } = this.session.loops.progress;
    // MegaMUD's `[Detouring to …]`: the trip off the lap, and that it is one.
    if (hold === 'errand' && walk.status === 'walking') {
      return { ...named, to: written(walk), why: 'detour', steps: left, end: 'go' };
    }
    const owed = this.lapOwed(place);
    const steps = owed === null ? null : this.rooms.stepsThrough(owed);
    return { ...named, to: null, why: null, steps, end: 'lap end' };
  }

  /**
   * The stops this lap still owes from its kept place, in order, running or
   * stopped; null where one is not placed or the lap bounces, whose way back
   * is not counted here. Read off the lap, never the map's drawing list,
   * which is empty for a stopped lap.
   */
  private lapOwed(lap: CarriedLap): readonly RoomId[] | null {
    if (lap.loop.bounce === true) return null;
    const owed: RoomId[] = [];
    for (const stop of lap.loop.stops.slice(lap.index)) {
      const match = this.rooms.matchStop(splitStop(stop));
      if (match.kind !== 'one') return null;
      owed.push(roomId(match.at.map, match.at.room));
    }
    return owed;
  }

  /** `@comeback-room`: the address the sender stated. */
  private comeBack(from: string, at: RoomReference): boolean {
    const walk = this.walkTo(at);
    if (typeof walk === 'string') {
      this.notice(
        t('session.remotes.comebackRefused', { who: from, reason: walk }),
        'remote-moves'
      );
      return false;
    }
    this.notice(
      t('session.remotes.comebackWalking', {
        who: from,
        stepCount: walk.stepCount,
        address: roomId(at.map, at.room)
      }),
      'remote-moves'
    );
    return true;
  }

  /**
   * The player's own route to `at`, through `walkRoute` so a running lap is
   * stopped for it and the supply list gets its say. The refusal, or the walk.
   */
  private walkTo(at: RoomReference): { stepCount: number; room: string } | string {
    const plan = this.rooms.planFromHere(roomId(at.map, at.room));
    if (typeof plan === 'string') return plan;
    const refused = this.session.walkRoute(plan);
    if (refused !== null) return refused;
    return {
      stepCount: plan.steps.length,
      room: plan.steps.at(-1)?.name ?? roomId(at.map, at.room)
    };
  }

  /** The name of the route or lap walking now, which a new start takes over from. */
  private running(): string | null {
    const { kind, moving } = this.session.movement;
    return kind !== null && moving ? this.progressOf(kind).name : null;
  }

  /**
   * What the last `@stop` stopped, while it is still stopped for that reason.
   * The reason is the identity: a lap or a route walked again, arrived, or
   * stopped by anything else carries another, or is not resumable at all.
   */
  private waiting(): StoppedByRemote | null {
    const by = this.stoppedBy;
    if (by === null) return null;
    const { kind, moving, resumable } = this.session.movement;
    if (kind === null || moving || !resumable) return null;
    const progress = this.progressOf(kind);
    if (progress.reason !== personStop(by)) return null;
    return { by, name: progress.name };
  }

  /** The stopped movement's reason and name, as the card shows them. */
  private progressOf(kind: MovementKind): { reason: string | null; name: string } {
    switch (kind) {
      case 'loop': {
        const loop = this.session.loops.progress;
        return { reason: loop.reason, name: loop.name ?? t('session.move.theLoop') };
      }
      case 'route': {
        const walk = this.session.walker.progress;
        return { reason: walk.reason, name: walk.destination ?? t('session.remotes.theRoute') };
      }
      default: {
        const never: never = kind;
        return never;
      }
    }
  }
}

/** A walk's destination as a loop stop is written (`Dark Cave 1/866`), which `@goto` reads back. */
function written(walk: WalkProgress): string {
  const name = walk.destination ?? '?';
  const at = walk.destinationRoom;
  return at === null ? name : `${name} ${roomId(at.map, at.room)}`;
}

/** Why a start or a resume did not walk, in words for the notice. */
function whyNot(answer: Exclude<MovementStart, { started: true }>): string {
  return 'refused' in answer
    ? answer.refused
    : t('session.remotes.regoTooFar', { stepCount: answer.confirm.steps });
}
