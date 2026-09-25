/**
 * Where the character is standing, asked for before a plan that needs it
 * (todo 812). A Goto or a Loop pressed in a room the client cannot place used
 * to be refused at once, leaving the player to press the Room card's locate
 * and ask again. This asks the realm through `Claims` (the one locate ask,
 * through the arbiter) and waits for the character's own publish to place it,
 * up to `tuning.session.locateResolveMs`; the caller then plans, and a room
 * still unplaced is refused in the words it always was. Free when the room is
 * placed, outside the realm, or where the realm has no locate word. The Room
 * card's locate button asks here too (todo 811). See `mudengine-session` ›
 * *The rest of the session's decisions are units beside it*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { QueueRefusal } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { Claims } from './Claims';
import type { SessionSink } from './SessionSink';
import type { CharacterState } from '../../shared/character';
import { roomAddress } from '../../shared/world';

/** Where the character stands, and the ask that says where. */
export interface LocatingParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly claims: Pick<Claims, 'askWhereIAm'>;
}

/** One wait in flight: every caller shares it, as they share the one `rm`. */
interface Waiting {
  readonly placed: Promise<boolean>;
  readonly settle: (placed: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class Locating implements SessionModule {
  private waiting: Waiting | null = null;

  constructor(
    private readonly parts: LocatingParts,
    private readonly sink: Pick<SessionSink, 'notice'>
  ) {}

  /**
   * True once the character is placed: at once when it already is, or when
   * the answer to the locate word places it. False at once where nothing can
   * be asked (outside the realm; a realm set to `none`, which the player
   * chose; one that refused its word, which `Vocabulary` has already said),
   * false with a notice where the queue sent nothing (automation off, a held
   * screen, no socket: todo 767), and false with a notice when the window
   * lapses. Never rejects.
   */
  placed(): Promise<boolean> {
    const state = this.parts.tracker.current;
    if (roomAddress(state.room) !== null) return Promise.resolve(true);
    if (state.phase !== 'in-game') return Promise.resolve(false);
    if (this.waiting !== null) return this.waiting.placed;
    const ask = this.parts.claims.askWhereIAm();
    if ('refused' in ask) {
      if (ask.refused !== 'unavailable') this.sink.notice(notAsked(ask.refused));
      return Promise.resolve(false);
    }
    const word = ask.asked;
    let settle: (placed: boolean) => void = () => undefined;
    const placed = new Promise<boolean>((resolve) => (settle = resolve));
    const ms = tuning().session.locateResolveMs;
    const timer = setTimeout(() => {
      this.finish(false);
      this.sink.notice(
        t('session.loop.locateUnresolved', { command: word, seconds: Math.round(ms / 1000) })
      );
    }, ms);
    // Never the reason a process stays alive; `dispose` clears it regardless.
    timer.unref?.();
    this.waiting = { placed, settle, timer };
    return placed;
  }

  /**
   * The Room card's locate button (todo 811): the one locate ask, in the
   * realm's own word, as a card asking. Where nothing went (the realm has no
   * word, or the queue refused it: todo 767) the press is refused out loud,
   * since a button that does nothing silently reads as a broken one.
   */
  ask(): boolean {
    // Never at a menu: a press racing a phase change would send `rm` there.
    if (this.parts.tracker.current.phase !== 'in-game') return false;
    const ask = this.parts.claims.askWhereIAm(t('session.probe.askedFromCard'));
    if ('asked' in ask) return true;
    this.sink.notice(notAsked(ask.refused));
    return false;
  }

  /**
   * The character as published: a room placed ends the wait, and so, quietly,
   * does leaving the realm, since a lost socket puts no module down and a
   * notice about `rm` after *Disconnected* would be about nothing.
   */
  onCharacter(state: CharacterState): void {
    if (this.waiting === null) return;
    if (roomAddress(state.room) !== null) this.finish(true);
    else if (state.phase !== 'in-game') this.finish(false);
  }

  /**
   * The realm refused the locate word (`Vocabulary`, beside `Claims`): that
   * is the answer, so the wait ends now and quietly (todo 762). `Vocabulary`
   * has said the realm lacks it; the lapse would have been a second sentence
   * about the same ask, four seconds later, on every MajorMUD press.
   */
  locateRefused(): void {
    this.finish(false);
  }

  /** The character that was waited for is gone; its callers are answered, not left hanging. */
  reset(): void {
    this.finish(false);
  }

  dispose(): void {
    this.finish(false);
  }

  private finish(placed: boolean): void {
    const waiting = this.waiting;
    if (waiting === null) return;
    this.waiting = null;
    clearTimeout(waiting.timer);
    waiting.settle(placed);
  }
}

/** Why a locate ask sent nothing, one sentence per refusal the queue gives. */
function notAsked(refusal: QueueRefusal): string {
  switch (refusal) {
    case 'unavailable':
      return t('session.loop.locateNone');
    case 'held':
      return t('session.loop.locateHeld');
    case 'offline':
      return t('session.loop.locateOffline');
    case 'switched-off':
      return t('session.loop.locateSwitchedOff');
    case 'expired':
      return t('session.loop.locateExpired');
    default: {
      const unreachable: never = refusal;
      return unreachable;
    }
  }
}
