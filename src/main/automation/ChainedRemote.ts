/**
 * A `@do` or `@party` whose command would send an `@` command on to another
 * character (todo 20261103-0930-01). Somebody granted `@do` on this character
 * could make it telepath `@do` to a second one, which trusts this one and
 * obeys. The command is refused, said on screen and recorded in the safety
 * trace; what the player types and what the client's own automation sends
 * never pass through here. See `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import type { SafetyDecision } from '../../shared/automation';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { passesOnARemote } from '../../shared/remotes';

/** Where the refusal is said and written down. */
export interface ChainedRemoteEvents {
  notice?: NoticeSink;
  decided?(decision: SafetyDecision): void;
}

/** True, said and recorded, when `command` run for `from` would pass a remote on. */
export function refusedChain(
  from: string,
  command: string,
  events: ChainedRemoteEvents,
  decision: DecisionKind
): boolean {
  if (!passesOnARemote(command)) return false;
  events.notice?.(t('automation.remotes.refusedChained', { from, command }), decision);
  events.decided?.({
    at: Date.now(),
    action: 'remote',
    because: t('automation.remotes.whyChained', { from, command }),
    acted: false,
    refused: t('automation.remotes.chainedReason')
  });
  return true;
}
