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
import { PARTY_LISTING_KEY, PartyListing } from './PartyListing';
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { AutomationConfig } from '../../shared/config';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import type { Block } from '../../shared/blocks';
import {
  isStaleSentence,
  readBy,
  REFRESH,
  staleAfter,
  unread,
  type StaleFact,
  type StaleSentence
} from '../../shared/staleness';
import { SET_STATLINE } from '../../shared/statline';
import { tuning } from '../app/tuning';
import type { SessionModule } from './Module';
import { StaleFacts } from './StaleFacts';
import { AgedFacts } from './AgedFacts';

export interface RoutineEvents {
  notice?(message: string): void;
  /**
   * Whether the character is on the ground (`Grounded.down`), for the two
   * drains, which keep what they owe until it is up (todo 760); the idle
   * tick and the fan-out ahead of `act`'s gate are handed no state. Not the
   * keep-alive, which serves the connection, nor the one-shot asks (`st`,
   * `pro`, `par`, the spellbook), which the server answers on the ground and
   * which would be lost. Required: a construction that forgot it would read a
   * character down as standing.
   */
  onTheGround(): boolean;
}

export class Routines implements SessionModule {
  /** Whether the character has been in the realm this session: the login menus are behind it. */
  private probed = false;
  /** Whether the entry batch went this session; it waits for automation to be on. */
  private entryAsked = false;
  /** What an answer has read this session (todo 835): `READ`, whatever it said. */
  private readonly read = new Set<StaleFact>();
  /** When the entry commands were last asked, or null before entering or once given up. See `askUnread`. */
  private askedAt: number | null = null;
  /** How many times `askUnread` has asked again this session. */
  private unreadAsks = 0;
  /** Whether the character is in the realm: the only time the idle clock runs. */
  private inRealm = false;
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
   * When the last look went out, so two arrivals in one second are two looks a
   * floor apart rather than two commands at once.
   *
   * `0` rather than `Date.now()`, for `rosterAskedAt`'s reason: the first
   * person this character meets should be looked at, and starting the clock at
   * construction would silence exactly the moment there is most to learn.
   */
  private lookedAtAt = 0;
  /**
   * Which listing the spellbook ask sent this session, or null while it has
   * not — a one-shot latch beside `entryAsked`, and separate from it
   * because the two fire at different moments: the entry batch goes on the
   * first status line with automation on, and which book to ask for is not known until the wire
   * has said `KAI=` or `MA=` (the prompt, the stat sheet, or a listing).
   */
  private askedBook: 'spells' | 'powers' | null = null;
  /** Whether the one `abil` of this session has gone out. See `askAbilities`. */
  private askedAbilities = false;
  /** When the stat sheet was last asked for to settle a buff ending; null is never. */
  private sheetAskedAt: number | null = null;
  /** The wrong-book correction has run, so it can only run once. */
  private bookCorrected = false;

  /** The party listing on its clock and after a round (todo 831). See `PartyListing`. */
  private readonly partyListing: PartyListing;
  /** What a sentence made stale, asked until a send carries it. */
  private readonly stale: StaleFacts;
  /** What `i`, `st` or `exp` answered a while ago. */
  private readonly aged = new AgedFacts();

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: RoutineEvents
  ) {
    this.partyListing = new PartyListing(queue, () => this.config);
    this.stale = new StaleFacts(queue);
  }

  configure(config: AutomationConfig): void {
    this.config = config;
    this.armIdle();
  }

  /** New connection: forget that we ever probed, and who we looked at. */
  reset(): void {
    this.sheetAskedAt = null;
    this.probed = false;
    this.entryAsked = false;
    this.read.clear();
    this.askedAt = null;
    this.unreadAsks = 0;
    this.toLookAt = [];
    this.lookedAt.clear();
    this.lookedAtAt = 0;
    this.rosterUnknown = false;
    this.rosterAskedAt = 0;
    this.askedBook = null;
    this.askedAbilities = false;
    this.bookCorrected = false;
    this.lastSent = Date.now();
    this.inRealm = false;
    this.partyListing.reset();
    this.stale.reset();
    this.aged.reset();
    this.stopIdle();
  }

  /**
   * What entering the realm asked for and nothing has answered, asked again
   * once `tuning.queue.unreadRetryMs` has passed (todo 835), at most
   * `tuning.queue.unreadRetries` times: an `st` or `i` that never came back
   * (the stat screen's hold drops what is queued) leaves health unknown all
   * session. Only what `onEnterRealm` asks, never once an answer came, and
   * said only for what the queue took; one it refused is tried after the wait.
   */
  private askUnread(): void {
    if (!this.config.enabled || this.askedAt === null) return;
    if (Date.now() - this.askedAt < tuning().queue.unreadRetryMs) return;
    const missing = unread(this.config.onEnterRealm, this.read);
    if (missing.length === 0) return;
    this.askedAt = Date.now();
    const commands = missing.map((fact) => REFRESH[fact].command).join(', ');
    if (this.unreadAsks >= tuning().queue.unreadRetries) {
      this.askedAt = null;
      this.events.notice?.(t('automation.routines.unreadGaveUp', { commands }));
      return;
    }
    const queued = missing.filter(
      (fact) =>
        this.queue.offer({
          ...REFRESH[fact],
          priority: 'probe',
          reason: t('automation.routines.reasonUnread')
        }) === 'queued'
    );
    if (queued.length === 0) return;
    this.unreadAsks += 1;
    this.events.notice?.(
      t('automation.routines.askingAgain', {
        commands: queued.map((fact) => REFRESH[fact].command).join(', ')
      })
    );
  }

  /** A combat round has come round: the party listing, where it is asked for then. */
  round(state: CharacterState): void {
    this.partyListing.afterRound(state);
  }

  /**
   * Called whenever character state changes.
   *
   * The entry batch goes on the first status line in the realm with
   * automation on, once per connection. `phase` becoming `in-game` is the
   * status line arriving, which is also the moment the server is ready to
   * answer questions.
   */
  onCharacter(state: CharacterState): void {
    if (state.phase !== 'in-game') {
      /*
       * Out of the realm — the socket gone, or the exit to the menu — there is
       * nothing to keep alive and nobody to ask. Left running, the clock
       * proposed a bare Enter every forty-five seconds into a socket that had
       * closed, for seven hours (2026-09-18: 552 of them in
       * `logs/2026-09-17_23-47-17_soul.mudcap.jsonl`), each one then read as
       * a command the realm had failed to answer.
       */
      this.inRealm = false;
      this.stopIdle();
      return;
    }
    if (!this.inRealm) {
      this.inRealm = true;
      /*
       * Armed here unconditionally, before the enabled check below, and on
       * every entry rather than the first: leaving stopped it.
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
    }
    /*
     * Only once automation is on: a character that entered with it off sent
     * nothing, and the first status line after it is switched on is when the
     * entry batch goes. Before, the first status line used up the one chance
     * with automation off, the batch never went, and the inventory stayed
     * unknown all session (2026-10-02).
     */
    this.probed = true;
    if (!this.entryAsked && this.config.enabled) {
      this.entryAsked = true;

      const commands = this.config.onEnterRealm;
      if (commands.length > 0) {
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
        this.askedAt = Date.now();
      }
      this.askForTheStatline();
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
    this.askUnread();
    if (this.config.enabled) {
      // An old listing waits for the fight to end; what is already owed does not.
      const aged = fightIsRunning(state) ? [] : this.aged.due(Date.now());
      if (aged.length > 0) this.stale.owe(aged, t('automation.routines.reasonAged'));
      else this.stale.ask();
    }
    // And the party listing on its clock (todo 831).
    this.partyListing.onCharacter(state);
  }

  /**
   * The prompt's shape, set on the way in and then read back.
   *
   * `set statline full custom <template>` puts the maximum health and mana,
   * the experience, what the next level still costs and the purse on every
   * prompt (`src/shared/statline.ts`), which retires the reason to re-ask `st`
   * and `exp` for those. Then `pro`, whose `Statusline:` row is what the
   * tracker builds its matcher from — from what the realm *holds*, never
   * from what was sent, because the send can be refused and another client
   * may have set something else. Behind the entry batch: `rm` keeps the head
   * of the probe band, and `pro` is thirty lines nobody wants ahead of the
   * room.
   */
  private askForTheStatline(): void {
    if (!this.config.enabled || !this.config.statline.control) return;
    this.queue.enqueue({
      command: SET_STATLINE,
      priority: 'probe',
      coalesceKey: 'probe:statline',
      reason: t('automation.routines.reasonStatline')
    });
    this.askProfile();
  }

  /**
   * `pro`, for its `Statusline:` row. Once on the way in when the client
   * sets the line, and again when a prompt stops matching what the last
   * report said — the tracker raises that (`takeStatlineRequest`), this asks.
   */
  askProfile(): void {
    if (!this.config.enabled) return;
    this.queue.enqueue({
      command: 'pro',
      priority: 'probe',
      coalesceKey: 'probe:pro',
      reason: t('automation.routines.reasonProfile')
    });
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
      coalesceKey: PARTY_LISTING_KEY,
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
    // Down, the flag waits for the character to be up (todo 760).
    if (!this.config.enabled || this.events.onTheGround()) return;
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
  /** *Auto Choose Best Spell* found no book read: one listing, on the same terms as entry. */
  askBook(state: CharacterState): void {
    this.askSpellbook(state);
  }

  /**
   * The record of the character was thrown away at the player's word
   * (`SessionManager.forgetCharacter`), and with it the book and the quest
   * counters this session had already read: each is null again, so each is
   * owed one more listing. The book is asked now, as on entry; the counters
   * wait for whatever needs them, as they always do.
   */
  characterForgotten(state: CharacterState): void {
    this.askedBook = null;
    this.askedAbilities = false;
    this.askSpellbook(state);
  }

  /**
   * The quest counters, once per session, when something needs them.
   *
   * `abil` is the only place on the wire a quest counter is ever stated
   * (`AbilitySums`), and the realm gates scripted ways through on exactly
   * those numbers: `9/1291`'s `go portal` is `checkability 133 5`, and a
   * character below that rank is put somewhere the plan never named rather
   * than refused. Unasked, `CharacterState.abilities` stays null for the whole
   * session and every such gate is priced as a guess — which is what walked a
   * character into the Caves of Chaos on 2026-09-15.
   *
   * **Asked when the question is live, not on the way in** (`askBook`'s shape,
   * and `Errands.askCountersFor` is the caller): a plan that crosses
   * one of those gates. A listing is not free of consequence even though the
   * command is — a *complete* one enumerates, so it settles **every** counter,
   * and the quest book stops offering its nodes as controls the moment one
   * arrives. Spending that on a character who never goes near a gated way
   * would be the client answering a question nobody asked.
   *
   * **No family gate here.** `Abilities` is in `GREATERMUD_ONLY`, so once a
   * realm has said it is MajorMUD the arbiter refuses the word before it is
   * tried and says so once; a gate here would only ask the same question
   * twice.
   */
  askAbilities(state: CharacterState): void {
    if (!this.config.enabled) return;
    if (this.askedAbilities) return;
    /*
     * Somebody has already answered it — the player's own `abil`, or the
     * listing that arrived while this was still deciding. The listing is the
     * fact; which command produced it is not.
     */
    this.askedAbilities = true;
    if (state.abilities !== null) return;
    this.queue.enqueue({
      command: 'abil',
      priority: 'probe',
      coalesceKey: 'probe:abil',
      reason: t('automation.routines.reasonAbilities')
    });
  }

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
   * one-name row with the server's own listing. A scroll read is the same
   * change, and `You already know how to cast` says the book holds a spell
   * the listing may not.
   */
  onBlock(block: Block): void {
    for (const fact of readBy(block.type)) this.read.add(fact);
    this.stale.answered(block.type);
    this.aged.answered(block.type, Date.now());
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
    if (changesTheBook(block) && this.askedBook !== null) {
      this.queue.enqueue({
        command: this.askedBook,
        priority: 'probe',
        coalesceKey: 'probe:spellbook',
        reason: t('automation.routines.reasonSpellbook')
      });
      return;
    }
    /*
     * A sentence that said a number changed without saying what to. The
     * *what* is `src/shared/staleness.ts`, declared as data; this is the ask.
     *
     * `Exp needed for next level` comes from `exp` or from the stat sheet, and
     * on this realm the status line carries no `Need=` field to maintain it
     * between them: `onEnterRealm` asks once and nothing asks again. So every
     * level a character trained for left *Exp. needed* and *Will level in* on
     * the Combat Stats card reading against the level before it, for the rest
     * of the session — a readout confidently stating a number the client had
     * no business believing. The maxima on the sheet and the purse a train was
     * paid out of are the same failure in two more places.
     *
     * **Both training sentences, and the welcome too.** `You hand over 250
     * copper farthings to train to the next level!` says a command was spent
     * to reach a new level; `Welcome to level 7!` states the fact the figures
     * depend on. On this realm they arrive together and always have — six
     * trains across the recorded sessions, each with its welcome on the next
     * line — so the second costs nothing (one coalesced intent, not two), and
     * on **MajorMUD**, where a train prints its own sentence and no welcome at
     * all, the figures are still corrected.
     *
     * The three lines a trainer prints that are *not* a level are none of
     * these types: `Training will cost 50 copper farthings!`, `You can not
     * afford to train!` and `You do not have the required experience necessary
     * to train!` all classify as `unknown` (checked against the real
     * classifier), so asking a trainer what it charges spends nothing.
     *
     * `probe` band and coalesced: the least urgent thing in the client, so it
     * can never displace an attack, an escape or a walk step — and a level is
     * exactly the moment a character is standing in a guild rather than in a
     * fight. Unconditional within `routines.enabled` like the spellbook
     * correction above: the client already asked for these figures on the way
     * in, and this is that same ask staying true rather than a new one nobody
     * chose.
     */
    if (isStaleSentence(block.type))
      this.stale.owe(staleAfter(block.type), this.whyStale(block.type));
  }

  /**
   * Why the refresh is going out, for the decision trace.
   *
   * The words stay here and the table stays data, because `locales/ui.en.yaml`
   * is the only place copy lives and a key looked up through a variable is a
   * key `i18n-coverage.test.ts` cannot check. A literal call per sentence instead.
   */
  private whyStale(type: StaleSentence): string {
    switch (type) {
      case 'user-levels':
        return t('automation.routines.reasonLevelled');
      case 'user-trains':
        return t('automation.routines.reasonTrained');
      case 'user-dies':
        return t('automation.routines.reasonDied');
      case 'user-stats-assigned':
        return t('automation.routines.reasonStatsTrained');
      default: {
        const never: never = type;
        return never;
      }
    }
  }

  /**
   * A sentence nothing recognised may have ended a buff, and the stat sheet
   * is what says which — it prints each active effect's own start sentence
   * at its foot, so `EffectTracker.readSheet` can drop what is gone,
   * settle a pending ending, or take back a lesson the wire contradicts.
   *
   * Asked for on the tracker's word (`takeSheetRequest`), never on the shape
   * of a line: the shape that admits every one of the table's 431 sentences
   * also admits `The thug nods.`, and a sheet per emote would spend the
   * budget a fight is fought with on a question already answered. So the
   * tracker says when a sheet would settle something and this asks once per
   * `tuning.spells.sheetAskMs` at most — `probe` band, coalesced onto the
   * entry probe's own key for the command, so an `st` already queued is
   * this ask rather than a second one. Unconditional within
   * `routines.enabled`, as the level-up `exp` is: the client already asks
   * for this sheet on the way in.
   */
  askSheet(now: number = Date.now()): void {
    if (!this.config.enabled) return;
    if (this.sheetAskedAt !== null && now - this.sheetAskedAt < tuning().spells.sheetAskMs) return;
    this.sheetAskedAt = now;
    this.queue.enqueue({
      command: 'st',
      priority: 'probe',
      coalesceKey: 'probe:st',
      reason: t('automation.routines.reasonBuffEnding')
    });
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
  onPlayersHere(names: readonly string[]): void {
    if (!this.config.talk.lookAtPlayers) return;
    const here = new Set(
      names.map((name) => name.trim().toLowerCase()).filter((key) => key.length > 0)
    );

    /*
     * **Dropped first, and this is the bug.** The queue was a list of
     * *arrivals* and nothing ever took a name out of it, so a look queued when
     * Durnan walked in was still owed when he left — and went out minutes
     * later, at the first quiet moment, to `You do not see durnan here!`
     * (reported 2026-09-07). The room's occupant list is authoritative about
     * who is here, the same rule a `who` listing follows for the realm, so
     * reconciling against it is the whole fix.
     *
     * `lookedAt` is deliberately *not* reconciled: it is a record of what this
     * session has already spent a command on, and somebody who leaves and comes
     * back has not changed what they are wearing.
     */
    this.toLookAt = this.toLookAt.filter((key) => here.has(key));

    for (const key of here) {
      if (this.lookedAt.has(key) || this.toLookAt.includes(key)) continue;
      this.toLookAt.push(key);
    }

    /*
     * And offered now rather than only at the next quiet moment.
     *
     * The idle tick was the wrong clock here for the reason it was wrong for
     * the roster catch-up (see the header): a character that fights and walks
     * all evening never goes quiet, so the answer arrived after the person had
     * gone. `lookAt` owns the floor between two looks, so this is the *first*
     * of its two drains and the idle tick is still the second — quiet is a good
     * moment to spend a command, it is just not the only one.
     */
    this.lookAt();
  }

  /**
   * Sends one look, if one is owed and the floor between them has passed.
   *
   * One at a time, not the whole queue: each is a command from the same budget
   * a fight is fought with, and a room of six people would otherwise spend six
   * at once on something nobody asked for urgently. The `idle` band is
   * unchanged — a look is visible to everybody standing there, so it still
   * yields to anything else the character is doing.
   */
  private lookAt(): void {
    if (!this.config.enabled || !this.config.talk.lookAtPlayers) return;
    // Down, the names wait for the character to be up (todo 760).
    if (this.events.onTheGround()) return;
    if (Date.now() - this.lookedAtAt < tuning().queue.lookAskMs) return;

    // Marked spent before the send, like the roster flag, so a look still held
    // behind a fight is not asked for twice.
    const next = this.toLookAt.shift();
    if (next === undefined) return;
    this.lookedAt.add(next);
    this.lookedAtAt = Date.now();
    this.queue.enqueue({
      command: `look ${next}`,
      priority: 'idle',
      coalesceKey: `idle:look:${next}`,
      /*
       * Worthless if it arrives late, for exactly the reason this todo was
       * written: the answer is about somebody standing in this room, and by
       * the time a held look reaches the wire they may have walked out. The
       * queue drops an expired intent rather than sending it.
       */
      expiresAt: Date.now() + tuning().queue.lookExpiresMs,
      reason: t('automation.routines.reasonLookAtPlayer')
    });
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
    // A reload while out of the realm must not start it; entering does. Not
    // gated on the master switch: the keep-alive serves the connection (see
    // `Intent.keepsLink`), and the two drains that share this tick gate
    // themselves on it.
    if (!this.inRealm || !this.config.idle.enabled) return;

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
      keepsLink: true,
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
     * And the second of the look queue's two drains — quiet is still the best
     * moment to spend a command on one, it is simply no longer the only one.
     * See `onPlayersHere`.
     */
    this.lookAt();
  }
}

/**
 * A sentence that says the book holds a spell the last listing may not: a
 * spell or power learned at a level, a scroll read into the book, or a scroll
 * read for a spell the book already has.
 */
function changesTheBook(block: Block): boolean {
  switch (block.type) {
    case 'user-learns': {
      const kind = block.groups?.['kind'];
      return kind === 'power' || kind === 'spell';
    }
    case 'user-reads-spell':
    case 'user-reads-known':
      return true;
    default:
      return false;
  }
}
