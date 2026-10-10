/**
 * A cash run (`shared/cashRun.ts`): the loop walked collecting the coins
 * asked for, and each time the character is loaded to the grade asked for,
 * the room cleared, a token used, the cash gained since the start deposited
 * at the nearest bank to the landing, and the lap given back to walk home.
 * Each token is looked at before it is used (`Uses remaining: N`) and passed
 * over at none left; with none left anywhere the run ends and the loop goes
 * on. Cash gained short of the token's fare is dropped and the run ends, so
 * the loop goes on unloaded (the user, 2026-10-09). Started by the player
 * only. See `mudengine-automation` › *Errands* › *A cash run*.
 */
import type { CommandQueue } from './CommandQueue';
import type { SessionModule } from './Module';
import { walkLeg } from './errandLeg';
import { stoppedByPerson } from './personStop';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CashRunAsk, CashRunToken } from '../../shared/cashRun';
import {
  DENOMINATIONS,
  fightIsRunning,
  monstersHere,
  type CharacterState,
  type Coins,
  type Denomination
} from '../../shared/character';
import { encumbranceAtLeast } from '../../shared/config';
import type { RoomId, Route } from '../../shared/world';

export interface CashRunPlanner {
  here(): RoomId | null;
  current(): CharacterState;
  /** The loop named, started as the player's Play starts one; its refusal, or null. */
  startLoop(name: string): string | null;
  /** Whether the lap is going, held for an errand included. */
  looping(): boolean;
  hold(): void;
  /** The lap given back, to walk on from wherever the character stands. */
  release(): void;
  routeTo(room: RoomId): Route | string;
  walk(route: Route): string | null;
  moveInFlight(): boolean;
  escaping(): boolean;
  /** The tokens the character carries, as the realm states them. */
  tokens(state: CharacterState): CashRunToken[];
  /** The nearest bank to where the character stands, or null where none is in reach. */
  nearestBank(): { room: RoomId; name: string } | null;
  collectCoins(kinds: readonly Denomination[], until: CashRunAsk['full']): void;
  collectAsConfigured(): void;
  /** Coins back on the floor; the kinds not dropped. */
  dropCoins(counts: ReadonlyMap<Denomination, number>, state: CharacterState): Denomination[];
  /** A deposit of what the purse holds over `keep`, at whichever bank it stands in. */
  deposit(keep: number, state: CharacterState): boolean;
}

export interface CashRunEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

type Stage = 'looking' | 'collecting' | 'clearing' | 'using' | 'walking' | 'banking' | 'dropping';

interface Token extends CashRunToken {
  /** What the last look said, or null where none has answered. */
  uses: number | null;
}

interface Run {
  ask: CashRunAsk;
  tokens: Token[];
  /** Cash on hand, and each coin, when the run started: what is kept back. */
  wealth: number;
  coins: Coins;
  stage: Stage;
  /** Whether the run holds the lap. */
  held: boolean;
  /** The token being looked at or used. */
  token: Token | null;
  /** Where the token was used, so a move off it is the landing; its name, for a landing nobody can place. */
  usedFrom: RoomId | null;
  usedFromName: string | null;
  /** The coins being dropped short of the fare; the lap waits for them to leave the purse. */
  dropping: Denomination[];
  /** Since when the room has held monsters with no fight in it. */
  quietSince: number | null;
  /** A room passed over full because its monsters stayed; tried again elsewhere. */
  passedOver: RoomId | null;
  bank: { room: RoomId; name: string } | null;
  legs: number;
  /** Walking, or waiting out a fight before the leg is planned again. */
  waiting: boolean;
  trips: number;
}

const ACTION = 'cash run';
const LOOK_KEY = 'cash:look';
const USE_KEY = 'cash:use';

export class CashRun implements SessionModule {
  private run: Run | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Whether the look asked for has gone out, so an older answer is not taken for it. */
  private lookSent = false;
  /**
   * Looks sent and not yet answered. The server answers in order and a token
   * always prints its uses, so a late answer to a look given up on is the one
   * ahead of the newest, never taken for it.
   */
  private looksOut = 0;

  constructor(
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: CashRunPlanner,
    private readonly events: CashRunEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.run !== null) this.end(t('automation.hostTrip.endedSwitchedOff'));
  }

  reset(): void {
    this.clear();
    this.run = null;
    this.looksOut = 0;
  }

  /** A trip off the loop under way: the lap held, not the opening looks or the collecting. */
  get busy(): boolean {
    const run = this.run;
    return run !== null && run.held && run.stage !== 'collecting' && run.stage !== 'clearing';
  }

  get running(): boolean {
    return this.run !== null;
  }

  abandon(): void {
    if (this.run !== null) this.end(t('automation.hostTrip.endedDied'));
  }

  /** The tokens the dialog offers: those carried that go from anywhere. */
  offered(state: CharacterState): CashRunToken[] {
    return this.planner.tokens(state);
  }

  /** The run; its refusal, said, or null once under way. */
  start(ask: CashRunAsk, state: CharacterState): string | null {
    const refused = this.refusal(ask, state);
    if (refused !== null) {
      this.say(t('automation.cashRun.refused', { why: refused }), refused);
      return refused;
    }
    const carried = this.planner.tokens(state);
    const tokens = ask.tokens
      .map((item) => carried.find((token) => token.item === item))
      .filter((token): token is CashRunToken => token !== undefined)
      .map((token) => ({ ...token, uses: null }));
    const looped = this.planner.startLoop(ask.loop);
    if (looped !== null) {
      this.say(t('automation.cashRun.refused', { why: looped }), looped);
      return looped;
    }
    this.run = {
      ask,
      tokens,
      wealth: state.inventory.wealth!,
      coins: { ...state.inventory.coins },
      stage: 'looking',
      held: false,
      token: null,
      usedFrom: null,
      usedFromName: null,
      dropping: [],
      quietSince: null,
      passedOver: null,
      bank: null,
      legs: 0,
      waiting: false,
      trips: 0
    };
    this.planner.collectCoins(ask.coins, ask.full);
    this.events.notice?.(
      t('automation.cashRun.started', {
        loop: ask.loop,
        tokens: tokens.map((token) => token.name).join(', '),
        wealth: state.inventory.wealth!.toLocaleString()
      })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.cashRun.because'),
      acted: true
    });
    this.lookAt(this.run, tokens[0]!);
    return null;
  }

  /** The player's Stop. */
  stop(): void {
    if (this.run !== null) this.end(t('automation.cashRun.stoppedByPlayer'));
  }

  onBlock(block: Block): void {
    const run = this.run;
    if (run === null) return;
    switch (block.type) {
      case 'item-uses-left': {
        const newest = this.looksOut <= 1;
        this.looksOut = Math.max(0, this.looksOut - 1);
        if (newest && run.stage === 'looking' && this.lookSent) {
          this.looked(run, Number(block.groups['uses']));
        }
        return;
      }
      case 'item-used-up': {
        // `There are no more uses in X.` names the item; the other sentence names none.
        const item = block.groups['item'];
        const ours = item === undefined || item.toLowerCase() === run.token?.name.toLowerCase();
        if (run.stage === 'using' && run.token !== null && ours) this.spent(run, run.token);
        return;
      }
      case 'user-deposits':
        if (run.stage === 'banking') this.banked(run, Number(block.groups['amount']));
        return;
      default:
        return;
    }
  }

  onCharacter(state: CharacterState): void {
    const run = this.run;
    if (run === null) return;
    switch (run.stage) {
      case 'collecting':
      case 'clearing':
        if (!this.planner.looping()) {
          this.end(t('automation.cashRun.loopStopped'));
          return;
        }
        this.collecting(run, state);
        return;
      case 'using': {
        const here = this.planner.here();
        if (here !== null && run.usedFrom !== null && here !== run.usedFrom) this.landed(run);
        else if (
          here === null &&
          run.usedFromName !== null &&
          state.room.name !== run.usedFromName
        ) {
          this.end(t('automation.cashRun.landedLost', { room: state.room.name ?? '' }));
        }
        return;
      }
      case 'dropping':
        // Released once every coin dropped is back to what the run started with; an
        // unknown count is not a drop, and the timer ends the wait.
        if (
          run.dropping.every((coin) => {
            const now = state.inventory.coins[coin];
            const before = run.coins[coin];
            return now !== null && before !== null && now <= before;
          })
        ) {
          this.end(t('automation.cashRun.endedShort'), true);
        }
        return;
      case 'walking':
        if (!run.waiting || fightIsRunning(state) || this.planner.moveInFlight()) return;
        run.waiting = false;
        this.leg(run);
        return;
      case 'looking':
      case 'banking':
        return;
      default: {
        const never: never = run.stage;
        return never;
      }
    }
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    const run = this.run;
    if (run === null || run.stage !== 'walking' || run.waiting || run.bank === null) return;
    if (arrived && this.planner.here() === run.bank.room) {
      this.atBank(run, state);
      return;
    }
    if (!stoppedByPerson(reason) && fightIsRunning(state)) {
      run.waiting = true;
      return;
    }
    this.end(t('automation.cashRun.bankNotReached', { bank: run.bank.name, why: reason ?? '' }));
  }

  private refusal(ask: CashRunAsk, state: CharacterState): string | null {
    if (!this.enabled) return t('automation.hostTrip.refusalSwitchedOff');
    if (this.run !== null) return t('automation.cashRun.refusalRunning');
    if (state.phase !== 'in-game') return t('automation.hostTrip.refusalNotInRealm');
    if (state.inventory.wealth === null) return t('automation.cashRun.refusalPurseUnread');
    const carried = this.planner.tokens(state);
    if (!ask.tokens.some((item) => carried.some((token) => token.item === item))) {
      return t('automation.cashRun.refusalNoToken');
    }
    return null;
  }

  /** Loaded to the grade: hold the lap and use a token once the room is empty. */
  private collecting(run: Run, state: CharacterState): void {
    const here = this.planner.here();
    if (!encumbranceAtLeast(run.ask.full, state.inventory.encumbranceWord)) return;
    if (here !== null && here === run.passedOver) return;
    if (!run.held) {
      if (this.planner.looping()) this.planner.hold();
      run.held = true;
    }
    run.stage = 'clearing';
    const fighting = fightIsRunning(state);
    if (!fighting && !monstersHere(state) && !this.planner.moveInFlight()) {
      run.quietSince = null;
      run.passedOver = null;
      this.trip(run, state);
      return;
    }
    // A fight is the room being cleared; monsters that stay without one are
    // left, and the next room is tried, since the token refuses with any here.
    if (fighting || run.quietSince === null) {
      run.quietSince = this.now();
      return;
    }
    if (this.now() - run.quietSince < tuning().cashRun.clearMs) return;
    this.events.notice?.(t('automation.cashRun.roomNotClear'));
    run.quietSince = null;
    run.passedOver = here;
    run.stage = 'collecting';
    this.giveLapBack(run);
  }

  /** The next token with uses left, looked at again before it is used; or the run's end. */
  private trip(run: Run, state: CharacterState): void {
    const token = run.tokens.find((each) => each.uses === null || each.uses > 0);
    if (token === undefined) {
      this.end(t('automation.cashRun.tokensSpent'), true);
      return;
    }
    const gained = state.inventory.wealth === null ? null : state.inventory.wealth - run.wealth;
    if (gained !== null && token.fare !== null && gained < token.fare) {
      this.dropGained(run, state, gained, token);
      return;
    }
    this.lookAt(run, token);
  }

  private lookAt(run: Run, token: Token): void {
    run.stage = 'looking';
    run.token = token;
    this.lookSent = false;
    this.queue.enqueue({
      command: `look ${token.name}`,
      priority: 'probe',
      coalesceKey: LOOK_KEY,
      expiresAt: this.now() + tuning().cashRun.sendMs,
      reason: t('automation.cashRun.reasonLook', { token: token.name }),
      onSent: () => {
        this.lookSent = true;
        this.looksOut += 1;
      }
    });
    this.arm(tuning().cashRun.lookMs, () => this.looked(run, null));
  }

  /** A look's answer, or null where none came: unknown is not spent. */
  private looked(run: Run, uses: number | null): void {
    if (this.run !== run || run.token === null) return;
    this.clear();
    const token = run.token;
    token.uses = uses;
    if (uses === null) {
      this.events.notice?.(t('automation.cashRun.usesUnread', { token: token.name }));
    } else {
      this.events.notice?.(
        uses === 1
          ? t('automation.cashRun.usesLeft.one', { token: token.name })
          : t('automation.cashRun.usesLeft.many', { token: token.name, uses })
      );
    }
    // At the start every token is looked at once, in order, then the lap walks.
    if (!run.held) {
      const next = run.tokens[run.tokens.indexOf(token) + 1];
      if (next !== undefined) {
        this.lookAt(run, next);
        return;
      }
      run.token = null;
      run.stage = 'collecting';
      if (run.tokens.every((each) => each.uses === 0))
        this.end(t('automation.cashRun.tokensSpent'));
      return;
    }
    if (uses === 0) {
      this.trip(run, this.planner.current());
      return;
    }
    this.use(run, token);
  }

  private use(run: Run, token: Token): void {
    const state = this.planner.current();
    if (monstersHere(state) || fightIsRunning(state)) {
      run.stage = 'clearing';
      run.quietSince = null;
      return;
    }
    run.stage = 'using';
    run.usedFrom = this.planner.here();
    run.usedFromName = state.room.name;
    const current = (): CharacterState => this.planner.current();
    this.queue.enqueue({
      command: `use ${token.name}`,
      priority: 'probe',
      coalesceKey: USE_KEY,
      expiresAt: this.now() + tuning().cashRun.sendMs,
      reason: t('automation.cashRun.reasonUse', { token: token.name }),
      // The server refuses the token with any monster in the room (`nomonsters`).
      stillWanted: () => !monstersHere(current()) && !fightIsRunning(current())
    });
    this.arm(tuning().cashRun.useMs, () => this.didNotTake(run));
  }

  private spent(run: Run, token: Token): void {
    this.clear();
    token.uses = 0;
    this.events.notice?.(t('automation.cashRun.usesLeft.many', { token: token.name, uses: 0 }));
    this.trip(run, this.planner.current());
  }

  /** The token did not move the character: monsters came in, or the realm refused it. */
  private didNotTake(run: Run): void {
    if (this.run !== run || run.stage !== 'using') return;
    if (monstersHere(this.planner.current())) {
      run.stage = 'clearing';
      run.quietSince = null;
      return;
    }
    this.end(t('automation.cashRun.didNotTake', { token: run.token?.name ?? '' }));
  }

  private landed(run: Run): void {
    this.clear();
    const token = run.token;
    if (token !== null && token.uses !== null) token.uses -= 1;
    run.token = null;
    run.usedFrom = null;
    run.usedFromName = null;
    const bank = this.planner.nearestBank();
    if (bank === null) {
      this.end(t('automation.cashRun.noBank'));
      return;
    }
    run.bank = bank;
    run.stage = 'walking';
    run.legs = 0;
    run.waiting = false;
    this.events.notice?.(t('automation.cashRun.toBank', { bank: bank.name }));
    if (this.planner.here() === bank.room) {
      this.atBank(run, this.planner.current());
      return;
    }
    this.leg(run);
  }

  private leg(run: Run): void {
    const bank = run.bank!;
    run.legs += 1;
    const refused = walkLeg(this.planner, bank.room, bank.name, run.legs, tuning().cashRun.maxLegs);
    if (refused === null) return;
    this.end(
      'ends' in refused
        ? refused.ends
        : t('automation.cashRun.bankNotReached', { bank: bank.name, why: refused.notReached })
    );
  }

  private atBank(run: Run, state: CharacterState): void {
    run.stage = 'banking';
    if (!this.planner.deposit(run.wealth, state)) {
      this.backToTheLoop(run);
      return;
    }
    this.arm(tuning().cashRun.bankMs, () => {
      if (this.run !== run) return;
      this.events.notice?.(t('automation.cashRun.notBanked', { bank: run.bank?.name ?? '' }));
      this.backToTheLoop(run);
    });
  }

  private banked(run: Run, amount: number): void {
    this.clear();
    run.trips += 1;
    this.events.notice?.(
      t('automation.cashRun.banked', {
        amount: amount.toLocaleString(),
        bank: run.bank?.name ?? ''
      })
    );
    this.backToTheLoop(run);
  }

  private backToTheLoop(run: Run): void {
    run.bank = null;
    run.stage = 'collecting';
    if (run.tokens.every((token) => token.uses === 0)) {
      this.end(t('automation.cashRun.tokensSpent'), true);
      return;
    }
    this.giveLapBack(run);
  }

  /** Short of the fare: what was collected goes back on the floor, and the loop goes on. */
  private dropGained(run: Run, state: CharacterState, gained: number, token: Token): void {
    const counts = new Map<Denomination, number>();
    for (const coin of DENOMINATIONS) {
      const now = state.inventory.coins[coin];
      const before = run.coins[coin];
      if (now === null || before === null) continue;
      if (now > before) counts.set(coin, now - before);
    }
    const kept = this.planner.dropCoins(counts, state);
    this.events.notice?.(
      t('automation.cashRun.shortOfFare', {
        gained: Math.max(gained, 0).toLocaleString(),
        fare: (token.fare ?? 0).toLocaleString(),
        token: token.name
      })
    );
    if (kept.length > 0) {
      this.say(t('automation.cashRun.notDropped', { coins: kept.join(', ') }), kept.join(', '));
    }
    // The lap stays held until the coins are on this room's floor, or they would land in the next.
    run.dropping = [...counts.keys()].filter((coin) => !kept.includes(coin));
    if (run.dropping.length === 0) {
      this.end(t('automation.cashRun.endedShort'), true);
      return;
    }
    run.stage = 'dropping';
    this.arm(tuning().cashRun.lookMs, () => {
      if (this.run === run) this.end(t('automation.cashRun.notDroppedInTime'));
    });
  }

  private giveLapBack(run: Run): void {
    if (!run.held) return;
    run.held = false;
    this.planner.release();
  }

  /** Over: `done` is the run ending as it should, the loop going on without it. */
  private end(why: string, done = false): void {
    const run = this.run;
    if (run === null) return;
    this.clear();
    this.run = null;
    const ours = new Set([LOOK_KEY, USE_KEY]);
    this.queue.cancel((intent) => ours.has(intent.coalesceKey ?? ''));
    this.planner.collectAsConfigured();
    this.giveLapBack(run);
    const one = run.trips === 1;
    if (done) {
      this.events.notice?.(
        one
          ? t('automation.cashRun.done.one', { why })
          : t('automation.cashRun.done.many', { why, trips: run.trips })
      );
    } else {
      const said = one
        ? t('automation.cashRun.ended.one', { why })
        : t('automation.cashRun.ended.many', { why, trips: run.trips });
      this.say(said, why);
    }
  }

  private arm(ms: number, fire: () => void): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      fire();
    }, ms);
    this.timer.unref?.();
  }

  private clear(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** A refusal or a setback, said and traced. */
  private say(message: string, refused: string): void {
    this.events.notice?.(message);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.cashRun.because'),
      acted: false,
      refused
    });
  }
}
