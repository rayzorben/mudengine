/**
 * `stat a`, asked whenever nothing the client holds was computed from what
 * the character wears, is and has up now (todo 45): on the way in, once `st`
 * and `i` have said what that is, and after a level, a train, a change of worn
 * gear or of the effects up. Only out of a fight and once the change has held
 * `tuning.statAll.settleMs`, and once per basis a session: the answer is kept
 * per basis (`keepSheet`), so a set of blessings that comes round again needs
 * no second ask. See `mudengine-automation` › *`stat a` once per basis*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import { ownSheetFor, statedBasis } from '../../shared/stated';
import type { CommandQueue } from './CommandQueue';

/** `StatCommand`'s shortest spelling of the `all` branch (`StatCommand.cs:27`). */
export const STAT_ALL = 'stat a';

export class StatAllAsk {
  /** Each basis a `stat a` went out for this session, so none is asked twice. */
  private readonly asked = new Set<string>();
  /** The basis waiting to settle, and since when. */
  private pending: { gear: string; since: number } | null = null;
  /** Asks sent since the last sheet came back. */
  private unanswered = 0;
  /** When the last ask went out. */
  private lastSentAt = 0;
  /** The realm answered `tuning.statAll.unansweredAsks` asks with no sheet: not asked again. */
  private givenUp = false;

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly notice: (message: string) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  onCharacter(state: CharacterState): void {
    if (this.givenUp || state.phase !== 'in-game') return;
    // The basis is not known until `st` and `i` have answered; asking before is asking twice.
    if (state.progress.level === null || state.inventory.listedAt === null) return;
    if (this.unansweredTooOften()) return;
    if (ownSheetFor(state) !== null) {
      this.pending = null;
      return;
    }
    const { gear } = statedBasis(state);
    if (this.asked.has(gear)) return;
    const now = this.now();
    if (this.pending?.gear !== gear) this.pending = { gear, since: now };
    if (fightIsRunning(state) || now - this.pending.since < tuning().statAll.settleMs) return;
    this.queue.offer({
      command: STAT_ALL,
      priority: 'probe',
      coalesceKey: `probe:${STAT_ALL}`,
      reason: t('automation.routines.reasonStatAll'),
      onSent: () => this.sent(gear)
    });
  }

  onBlock(block: Block): void {
    if (block.type === 'user-stat-all') this.unanswered = 0;
  }

  reset(): void {
    this.asked.clear();
    this.pending = null;
    this.unanswered = 0;
    this.lastSentAt = 0;
    this.givenUp = false;
  }

  /*
   * MajorMUD's answer to `stat a` is unmeasured (bearfather is read-only
   * before login): a realm that prints `st` for it, or nothing, never resets
   * the count, and is not asked again this session. Decided once the last ask
   * has had `settleMs` to be answered, so it is said without waiting for
   * another change.
   */
  private unansweredTooOften(): boolean {
    const { unansweredAsks: limit, settleMs } = tuning().statAll;
    if (this.unanswered < limit || this.now() - this.lastSentAt < settleMs) return false;
    this.givenUp = true;
    this.notice(t('automation.routines.statAllGaveUp', { command: STAT_ALL, count: limit }));
    return true;
  }

  private sent(gear: string): void {
    this.asked.add(gear);
    this.pending = null;
    this.unanswered += 1;
    this.lastSentAt = this.now();
  }
}
