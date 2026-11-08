/**
 * Digging up the Lagoon's disturbed ground until the spades are gone.
 *
 * Paradigm's text block 3372 answers `dig treasure` where the room holds the
 * disturbed ground (item 3403) and the inventory a spade (3404): `You use your
 * spade and dig up the ground, to find...`, then one roll of 3373. A spade
 * breaks (5%, a spell whose sentence no capture holds yet), an item may turn
 * up (four 10% chances; a miss prints nothing, the user's "no message"),
 * `Nothing.` (30%), or spell 5095 drops the character into one of the Dark
 * Pits 13/315 to 323 (20%), whose `climb out` (3383) starts with `nomonsters`.
 *
 * The roll waits on `adddelay 4`: GreaterMUD's `TextBlockPart` parks the rest
 * of the block as the player's current command for four seconds, and anything
 * typed meanwhile waits in the server's queue (the user's wire: a dig typed
 * after `to find...` is answered with no reprint between). So a dig ends when
 * its roll prints, when the room reprints, or `tuning.dig.delayMs` after the
 * dig line, and never on a prompt.
 *
 * Each pass is: let auto-combat clear the room, climb out of a pit, dig. The
 * spade count is the inventory's, never this unit's arithmetic: a dig whose
 * answer was not one of the four sentences above, or that had no answer, and a
 * find, are followed by an `i`, and the inventory says whether a spade went.
 * No spade left ends the run. See `mudengine-automation` › `parts/errands.md` › *The
 * treasure dig*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { isPrompt } from '../../shared/blocks';
import {
  fightHere,
  fightIsRunning,
  monstersHere,
  type CharacterState,
  type FightSigns
} from '../../shared/character';
import { bareName } from '../../shared/items';
import { carriedCount } from '../../shared/supplies';
import type { DigStatus, DigView } from '../../shared/tasks';
import { nameAnswersTo } from '../../shared/world';
import { taken, type CommandQueue } from './CommandQueue';
import { whyNotQueued } from './queueRefusals';
import type { SessionModule } from './Module';

/** What the dig types, and what it digs with and in, as the realm names them. */
export const DIG = {
  command: 'dig treasure',
  climb: 'climb out',
  spade: 'spade',
  ground: 'disturbed ground',
  /** Message 1431, the 30% roll. */
  nothing: 'Nothing.'
} as const;

/** What the session tells the dig. */
export interface DigEvents {
  /** The character now, for the ask at the send. */
  stateNow(): CharacterState;
  /** `AutoCombat.quarry` and a monster's recent blow, for `fightHere`. */
  signs: FightSigns;
  /** Whether auto-combat may fight at all (`AutoCombat.switchedOn`). */
  combatOn(): boolean;
  /** A move the server has still to run (`CharacterTracker.pendingMoves`). */
  moveInFlight(): boolean;
  /** `Recovery` would sit the character down, or a rest is on its way. */
  wantsRest(state: CharacterState): boolean;
  /** A walk, an escape or a trip owns the character. */
  busy(): boolean;
  notice(message: string): void;
  /** What the card draws moved. */
  changed(): void;
}

/** The command out and not yet answered. */
interface Owed {
  kind: 'dig' | 'climb' | 'count';
  /** For a dig: whether the server's dig line came back, which starts the delay. */
  dug: boolean;
}

/** Lines that land between a dig and its roll and say nothing about the dig. */
const UNRELATED: ReadonlySet<Block['domain']> = new Set([
  'room',
  'presence',
  'conversation',
  'combat',
  'status',
  'session'
]);

export class TreasureDig implements SessionModule {
  private on = false;
  private status: DigStatus = 'off';
  private detail: string | null = null;
  private dug = 0;
  private finds: string[] = [];
  private falls = 0;
  private inPit = false;
  private owed: Owed | null = null;
  /** An `i` is owed before the next dig: the run's first, after a find, or after an unread answer. */
  private countOwed = false;
  /** When the `i` owed was sent; an inventory read before it does not answer. */
  private countAskedAt: number | null = null;
  /** Digs in a row answered without the dig line; two with a spade in the inventory stop the run. */
  private refusals = 0;
  private lastRefusal: string | null = null;
  /** A refused `climb out` (a monster here) is tried again after this. */
  private climbAfter = 0;
  /**
   * Ends what was owed when nothing answers it: the delay running out on a
   * roll that prints nothing, or a command with no answer at all. A pit at
   * full health prints no prompts to wake the run.
   */
  private answerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private enabled: boolean,
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly events: DigEvents,
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** The socket closed or the character changed: a run does not outlive it. */
  reset(): void {
    if (this.on) this.events.notice(t('automation.dig.stoppedByReset'));
    this.stop('off', null);
  }

  dispose(): void {
    this.on = false;
    this.clearTimer();
  }

  get view(): DigView {
    return {
      id: 'treasure-dig',
      on: this.on,
      status: this.status,
      spades: this.spades(this.events.stateNow()),
      dug: this.dug,
      finds: [...this.finds],
      falls: this.falls,
      detail: this.detail
    };
  }

  /** The card's switch. Starting counts the spades first. */
  set(on: boolean): void {
    if (on === this.on) return;
    if (!on) {
      this.events.notice(t('automation.dig.switchedOff', { dug: this.dug }));
      this.stop('off', null);
      return;
    }
    this.on = true;
    this.dug = 0;
    this.finds = [];
    this.falls = 0;
    this.refusals = 0;
    this.lastRefusal = null;
    this.countOwed = true;
    this.countAskedAt = null;
    this.owed = null;
    this.events.notice(t('automation.dig.switchedOn'));
    this.decide(this.events.stateNow());
  }

  onBlock(block: Block): void {
    if (!this.on) return;
    // The fall is the dig's whole answer; the pit's own prompt follows.
    if (block.type === 'user-dig-collapses') {
      this.inPit = true;
      this.falls += 1;
      this.end();
      return;
    }
    if (block.type === 'user-climbs-out') {
      this.inPit = false;
      this.end();
      return;
    }
    const owed = this.owed;
    /*
     * A find is kept however late it lands: the delay is GreaterMUD's four
     * seconds and a guessed tick, and a roll after it ran out is still this
     * run's. It ends only a dig whose dig line came.
     */
    if (block.type === 'user-dig-finds') {
      const item = block.groups['item']?.trim() ?? '';
      if (item !== '') this.finds.push(item);
      this.events.notice(t('automation.dig.found', { item }));
      // The find went into the inventory, so it is read before the next dig.
      this.countOwed = true;
      if (owed?.kind === 'dig' && owed.dug) this.end();
      else this.events.changed();
      return;
    }
    if (owed === null) return;
    switch (owed.kind) {
      case 'climb':
        this.climbAnswer(block);
        return;
      case 'count':
        // Ended by the inventory (`next`) or the timer.
        return;
      case 'dig':
        this.digAnswer(owed, block);
        return;
      default: {
        const never: never = owed.kind;
        return never;
      }
    }
  }

  onCharacter(state: CharacterState): void {
    if (!this.on) return;
    this.decide(state);
  }

  private climbAnswer(block: Block): void {
    if (block.type === 'room-command-refused') {
      // `nomonsters`: something here the room did not show yet.
      this.climbAfter = this.now() + tuning().dig.climbRetryMs;
      this.end();
      this.arm(tuning().dig.climbRetryMs);
      return;
    }
    if (isPrompt(block.type)) this.end();
  }

  private digAnswer(owed: Owed, block: Block): void {
    if (block.type === 'user-digs') {
      owed.dug = true;
      this.dug += 1;
      this.refusals = 0;
      // The delay starts here; a roll that prints nothing is over when it runs out.
      this.arm(tuning().dig.delayMs);
      this.events.changed();
      return;
    }
    if (!owed.dug) {
      // Before the dig line: the refusal, or a line that says nothing about the dig.
      // A late `Nothing.` is the last dig's roll, never this one's refusal.
      const text = block.text.trim();
      if (!isPrompt(block.type) && !UNRELATED.has(block.domain) && text !== DIG.nothing) {
        this.lastRefusal = text;
      }
      return;
    }
    // The roll printed: the delay is over.
    if (block.text.trim() === DIG.nothing || block.type === 'room-exits') {
      this.end();
      return;
    }
    // A line the roll does not explain: a spade breaking. The inventory says.
    if (!isPrompt(block.type) && !UNRELATED.has(block.domain)) this.countOwed = true;
  }

  /** What was owed is answered; the run decides once the line has been applied. */
  private end(): void {
    this.owed = null;
    this.clearTimer();
    this.events.changed();
    queueMicrotask(() => {
      if (this.on) this.decide(this.events.stateNow());
    });
  }

  /** Nothing answered in time. A dig with no dig line is a refusal, and the inventory says why. */
  private unanswered(): void {
    this.answerTimer = null;
    const owed = this.owed;
    if (!this.on) return;
    if (owed?.kind === 'dig' && !owed.dug) {
      this.refusals += 1;
      this.countOwed = true;
    }
    this.owed = null;
    this.decide(this.events.stateNow());
  }

  private arm(ms: number): void {
    this.clearTimer();
    this.answerTimer = setTimeout(() => this.unanswered(), ms);
    this.answerTimer.unref?.();
  }

  private spades(state: CharacterState): number | null {
    return state.inventory.listedAt === null ? null : carriedCount(state, DIG.spade);
  }

  private decide(state: CharacterState): void {
    const status = this.next(state);
    if (status !== this.status) {
      this.status = status;
      this.events.changed();
    }
  }

  /** What the run does now, sending it if anything; the status it is in. */
  private next(state: CharacterState): DigStatus {
    if (state.phase !== 'in-game') return this.status;
    if (this.owed?.kind === 'count' && this.countAnswered(state)) this.end();
    if (this.owed !== null) return this.status;
    if (!this.enabled) return this.held('unswitched', t('automation.dig.masterOff'));
    if (!this.events.combatOn()) return this.held('unswitched', t('automation.dig.combatOff'));
    if (fightHere(state, this.events.signs, this.now())) return this.held('fighting', null);
    if (monstersHere(state)) {
      const names = state.room.occupants.filter((one) => one.kind !== 'player');
      const monsters = names.map((one) => one.name).join(', ');
      return this.held('unfought', t('automation.dig.unfought', { monsters }));
    }
    if (state.vitals.resting || state.vitals.meditating || this.events.wantsRest(state)) {
      return this.held('resting', null);
    }
    if (this.events.busy() || this.events.moveInFlight()) return this.status;

    if (this.countOwed) return this.count(state);
    const spades = this.spades(state);
    if (spades === 0) {
      this.events.notice(t('automation.dig.noSpades', { dug: this.dug }));
      return this.stop('done', null);
    }
    if (this.refusals >= tuning().dig.refusals) {
      const line = this.lastRefusal ?? t('automation.dig.noAnswer');
      this.events.notice(t('automation.dig.refused', { line }));
      return this.stop('refused', line);
    }
    if (this.inPit) {
      const refused = this.now() >= this.climbAfter ? this.send('climb', DIG.climb) : null;
      return this.held('climbing', refused);
    }
    if (!state.room.items.some((item) => nameAnswersTo(bareName(item.name), DIG.ground))) {
      return this.held('no-ground', t('automation.dig.noGround', { room: state.room.name ?? '' }));
    }
    return this.held('digging', this.send('dig', DIG.command));
  }

  /** Whether an inventory was read since the `i` went out. */
  private countAnswered(state: CharacterState): boolean {
    const asked = this.countAskedAt;
    return asked !== null && state.inventory.listedAt !== null && state.inventory.listedAt >= asked;
  }

  /** Asks the inventory; once it is read the dig decides again, and an unanswered `i` is asked again. */
  private count(state: CharacterState): DigStatus {
    if (this.countAnswered(state)) {
      this.countOwed = false;
      this.countAskedAt = null;
      return this.next(state);
    }
    return this.held('counting', this.send('count', 'i'));
  }

  private held(status: DigStatus, detail: string | null): DigStatus {
    if (detail !== this.detail) {
      this.detail = detail;
      this.events.changed();
    }
    return status;
  }

  private stop(status: DigStatus, detail: string | null): DigStatus {
    this.on = false;
    this.status = status;
    this.detail = detail;
    this.owed = null;
    this.inPit = false;
    this.countOwed = false;
    this.countAskedAt = null;
    this.climbAfter = 0;
    this.clearTimer();
    this.events.changed();
    return status;
  }

  private clearTimer(): void {
    if (this.answerTimer === null) return;
    clearTimeout(this.answerTimer);
    this.answerTimer = null;
  }

  /** Offers the command; why the queue would not take it, or null. */
  private send(kind: Owed['kind'], command: string): string | null {
    const offered = this.queue.offer({
      command,
      // The dig is the character's task, like a walk; the `i` is an ask like any other.
      priority: kind === 'count' ? 'probe' : 'movement',
      coalesceKey: `treasure-dig:${kind}`,
      expiresAt: this.now() + tuning().dig.expiresMs,
      // A monster walking in, or the fight it starts, between the proposal and the send.
      stillWanted: () => {
        const now = this.events.stateNow();
        return this.on && !fightIsRunning(now) && (kind === 'count' || !monstersHere(now));
      },
      onSent: () => {
        if (kind === 'count') this.countAskedAt = this.now();
        this.owed = { kind, dug: false };
        this.arm(tuning().dig.answerMs);
      },
      reason: t('automation.dig.reason')
    });
    return taken(offered) ? null : t('automation.dig.notQueued', { reason: whyNotQueued(offered) });
  }
}
