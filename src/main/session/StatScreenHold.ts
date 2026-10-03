/**
 * The arbiter stood down while the stat screen has the terminal, and given the
 * command line back only by a prompt that answers `train stats` or leaves the
 * screen. A prompt the server prints before it reaches the ask answers an
 * earlier command (todo 02b: the level's own `train`, a room repaint), and
 * releasing on it sent `st` into the family name field. The order comes from
 * the ask's echo, as `StatScreen` reads it (todo 116). See `mudengine-automation`
 * › *A screen that is not a command prompt stands the whole arbiter down*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { isPrompt, type Block } from '../../shared/blocks';
import { opensStatScreen } from '../../shared/commands';
import { echoesStatScreenAsk } from '../automation/StatScreen';
import type { CommandQueue } from '../automation/CommandQueue';
import type { Publisher } from './Publisher';
import type { SessionSink } from './SessionSink';

export class StatScreenHold {
  /** `train stats` sent and not yet echoed: the server has not reached them. */
  private unechoed = 0;
  /** When the last of them was sent, for an echo that never comes. */
  private askedAt = 0;

  constructor(
    private readonly queue: Pick<CommandQueue, 'hold' | 'release' | 'holding'>,
    private readonly publisher: Pick<Publisher, 'noteSafety'>,
    private readonly sink: Pick<SessionSink, 'notice'>,
    /** What is left of a talk-box line, dropped and said as the hold starts. */
    private readonly dropTyped: () => void
  ) {}

  /**
   * A command left the client, the player's or the arbiter's. A `train stats`
   * arms the hold a round trip before the screen: the server answers it with
   * no prompt, so the next drain would otherwise send into the form.
   */
  noteSent(command: string, now: number): void {
    if (!opensStatScreen(command)) return;
    // A hold `clear()` lifted (a reset, the realm left) took its asks with it.
    if (this.queue.holding === null) this.unechoed = 0;
    this.unechoed += 1;
    this.askedAt = now;
    this.hold(t('session.stats.asked'), now);
  }

  /** Every block, ahead of every module: none may propose while the screen is up. */
  onBlock(block: Block, now: number): void {
    if (block.type === 'user-stats-screen') {
      // The server is in the form; the next prompt is the way out of it.
      this.unechoed = 0;
      this.hold(t('session.stats.screen'), now);
    } else if (echoesStatScreenAsk(block)) {
      this.unechoed = Math.max(0, this.unechoed - 1);
    } else if (block.type === 'user-stats-assigned') {
      /*
       * The exit sentence releases too (todo 115): `SAVE` prints the
       * suicide-password paragraph and the room *before* the prompt, and the
       * `st` it triggers went to a held queue and was dropped.
       */
      this.release();
    } else if (isPrompt(block.type) && !this.awaitingEcho(now)) {
      // Any prompt, not the status line alone: `SAVE` comes back to the
      // realm's prompt and `QUIT` to the character menu.
      this.release();
    }
  }

  /**
   * An ask the server has not reached. An echo that never comes (a realm that
   * does not echo it) is waited for `train.echoMs`, as `StatScreen` waits, so
   * the hold cannot outlast the session on a missing echo.
   */
  private awaitingEcho(now: number): boolean {
    return this.unechoed > 0 && now - this.askedAt < tuning().train.echoMs;
  }

  /**
   * Cleared rather than paused: what is queued was decided for a character
   * standing in a room, and the server has already run `Player.Exits()` on
   * them. Said once and recorded beside every other refusal, because a client
   * that silently stops automating looks like one that has crashed.
   */
  private hold(because: string, now: number): void {
    if (this.queue.holding === null) this.dropTyped();
    if (!this.queue.hold(because)) return;
    this.sink.notice(t('session.stats.held'));
    this.publisher.noteSafety({ at: now, action: 'stat screen', because, acted: true });
  }

  private release(): void {
    this.unechoed = 0;
    if (!this.queue.release()) return;
    this.sink.notice(t('session.stats.released'));
  }
}
