/**
 * What the server still owes this client, settled: the ordered answer a
 * locate gives, the probe sent after a step left unanswered, and the
 * write-off on the claim's own clock, each said out loud once; and the one
 * question, `rm`, that a lost lap and a scattered walk both ask. Settled off
 * every line and off the session's reconsider tick, and owning no state of
 * its own: the claims are the tracker's. See `mudengine-wire` ›
 * `parts/room.md`, and `mudengine-session` › *The rest of the session's
 * decisions are units beside it*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { AutoCombat } from '../automation/AutoCombat';
import type { CommandQueue, QueueRefusal } from '../automation/CommandQueue';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { Vocabulary } from './Vocabulary';

/** Where the claims are kept, who asks, who is told a step is owed, and the word that asks. */
export interface ClaimsParts {
  readonly tracker: Pick<
    CharacterTracker,
    'takeSettledByLocate' | 'staleProbe' | 'expireStaleClaims' | 'pendingMoves' | 'locateRefused'
  >;
  readonly queue: Pick<CommandQueue, 'offer'>;
  readonly combat: Pick<AutoCombat, 'noteMovePending'>;
  readonly vocabulary: Pick<Vocabulary, 'locateWord'>;
}

/**
 * What a locate ask came to: the word on its way (sent, or joined to the same
 * ask already waiting), or why nothing went (todo 767). `unavailable` is a
 * realm with no word as well as one the queue retired untried.
 */
export type LocateAsk = { readonly asked: string } | { readonly refused: QueueRefusal };

/** What the session that built this answers for it. */
export interface ClaimsSession {
  notice(message: string): void;
}

export class Claims {
  private readonly tracker: ClaimsParts['tracker'];
  private readonly queue: ClaimsParts['queue'];
  private readonly combat: ClaimsParts['combat'];
  private readonly vocabulary: ClaimsParts['vocabulary'];

  constructor(
    parts: ClaimsParts,
    private readonly session: ClaimsSession
  ) {
    this.tracker = parts.tracker;
    this.queue = parts.queue;
    this.combat = parts.combat;
    this.vocabulary = parts.vocabulary;
  }

  /**
   * Ask the realm where the character is standing.
   *
   * `rm` answers with coordinates — the only exact statement of position this
   * server makes — and the tracker takes them outright (`user-profile`).
   *
   * Only where the realm has the word. **MajorMUD does not**, and a command
   * this server family does not have is not refused quietly: it is *said out
   * loud in the room*. So the first `You say "rm"` retires it for the session,
   * and whoever asked falls back to what it does anyway — waiting for the next
   * room block and re-deriving. That fallback is the whole client on a realm
   * with no locate command, which is why the reckoning above it had to be
   * right rather than merely recoverable.
   *
   * One coalesce key for both callers, because it is one question: a lap that
   * lost its place and a walk that has just been scattered want the same
   * sentence back, and two keys would spend two commands on it.
   *
   * Returns the word asked, or why nothing was, so a caller waiting on the
   * answer (`Locating`) knows whether one is coming and can say why not.
   * `reason` is who asked, for the Room card's button (todo 811). The queue's
   * own refusal is the answer (todo 767): a lineage already read as MajorMUD
   * retires the word untried (`unavailable`, todo 762), and automation off, a
   * held screen or no socket send nothing either, where reporting them asked
   * had `Locating` wait out its window to say *asked* about nothing.
   */
  askWhereIAm(reason = t('session.loop.locateReason')): LocateAsk {
    const word = this.vocabulary.locateWord;
    if (word === null) return { refused: 'unavailable' };
    const offered = this.queue.offer({
      command: word,
      priority: 'probe',
      coalesceKey: 'loop-locate',
      expiresAt: Date.now() + tuning().session.locateExpiresMs,
      reason
    });
    return offered === 'queued' || offered === 'joined' ? { asked: word } : { refused: offered };
  }

  /**
   * The realm refused `rm`, which is an ordered answer all the same: what was
   * sent before it is not coming (todo 10). See `Vocabulary.noteWordMissing`.
   */
  locateRefused(): void {
    for (const lost of this.tracker.locateRefused()) {
      this.session.notice(t('session.walk.claimSettledByLocate', { command: lost.command }));
    }
  }

  /**
   * What the server still owes, settled: the probe, the ordered answer and the
   * write-off. Run on every block and on the session's reconsider tick,
   * because both of its clocks are clocks: a probe asked only when the next
   * line arrived went out after a silence long enough to have written the
   * step off, and the probe then kept alive a claim the arriving room was
   * then credited to. `mudengine-wire` § A step unanswered is probed has the
   * rule.
   */
  settle(): void {
    /*
     * **What the server still owes this client is a fact about the wire, so it
     * is read off every line rather than off the ones that moved the HUD.**
     *
     * Both halves of it used to sit inside `act`'s `if (changed)`, among the
     * things that *decide* — and the answer to a step is not a decision. A
     * refusal (`There is no exit in that direction!`) answers a move and
     * changes nothing else, so the client learned the step had landed only on
     * whatever line happened to change something next.
     *
     * `expireStaleClaims` is the other half, and it is the one the report was
     * actually about. A step nothing ever answers used to stay outstanding for
     * the rest of the session, and six things gate on that: running away,
     * `Walker.start`, a loop's next leg, the walk home and auto-combat. Exactly
     * one of them — auto-combat — had a clock, so it recovered after eight
     * seconds, said so, and left the character unable to run, walk or loop for
     * the whole evening with nothing further said. The bound moved to the claim
     * itself so they all recover together, and this is where it is said out
     * loud: once, naming the command, because "a step went unanswered" is a
     * sentence a player can only agree with.
     */
    /*
     * Before the flat clock, the probe (todo 10). A step unanswered for
     * `staleProbeMs` has `rm` sent after it; the server answers in order, so
     * a `Location:` arriving with the step still unanswered proves the step
     * produced nothing and drops it at once, while a probe still unanswered
     * proves the server is slow and the step waits — up to `staleMoveMaxMs`.
     * A `n` answered nine seconds late cost a loop its place, five `rm`s and
     * a stop, all for a room that then arrived.
     */
    for (const lost of this.tracker.takeSettledByLocate()) {
      this.session.notice(
        lost.moved
          ? t('session.walk.claimSettledByLocate', { command: lost.command })
          : t('session.walk.readSettledByLocate', { command: lost.command })
      );
    }
    const word = this.vocabulary.locateWord;
    if (word !== null) {
      const probed = this.tracker.staleProbe(Date.now());
      if (probed !== null) {
        this.queue.offer({
          command: word,
          priority: 'probe',
          coalesceKey: 'stale-probe',
          expiresAt: Date.now() + tuning().parse.staleMoveMaxMs,
          reason: t('session.walk.probeReason')
        });
        const seconds = Math.round(tuning().parse.staleProbeMs / 1000);
        this.session.notice(
          probed.length === 0
            ? t('session.walk.claimProbedUntyped', { seconds })
            : t('session.walk.claimProbed', { command: probed, seconds })
        );
      }
    }
    const lapsed = this.tracker.expireStaleClaims(Date.now());
    // Several bare re-reads lapsing together are one sentence, not one each.
    const bareReads = lapsed.filter((lost) => !lost.moved && lost.command.length === 0).length;
    for (const lost of lapsed) {
      const seconds = this.staleMoveSeconds;
      /*
       * Five literal keys rather than one composed sentence, because
       * `i18n-coverage.test.ts` reads the key straight after `t(` — and
       * because only a **move** held anything. `pendingMoves` counts moves
       * alone, so a lapsed peek or bare Enter gated neither the escape nor the
       * walker nor a loop, and saying it had was a sentence that was false
       * about once a session (a bare Enter goes unanswered about once in three
       * thousand).
       */
      if (lost.moved) {
        this.session.notice(
          lost.command.length === 0
            ? t('session.walk.claimLapsedUntyped', { seconds })
            : t('session.walk.claimLapsed', { command: lost.command, seconds })
        );
      } else if (lost.command.length > 0) {
        this.session.notice(t('session.walk.readLapsed', { command: lost.command, seconds }));
      } else if (bareReads === 1) {
        this.session.notice(t('session.walk.readLapsedUntyped', { seconds }));
      }
    }
    if (bareReads > 1) {
      this.session.notice(
        t('session.walk.readLapsedSeveral', { count: bareReads, seconds: this.staleMoveSeconds })
      );
    }
    this.combat.noteMovePending(this.tracker.pendingMoves > 0);
  }

  /** The lapse the notice quotes, in whole seconds. Read, never captured. */
  private get staleMoveSeconds(): number {
    return Math.round(tuning().parse.staleMoveMs / 1000);
  }
}
