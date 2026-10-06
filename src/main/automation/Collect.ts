/**
 * Walking to a room and taking named items off its floor (todo 05,
 * 2026-10-03): out of `GearRecovery`, so going back for the gear after a death
 * and fetching what was hidden in a room are one walk and one pick-up. A leg
 * planned by the navigation engine, an optional `search` first for a hidden
 * pile, a `get` per item the floor lists, then waiting for the pack. The
 * owner says what each ending means; this reports which ending it was. See
 * `mudengine-automation` › *Going back for the kit is a leg, and it refuses
 * loudly*.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { DENOMINATIONS, type CharacterState, type Denomination } from '../../shared/character';
import { sameItem } from '../../shared/items';
import { carriedCount } from '../../shared/supplies';
import type { RoomId, Route } from '../../shared/world';

export interface CollectPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** A route to the room, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Returns its refusal, or null. */
  walk(route: Route): string | null;
  /** The word that picks a coin up on this realm (todo 830); omitted, the denomination. */
  coinWord?(coin: Denomination): string;
  /**
   * A fight here, or one auto-combat is about to open: a search waits it out,
   * since the server answers `You may not search while attacking!` after
   * spending the command (`AutoSearch.fightHere`). Omitted, never.
   */
  fighting?(): boolean;
}

/** What to take, from where, and the owner's words for each command sent. */
export interface CollectAsk {
  to: RoomId;
  /** Empty, every search in `search` is sent: nothing found ends them early. */
  items: readonly string[];
  /**
   * Bare searches before taking what the open floor holds, for a pile `hide`
   * left out of `You notice`, and why each is sent; null searches none.
   */
  search: { times: number; reason: string } | null;
  /** Each command's coalescing key starts with it, so two owners never join. */
  key: string;
  /** Why each `get` is sent, as the trace says it. */
  reason(item: string): string;
  /** Present, the room's open coins are taken too, sent with this reason: a death drops the purse. */
  coinReason?(coin: Denomination): string;
  /** How long the pack has to show a `get`, and how long a queued one stays wanted. */
  collectMs: number;
  expiresMs: number;
}

type SearchPlan = NonNullable<CollectAsk['search']>;

export type CollectStart =
  { kind: 'here' } | { kind: 'walking'; steps: number } | { kind: 'refused'; why: string };

export type CollectEnd =
  /** The walk stopped short, or arrived somewhere else; `why` is the walk's reason. */
  | { kind: 'not-reached'; why: string | null }
  /** The character left the room before the pack showed what was asked. */
  | { kind: 'left' }
  /** None of the items is on the floor, nor in what `searches` sent searches turned up. */
  | { kind: 'nothing-here'; searches: number }
  | { kind: 'taken'; asked: readonly string[]; arrived: readonly string[] };

export interface CollectEvents {
  /** The leg arrived: the dangerous part of the trip is over. */
  arrived?(): void;
  /** The `get`s sent: `gone` of the items are on no floor here, `capped` over the limit left. */
  taking?(taking: readonly string[], gone: number, capped: number): void;
  ended(end: CollectEnd, state: CharacterState): void;
}

/** Where a collection stands, for a card. */
export type CollectStage = 'walking' | 'searching' | 'taking';

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; ask: CollectAsk }
  | {
      kind: 'searching';
      ask: CollectAsk;
      plan: SearchPlan;
      /** Searches offered, this one included, and how many of them went out. */
      offered: number;
      sent: number;
      /** The queue would not take this one, so no more are asked. */
      refused: boolean;
      /** Set by the answer's block; read on the state after it. */
      answered: boolean;
      /** A fight held this one, so it may have been dropped unsent. */
      foughtOver: boolean;
      queuedAt: number;
      sentAt: number | null;
    }
  | { kind: 'taking'; ask: CollectAsk; before: ReadonlyMap<string, number>; askedAt: number };

/** Whether a search turned the item up here, or the room lists it in the open. */
function onAFloor(state: CharacterState, item: string): boolean {
  const { hidden, items } = state.room;
  return [...hidden, ...items].some((floor) => sameItem(floor.name, item));
}

export class Collect {
  private phase: Phase = { kind: 'idle' };

  constructor(
    private readonly queue: CommandQueue,
    private readonly planner: CollectPlanner,
    private readonly events: CollectEvents,
    private readonly now: () => number = () => Date.now()
  ) {}

  get busy(): boolean {
    return this.phase.kind !== 'idle';
  }

  get stage(): CollectStage | null {
    return this.phase.kind === 'idle' ? null : this.phase.kind;
  }

  /**
   * Put down without an ending: a death, a reset, the owner switched off, a
   * stop. What it still has queued is taken back, or a search goes out after.
   */
  cancel(): void {
    const phase = this.phase;
    this.phase = { kind: 'idle' };
    if (phase.kind === 'idle') return;
    const ours = `${phase.ask.key}:`;
    this.queue.cancel((intent) => intent.coalesceKey?.startsWith(ours) === true);
  }

  /**
   * Starts the walk, or the pick-up where the character already stands. The
   * owner calls it only while not `busy`. Standing there, the first command
   * goes out (and an ending may be reported) before this returns.
   */
  start(ask: CollectAsk, state: CharacterState): CollectStart {
    if (this.planner.here() === ask.to) {
      this.arrive(ask, state);
      return { kind: 'here' };
    }
    const route = this.planner.routeTo(ask.to);
    if (typeof route === 'string') return { kind: 'refused', why: route };
    // A blocked route is a reason, not a walk of no steps.
    if (route.blocked) {
      return { kind: 'refused', why: route.reason ?? t('automation.walk.refusalNoRoute') };
    }
    const refused = this.planner.walk(route);
    if (refused !== null) return { kind: 'refused', why: refused };
    this.phase = { kind: 'walking', ask };
    return { kind: 'walking', steps: route.steps.length };
  }

  /** The walker's report: this leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { ask } = this.phase;
    if (!arrived || this.planner.here() !== ask.to) {
      this.end({ kind: 'not-reached', why: reason }, state);
      return;
    }
    this.events.arrived?.();
    this.arrive(ask, state);
  }

  /**
   * A bare search's answer, either way: `room-hidden-items` or `Your search
   * revealed nothing.` (`Classifier.answerSearch` retypes the listing). Read
   * on the state that follows, which holds `room.hidden`.
   */
  onBlock(block: Block): void {
    if (this.phase.kind !== 'searching') return;
    const bare = block.type === 'user-search-failed' && block.groups['direction'] === undefined;
    if (block.type === 'room-hidden-items' || bare) this.phase.answered = true;
  }

  onCharacter(state: CharacterState): void {
    const phase = this.phase;
    if (phase.kind === 'idle' || phase.kind === 'walking') return;
    if (this.planner.here() !== phase.ask.to) {
      this.end({ kind: 'left' }, state);
      return;
    }
    if (phase.kind === 'searching') {
      this.searched(phase, state);
      return;
    }
    const asked = [...phase.before.keys()];
    const arrived = asked.filter(
      (item) => carriedCount(state, item) > (phase.before.get(item) ?? 0)
    );
    const waited = this.now() - phase.askedAt;
    if (arrived.length < asked.length && waited < phase.ask.collectMs) return;
    this.end({ kind: 'taken', asked, arrived }, state);
  }

  private arrive(ask: CollectAsk, state: CharacterState): void {
    if (ask.search !== null) this.search(ask, ask.search, 1, 0);
    else this.take(ask, state, 0);
  }

  /**
   * One bare `search`. The server rolls each hidden item against Perception
   * per search (`Player.TrySearch`) and a `get` takes only what a search showed
   * this character (`GetCommand`, `SeenHiddenItems`): server source, and the
   * wire agrees (`2026-08-26_15-12-06_main.log`: `You hid padded gloves.`, then
   * `Your search revealed nothing.`, then `You notice padded gloves here.`).
   */
  private search(ask: CollectAsk, plan: SearchPlan, offered: number, sent: number): void {
    const phase: Phase = {
      kind: 'searching',
      ask,
      plan,
      offered,
      sent,
      refused: false,
      answered: false,
      foughtOver: false,
      queuedAt: this.now(),
      sentAt: null
    };
    this.phase = phase;
    const taken = this.queue.offer({
      command: 'search',
      priority: 'probe',
      coalesceKey: `${ask.key}:search`,
      expiresAt: this.now() + tuning().search.expiresMs,
      reason: plan.reason,
      stillWanted: () => this.planner.fighting?.() !== true,
      onSent: () => {
        if (this.phase !== phase) return;
        phase.sentAt = this.now();
        phase.sent += 1;
      }
    });
    // Not taken, so no more are asked: what the open floor holds is still worth taking.
    if (taken !== 'queued' && taken !== 'joined') {
      phase.answered = true;
      phase.refused = true;
    }
  }

  /**
   * Another search while any named item is on neither floor, up to the
   * ask's: each search rolls each item, so one found says nothing of the
   * rest. Then the pick-up, with the searches that went out.
   */
  private searched(phase: Extract<Phase, { kind: 'searching' }>, state: CharacterState): void {
    const { ask, plan, offered, sent, refused, sentAt, queuedAt } = phase;
    // Nothing ages through a fight; one dropped unsent for it is asked again after.
    if (this.planner.fighting?.() === true) {
      phase.foughtOver = true;
      phase.queuedAt = this.now();
      return;
    }
    if (phase.foughtOver && sentAt === null && !phase.answered) {
      this.search(ask, plan, offered, sent);
      return;
    }
    if (!phase.answered && this.now() - (sentAt ?? queuedAt) < ask.collectMs) return;
    const wanted = ask.items.length === 0 || ask.items.some((item) => !onAFloor(state, item));
    if (!refused && offered < plan.times && wanted) {
      this.search(ask, plan, offered + 1, sent);
      return;
    }
    this.take(ask, state, sent);
  }

  /** A `get` for each item a search turned up or the floor lists, bounded by `maxGear`. */
  private take(ask: CollectAsk, state: CharacterState, searches: number): void {
    const onFloor = ask.items.filter((item) => onAFloor(state, item));
    if (onFloor.length === 0) {
      this.end({ kind: 'nothing-here', searches }, state);
      return;
    }
    const taking = onFloor.slice(0, tuning().spending.maxGear);
    const expiresAt = this.now() + ask.expiresMs;
    const before = new Map(taking.map((item) => [item, carriedCount(state, item)]));
    for (const item of taking) {
      this.queue.enqueue({
        command: `get ${item}`,
        priority: 'probe',
        coalesceKey: `${ask.key}:${item.toLowerCase()}`,
        expiresAt,
        reason: ask.reason(item)
      });
    }
    const { coinReason } = ask;
    const cash = state.room.cash;
    const coins = coinReason === undefined || cash === null ? [] : DENOMINATIONS;
    for (const coin of coins.filter((each) => (cash?.[each] ?? 0) > 0)) {
      this.queue.enqueue({
        command: `get ${this.planner.coinWord?.(coin) ?? coin}`,
        priority: 'probe',
        coalesceKey: `${ask.key}:${coin}`,
        expiresAt,
        reason: coinReason?.(coin) ?? coin
      });
    }
    this.phase = { kind: 'taking', ask, before, askedAt: this.now() };
    this.events.taking?.(taking, ask.items.length - onFloor.length, onFloor.length - taking.length);
  }

  private end(end: CollectEnd, state: CharacterState): void {
    this.phase = { kind: 'idle' };
    this.events.ended(end, state);
  }
}
