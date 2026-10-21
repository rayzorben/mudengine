/**
 * A leader's question to each party member about what stops a room's spell
 * on the way (todo 20261021-1200-01): `@stoppers 690,691,1181,3609` to a
 * member whose `@version` named this client, answered `{yes: 690}` or
 * `{no}`; `@have <name>` per item, in the realm's order, to anyone else,
 * stopping at the first `{yes: 1}` (the captured shape). An answer is kept
 * until the member leaves the party or is handed a copy (`forget`); silence
 * past `tuning.remotes.replyMs` is `silent`, which is never read as carried.
 * `@wealth` is asked the same way for the member's purse. Composed by
 * `Remotes`, which sends and reads for it. `mudengine-automation` ›
 * `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { NoticeSink } from '../../shared/decisionSettings';
import { playerKey } from '../../shared/players';
import type { RemoteReply } from '../../shared/remotes';
import type { WayStopper } from '../world/navigation/stoppers';

export type StopperAnswer =
  | { kind: 'has'; item: number }
  | { kind: 'lacks' }
  /** No answer in time, the word refused, or the queue would not ask: not carried, as far as anyone knows. */
  | { kind: 'silent' };

export interface PartyStopperEvents {
  /** `@stoppers`, `@have` or `@wealth` to `who`; whether the queue took it. */
  ask(who: string, name: 'stoppers' | 'have' | 'wealth', argument?: string): boolean;
  /** Whether `who` said with `@version` that they run this client. */
  runsThisClient(who: string): boolean;
  notice?: NoticeSink;
}

interface Pending {
  who: string;
  question: WayStopper;
  /** Which of the question's items a `@have` is out for. */
  index: number;
  viaHave: boolean;
  at: number;
}

export class PartyStoppers {
  /** Each member's answer per spell, by `playerKey`. */
  private readonly answers = new Map<string, Map<number, StopperAnswer>>();
  private readonly pending = new Map<string, Pending>();
  /** `@wealth` out to a member, by key, since when. */
  private readonly wealthAsked = new Map<string, { who: string; at: number }>();
  /** A member's purse in copper, or null where they never answered. */
  private readonly purses = new Map<string, number | null>();

  constructor(
    private readonly events: PartyStopperEvents,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The members' answers for this spell, asking each who has not answered and
   * is not being asked. `asking` is who the caller still waits for.
   */
  settle(
    question: WayStopper,
    members: readonly string[]
  ): { asking: string[]; answers: Map<string, StopperAnswer> } {
    const asking: string[] = [];
    const answers = new Map<string, StopperAnswer>();
    for (const who of members) {
      const key = playerKey(who);
      const known = this.answers.get(key)?.get(question.spell);
      if (known !== undefined) {
        answers.set(who, known);
        continue;
      }
      if (this.pending.has(key)) {
        asking.push(who);
        continue;
      }
      const viaHave = !this.events.runsThisClient(who);
      if (this.send(who, question, 0, viaHave)) asking.push(who);
      else answers.set(who, this.record(who, question.spell, { kind: 'silent' }));
    }
    return { asking, answers };
  }

  /** `@wealth` to a member, once per answer; whether it went or is out. */
  askWealth(who: string): boolean {
    const key = playerKey(who);
    if (this.wealthAsked.has(key)) return true;
    if (!this.events.ask(who, 'wealth')) return false;
    this.wealthAsked.set(key, { who, at: this.now() });
    return true;
  }

  /** A member's purse in copper; null where they never answered; undefined while unasked or out. */
  purseOf(who: string): number | null | undefined {
    return this.purses.get(playerKey(who));
  }

  /** Forgets what a member answered, so the next `settle` asks again: they left, or were handed a copy. */
  forget(who: string): void {
    const key = playerKey(who);
    this.answers.delete(key);
    this.pending.delete(key);
    this.wealthAsked.delete(key);
    this.purses.delete(key);
  }

  /** A reply from `from`, read against the question out to them. Whether it was read. */
  heard(from: string, reply: RemoteReply): boolean {
    const key = playerKey(from);
    if (reply.kind === 'wealth') {
      if (!this.wealthAsked.has(key)) return false;
      this.wealthAsked.delete(key);
      this.purses.set(key, reply.copper);
      return true;
    }
    const out = this.pending.get(key);
    if (out === undefined) return false;
    const { question, index, viaHave } = out;
    switch (reply.kind) {
      case 'yes': {
        const item = viaHave ? question.items[index]?.id : reply.figure;
        const named = item !== undefined && question.items.some((each) => each.id === item);
        this.record(from, question.spell, named ? { kind: 'has', item } : { kind: 'silent' });
        return true;
      }
      case 'no':
        if (viaHave && index + 1 < question.items.length)
          this.send(from, question, index + 1, true);
        else this.record(from, question.spell, { kind: 'lacks' });
        return true;
      case 'refused':
        this.record(from, question.spell, { kind: 'silent' });
        return true;
      default:
        return false;
    }
  }

  /** Questions past `tuning.remotes.replyMs` are written off as silence, said. */
  sweep(now: number): void {
    const deadline = now - tuning().remotes.replyMs;
    for (const out of [...this.pending.values()]) {
      if (out.at > deadline) continue;
      this.events.notice?.(
        t('automation.stoppers.lapsed', { who: out.who, spell: out.question.name }),
        'party-stoppers'
      );
      this.record(out.who, out.question.spell, { kind: 'silent' });
    }
    for (const [key, out] of [...this.wealthAsked]) {
      if (out.at > deadline) continue;
      this.wealthAsked.delete(key);
      this.purses.set(key, null);
    }
  }

  reset(): void {
    this.answers.clear();
    this.pending.clear();
    this.wealthAsked.clear();
    this.purses.clear();
  }

  private send(who: string, question: WayStopper, index: number, viaHave: boolean): boolean {
    const taken = viaHave
      ? this.events.ask(who, 'have', question.items[index]!.name)
      : this.events.ask(who, 'stoppers', question.items.map((item) => item.id).join(','));
    if (taken) this.pending.set(playerKey(who), { who, question, index, viaHave, at: this.now() });
    return taken;
  }

  private record(who: string, spell: number, answer: StopperAnswer): StopperAnswer {
    const key = playerKey(who);
    this.pending.delete(key);
    const known = this.answers.get(key) ?? new Map<number, StopperAnswer>();
    known.set(spell, answer);
    this.answers.set(key, known);
    return answer;
  }
}
