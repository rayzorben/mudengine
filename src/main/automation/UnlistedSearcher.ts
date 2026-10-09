/**
 * Another player searching a room that did not list them: one bare Enter.
 *
 * `<Name> is searching the area.` is said only to the searcher's room, after
 * the search has broken their stealth (GreaterMUD `Player.TrySearch`), so a
 * name the occupants lack belongs to someone who sneaked in or was hiding,
 * and the reprint lists them. Asked once per name per arrival, so a realm
 * whose reprint still leaves them out is not asked on every search.
 */
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { Block } from '../../shared/blocks';
import { REREAD_ROOM } from '../../shared/commands';
import { playerKey } from '../../shared/players';
import type { CommandQueue } from './CommandQueue';

export class UnlistedSearcher {
  private room: CharacterState['room'] | null = null;
  /** The arrival `asked` belongs to: a new room asks afresh. */
  private arrival: number | null = null;
  private readonly asked = new Set<string>();

  constructor(private readonly queue: Pick<CommandQueue, 'enqueue'>) {}

  onCharacter(state: CharacterState): void {
    this.room = state.room;
    if (state.room.arrival === this.arrival) return;
    this.arrival = state.room.arrival;
    this.asked.clear();
  }

  onBlock(block: Block): void {
    if (block.type !== 'player-searches') return;
    const player = block.groups['player'];
    if (player === undefined || this.room === null) return;
    const key = playerKey(player);
    if (this.asked.has(key)) return;
    if (this.room.occupants.some((who) => playerKey(who.name) === key)) return;
    this.asked.add(key);
    const arrival = this.arrival;
    this.queue.enqueue({
      command: REREAD_ROOM,
      priority: 'probe',
      coalesceKey: 'probe:room-searcher',
      // A reprint of the next room is no answer about this one.
      stillWanted: () => this.arrival === arrival,
      reason: t('automation.routines.reasonSearcherUnlisted', { player })
    });
  }

  reset(): void {
    this.room = null;
    this.arrival = null;
    this.asked.clear();
  }
}
