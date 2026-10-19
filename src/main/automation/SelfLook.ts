/**
 * `l <name>`, once on the way in (todo 20261019-0931-01): a look at this
 * character is the only place the realm says its gender, hair and eyes, which
 * the portrait is drawn from. Asked on the first state after entry that knows
 * the name (`st` gives it), in the probe band behind the entry batch, and only
 * while portraits are on and nothing has read the appearance yet. See
 * `mudengine-automation` › *A routine reacts to what happens*.
 */
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import type { CommandQueue } from './CommandQueue';

export const SELF_LOOK_KEY = 'probe:look-self';

export class SelfLook {
  /** Whether the look went, or was declined, since the character entered the realm. */
  private settled = false;
  /** Whether portraits being off has been said this session. */
  private saidOff = false;

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly portraits: () => boolean,
    private readonly notice: NoticeSink
  ) {}

  /** A state in the realm, with automation on. */
  onCharacter(state: CharacterState): void {
    if (this.settled || state.name === null || state.appearance !== null) return;
    if (!this.portraits()) {
      if (!this.saidOff) this.notice(t('automation.routines.selfLookOff'), 'look-at-self');
      this.saidOff = true;
      this.settled = true;
      return;
    }
    // A queue that is held or offline took nothing: asked again on the next state.
    const taken = this.queue.offer({
      command: `l ${state.name}`,
      priority: 'probe',
      coalesceKey: SELF_LOOK_KEY,
      reason: t('automation.routines.reasonSelfLook'),
      decision: 'look-at-self'
    });
    this.settled = taken === 'queued' || taken === 'joined';
  }

  /** Out of the realm: the next entry looks again, if nothing has read the appearance. */
  left(): void {
    this.settled = false;
  }

  reset(): void {
    this.settled = false;
    this.saidOff = false;
  }
}
