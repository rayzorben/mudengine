/**
 * Nothing automated acts on a character lying mortally wounded. The server
 * refuses every command from `You drop to the ground!` until the character
 * is up (todo 20). Thirty hit points of it are survivable (`Misc.DeathHP` is
 * −30): bleeding costs one a tick, another player's `aid` stops it, and a
 * character no longer bleeding regains one a tick, so going quiet is what
 * leaves room for all three. One gate, read by the line path and by
 * the reconsider tick alike (todo 742), and said once per stretch on the
 * ground, because a client that silently stops automating looks exactly like
 * one that has crashed. See `mudengine-automation` › `parts/safety.md`.
 */
import { t } from '../app/i18n';
import type { Publisher } from './Publisher';
import type { SessionSink } from './SessionSink';
import type { CharacterState } from '../../shared/character';

export class Grounded {
  /**
   * Whether the last state this was asked about was on the ground, which is
   * also whether this stretch has been said. Cleared by the first state that
   * is not, so a second knockdown says it again: it is a fact about the
   * moment, not a lesson about the realm.
   */
  private said = false;

  /**
   * On the ground as of the last line or tick: what the clocks that keep their
   * own state read, since a character down is fed no new one (todo 755).
   */
  get down(): boolean {
    return this.said;
  }

  constructor(
    private readonly publisher: Pick<Publisher, 'noteSafety'>,
    private readonly sink: Pick<SessionSink, 'notice'>
  ) {}

  /**
   * True while the character is on the ground, and the caller stands down.
   * Said, and recorded beside every other refusal, on the first of a stretch.
   */
  standsDown(state: CharacterState): boolean {
    if (!state.mortallyWounded) {
      this.said = false;
      return false;
    }
    if (this.said) return true;
    this.said = true;
    this.sink.notice(t('session.safety.mortallyWounded'));
    this.publisher.noteSafety({
      at: Date.now(),
      action: 'stand down',
      because:
        state.vitals.hp === null
          ? t('session.safety.whyMortallyWoundedUnread')
          : t('session.safety.whyMortallyWounded', { hp: state.vitals.hp }),
      acted: true
    });
    return true;
  }
}
