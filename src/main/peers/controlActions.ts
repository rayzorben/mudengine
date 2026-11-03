/**
 * One remote control action run on the sharer's character (todo
 * 20261031-1156-01). A line, a move and rest go through the character's
 * command queue at the band a typed command uses, as `@do` does, so the
 * queue paces them and the master switch's `user` exemption is the player's
 * own. Stop, play and the two switches are the toolbar's own presses. A line
 * that would send an `@` command on to another character is refused, as a
 * `@do`'s is (`ChainedRemote`), and so is one that logs the character off or
 * deletes it (`logsOffOrDeletes`). Every answer is in the sharer's words.
 */
import { asCardCommand } from '../../shared/asking';
import { logsOffOrDeletes } from '../../shared/commands';
import type { MovementStart } from '../../shared/movement';
import type { ControlAction, ControlAnswer, ControlSwitch } from '../../shared/peerControl';
import { DIRECTION_COMMAND } from '../../shared/world';
import { t } from '../app/i18n';
import { refusedChain, type ChainedRemoteEvents } from '../automation/ChainedRemote';
import type { CommandQueue, QueueRefusal } from '../automation/CommandQueue';

/** The character as an action reaches it. */
export interface ControlledSession {
  readonly queue: Pick<CommandQueue, 'offer'>;
  /** Where a refused chain is said and written down. */
  readonly reports: ChainedRemoteEvents;
  /** The longest line a card may send (`tuning.queue.cardCommandMaxChars`). */
  readonly lineMax: number;
  stopMoving(by: string): void;
  /** Play, as the toolbar's: placed first, then the loop named or what was stopped. */
  play(loop: string | null, confirmed: number | null): Promise<MovementStart | null>;
  /** The toolbar's switch; the refusal in the client's words, or null. */
  setSwitch(name: ControlSwitch, on: boolean): string | null;
}

const DONE: ControlAnswer = { r: 'done' };
const refused = (why: string): ControlAnswer => ({ r: 'refused', why });

/** Why the queue sent nothing, one sentence per refusal. */
function notQueued(refusal: QueueRefusal): string {
  switch (refusal) {
    case 'held':
      return t('peers.control.queue.held');
    case 'offline':
      return t('peers.control.queue.offline');
    case 'switched-off':
      return t('peers.control.queue.switchedOff');
    case 'expired':
      return t('peers.control.queue.expired');
    case 'unavailable':
      return t('peers.control.queue.unavailable');
    default: {
      const never: never = refusal;
      return never;
    }
  }
}

/** A command proposed as though `by` typed it into this character's terminal. */
function typed(session: ControlledSession, command: string, by: string): ControlAnswer {
  const offered = session.queue.offer({
    command,
    priority: 'user',
    reason: t('peers.control.reason', { from: by }),
    decision: 'remote-control'
  });
  return offered === 'queued' || offered === 'joined' ? DONE : refused(notQueued(offered));
}

function played(answer: MovementStart | null): ControlAnswer {
  if (answer === null) return refused(t('app.session.notConnected'));
  if ('started' in answer) return DONE;
  if ('refused' in answer) return refused(answer.refused);
  return { r: 'confirm', name: answer.confirm.name, steps: answer.confirm.steps };
}

export async function runControl(
  session: ControlledSession,
  action: ControlAction,
  by: string
): Promise<ControlAnswer> {
  switch (action.a) {
    case 'line': {
      const line = asCardCommand(action.text, session.lineMax);
      if (line === null) return refused(t('peers.control.badLine', { max: session.lineMax }));
      if (logsOffOrDeletes(line)) return refused(t('peers.control.leaves', { text: line }));
      if (refusedChain(by, line, session.reports, 'remote-control')) {
        return refused(t('automation.remotes.chainedReason'));
      }
      return typed(session, line, by);
    }
    case 'move':
      return typed(session, DIRECTION_COMMAND[action.dir], by);
    case 'rest':
      return typed(session, 'rest', by);
    case 'stop':
      session.stopMoving(by);
      return DONE;
    case 'play':
      return played(await session.play(action.loop, action.confirmed));
    case 'switch': {
      const why = session.setSwitch(action.name, action.on);
      return why === null ? DONE : refused(why);
    }
    default: {
      const never: never = action;
      return never;
    }
  }
}
