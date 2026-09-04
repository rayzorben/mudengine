/**
 * The standing routines: what the client does on its own, and when.
 *
 * Two of them, both descended from the CoffeeScript engine's
 * `automation/events.coffee`:
 *
 * - **On entering the realm**, ask the questions that populate the HUD. The
 *   server volunteers almost nothing — the status line carries no maxima, no
 *   level, no inventory — so this is how a freshly connected client stops
 *   showing dashes. The list mirrors the original's `onGameEnter`, which
 *   cleared the queue and pushed `sc, pro, l, st, i, exp` (`user.coffee`).
 *   `sc` is *scan*, not score: it shares the `Current Adventurers` block with
 *   `who`, which is why the legacy `WhoList` accepted abbreviations of both.
 * - **When idle**, send the idle command. The original did this purely as a
 *   keep-alive (`user.keepAlive`, `idleCommand: 'l'` in the character config);
 *   `l` re-reads the room, so it doubles as a cheap refresh after someone else
 *   has moved things around. Idle means **this client has sent nothing**, not
 *   that the wire has been quiet — see `noteSent`, which is where reading it
 *   the other way made the keep-alive unreachable on a server that repaints
 *   its own status line every thirty seconds.
 *
 * The original drained its backlog one command per status line, below movement
 * and below the player typing (`onStep` → `onIdle`). That is the same shape as
 * the arbiter's prompt credit and its `probe` band, so the routine only has to
 * say *what* to ask; the queue already knows when.
 *
 * Both are *proposals*. They go into the queue like anything else and the
 * arbiter decides when — or whether — they reach the wire. Nothing here writes
 * to the socket, which is the whole point of §6.
 *
 * A third followed them: **refreshing the realm roster after an unlisted
 * arrival**. `player-enters` and `player-arrives-room` are broadcasts the
 * server volunteers for free, same as everything the roster is maintained
 * from — but asking `who` to resolve what they mean costs a command from the
 * budget walking and fighting spend from, same as the realm-entry probe.
 * Firing it on every arrival would be one `who` per adventurer in a busy room,
 * so it is **debounced**: the first arrival asks, and every arrival inside
 * `tuning.queue.rosterAskMs` is answered by that same listing.
 *
 * It rode on the idle tick alone until 2026-09-02, which was the wrong clock
 * twice over: it needed `idle.enabled`, and it needed the character to have
 * stopped doing anything for the configured quiet period. A character that
 * fights and walks all evening never goes quiet, so the roster stayed exactly
 * as stale as the last listing left it — reported as a `who` listing on screen
 * with the Player flyout calling somebody on it *offline*. The idle tick is
 * still a drain, because quiet is the best moment to spend a command; it is no
 * longer the only one. See CLAUDE.md "Every listing is seeded by a command and
 * maintained for free".
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { AutomationConfig } from '../../shared/config';
import type { CharacterState } from '../../shared/character';
import type { Block } from '../../shared/blocks';
import { tuning } from '../app/tuning';

export interface RoutineEvents {
  notice?(message: string): void;
}

export class Routines {
  /** Whether the realm-entry probe has already run this session. */
  private probed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastSent = Date.now();
  /**
   * Somebody arrived without a listing to explain them, and no listing has
   * resolved it since.
   *
   * A flag rather than a count: the queued `who` answers every unlisted
   * arrival at once, so how many there are does not change what to do about
   * it, only whether to bother.
   */
  private rosterUnknown = false;
  /**
   * When the roster catch-up last sent a `who`, so the next one is a debounce
   * rather than a queue of them.
   *
   * `0` rather than `Date.now()`: the first arrival of a session should ask,
   * and starting the clock at construction would silence the first minute —
   * which is exactly the minute a character that has just connected knows
   * least about who is in the realm.
   */
  private rosterAskedAt = 0;
  /**
   * People seen in the room whose kit this character has not looked at.
   *
   * A queue rather than a flag, unlike `rosterUnknown`: one `who` answers every
   * unlisted arrival at once, but a look answers about exactly one person, so
   * how many there are is precisely what decides how many commands to spend.
   *
   * Names already looked at stay out of it for the session — what somebody is
   * wearing changes rarely, and re-looking would spend a command and announce
   * this character again for an answer that has not moved.
   */
  private toLookAt: string[] = [];
  private lookedAt = new Set<string>();
  /**
   * Which listing the spellbook ask sent this session, or null while it has
   * not — a second one-shot latch beside `probed`, and separate from it
   * because the two fire at different moments: the entry probe fires on the
   * first status line, and which book to ask for is not known until the wire
   * has said `KAI=` or `MA=` (the prompt, the stat sheet, or a listing).
   */
  private askedBook: 'spells' | 'powers' | null = null;
  /** The wrong-book correction has run, so it can only run once. */
  private bookCorrected = false;

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: RoutineEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
    this.armIdle();
  }

  /** New connection: forget that we ever probed, and who we looked at. */
  reset(): void {
    this.probed = false;
    this.toLookAt = [];
    this.lookedAt.clear();
    this.rosterUnknown = false;
    this.rosterAskedAt = 0;
    this.askedBook = null;
    this.bookCorrected = false;
    this.lastSent = Date.now();
    this.stopIdle();
  }

  /**
   * Called whenever character state changes.
   *
   * The probe fires on the transition into the realm, once. `phase` becoming
   * `in-game` is the status line arriving, which is also the moment the server
   * is ready to answer questions.
   */
  onCharacter(state: CharacterState): void {
    if (state.phase !== 'in-game') return;
    if (!this.probed) {
      this.probed = true;
      /*
       * Armed here unconditionally, before the enabled check below.
       *
       * It used to sit after the probe commands were built and only ran when
       * there were some — so a character configured with an empty
       * `onEnterRealm` (a real choice: "never ask on the way in") never armed
       * the idle clock at all, for the entire session. Nothing else arms it
       * except a config *reload*, which does not happen just from playing. The
       * keep-alive and the roster catch-up both depend on this clock, and
       * neither has anything to do with whether there happen to be entry
       * probes configured.
       */
      this.armIdle();

      const commands = this.config.onEnterRealm;
      if (this.config.enabled && commands.length > 0) {
        for (const command of commands) {
          this.queue.enqueue({
            command,
            priority: 'probe',
            // One `st` is as good as two. Coalescing by intent rather than by
            // text is what lets this be safe.
            coalesceKey: `probe:${command}`,
            reason: t('automation.routines.reasonEnterRealm')
          });
        }

        this.events.notice?.(
          t('automation.routines.enteringRealm', { commands: commands.join(', ') })
        );
      }
    }
    /*
     * After the entry batch, never before it: both land in the probe band in
     * enqueue order, and `rm` — the position fix — keeps the head of it. Not
     * *inside* the batch either, because which book this character owns may
     * not be known until the stat sheet the batch itself asks for answers.
     */
    this.askSpellbook(state);
    /*
     * And the third drain of the roster flag, for a character that neither
     * goes quiet nor sees another arrival: the window opens mid-fight as
     * readily as anywhere else, and state changes on every status line. The
     * debounce inside `askRoster` is what makes this safe to call from the
     * busiest path in the client.
     */
    this.askRoster();
  }

  /**
   * The party changed, so ask what it is now.
   *
   * The roster is the only place another character's health is visible, and it
   * is only as current as the last `party` — so a party card that waits for
   * somebody to type one is a card that is empty at exactly the moment it
   * became worth having.
   *
   * The same class of thing as the realm-entry probe, and defensible for the
   * same reason: it populates a readout from an otherwise silent server, once,
   * on a transition. Not periodic — a rule does that, with `partySize`, because
   * how often to spend a command on it is a judgement about how the character
   * is being played.
   *
   * Coalesced by intent, so somebody inviting three people in one breath asks
   * once.
   */
  onPartyChanged(): void {
    if (!this.config.enabled) return;
    const command = this.config.onPartyChange;
    if (command.length === 0) return;
    this.queue.enqueue({
      command,
      priority: 'probe',
      coalesceKey: 'probe:party',
      reason: t('automation.routines.reasonPartyChanged')
    });
  }

  /**
   * Somebody was noticed — entering the realm, or walking into this room —
   * with no listing on file to say what they are.
   *
   * Raises the flag and asks straight away when the debounce window is open —
   * `askRoster` is the one place that decides. Waiting for the idle tick was
   * the whole of this before, and it was too weak a trigger: a character that
   * fights and walks all evening is never idle, so the roster was as stale as
   * whatever the last listing left, for the whole session.
   *
   * An arrival inside the window sets the flag and sends nothing — one `who`
   * answers every unlisted arrival at once, which is why this is a flag and
   * not a count.
   */
  onRosterUnknown(): void {
    this.rosterUnknown = true;
    this.askRoster();
  }

  /**
   * A listing arrived — from this routine's own `who` or a typed one — and
   * resolved whatever was unknown.
   *
   * The clock moves too, and that is the point of taking a *typed* listing as
   * well as an asked-for one: somebody who types `who` themselves has just
   * spent the command this would have spent, and asking again a second later
   * would be the client talking over them.
   */
  onWhoListing(): void {
    this.rosterUnknown = false;
    this.rosterAskedAt = Date.now();
  }

  /**
   * The roster catch-up: one `who`, at most once a minute.
   *
   * **A debounce, not a quiet period.** This used to ride on the idle tick
   * alone, which needs `idle.enabled` *and* a character that has stopped doing
   * anything for the configured period — so a character that fights and walks
   * all evening never asked, and the roster stayed as stale as the last
   * listing left it. The symptom was a `who` listing on screen and the Player
   * flyout calling somebody on it offline.
   *
   * The flag is kept beside the clock rather than replaced by it: an arrival
   * inside the window is still unresolved, and the idle tick and the next
   * state change both drain it once the window opens. `rosterAskedAt` moves
   * before the send, the same eager clearing the flag has always had — a `who`
   * queued behind combat must not be asked for again on the next arrival.
   */
  private askRoster(): void {
    if (!this.rosterUnknown || !this.probed) return;
    /*
     * The switch, stated here rather than left to the band.
     *
     * On the idle tick alone this was gated twice by accident of where it
     * lived — `armIdle` returns without arming unless `enabled` *and*
     * `idle.enabled` are on. Moving it off that tick took both away, and what
     * was left holding it was `CommandQueue.enqueue` refusing anything but
     * `user` while automation is off: true, and the wrong place for the only
     * copy of a decision.
     *
     * `idle.enabled` is deliberately **not** re-imposed: that switch says
     * *never send a keep-alive*, which is a different sentence from *never
     * refresh the roster*, and it only ever governed this by accident of one
     * timer serving both.
     */
    if (!this.config.enabled) return;
    const since = Date.now() - this.rosterAskedAt;
    if (since < tuning().queue.rosterAskMs) return;

    this.rosterUnknown = false;
    this.rosterAskedAt = Date.now();
    this.queue.enqueue({
      command: 'who',
      priority: 'idle',
      coalesceKey: 'idle:who',
      reason: t('automation.routines.reasonRosterUnknown')
    });
  }

  /**
   * Ask for the book this character owns, once, as soon as the wire has said
   * which that is: `KAI=` in the prompt or `Kai:` on the stat sheet means
   * `powers`, `MA=`/`Mana:` means `spells`, and a character the wire has
   * said neither about is asked nothing — a warrior's prompt simply has no
   * mana field, and a guess sent to a realm that does not know the word is
   * *spoken out loud in the room*.
   *
   * The **full words**, not `sp`/`pow`: both full words are in the realm's
   * own table (docs/greatermud/commands.md), and the corpus's one MajorMUD
   * spellbook (captures/056) was produced by the full word too — the short
   * forms are evidenced only on GreaterMUD.
   */
  private askSpellbook(state: CharacterState): void {
    if (!this.config.enabled) return;
    if (this.askedBook !== null) return;
    const kind = state.vitals.manaType;
    if (kind === null) return;
    this.askedBook = kind === 'KAI' ? 'powers' : 'spells';
    this.queue.enqueue({
      command: this.askedBook,
      priority: 'probe',
      coalesceKey: 'probe:spellbook',
      reason: t('automation.routines.reasonSpellbook')
    });
  }

  /**
   * The two lines that keep the ask honest, read off the stream.
   *
   * A `spellbook-refused` is the server saying the wrong book was asked for
   * — and naming the right one, which is re-asked once and said out loud: a
   * correction that ran silently would leave "asked and nothing came back"
   * as the visible story. `user-learns` is a level-up putting a spell in the
   * book between listings; the re-ask is what replaces the appended
   * one-name row with the server's own listing.
   */
  onBlock(block: Block): void {
    if (!this.config.enabled) return;
    if (block.type === 'spellbook-refused') {
      const book = block.groups?.['book'];
      if (this.bookCorrected || (book !== 'spells' && book !== 'powers')) return;
      this.bookCorrected = true;
      this.askedBook = book;
      /*
       * A queued wrong ask goes first: coalescing keeps the *existing*
       * command's text — "the request is the same request" — which is
       * exactly wrong here, where the correction is a different word for
       * the same intent. Without this, an ask still held in the queue (the
       * player mid-line, say) would swallow the correction and then earn
       * the same refusal again, with the one-shot already spent.
       */
      this.queue.cancel((intent) => intent.coalesceKey === 'probe:spellbook');
      this.queue.enqueue({
        command: book,
        priority: 'probe',
        coalesceKey: 'probe:spellbook',
        reason: t('automation.routines.reasonSpellbook')
      });
      this.events.notice?.(t('automation.routines.spellbookCorrected', { book }));
      return;
    }
    if (block.type === 'user-learns' && this.askedBook !== null) {
      const kind = block.groups?.['kind'];
      if (kind !== 'power' && kind !== 'spell') return;
      this.queue.enqueue({
        command: this.askedBook,
        priority: 'probe',
        coalesceKey: 'probe:spellbook',
        reason: t('automation.routines.reasonSpellbook')
      });
      return;
    }
    /*
     * Trained, so the figure on file is wrong — the same correction the
     * spellbook gets above, applied to the other thing a level invalidates.
     *
     * `Exp needed for next level` comes from `exp` or from the stat sheet, and
     * on this realm the status line carries no `Need=` field to maintain it
     * between them: `onEnterRealm` asks once and nothing asks again. So every
     * level a character trained for left *Exp. needed* and *Will level in* on
     * the Combat Stats card reading against the level before it, for the rest
     * of the session — a readout confidently stating a number the client had
     * no business believing.
     *
     * **Both sentences, one ask.** `You hand over 250 copper farthings to train
     * to the next level!` is the one the request named and the one that says a
     * command was spent to reach a new level; `Welcome to level 7!` is the one
     * that states the fact the figure depends on. On this realm they arrive
     * together and always have — six trains across the recorded sessions, each
     * with its welcome on the next line — so the second costs nothing, and if
     * a realm ever separated them the figure would still be corrected.
     *
     * The three lines a trainer prints that are *not* a level are none of
     * these types: `Training will cost 50 copper farthings!`, `You can not
     * afford to train!` and `You do not have the required experience necessary
     * to train!` all classify as `unknown` (checked against the real
     * classifier), so asking a trainer what it charges spends nothing.
     *
     * `probe` band and coalesced by one key: the least urgent thing in the
     * client, so it can never displace an attack, an escape or a walk step —
     * and a level is exactly the moment a character is standing in a guild
     * rather than in a fight. Unconditional within `routines.enabled` like the
     * spellbook correction above: the client already asked for this figure on
     * the way in, and this is that same ask staying true rather than a new one
     * nobody chose.
     */
    if (block.type === 'user-trains' || block.type === 'user-levels') {
      this.queue.enqueue({
        command: 'exp',
        priority: 'probe',
        // The key the entry probe already builds for this command
        // (`probe:${command}`), so the two are one intent rather than two
        // spellings of it — coalesce by intent is the whole rule.
        coalesceKey: 'probe:exp',
        reason: t('automation.routines.reasonTrained')
      });
    }
  }

  /**
   * A player is standing in this character's room.
   *
   * Queued rather than looked at now, and on the idle tick rather than on
   * arrival, for the reason the roster catch-up is: a room that fills up would
   * otherwise fire a command per person, into a fight if one is running. The
   * look is a *spent command* and a *visible* one — the server tells the person
   * they were looked at — so it goes out only while nothing else is happening.
   */
  onPlayerSeen(name: string): void {
    if (!this.config.talk.lookAtPlayers) return;
    const key = name.trim().toLowerCase();
    if (key.length === 0 || this.lookedAt.has(key) || this.toLookAt.includes(key)) return;
    this.toLookAt.push(key);
  }

  /**
   * A command left this client. The keep-alive measures **only** this.
   *
   * It used to count inbound bytes too — *any traffic at all* — and that made
   * it unreachable on the realms this client is for. GreaterMUD repaints the
   * status line unprompted every thirty seconds, so with the default
   * forty-five second quiet period the clock was reset fifteen seconds before
   * it could ever expire, for as long as the session lasted. Measured in the
   * session it was reported from
   * (`logs/2026-09-02_16-54-23_festus.mudcap.jsonl`): three unprompted
   * repaints across 140 seconds in which this client sent nothing whatever,
   * ended by the player pressing Enter by hand.
   *
   * Counting the client's own silence is also the only reading that matches
   * what the keep-alive is *for*. Both of its jobs are about this side of the
   * wire: a server deciding whether to drop an idle connection is counting
   * what it has been sent, and a client wanting to know the room and the
   * vitals it has not been told about has to ask. A server that is talking to
   * itself answers neither.
   *
   * Automation's own commands count, not only typed ones — a character
   * meditating every three seconds is not idle, and an Enter behind that would
   * be a command spent from the budget the fight it is recovering from is
   * fought with.
   */
  noteSent(): void {
    this.lastSent = Date.now();
  }

  dispose(): void {
    this.stopIdle();
  }

  private armIdle(): void {
    this.stopIdle();
    if (!this.config.enabled || !this.config.idle.enabled) return;

    // Checked at a fraction of the threshold so the command lands close to the
    // configured quiet period rather than up to a whole period late.
    const tick = Math.max(tuning().queue.minIdleTickMs, (this.config.idle.afterSeconds * 1000) / 4);
    this.idleTimer = setInterval(() => this.checkIdle(), tick);
    this.idleTimer.unref?.();
  }

  private stopIdle(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private checkIdle(): void {
    if (!this.probed) return;
    const quietFor = Date.now() - this.lastSent;
    if (quietFor < this.config.idle.afterSeconds * 1000) return;

    // Reset first: if the queue is busy and this never reaches the wire, we
    // still should not retry every tick.
    this.lastSent = Date.now();
    this.queue.enqueue({
      command: this.config.idle.command,
      priority: 'idle',
      coalesceKey: 'idle',
      // Worthless if it arrives late — by then something else has happened.
      expiresAt: Date.now() + this.config.idle.afterSeconds * 1000,
      reason: t('automation.routines.reasonIdle')
    });

    /*
     * The roster catch-up, on the same idle event as the keep-alive rather
     * than a clock of its own — one less timer, and quiet is still the best
     * moment to spend a command. `askRoster` owns the debounce, so this is the
     * *second* of its two drains rather than the only one; the first is the
     * arrival itself, for a character that never goes quiet at all.
     */
    this.askRoster();

    /*
     * One look per idle tick, not the whole queue: each is a command from the
     * same budget, and a room of six people would otherwise spend six at once
     * on something nobody asked for urgently. Marked looked-at before the send
     * for the same reason the roster flag is cleared eagerly — a look still
     * queued behind combat must not be asked for twice.
     */
    const next = this.toLookAt.shift();
    if (next !== undefined && this.config.talk.lookAtPlayers) {
      this.lookedAt.add(next);
      this.queue.enqueue({
        command: `look ${next}`,
        priority: 'idle',
        coalesceKey: `idle:look:${next}`,
        reason: t('automation.routines.reasonLookAtPlayer')
      });
    }
  }
}
