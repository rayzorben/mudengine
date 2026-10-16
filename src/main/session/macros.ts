/**
 * A macro's commands, queued (todo 04): each goes into the queue at the
 * player's own band and out through `send` when its turn comes, one prompt at
 * a time: written at once, fifteen commands fill the realm's queue and the
 * automation behind them is told to slow down (`Intent.typed`). A client
 * command or a value (`{mob}`) is worked out at its turn (todo 83), since the
 * steps before it may have moved the character. `MacroRunner` decides which
 * steps go and when; this is how one goes, and how a refusal is said.
 */
import type { CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import {
  MACRO_PLACEHOLDERS,
  fillValue,
  placeholdersIn,
  type MacroPlaceholder
} from '../../shared/macro';
import type { MacroFault, MacroStep } from '../../shared/macroSteps';
import { t } from '../app/i18n';
import type { CommandQueue, Intent } from '../automation/CommandQueue';
import { interpolate } from '../automation/RuleEngine';
import type { Aliases } from '../../shared/aliases';
import { clientCommandWords } from './clientCommands';

export interface MacroParts {
  /** A line that is not a macro goes out as typed. */
  send(data: string): void;
  queue: Pick<CommandQueue, 'holding' | 'enqueue' | 'cancel'>;
  connected(): boolean;
  notice: NoticeSink;
  /** The queue moved: the window is told. */
  published(): void;
  /** The character as it is now, read at each late step's turn. */
  state(): CharacterState;
  /** The monster auto-combat would open on (`AutoCombat.pick`), for `{mob}`. */
  mob(state: CharacterState): string | null;
  /** The character's aliases, and the most a `get all` takes, as the file states them now. */
  automation(): { aliases: Aliases; remotes: { maxGets: number } };
}

/** One macro's run as its queued commands see it. */
export interface MacroBatch {
  /** The line it came from, for the queue's reason. */
  readonly line: string;
  /** Every command's coalesce key starts with it. */
  readonly key: string;
  /** A number no earlier command of this run used. */
  next(): number;
  /** Whether the rest has been dropped. */
  stopped(): boolean;
  /** Drops the rest: what follows was written for what the stopping step did. */
  stop(): void;
  /** A macro value now, or null where the client does not know it. */
  value(name: MacroPlaceholder, state: CharacterState): string | null;
}

/** A step that goes into the queue as commands. */
export type QueuedStep = Extract<MacroStep, { kind: 'send' | 'client' }>;

/** One step's commands into the queue. False, with the rest of the run cancelled and said, where it refused. */
export function queueStep(step: QueuedStep, batch: MacroBatch, parts: MacroParts): boolean {
  const times = step.kind === 'send' ? step.times : 1;
  const command = step.kind === 'send' ? step.command : step.words;
  for (let i = 0; i < times; i += 1) {
    const taken = parts.queue.enqueue({
      command,
      priority: 'user',
      typed: true,
      // Unique per command: a second `s` is a different move.
      coalesceKey: `${batch.key}${batch.next()}`,
      reason: t('session.macro.reason', { line: batch.line }),
      stillWanted: () => !batch.stopped(),
      ...lateWords(step, batch, parts)
    });
    if (!taken) {
      refused(command, batch, parts);
      return false;
    }
  }
  return true;
}

/** Drops what is still waiting of one run: its steps refuse, its queued commands go. */
export function cancelRun(batch: MacroBatch, queue: Pick<CommandQueue, 'cancel'>): void {
  batch.stop();
  queue.cancel((intent) => intent.coalesceKey?.startsWith(batch.key) === true);
}

/**
 * The line's own earlier command can close the queue: a `train stats` goes
 * out inside `enqueue` and holds it. What is still waiting of the line goes
 * too; what went out has gone.
 */
export function refused(command: string, batch: MacroBatch, parts: MacroParts): void {
  cancelRun(batch, parts.queue);
  const reason = parts.queue.holding;
  parts.notice(
    reason !== null
      ? t('session.macro.restHeld', { command, reason })
      : t('session.macro.restRefused', { command })
  );
  parts.published();
}

/**
 * How a step's words are worked out at its turn, or nothing for a step sent
 * as written. A client command with nothing to do drops alone; a value the
 * client does not know (no monster to attack, no leader) stops the line,
 * because what follows it was written for what that step does.
 */
function lateWords(
  step: QueuedStep,
  batch: MacroBatch,
  parts: MacroParts
): Pick<Intent, 'resolve'> {
  if (step.kind === 'client') {
    return {
      resolve: () =>
        clientCommandWords(
          step.command,
          parts.state(),
          parts.automation().remotes.maxGets,
          parts.notice
        )
    };
  }
  const { command, fills } = step;
  if (fills.length === 0) return {};
  const halt = (message: string): string[] => {
    batch.stop();
    parts.notice(message);
    return [];
  };
  return {
    resolve: () => {
      const state = parts.state();
      let filled = command;
      for (const name of MACRO_PLACEHOLDERS) {
        if (!fills.includes(name)) continue;
        const value = batch.value(name, state);
        if (value === null) {
          return halt(
            name === 'mob'
              ? t('session.macro.noMob', { command })
              : t('session.macro.noValue', { command, name: `{${name}}` })
          );
        }
        filled = fillValue(filled, name, value);
      }
      // A guard field is spelled as a rule spells it; an unread one stays braced.
      filled = interpolate(filled, null, state);
      const unread = placeholdersIn(filled).find((name) => fills.includes(name));
      if (unread !== undefined) {
        return halt(t('session.macro.noValue', { command, name: `{${unread}}` }));
      }
      return [filled];
    }
  };
}

/** Why a macro is not run, in words. */
export function macroFaultText(fault: MacroFault): string {
  switch (fault.kind) {
    case 'inside':
      return t('session.macro.inside', { name: `{${fault.name}}` });
    case 'noRoom':
      return t('session.macro.noRoom');
    case 'missing':
      return t('session.macro.missing', { name: `{${fault.name}}` });
    case 'loops':
      return t('session.macro.loops', { chain: fault.chain.join(' → ') });
    case 'tooMany':
      return t('session.macro.tooMany', { limit: fault.limit });
    default: {
      const never: never = fault;
      return never;
    }
  }
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
