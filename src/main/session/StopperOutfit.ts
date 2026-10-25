/**
 * Everyone walking a way carries what stops its room spells before the walk
 * starts (todo 20261021-1200-01): the Silver River took Rayzor and his
 * follower eight ticks apart. Before a route or a lap the leader asks each
 * joined member (`PartyStoppers`); a member with none is bought one with the
 * leader's own copy where the purse and the banks cover it (`Supplies`) and
 * handed it at the counter; else the member is asked their wealth and told
 * `@do buy <item>` there, and asked again. Anyone the leader cannot settle,
 * a member silent or short, refuses the walk naming who and what (the
 * user, 2026-10-21): never walk on. One spell at a time, then the walk is
 * asked for again (`retry`). `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { PartyStoppers } from '../automation/PartyStoppers';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import { partyMembers, packRows, type CharacterState } from '../../shared/character';
import { chargedInCopper, coveredBy } from '../../shared/coins';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { BOUGHT_ROW, type SupplyItem } from '../../shared/packConfig';
import { playerKey } from '../../shared/players';
import { carriedCount } from '../../shared/supplies';
import { coinWords, roomAddress, type RoomId } from '../../shared/world';
import { stopperHeld, type WayStopper } from '../world/navigation/stoppers';
import type { StopperCounter } from './RoomHazards';

/** What `consider` decided: the walk may go, this has the character, or the walk is refused. */
export type OutfitVerdict =
  { kind: 'go' } | { kind: 'held'; said: string } | { kind: 'refused'; why: string };

export interface StopperOutfitParts {
  stoppers: Pick<PartyStoppers, 'settle' | 'askWealth' | 'purseOf' | 'forget'>;
  /** The nearest counter selling any of these items from where the character stands, or null. */
  counterFor(items: readonly number[]): StopperCounter | null;
  /** What one costs at that counter in copper before charm; null where unsaid. */
  priceAt(name: string, room: RoomId): number | null;
  /** A supply errand for the row; its refusal, or null once walking (`Supplies.fetch`). */
  fetch(row: SupplyItem, state: CharacterState): string | null;
  fetching(): boolean;
  /** `give <item> to <who>`; whether the queue took it. */
  give(item: string, who: string): boolean;
  /** `@do <command>` to a member; whether the queue took it. */
  tellDo(who: string, command: string): boolean;
  /** Walks the character to the counter as an errand's leg; a refusal, or null. */
  walkTo(room: RoomId): string | null;
  walking(): boolean;
  notice: NoticeSink;
  decided(decision: SafetyDecision): void;
}

interface Job {
  /** The spells still to settle, the first being worked. */
  way: WayStopper[];
  /** Whether this character is outfitted too (a lap; a route's own copy is the plan's). */
  self: boolean;
  /** Whether this took the character at all; only then is the walk asked for again. */
  held: boolean;
  /** Asks for the walk again once everyone carries one. */
  retry(): void;
}

interface Buying {
  stopper: WayStopper;
  counter: StopperCounter;
  /** Whether one of the copies is this character's own. */
  self: boolean;
  /** The members to hand a copy to, in order. */
  lacking: string[];
  /** The pack's copies once bought: what it held plus one each. */
  copies: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'asking'; job: Job; said: number | null }
  | { kind: 'buying'; job: Job; buy: Buying }
  | { kind: 'handing'; job: Job; buy: Buying; given: string | null; since: number }
  | { kind: 'purses'; job: Job; buy: Buying; price: number }
  | {
      kind: 'member-buying';
      job: Job;
      buy: Buying;
      who: string;
      rest: string[];
      told: number | null;
      since: number;
    }
  | { kind: 'confirming'; job: Job; stopper: WayStopper };

const ACTION = 'outfit party';
const KIND: DecisionKind = 'party-stoppers';

export class StopperOutfit {
  private phase: Phase = { kind: 'idle' };

  constructor(
    private readonly parts: StopperOutfitParts,
    private readonly now: () => number = Date.now
  ) {}

  get busy(): boolean {
    return this.phase.kind !== 'idle';
  }

  /**
   * Before a walk over `way`: `go` where everyone carries what it wants, or
   * nothing is wanted; `held` where this takes the character, said, and
   * calls `retry` once everyone does; `refused`, said and traced, with
   * `retry` never called. `self` outfits this character as well.
   */
  consider(
    way: readonly WayStopper[],
    state: CharacterState,
    self: boolean,
    retry: () => void
  ): OutfitVerdict {
    if (way.length === 0) return { kind: 'go' };
    if (this.busy) return { kind: 'refused', why: t('automation.stoppers.busy') };
    const job: Job = { way: [...way], self, held: false, retry };
    const said = this.decide(job, state);
    if (said === null) return { kind: 'go' };
    return this.busy ? { kind: 'held', said } : { kind: 'refused', why: said };
  }

  onCharacter(state: CharacterState): void {
    if (state.phase !== 'in-game') {
      this.abandon(t('automation.stoppers.abandonedLeftRealm'));
      return;
    }
    const phase = this.phase;
    switch (phase.kind) {
      case 'idle':
        return;
      case 'asking':
      case 'confirming':
        this.decide(phase.job, state);
        return;
      case 'buying':
        this.bought(phase.job, phase.buy, state);
        return;
      case 'handing':
        this.hand(phase, state);
        return;
      case 'purses':
        this.purses(phase, state);
        return;
      case 'member-buying':
        this.memberBuys(phase, state);
        return;
      default: {
        const never: never = phase;
        return never;
      }
    }
  }

  /** `You give <item> to <who>.` confirms a hand-over. */
  onBlock(block: Block): void {
    const phase = this.phase;
    if (phase.kind !== 'handing' || phase.given === null || block.type !== 'user-gives') return;
    const target = block.groups['target'];
    if (target === undefined || playerKey(target) !== playerKey(phase.given)) return;
    this.parts.stoppers.forget(phase.given);
    this.parts.notice(
      t('automation.stoppers.handed', { who: phase.given, item: phase.buy.counter.item.name }),
      KIND
    );
    const lacking = phase.buy.lacking.filter((who) => playerKey(who) !== playerKey(phase.given!));
    this.phase = {
      kind: 'handing',
      job: phase.job,
      buy: { ...phase.buy, lacking },
      given: null,
      since: this.now()
    };
  }

  /** Nothing more is done, said where something was under way. */
  abandon(reason: string): void {
    if (!this.busy) return;
    this.phase = { kind: 'idle' };
    this.parts.notice(t('automation.stoppers.abandoned', { reason }), KIND);
  }

  reset(): void {
    this.phase = { kind: 'idle' };
  }

  /**
   * The first spell of the way: who lacks a stopper for it, and what to do
   * about them. Returns what was said where this takes the character.
   */
  private decide(job: Job, state: CharacterState): string | null {
    const stopper = job.way[0];
    if (stopper === undefined) return this.done(job);
    const carrying = packRows(state.inventory);
    const selfLacks = job.self && !stopperHeld(stopper, carrying);
    const members = state.party.following === null ? partyMembers(state) : [];
    const { asking, answers } = this.parts.stoppers.settle(stopper, members);
    if (asking.length > 0) {
      const said = this.phase.kind === 'asking' ? this.phase.said : null;
      job.held = true;
      this.phase = { kind: 'asking', job, said: said ?? stopper.spell };
      const line = t('automation.stoppers.asking', {
        who: asking.join(', '),
        spell: stopper.name,
        items: stopper.items.map((item) => item.name).join(', ')
      });
      if (said !== stopper.spell) this.parts.notice(line, KIND);
      return line;
    }
    const silent = members.filter((who) => answers.get(who)?.kind === 'silent');
    if (silent.length > 0) {
      return this.refuse(
        t('automation.stoppers.refusalSilent', {
          who: silent.join(', '),
          spell: stopper.name,
          items: stopper.items.map((item) => item.name).join(', ')
        })
      );
    }
    const lacking = members.filter((who) => answers.get(who)?.kind === 'lacks');
    if (this.phase.kind === 'confirming' && (selfLacks || lacking.length > 0)) {
      return this.refuse(
        t('automation.stoppers.refusalStillLacks', {
          who: [...(selfLacks ? [t('automation.stoppers.self')] : []), ...lacking].join(', '),
          items: stopper.items.map((item) => item.name).join(', '),
          spell: stopper.name
        })
      );
    }
    if (!selfLacks && lacking.length === 0) {
      this.phase = { kind: 'idle' };
      return this.decide({ ...job, way: job.way.slice(1) }, state);
    }
    const counter = this.parts.counterFor(stopper.items.map((item) => item.id));
    if (counter === null) {
      return this.refuse(
        t('automation.stoppers.refusalNoCounter', {
          items: stopper.items.map((item) => item.name).join(', '),
          spell: stopper.name
        })
      );
    }
    const quoted = this.parts.priceAt(counter.item.name, counter.room);
    if (quoted === null) {
      return this.refuse(
        t('automation.stoppers.refusalUnpriced', { item: counter.item.name, shop: counter.shop })
      );
    }
    const price = chargedInCopper(quoted, state.progress.charm);
    const copies = carriedCount(state, counter.item.name) + (selfLacks ? 1 : 0) + lacking.length;
    const buy: Buying = { stopper, counter, self: selfLacks, lacking, copies };
    const owed = price * ((selfLacks ? 1 : 0) + lacking.length);
    if (coveredBy(owed, state.inventory.wealth, state.banks) === true) {
      return this.buy(job, buy, owed, state);
    }
    if (selfLacks) {
      return this.refuse(
        t('automation.stoppers.refusalPurse', { item: counter.item.name, price: coinWords(owed) })
      );
    }
    // The leader cannot pay for them: each member is asked what they carry in coin.
    for (const who of lacking) this.parts.stoppers.askWealth(who);
    job.held = true;
    this.phase = { kind: 'purses', job, buy, price };
    const line = t('automation.stoppers.askingWealth', {
      who: lacking.join(', '),
      item: counter.item.name,
      price: coinWords(price)
    });
    this.parts.notice(line, KIND);
    return line;
  }

  /** The leader's errand for every copy wanted, the walk owed back through `retry`. */
  private buy(job: Job, buy: Buying, owed: number, state: CharacterState): string | null {
    const { counter, copies, lacking } = buy;
    const row: SupplyItem = {
      name: counter.item.name,
      min: copies,
      max: copies,
      shop: counter.shop,
      at: counter.at,
      ...BOUGHT_ROW
    };
    const refused = this.parts.fetch(row, state);
    if (refused !== null) {
      return this.refuse(
        t('automation.stoppers.refusalErrand', { item: counter.item.name, why: refused })
      );
    }
    job.held = true;
    this.phase = { kind: 'buying', job, buy };
    const line = t('automation.stoppers.buying', {
      count: copies - carriedCount(state, counter.item.name),
      item: counter.item.name,
      shop: counter.shop,
      price: coinWords(owed),
      who: [...lacking, ...(buy.self ? [t('automation.stoppers.self')] : [])].join(', ')
    });
    this.parts.notice(line, KIND);
    return line;
  }

  /** The errand over: every copy in the pack, then each member is handed one. */
  private bought(job: Job, buy: Buying, state: CharacterState): void {
    if (this.parts.fetching()) return;
    if (carriedCount(state, buy.counter.item.name) < buy.copies) {
      this.refuse(t('automation.stoppers.refusalNotBought', { item: buy.counter.item.name }));
      return;
    }
    this.phase = { kind: 'handing', job, buy, given: null, since: this.now() };
    this.hand(this.phase, state);
  }

  /** One member at a time: handed a copy once they stand here, confirmed by the server's echo. */
  private hand(phase: Extract<Phase, { kind: 'handing' }>, state: CharacterState): void {
    const { job, buy, given, since } = phase;
    const who = buy.lacking[0];
    if (who === undefined) {
      this.phase = { kind: 'confirming', job, stopper: buy.stopper };
      this.decide(job, state);
      return;
    }
    const item = buy.counter.item.name;
    if (this.now() - since > tuning().remotes.replyMs) {
      this.refuse(
        given === null
          ? t('automation.stoppers.refusalNotHere', { who, item })
          : t('automation.stoppers.refusalNotTaken', { who, item })
      );
      return;
    }
    if (given !== null || !standsHere(state, who)) return;
    if (!this.parts.give(item, who)) return;
    this.phase = { ...phase, given: who, since: this.now() };
  }

  /** Each member's purse, once answered: enough, and the leader walks them to the counter. */
  private purses(phase: Extract<Phase, { kind: 'purses' }>, state: CharacterState): void {
    const { job, buy, price } = phase;
    const item = buy.counter.item.name;
    const purses = buy.lacking.map((who) => ({ who, purse: this.parts.stoppers.purseOf(who) }));
    if (purses.some(({ purse }) => purse === undefined)) return;
    const silent = purses.filter(({ purse }) => purse === null).map(({ who }) => who);
    if (silent.length > 0) {
      this.refuse(t('automation.stoppers.refusalWealthSilent', { who: silent.join(', '), item }));
      return;
    }
    const short = purses.filter(
      ({ purse }) => purse !== null && purse !== undefined && purse < price
    );
    if (short.length > 0) {
      this.refuse(
        t('automation.stoppers.refusalMemberPurse', {
          who: short.map(({ who, purse }) => `${who} (${coinWords(purse!)})`).join(', '),
          item,
          price: coinWords(price)
        })
      );
      return;
    }
    const [who, ...rest] = buy.lacking;
    if (who === undefined) return;
    this.phase = { kind: 'member-buying', job, buy, who, rest, told: null, since: this.now() };
    this.parts.notice(
      t('automation.stoppers.membersBuy', {
        who: buy.lacking.join(', '),
        item,
        shop: buy.counter.shop
      }),
      KIND
    );
    this.memberBuys(this.phase, state);
  }

  /** At the counter with the member, `@do buy <item>`; then they are asked again. */
  private memberBuys(
    phase: Extract<Phase, { kind: 'member-buying' }>,
    state: CharacterState
  ): void {
    const { job, buy, who, rest, told, since } = phase;
    const item = buy.counter.item.name;
    if (told !== null) {
      if (this.now() - told < tuning().supplies.buyTimeoutMs) return;
      // The buy's answer went to them, not here: they are asked again, and the answer decides.
      this.parts.stoppers.forget(who);
      const next = rest[0];
      this.phase =
        next === undefined
          ? { kind: 'confirming', job, stopper: buy.stopper }
          : {
              kind: 'member-buying',
              job,
              buy,
              who: next,
              rest: rest.slice(1),
              told: null,
              since: this.now()
            };
      return;
    }
    if (this.now() - since > tuning().walk.errandAskMs) {
      this.refuse(t('automation.stoppers.refusalNotHere', { who, item }));
      return;
    }
    if (roomAddress(state.room) !== buy.counter.room) {
      if (this.parts.walking()) return;
      const refused = this.parts.walkTo(buy.counter.room);
      if (refused !== null)
        this.refuse(t('automation.stoppers.refusalErrand', { item, why: refused }));
      return;
    }
    if (!standsHere(state, who)) return;
    if (!this.parts.tellDo(who, `buy ${item}`)) return;
    this.phase = { ...phase, told: this.now() };
    this.parts.notice(t('automation.stoppers.toldToBuy', { who, item }), KIND);
  }

  /** Everyone carries one. A walk this took over is asked for again; one it never held goes on itself. */
  private done(job: Job): null {
    this.phase = { kind: 'idle' };
    if (!job.held) return null;
    this.parts.notice(t('automation.stoppers.settled'), KIND);
    job.retry();
    return null;
  }

  private refuse(why: string): string {
    this.phase = { kind: 'idle' };
    this.parts.notice(t('automation.stoppers.refused', { why }), KIND);
    this.parts.decided({
      at: this.now(),
      action: ACTION,
      because: t('automation.stoppers.because'),
      acted: false,
      refused: why
    });
    return why;
  }
}

/** Whether a member is listed among the room's occupants. */
function standsHere(state: CharacterState, who: string): boolean {
  const key = playerKey(who);
  return state.room.occupants.some((each) => playerKey(each.name) === key);
}
