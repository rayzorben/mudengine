/**
 * `@stop` and `@rego` (todo 15): the player's own Stop and Play on another
 * player's word. A stop is `stopMoving` with the sender named as the reason,
 * so the card and the notices say who; a resume is Play from wherever the
 * character now stands, with the distance it measures taken as agreed, since
 * the sender's word is the agreement Play would ask the player for. Only what
 * a `@stop` stopped is resumed, and only while it is still stopped for that
 * reason: a walk started since, or another stop, replaces it. See
 * `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { personStop } from '../automation/personStop';
import type { RemoteEvents, StoppedByRemote } from '../automation/Remotes';
import type { LoopProgress } from '../../shared/loops';
import type { Movement, MovementKind, MovementStart } from '../../shared/movement';
import type { WalkProgress } from '../../shared/walk';

/** The session's own doors a remote stop and resume go through. */
export interface RemoteMovesSession {
  readonly movement: Movement;
  readonly walker: { readonly progress: WalkProgress };
  readonly loops: { readonly progress: LoopProgress };
  stopMoving(by: string | null): void;
  startMoving(loopName: string | null, confirmed: number | null): MovementStart;
}

export class RemoteMoves {
  /** Who sent the last `@stop` that stopped something. */
  private stoppedBy: string | null = null;

  constructor(
    private readonly session: RemoteMovesSession,
    private readonly notice: (message: string) => void
  ) {}

  /** What `Remotes` asks: `@status`, `@stop` and `@rego`. */
  readonly events: Required<Pick<RemoteEvents, 'progress' | 'stopMoving' | 'resumeMoving'>> = {
    progress: () => ({
      walk: this.session.walker.progress,
      loop: this.session.loops.progress,
      stopped: this.waiting()
    }),
    stopMoving: (from) => this.stop(from),
    resumeMoving: (from) => this.resume(from)
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
    const reason =
      'refused' in answer
        ? answer.refused
        : t('session.remotes.regoTooFar', { stepCount: answer.confirm.steps });
    this.notice(t('session.remotes.regoRefused', { who: from, name: stopped.name, reason }));
    return false;
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
