/**
 * Remotes that move this character on another player's word. `@stop` and
 * `@rego` (todo 15) are the player's own Stop and Play: the stop names its
 * sender as the reason, and the resume takes the distance it measures as
 * agreed. Only what a `@stop` stopped is resumed, while it is still stopped
 * for that reason. `@loop` (todo 16) starts the loop a name or start room
 * picks out (`matchLoop`) as the palette starts one; several or none start
 * nothing and are said. See `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { personStop } from '../automation/personStop';
import type { RemoteEvents, StoppedByRemote } from '../automation/Remotes';
import { matchLoop, type Loop, type LoopProgress } from '../../shared/loops';
import type { Movement, MovementKind, MovementStart } from '../../shared/movement';
import type { WalkProgress } from '../../shared/walk';

/** The session's own doors a remote stop and resume go through. */
export interface RemoteMovesSession {
  readonly movement: Movement;
  readonly walker: { readonly progress: WalkProgress };
  readonly loops: { readonly progress: LoopProgress };
  stopMoving(by: string | null): void;
  startMoving(loopName: string | null, confirmed: number | null): MovementStart;
  /** The loops this character can run, as its options define them. */
  readonly loopsDefined: readonly Loop[];
  startLoop(loop: Loop): MovementStart;
}

export class RemoteMoves {
  /** Who sent the last `@stop` that stopped something. */
  private stoppedBy: string | null = null;

  constructor(
    private readonly session: RemoteMovesSession,
    private readonly notice: (message: string) => void
  ) {}

  /** What `Remotes` asks: `@status`, `@stop`, `@rego` and `@loop`. */
  readonly events: Required<
    Pick<RemoteEvents, 'progress' | 'stopMoving' | 'resumeMoving' | 'startLoop'>
  > = {
    progress: () => ({
      walk: this.session.walker.progress,
      loop: this.session.loops.progress,
      stopped: this.waiting()
    }),
    stopMoving: (from) => this.stop(from),
    resumeMoving: (from) => this.resume(from),
    startLoop: (from, request) => this.loop(from, request)
  };

  private stop(from: string): boolean {
    const { kind, moving } = this.session.movement;
    if (kind === null || !moving) {
      this.notice(t('session.remotes.stopNothing', { who: from }));
      return false;
    }
    this.session.stopMoving(from);
    this.stoppedBy = from;
    return true;
  }

  private resume(from: string): boolean {
    const stopped = this.waiting();
    if (stopped === null) {
      this.notice(t('session.remotes.regoNothing', { who: from }));
      return false;
    }
    let answer = this.session.startMoving(null, null);
    // Measured and agreed in one turn, so the second answer cannot ask again.
    if ('confirm' in answer) answer = this.session.startMoving(null, answer.confirm.steps);
    if ('started' in answer) {
      this.stoppedBy = null;
      this.notice(t('session.remotes.regoResumed', { who: from, name: stopped.name }));
      return true;
    }
    this.notice(
      t('session.remotes.regoRefused', { who: from, name: stopped.name, reason: whyNot(answer) })
    );
    return false;
  }

  private loop(from: string, request: string): boolean {
    const match = matchLoop(this.session.loopsDefined, request);
    switch (match.kind) {
      case 'none':
        this.notice(t('session.remotes.loopNone', { who: from, request }));
        return false;
      case 'several':
        this.notice(
          t('session.remotes.loopSeveral', {
            who: from,
            request,
            count: match.loops.length,
            names: match.loops.map((loop) => loop.name).join('; ')
          })
        );
        return false;
      case 'one':
        return this.startNamed(from, match.loop);
      default: {
        const never: never = match;
        return never;
      }
    }
  }

  /** Starts `loop` as the palette does, saying who asked and what it took over from. */
  private startNamed(from: string, loop: Loop): boolean {
    const { kind, moving } = this.session.movement;
    const replacing = kind !== null && moving ? this.progressOf(kind).name : null;
    const answer = this.session.startLoop(loop);
    if (!('started' in answer)) {
      this.notice(
        t('session.remotes.loopRefused', { who: from, name: loop.name, reason: whyNot(answer) })
      );
      return false;
    }
    this.notice(
      replacing === null
        ? t('session.remotes.loopStarted', { who: from, name: loop.name })
        : t('session.remotes.loopReplaced', { who: from, name: loop.name, was: replacing })
    );
    return true;
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

/** Why a start or a resume did not walk, in words for the notice. */
function whyNot(answer: Exclude<MovementStart, { started: true }>): string {
  return 'refused' in answer
    ? answer.refused
    : t('session.remotes.regoTooFar', { stepCount: answer.confirm.steps });
}
