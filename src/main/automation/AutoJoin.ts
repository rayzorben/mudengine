/**
 * Joining a party when its leader invites this character, without waiting for
 * the `@join` that follows (captures/112: the invitation, `Swampfox telepaths:
 * @join`, `join Swampfox`). `automation.remotes.autoJoin`, todo 07.
 *
 * Gated as `@join` is (`judgeRemote`), so it lets in nobody `@join` would
 * refuse; never while already in a party, since what `join` does to one is
 * uncaptured. Every refusal is said. The `@join` usually arrives in the same
 * read, after this `join` went and before its answer, so `@join` asks
 * `joining` and no second `join` goes. `mudengine-automation` › remotes.
 */
import { isPrompt, type Block } from '../../shared/blocks';
import { inAParty, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { judgeRemote } from '../../shared/remotes';
import { t } from '../app/i18n';
import type { CommandQueue, Intent } from './CommandQueue';
import { evidenceAbout, unresolvedClauseOf } from './RemoteEvidence';

export interface AutoJoinEvents {
  notice?(message: string): void;
}

/** `join <leader>`, one per leader however it was asked for: an invitation and a `@join` are one join. */
export function joinIntent(leader: string, reason: string): Intent {
  return { command: `join ${leader}`, priority: 'user', coalesceKey: joinKey(leader), reason };
}

function joinKey(leader: string): string {
  return `remote:join:${leader.toLowerCase()}`;
}

export class AutoJoin {
  /** The leader a `join` went to, lower-cased, until the next prompt, which follows its answer. */
  private sentTo: string | null = null;

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: AutoJoinEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /**
   * Whether a `join` to `leader` is already on its way: waiting in the queue,
   * or sent and not yet answered. The queue is asked rather than remembered,
   * so a `join` the queue dropped (a hold, a disconnect) is not waited on.
   */
  joining(leader: string): boolean {
    const key = joinKey(leader);
    return this.sentTo === key || this.queue.queued((intent) => intent.coalesceKey === key);
  }

  reset(): void {
    this.sentTo = null;
  }

  onBlock(block: Block, state: CharacterState): void {
    if (isPrompt(block.type)) this.sentTo = null;
    if (block.type !== 'party-invited') return;
    const { enabled, remotes } = this.config;
    if (!enabled || !remotes.enabled || !remotes.autoJoin) return;
    // `leader` is somebody inviting this character; `player` is this character inviting somebody.
    const leader = block.groups['leader'];
    if (leader === undefined || this.joining(leader)) return;

    if (inAParty(state) || state.party.following !== null) {
      this.events.notice?.(t('automation.remotes.autoJoinInParty', { from: leader }));
      return;
    }
    const verdict = judgeRemote(leader, 'join', remotes, evidenceAbout(leader, state));
    if (!verdict.allowed) {
      this.events.notice?.(
        verdict.because === 'denied'
          ? t('automation.remotes.autoJoinDenied', { from: leader })
          : t('automation.remotes.autoJoinNotGranted', {
              from: leader,
              unresolvedClause: unresolvedClauseOf(verdict)
            })
      );
      return;
    }
    const key = joinKey(leader);
    this.queue.enqueue({
      ...joinIntent(leader, t('automation.remotes.reasonAutoJoin', { from: leader })),
      onSent: () => {
        this.sentTo = key;
      }
    });
  }
}
