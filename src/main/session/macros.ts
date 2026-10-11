/**
 * A talk-box line that stands for several commands (todo 04), parsed again
 * here rather than trusted off the wire. Each goes into the queue at the
 * player's own band and out through `send` when its turn comes, one prompt
 * at a time: written at once, fifteen commands fill the realm's queue and the
 * automation behind them is told to slow down (`Intent.typed`). A client
 * command or a `{mob}` step is worked out at its turn (todo 83), since the
 * steps before it may have moved the character.
 */
import type { CharacterState } from '../../shared/character';
import { asTyped, clientCommandOf, stepsOf } from '../../shared/clientCommands';
import { fillMob, macroLength, placeholdersIn, unknownPlaceholder } from '../../shared/macro';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue, Intent } from '../automation/CommandQueue';
import { interpolate } from '../automation/RuleEngine';
import { clientCommandWords } from './clientCommands';

export interface MacroParts {
  /** A line that is not a macro goes out as typed. */
  send(data: string): void;
  queue: Pick<CommandQueue, 'holding' | 'enqueue' | 'cancel'>;
  connected(): boolean;
  notice(message: string): void;
  /** The queue moved: the window is told. */
  published(): void;
  /** A number no earlier line of this session used, for the line's coalesce keys. */
  batch(): number;
  /** The character as it is now, read at each late step's turn. */
  state(): CharacterState;
  /** The monster auto-combat would open on (`AutoCombat.pick`), for `{mob}`. */
  mob(state: CharacterState): string | null;
}

export function queueMacro(line: string, parts: MacroParts): void {
  const steps = stepsOf(line);
  if (steps === null) {
    parts.send(`${asTyped(line) ?? line}\r`);
    return;
  }
  const unknown = steps.map((step) => unknownPlaceholder(step.command)).find(Boolean) ?? null;
  if (unknown !== null) {
    parts.notice(t('session.macro.unknownPlaceholder', { name: `{${unknown}}` }));
    return;
  }
  const count = macroLength(steps);
  const limit = tuning().session.macroCommands;
  if (count > limit) {
    parts.notice(t('session.macro.tooMany', { count, limit }));
    return;
  }
  const holding = parts.queue.holding;
  if (holding !== null || !parts.connected()) {
    parts.notice(
      holding !== null ? t('session.macro.held', { reason: holding }) : t('session.macro.offline')
    );
    return;
  }
  const batch = `macro:${parts.batch()}:`;
  // Set by a `{mob}` step with nothing to attack: the rest of the line drops.
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  let n = 0;
  for (const step of steps) {
    for (let i = 0; i < step.times; i += 1) {
      n += 1;
      const taken = parts.queue.enqueue({
        command: step.command,
        priority: 'user',
        typed: true,
        // Unique per command: a second `s` is a different move.
        coalesceKey: `${batch}${n}`,
        reason: t('session.macro.reason', { line }),
        stillWanted: () => !stopped,
        ...lateWords(step.command, parts, stop)
      });
      if (!taken) {
        /*
         * The line's own earlier command can close the queue: a `train
         * stats` goes out inside `enqueue` and holds it. What is still
         * waiting of the line goes too; what went out has gone.
         */
        parts.queue.cancel((intent) => intent.coalesceKey?.startsWith(batch) === true);
        const reason = parts.queue.holding;
        parts.notice(
          reason !== null
            ? t('session.macro.restHeld', { command: step.command, reason })
            : t('session.macro.restRefused', { command: step.command })
        );
        parts.published();
        return;
      }
    }
  }
  parts.published();
}

/**
 * How a step's words are worked out at its turn, or nothing for a step sent
 * as written. A client command with nothing to do drops alone; a `{mob}` with
 * nothing to attack, or a guard field not read yet, stops the line, because
 * what follows it was written for what that step does.
 */
function lateWords(command: string, parts: MacroParts, stop: () => void): Pick<Intent, 'resolve'> {
  const client = clientCommandOf(command);
  if (client !== null) {
    return { resolve: () => clientCommandWords(client, parts.state(), parts.notice) };
  }
  const names = placeholdersIn(command);
  if (names.length === 0) return {};
  const halt = (message: string): string[] => {
    stop();
    parts.notice(message);
    return [];
  };
  return {
    resolve: () => {
      const state = parts.state();
      let filled = command;
      if (names.includes('mob')) {
        const mob = parts.mob(state);
        if (mob === null) return halt(t('session.macro.noMob', { command }));
        filled = fillMob(command, mob);
      }
      // A guard field is spelled as a rule spells it; an unread one stays braced.
      filled = interpolate(filled, null, state);
      const unread = placeholdersIn(filled)[0];
      if (unread !== undefined) {
        return halt(t('session.macro.noValue', { command, name: `{${unread}}` }));
      }
      return [filled];
    }
  };
}

/** What the talk box's Drop, or a death, took out of the queue. */
export function droppedNotice(count: number, died: boolean): string {
  if (died) {
    return count === 1
      ? t('session.macro.droppedDied.one', { count })
      : t('session.macro.droppedDied.many', { count });
  }
  return count === 1
    ? t('session.macro.dropped.one', { count })
    : t('session.macro.dropped.many', { count });
}
