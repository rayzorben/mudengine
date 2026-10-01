/**
 * A talk-box line that stands for several commands (todo 04), parsed again
 * here rather than trusted off the wire. Each goes into the queue at the
 * player's own band and out through `send` when its turn comes, one prompt
 * at a time: written at once, fifteen commands fill the realm's queue and the
 * automation behind them is told to slow down (`Intent.typed`).
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue } from '../automation/CommandQueue';
import { macroLength, parseMacro } from '../../shared/macro';

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
}

export function queueMacro(line: string, parts: MacroParts): void {
  const steps = parseMacro(line);
  if (steps === null) {
    parts.send(`${line}\r`);
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
        reason: t('session.macro.reason', { line })
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
