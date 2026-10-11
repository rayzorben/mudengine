/**
 * The `@stats` answer sent again when it changes (todo 86): a level, a
 * training or a stat that moved changes who the leader should send at a trap
 * or a door. Only to a party member who asked before, so only a mudengine
 * client that reads it; dropped when they leave the party.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { inAParty, partyMembers, type CharacterState } from '../../shared/character';
import { playerKey } from '../../shared/players';
import { formatStats } from '../../shared/remotes';
import type { CommandQueue } from './CommandQueue';

export class SheetReports {
  /** Who was told, by key, with what they were last told. */
  private readonly told = new Map<string, { who: string; body: string }>();

  constructor(private readonly queue: Pick<CommandQueue, 'enqueue'>) {}

  /** `@stats` was answered with `body`: keep it so a change is sent on. */
  answered(who: string, body: string): void {
    this.told.set(playerKey(who), { who, body });
  }

  onCharacter(state: CharacterState): void {
    if (this.told.size === 0) return;
    const party = new Set(
      [...partyMembers(state), state.party.following ?? ''].map((name) => playerKey(name))
    );
    for (const [key, { who, body }] of [...this.told]) {
      if (!inAParty(state) || !party.has(key)) {
        this.told.delete(key);
        continue;
      }
      const now = formatStats(state.progress);
      if (now === null || now === body) continue;
      this.told.set(key, { who, body: now });
      this.queue.enqueue({
        command: `/${who} ${now}`,
        priority: 'user',
        coalesceKey: `remote:sheet:${key}`,
        reason: t('automation.remotes.reasonSheetChanged', { who })
      });
    }
  }

  reset(): void {
    this.told.clear();
  }
}
