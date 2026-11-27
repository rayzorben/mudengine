/**
 * Standing in the rank `automation.party.preferredRank` names, once after
 * joining a party (todo 863; fatavatar `42015d0`). The party list prints each
 * member's rank, so this character's own row says where it stands. `frontrank` and `backrank` go out
 * when that row says another rank; `mid` sends nothing, as MegaMUD sends
 * nothing for it. A row with no rank yet is unknown and sends nothing, and one
 * join gets one command, spent when the queue takes it. The answer is the
 * `You have moved to the … ranks of your group.` line, which moves the row.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { memberNamed, type CharacterState } from '../../shared/character';
import type { AutomationConfig, PartyRank } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { taken, type CommandQueue, type Intent } from './CommandQueue';
import { whyNotQueued } from './queueRefusals';

const RANK: DecisionKind = 'party-rank';

export interface AutoRankEvents {
  notice?: NoticeSink;
}

/** The command that moves this character to `rank`: the server's own `frontrank`, `midrank`, `backrank`. */
export function rankCommand(rank: PartyRank): string {
  return `${rank}rank`;
}

export class AutoRank {
  /** A command for this party went out, or the party is already where it should be. */
  private settled = false;
  /** The refusal said for this party, so a queue that stays closed is said once. */
  private told: string | null = null;

  constructor(
    private config: AutomationConfig,
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly events: AutoRankEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  reset(): void {
    this.settled = false;
    this.told = null;
  }

  onCharacter(state: CharacterState): void {
    const row = memberNamed(state, state.name);
    // No row, or an invitation still out: no party joined, so the next join starts afresh.
    if (row === undefined || row.invited) {
      this.reset();
      return;
    }
    const wanted = this.config.party.preferredRank;
    // Unknown is not different: the party list has not said where this character stands.
    if (this.settled || wanted === 'mid' || row.rank === null) return;
    if (row.rank === wanted) {
      this.settled = true;
      return;
    }
    const intent: Intent = {
      command: rankCommand(wanted),
      priority: 'movement',
      coalesceKey: 'party:rank',
      reason: t('automation.party.reasonRank', {
        listed: row.rank,
        wanted
      }),
      decision: RANK
    };
    const offered = this.queue.offer(intent);
    if (taken(offered)) {
      this.settled = true;
      return;
    }
    // Not spent: a master switch turned on later still moves the rank.
    const why = whyNotQueued(offered);
    if (this.told === why) return;
    this.told = why;
    this.events.notice?.(t('automation.party.rankRefused', { wanted, why }), RANK);
  }
}
