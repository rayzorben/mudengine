/**
 * Drawing cash at a vault the character stands in: `bank` first, because the
 * record may be stale and the server answers a withdrawal over the balance
 * with silence (`WithdrawCommand`); then `withdraw` what is wanted, never more
 * than the vault states; and only a `user-withdraws` of that amount is the
 * vault paying, so a `withdraw` the player typed is not taken for it. Out of
 * `Supplies`, so a supply errand and a gear trip draw cash one way. The owner
 * walks there and says what each ending means. See `mudengine-automation` ›
 * *The pack is kept stocked*.
 */
import type { CommandQueue } from './CommandQueue';
import type { Block } from '../../shared/blocks';
import { balanceOf, type CharacterState } from '../../shared/character';

/** The vault, as the balance names it. */
export interface Vault {
  shop: number;
  name: string;
}

export interface WithdrawalAsk {
  vault: Vault;
  /** Under this on deposit, the vault will not do. */
  need: number;
  /** What to draw where the vault holds it; it never draws more than it states. */
  wanted: number;
  /** The coalescing keys start with it, so two owners never join. */
  key: string;
  /** Why each command is sent, as the trace says it. */
  reasons: { balance: string; withdraw(amount: number): string };
  /** How long `bank` and then `withdraw` each have to be answered. */
  answerMs: number;
  expiresMs: number;
}

export type WithdrawalEnd =
  | { kind: 'paid'; amount: number }
  /** The vault holds less than `need`. */
  | { kind: 'short'; held: number }
  /** No balance came back, or the withdrawal was not paid. */
  | { kind: 'silent'; stage: WithdrawalStage };

export type WithdrawalStage = 'balance' | 'withdrawing';

export interface WithdrawalEvents {
  ended(end: WithdrawalEnd): void;
}

export class Withdrawal {
  private asked: {
    ask: WithdrawalAsk;
    stage: WithdrawalStage;
    at: number;
    amount: number | null;
  } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: CommandQueue,
    private readonly events: WithdrawalEvents,
    private readonly now: () => number = () => Date.now()
  ) {}

  get stage(): WithdrawalStage | null {
    return this.asked?.stage ?? null;
  }

  /** Asks the balance; the owner calls it standing in the vault, only while no stage is set. */
  start(ask: WithdrawalAsk): void {
    this.asked = { ask, stage: 'balance', at: this.now(), amount: null };
    this.queue.enqueue({
      command: 'bank',
      priority: 'probe',
      coalesceKey: `${ask.key}:bank`,
      expiresAt: this.now() + ask.expiresMs,
      reason: ask.reasons.balance
    });
    this.arm();
  }

  /** Put down without an ending: what it still has queued is taken back. */
  cancel(): void {
    this.clear();
    const asked = this.asked;
    this.asked = null;
    if (asked === null) return;
    const ours = new Set([`${asked.ask.key}:bank`, `${asked.ask.key}:withdraw`]);
    this.queue.cancel((intent) => ours.has(intent.coalesceKey ?? ''));
  }

  /** The balance `bank` stated, newer than the ask: draw on it, or end short. */
  onCharacter(state: CharacterState): void {
    const asked = this.asked;
    if (asked === null || asked.stage !== 'balance') return;
    const held = balanceOf({ id: asked.ask.vault.shop, name: asked.ask.vault.name }, state.banks);
    if (held === null || held.at < asked.at) return;
    if (held.copper < asked.ask.need || held.copper <= 0) {
      this.end({ kind: 'short', held: held.copper });
      return;
    }
    const amount = Math.min(held.copper, asked.ask.wanted);
    asked.stage = 'withdrawing';
    asked.amount = amount;
    this.queue.enqueue({
      command: `withdraw ${amount}`,
      priority: 'probe',
      coalesceKey: `${asked.ask.key}:withdraw`,
      expiresAt: this.now() + asked.ask.expiresMs,
      reason: asked.ask.reasons.withdraw(amount)
    });
    this.arm();
  }

  onBlock(block: Block): void {
    const asked = this.asked;
    if (asked?.stage !== 'withdrawing' || block.type !== 'user-withdraws') return;
    if (Number(block.groups['amount']) !== asked.amount) return;
    this.end({ kind: 'paid', amount: asked.amount });
  }

  private arm(): void {
    this.clear();
    const asked = this.asked;
    if (asked === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.asked === asked) this.end({ kind: 'silent', stage: asked.stage });
    }, asked.ask.answerMs);
    this.timer.unref?.();
  }

  private end(end: WithdrawalEnd): void {
    this.clear();
    this.asked = null;
    this.events.ended(end);
  }

  private clear(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
