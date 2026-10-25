/**
 * A fare's cash drawn before the walk (todo 20261024-0804-01): the server takes
 * a ship's passage or a toll from the purse (`TextBlockPart.cs` `price`), so
 * a way the purse is short for walks first to the bank nearest the room the
 * fare is paid in that holds the shortfall by the character's record, draws it
 * (`Withdrawal`, `bank` first), and asks for the walk again (`retry`). A walk
 * the player answered the fare for comes through here only after that answer
 * (`Travel.fareUnpaid`). Every ending is said; a bank short or silent, or no
 * bank holding it, refuses the walk naming the shortfall.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { walkLeg, type LegWalker } from '../automation/errandLeg';
import { Withdrawal, type WithdrawalEnd } from '../automation/Withdrawal';
import type { CommandQueue } from '../automation/CommandQueue';
import type { Block } from '../../shared/blocks';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import { coinWords, roomAddress, roomId, type CashPlace, type RoomId } from '../../shared/world';

export interface FareCashParts extends LegWalker {
  queue: Pick<CommandQueue, 'enqueue' | 'cancel'>;
  /** The vaults holding `need` by the record, best first for a stop on the way to `then`. */
  cashFrom(need: number, then: RoomId | null): CashPlace[];
  walking(): boolean;
  moveInFlight(): boolean;
  notice: NoticeSink;
}

/** What `start` decided: the draw has the character, or the walk is refused (already said). */
export type FareCashStart = { kind: 'held' } | { kind: 'refused'; why: string };

interface Draw {
  bank: CashPlace;
  room: RoomId;
  short: number;
  legs: number;
  /** At the vault, with `bank` or `withdraw` asked. */
  drawing: boolean;
  /** Asks for the walk again once the purse holds the fare. */
  retry(): void;
}

const DECISION = 'walk-fare';

export class FareCash {
  private draw: Draw | null = null;
  /** The last ending said, for a `start` that ended inside itself. */
  private said = '';
  private readonly withdrawal: Withdrawal;

  constructor(
    private readonly parts: FareCashParts,
    now: () => number = () => Date.now()
  ) {
    this.withdrawal = new Withdrawal(parts.queue, { ended: (end) => this.drew(end) }, now);
  }

  get busy(): boolean {
    return this.draw !== null;
  }

  /** Put down without an ending: a new walk, a death, leaving the realm. */
  reset(): void {
    this.withdrawal.cancel();
    this.draw = null;
  }

  /** `short` copper drawn before the fare paid in `at`; `fare` the way's whole fare, for the words. */
  start(
    short: number,
    fare: number,
    at: RoomId | null,
    state: CharacterState,
    retry: () => void
  ): FareCashStart {
    this.reset();
    const words = { fare: coinWords(fare), short: coinWords(short) };
    const bank = this.parts.cashFrom(short, at)[0];
    if (bank === undefined) {
      this.end(t('session.walk.fareCash.noBank', words));
      return { kind: 'refused', why: this.said };
    }
    const room = roomId(bank.map, bank.room);
    this.draw = { bank, room, short, legs: 0, drawing: false, retry };
    this.parts.notice(t('session.walk.fareCash.going', { ...words, bank: bank.name }), DECISION);
    this.step(state);
    return this.busy ? { kind: 'held' } : { kind: 'refused', why: this.said };
  }

  onBlock(block: Block): void {
    if (this.draw?.drawing === true) this.withdrawal.onBlock(block);
  }

  /** The leg to the vault, walked again after a fight; at the vault, the draw. */
  onCharacter(state: CharacterState): void {
    const draw = this.draw;
    if (draw === null) return;
    if (draw.drawing) this.withdrawal.onCharacter(state);
    else if (!this.parts.walking()) this.step(state);
  }

  /** Standing at the vault: the draw; else the next leg, unless something else has the character. */
  private step(state: CharacterState): void {
    const draw = this.draw;
    if (draw === null) return;
    if (this.parts.moveInFlight() || fightIsRunning(state)) return;
    if (roomAddress(state.room) === draw.room) {
      draw.drawing = true;
      this.withdrawal.start({
        vault: { shop: draw.bank.shop, name: draw.bank.name },
        need: draw.short,
        wanted: draw.short,
        key: 'fare',
        reasons: {
          balance: t('session.walk.fareCash.reasonBalance', { bank: draw.bank.name }),
          withdraw: (amount) =>
            t('session.walk.fareCash.reasonWithdraw', { amount: coinWords(amount) })
        },
        answerMs: tuning().banking.fareVaultMs,
        expiresMs: tuning().banking.expiresMs,
        decision: DECISION
      });
      return;
    }
    // A fight ends a leg and the next is planned from where it left the character, up to `fareLegs`.
    draw.legs += 1;
    const { fareLegs } = tuning().banking;
    const refused = walkLeg(this.parts, draw.room, draw.bank.roomName, draw.legs, fareLegs);
    if (refused === null) return;
    this.end(
      'ends' in refused
        ? refused.ends
        : t('session.walk.fareCash.notReached', { bank: draw.bank.name, why: refused.notReached })
    );
  }

  private drew(end: WithdrawalEnd): void {
    const draw = this.draw;
    if (draw === null) return;
    const bank = draw.bank.name;
    switch (end.kind) {
      case 'paid':
        this.draw = null;
        this.parts.notice(
          t('session.walk.fareCash.drew', { amount: coinWords(end.amount), bank }),
          DECISION
        );
        draw.retry();
        return;
      case 'short':
        this.end(
          t('session.walk.fareCash.bankShort', {
            bank,
            held: coinWords(end.held),
            short: coinWords(draw.short)
          })
        );
        return;
      case 'silent':
        this.end(t('session.walk.fareCash.bankSilent', { bank }));
        return;
      default: {
        const never: never = end;
        return never;
      }
    }
  }

  private end(why: string): void {
    this.reset();
    this.said = why;
    this.parts.notice(why, DECISION);
  }
}
