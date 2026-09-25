/**
 * The barrier ladder: what the walk does when the way ahead is shut (todo
 * 740, out of `Walker`). A door the room already calls shut is opened
 * instead of stepped into; a refusal is answered rung by rung — `open`, the
 * key, a pick, a bash — then a round standing at the door and the ladder
 * again; a hidden exit is searched for until it is found; and a refusal that
 * is not this step's stops the walk as lost.
 *
 * ## The ladder
 *
 * A shut door is shut until something opens it, and there are three ways up:
 * `open` it, pick its lock, or bash it down. They are rungs rather than
 * alternatives because each one answers a question the one below could not:
 *
 * | The server says | What is left |
 * |---|---|
 * | `The door is closed!` | `open` — it may simply be shut |
 * | `The door is locked.` | opening is spent; a lock is what is in the way |
 * | `Your skill fails you this time.` | that pick did not take; another might |
 * | `Your attempts to bash through fail!` | that bash did not land; another might |
 *
 * Nothing here retries a rung it has already been refused on: `open` at a
 * locked door answers the same word every time, which is a command per
 * attempt spent to be told what the client already knows.
 *
 * And nothing waits for an answer it already has. `The gate is locked.` is
 * the whole of the news; the move queued behind the `open` that provoked it
 * is taken back rather than sent to be refused — see `onOpenRefused`.
 *
 * The lever rungs are `Levers`', asked through `BarrierLevers`; the hold at a
 * door or a search takes the slot `Holds` owns. The why is
 * `mudengine-automation` › `parts/walking.md`.
 */
import { asSpokenDirection, type RouteStep } from '../../../shared/world';
import type { Block } from '../../../shared/blocks';
import type { CharacterState } from '../../../shared/character';
import type { AutomationConfig } from '../../../shared/config';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { CommandQueue } from '../CommandQueue';
import type { WalkClock } from './clock';
import type { WalkerEvents, WalkInFlight } from './ports';
import type { Holds } from './Holds';
import type { Levers } from './Levers';

/**
 * The attempt on a barrier that is on the wire, while it is.
 *
 * `open` is one of them rather than a fire-and-forget: its answer decides the
 * next rung, and the step is no longer queued behind it — see `sendOpen`.
 */
type Forcing = 'bash' | 'pick' | 'open' | 'key';

/** What the barrier ladder asks of the walk it stands still, answered by `Walker`. */
export interface BarriersWalk extends Pick<
  WalkInFlight,
  'walking' | 'quiet' | 'step' | 'publish' | 'stop' | 'stepAgain'
> {
  /** The holds asked again (where `state` is known), then the step. */
  retry(state: CharacterState | undefined, fresh: boolean): void;
  /**
   * An attempt on the barrier, timed as the step is: queued, waited for until
   * it is on the wire, and its answer waited for after. `onSent` is the
   * step's own unless said otherwise.
   */
  dispatch(step: RouteStep, command: string, reason: string, onSent?: () => void): void;
  /** The step's command reached the wire; false for one the walk has moved past. */
  onWire(step: RouteStep): boolean;
  /** How long to give the server before asking it to say something. */
  nudgeAfter(): number;
  /** One bare Enter on the nudge's own key: the room reprinted. */
  reprint(reason: string): void;
}

export type BarriersEvents = Pick<
  WalkerEvents,
  'notice' | 'keyToUse' | 'refused' | 'stateNow' | 'pendingMoves'
>;

/** The lever rungs, which are the last on the ladder, and the pulls spent at the step. */
export type BarrierLevers = Pick<Levers, 'pullLevers' | 'fetchLever' | 'blameable' | 'forgetPulls'>;

export class Barriers {
  /**
   * Doors opened for the step in flight.
   *
   * Per step, not per route: a corridor with a door at each end is two ordinary
   * steps, and a counter that ran for the whole route would refuse the second
   * one because the first had used the budget. Reset every time a step is sent.
   */
  private opened = 0;
  /**
   * Bashes and picks spent on the step in flight, and whether the barrier is
   * known locked.
   *
   * Per step for `opened`'s reason, and `locked` is what stops the ladder
   * repeating its cheapest rung: `open` at a locked door answers `The door is
   * locked.` every single time (captured live in the sewers under Newhaven —
   * three `open w`, three identical refusals, then the walk stopped anyway).
   * Once the server has said the word, opening is spent and forcing is what is
   * left.
   */
  private bashed = 0;
  private picked = 0;
  /**
   * Whether the key has already been tried against the barrier in the way.
   *
   * A flag rather than a count, and it is the difference between this rung and
   * the two under it: picking and bashing are rolls that are worth repeating,
   * and a key either matches the door's row or does not. Sending it twice in
   * one run of the ladder would spend a command to be told `Your command had
   * no effect.` a second time.
   *
   * Cleared with the other two, so `holdAtBarrier` running the ladder again
   * does try the key again — which is what answers the door the server
   * re-locks behind the character on its own timer.
   */
  private keyed = false;
  private locked = false;
  /**
   * How many times the whole ladder has been run again at the barrier the step
   * in flight is standing at.
   *
   * Not per step like the three above — those are reset every time the step is
   * sent, which is exactly what a retry does, so a counter reset there could
   * never bound anything. This one is cleared by a **confirmed step**: the
   * fact that says the character got past the door. See `holdAtBarrier`.
   */
  private barrierRounds = 0;
  /** Searches spent looking for the hidden exit at the step in flight. */
  private searched = 0;
  /**
   * The server has said it found this step's hidden exit.
   *
   * **The bound on a search rung that otherwise has none.** `mustSearchFirst`
   * decides *is it open yet* from the room's own `Obvious exits:` line, which
   * is right — a found exit joins it, so a lap pays for one search and no more
   * — and it is a line this client does not always read: `open trap door
   * below` was a direction `parseExit` had no word for until today, and a
   * realm may qualify one some third way tomorrow. With no ceiling on the
   * searching (todo 04) and no blame written down for a searchable edge, a
   * walk that could not recognise its own success searched every 1.5s forever
   * and said so once every five minutes.
   *
   * `You found an exit …!` is the server saying so outright, which outranks
   * reading it back off a list. Cleared with the rest of the step's budget.
   */
  private found = false;
  /**
   * When the line about that search was last said. Zero so the first one
   * always speaks; see `holdSearching` for why it speaks again.
   */
  private searchSaidAt = 0;
  /**
   * The forcing attempt on the wire, if one is.
   *
   * `Your attempts to bash through fail!` and `Your skill fails you this time.`
   * are answers to a specific command, and the second is not even specific to
   * picking — the server spends the same sentence on a failed trap disarm. So
   * neither is acted on unless this says the walker asked the question.
   */
  private forcing: Forcing | null = null;
  /**
   * The two skills a barrier is graded against, from the last state seen.
   *
   * Kept here rather than asked for at the moment of the refusal because
   * `Walker.onBlock` has no state to read: a block is a line off the wire and the stat
   * sheet arrived some time earlier. Null until a sheet has said, and a null
   * skill never meets a stated number — the same direction `forcedDoorCost`
   * already takes, where a character whose sheet nobody has read is priced as
   * if it could force nothing.
   */
  private strength: number | null = null;
  private picklocks: number | null = null;

  constructor(
    private config: AutomationConfig,
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: BarriersEvents,
    private readonly walk: BarriersWalk,
    private readonly clock: Pick<WalkClock, 'afterHold' | 'afterStep' | 'clear'>,
    /** The one-deep hold slot, which `Holds` owns: a door and a search take it. */
    private readonly slot: Pick<Holds, 'current' | 'take'>,
    private readonly levers: BarrierLevers
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /**
   * The two skills a barrier is graded against, kept whether or not a walk is
   * running: the stat sheet arrives when it arrives, and the moment a barrier
   * is graded against these numbers is a refusal off the wire with no state
   * beside it.
   */
  noteSkills(state: CharacterState): void {
    this.strength = state.progress.strength;
    this.picklocks = state.progress.picklocks;
  }

  /**
   * The door is behind the character — a confirmed step, a fresh plan, a new
   * walk — which is the one fact that says the ladder got past it. See
   * `barrierRounds`, and `forgetLock`, which is the same fact about the lock
   * and is the only thing that clears it.
   */
  passed(): void {
    this.barrierRounds = 0;
    this.forgetLock();
  }

  /** A new connection: forget everything. */
  reset(): void {
    this.strength = null;
    this.picklocks = null;
    this.barrierRounds = 0;
    this.forget();
    /*
     * `locked` is here rather than left to `forget`: it stopped being part of
     * that reset when a lock had to survive a barrier round.
     */
    this.forgetLock();
  }

  /**
   * A forcing attempt came back a failure, which is the walk's news only
   * while it has that attempt of its own in flight:
   *
   * - **`bash`**: a hand-typed `bas` at a door the player is dealing with
   *   themselves is not the walk's news.
   * - **`pick`**: `Your skill fails you this time.` also answers a failed trap
   *   disarm, so it means "the pick missed" only while the walker has one in
   *   flight.
   * - **`key`**: `Your command had no effect.` is what `Door.TryUnlock`
   *   answers a key that does not match the door's row with — the same
   *   sentence the server gives every command it could not carry out. It is
   *   the commonest line in the game after the status line, and acting on it
   *   unguarded would end a walk every time the player typed at something
   *   that was not there.
   */
  onForcingFailed(kind: Exclude<Forcing, 'open'>): void {
    if (this.forcing === kind) this.forceAgainOrHold();
  }

  /**
   * A round standing still, then the whole question again. The hold is let go
   * before anything else is asked: `Holds.holdForHealth` claims a walk only
   * when nothing else is holding it, and a `barrier` or a `searching` left
   * standing would silence the one hold this round exists to give way to.
   */
  private roundAfter(ms: number): void {
    this.clock.afterHold(ms, () => {
      if (!this.walk.walking()) return;
      this.slot.take(null);
      this.walk.retry(this.events.stateNow?.(), true);
    });
  }

  /**
   * `open` came back refused, so that rung is spent and the next one is taken
   * now.
   *
   * **The step is no longer queued behind the `open`**, which is what makes
   * this worth reading at all. It used to be, so that the `direction-failed`
   * it came back with would take the next rung — a move sent to be told `The
   * gate is closed!` a second time, out of the budget the walk is walked with.
   * Reported from the wire with the whole exchange in it:
   *
   *     [HP=112/MA=16]:e          The gate is closed!
   *     [HP=112/MA=16]:open e     The gate is locked.
   *     [HP=112/MA=16]:e          The gate is closed!   <- this one
   *     [HP=112/MA=16]:bas e      You bashed the gate open.
   *
   * Cancelling it from the queue instead does not work and looking at why is
   * the useful part: the queue's window is three commands and its gap is
   * 350ms, while this realm answers a command in a measured 1,239ms — so the
   * step is on the wire long before its answer could recall it. *A sent
   * command cannot be recalled* is the rule, and the fix has to be not sending
   * it. `sendOpen` therefore waits for the `open`'s own answer, of which this
   * is one and `door-changed` is the other.
   *
   * `The door is locked.` additionally spends **every** remaining `openTries`:
   * a lock answers the same word every time, so repeating the rung is a
   * command per attempt spent to be told what the client already knows. The
   * other shape (`That is not a door or a gate!`) leaves the budget alone and
   * simply moves on, because it says the realm data was wrong about the
   * barrier rather than anything about a lock.
   */
  onOpenRefused(block: Block): void {
    if (this.forcing !== 'open') return;
    this.forcing = null;
    if (block.groups['reason'] === 'locked') this.locked = true;

    const step = this.walk.step();
    if (step === undefined) return;
    const barrier = block.groups['barrier'] ?? t('automation.walk.fallbackBarrier');
    if (this.force(step, barrier)) return;
    this.holdAtBarrier(step, barrier);
  }

  /**
   * The server refused the step: no exit that way, or something in it.
   *
   * The two `direction-failed` shapes are not one fact and the pattern
   * captures which is which: `There is no exit in that direction!` says the
   * realm data was wrong, and no amount of opening or forcing helps. Only a
   * `door` or a `gate` is worth a command.
   */
  onRefusedStep(block: Block): void {
    const step = this.walk.step();
    const barrier = block.groups['barrier'];

    /*
     * A refusal is only this step's while this step's move is the only one
     * outstanding. More than one and the sentence answers whichever went
     * first, which this walk has no way to know — so it is acted on by
     * stopping and by nothing else: no door opened in a direction that may
     * not be in the way, no edge written down, no command spent on somebody
     * else's wall. The tracker consumes the move *after* the walker sees the
     * block, so this step's own is still counted here: one is ours.
     */
    if (!this.refusalIsOurs()) {
      /*
       * And it stops as *lost*, not as a refused route: one of the moves out
       * there landed and one did not, so which room this is standing in is
       * exactly the thing nobody knows. That is the reason a loop answers
       * with one `rm` and the same stop again, rather than by giving up on
       * a stop that was never the problem.
       */
      this.walk.stop(t('automation.walk.reasonAmbiguous'));
      return;
    }

    if (step !== undefined && barrier !== undefined) {
      /*
       * Bounded by `openTries`, per step — and skipped outright once the
       * server has said `locked`, because that is the one refusal repeating
       * cannot get past.
       */
      if (
        !this.locked &&
        this.config.movement.openDoors &&
        this.opened < this.config.movement.openTries
      ) {
        this.sendOpen(step, barrier);
        return;
      }
      if (this.force(step, barrier)) return;
      /*
       * Every rung spent and the way still shut. It waits and runs the ladder
       * again rather than ending the journey — see `holdAtBarrier`.
       */
      this.holdAtBarrier(step, barrier);
      return;
    }

    if (step !== undefined && barrier === undefined) {
      /*
       * `There is no exit in that direction!`. One sentence, four causes
       * (docs/greatermud/movement.md) — a wrong map, a hidden exit nobody has
       * found, a text exit approached as a direction, a remote-action exit —
       * and the document's own warning is that *a client that marks the map
       * from this message will mark it wrongly*. This client did.
       */
      if (this.searchFor(step)) return;
      if (this.levers.pullLevers(step)) return;
      /*
       * A remote-action exit is the fourth of that sentence's four causes
       * (docs/greatermud/movement.md) and the one the client could do
       * something about and did not. See `Levers.fetchLever`.
       */
      if (this.levers.fetchLever(step)) return;
      /*
       * **What is written down is which of the two the refusal was**, because
       * the sentences are not interchangeable and the wrong one was being
       * said. `The realm data promised an exit n that the realm refuses` is
       * true of a corridor the data invented; said about a `Hidden/Needs 2
       * Actions` exit it accuses the realm data of exactly the thing the realm
       * data got right — the exit is real and it is shut. Reported as todo 04
       * with the room number in it (`1/1056`), and the exit is in the file,
       * with both its levers.
       */
      if (this.levers.blameable(step)) {
        this.events.refused?.(step.from, step.direction, shutRatherThanMissing(step));
      }
    }
    this.stopRefused(step, barrier);
  }

  /**
   * Looks for the hidden exit the realm says is there, and **keeps looking**.
   * Returns whether anything was sent.
   *
   * A `Hidden/Searchable` exit answers a bare direction with `There is no exit
   * in that direction!` until it has been found, so the refusal is not news —
   * it is the step the realm data already described, and `edgePenalty` priced
   * the search into the route when it chose this leg.
   *
   * **It searches until it works** (todo 04, 2026-09-06). It used to be
   * bounded at `searchTries`, after which the walk gave up and struck the edge
   * out — and the reported transcript is exactly that: two searches at Outer
   * Keep 1/1368, the route stopped, the corridor blacklisted, and a hand-typed
   * `sea s` a moment later answering `You found an exit to the south!`. The
   * realm's own data says a search reveals this one; a client that stops
   * asking has decided the realm is wrong on two rolls of a skill check. And
   * the person it stops belongs to stated the trade: *the player would prefer
   * the slowdown over coming back to his character stopped after being gone 8
   * hours.*
   *
   * **The unbounded set is narrow and the realm chose it.** Only an edge the
   * realm marks `Hidden/Searchable` — 251 of the shipped file's 1,469 hidden
   * exits — reaches here.
   * Every other refusal is blamed and written down after one, exactly as
   * before, so a corridor that genuinely no longer exists is still struck out.
   *
   * **Paced by a floor, not by a count**, and the walk *holds* rather than
   * marching on: `searchRetryMs` is the beat, `WalkHold` says `searching`, and
   * `Walker.holdBeforeSending` is what stops the step going out at a wall it already
   * knows about.
   *
   * The answer (`You found an exit to the east!`) is deliberately not read —
   * the room reprints with the exit in its own list, which is what the step
   * ahead of it reads.
   */
  private searchFor(step: RouteStep): boolean {
    const need = step.requirement;
    if (need?.kind !== 'hidden' || need.searchable !== true) return false;
    this.holdSearching(step);
    return true;
  }

  /**
   * Sends one `search <direction>` and stands still for a beat.
   *
   * Shaped on `holdAtBarrier`, which answers the same question about a shut
   * door: the way is not open *this time round*, the reason is temporary, and
   * a route that ended there would have to be noticed and asked for by hand.
   * The one difference is that this has no ceiling — see `searchFor`.
   */
  holdSearching(step: RouteStep): void {
    /*
     * Said when it starts and **again on a slow clock**, unlike the barrier's
     * one line: that hold lasts a round and ends the walk, where this one has
     * no ceiling and can outlast a lap. Said once, the reason a character is
     * standing in a corridor at 3am is a line eight hours up the scrollback —
     * the reviewer's find, 2026-09-06.
     */
    const now = Date.now();
    if (!this.walk.quiet() && now - this.searchSaidAt >= tuning().walk.searchSayEveryMs) {
      this.searchSaidAt = now;
      this.events.notice?.(t('automation.walk.searchHolding', { stepName: step.name }));
    }
    this.searched += 1;
    this.queue.enqueue({
      command: `search ${step.direction}`,
      priority: 'movement',
      /*
       * **Coalesced, because the searching has no ceiling.** The beat is
       * measured from the enqueue, not from the send, so while the queue is
       * holding — a half-typed line holds it for up to `abandonedLineMs` — one
       * more un-expiring `movement` intent piled up every `searchRetryMs` and
       * they all flushed together when the hold released. One search at a time
       * is what a search *means*, which is the queue's own rule: coalesce by
       * intent, never by command text. The key names the direction, so a
       * search of a different way is a different intent.
       */
      coalesceKey: `walk:search:${step.direction}`,
      reason: t('automation.walk.reasonSearching', { stepName: step.name })
    });
    this.armSearchBeat();
  }

  /**
   * Stands still for one beat and then asks the whole question again.
   *
   * Its own method because two things arm it — a search going out, and a
   * reprint asked for after one is answered — and the second has to measure the
   * beat from **its own** command rather than inheriting what is left of the
   * search's. A search is answered in about a round, so the remainder would
   * often be too short for the reprint to land, and the re-ask would send
   * another search at a room whose answer was still on the wire.
   */
  private armSearchBeat(): void {
    // The step's deadline was timing a move the refusal has already answered.
    this.clock.clear();
    this.slot.take('searching');
    this.walk.publish();
    this.roundAfter(tuning().walk.searchRetryMs);
  }

  /**
   * The server answered a search, and the room on screen has not changed.
   *
   * **`You found an exit to the south!` does not reprint the room** — reported
   * as todo 03, with the wire under it: eleven `search s` at Outer Keep,
   * Intersection, seven of them answered `You found an exit to the south!`, and
   * not one step taken. The exit was found on the *first* one.
   *
   * `mustSearchFirst` reads the room block's own `Obvious exits:` line, which
   * is the right source — a found exit joins it, so a lap that found the way
   * once pays no search on the next lap. What was missing is anything to make
   * that source current, so the walk held on a line the server had already
   * superseded and asked again every beat, for as long as the character was
   * left alone.
   *
   * So the answer is one bare Enter (`REREAD_ROOM`, never `l` — a look
   * announces itself to everybody in the room), and the beat is re-armed from
   * it so the reprint has a full round to land.
   *
   * **Not every realm withholds the reprint**, and the claim here was once
   * written as though none reprinted at all. `captures/005:186` is a MajorMUD
   * realm answering `sear d` with `You found an exit downwards!` *and* the room
   * in the same breath. Where that happens this costs one bare Enter, once,
   * coalesced onto the nudge's own key — and the `found` flag rather than the
   * reprint is what actually ends the searching, so the extra command is the
   * whole of the cost on a realm that did not need it.
   *
   * **A failure asks too, every `searchRecheckEvery`th time**, which is the
   * other half of what was asked for. A success can be missed two ways — the
   * sentence arriving in a burst while the walk was not holding, and somebody
   * else opening the way — and the room is the only thing that actually
   * settles it. Counted rather than clocked, so a slow link does not change how
   * many searches it costs.
   */
  onSearchAnswered(block: Block): void {
    if (this.slot.current !== 'searching') return;
    const step = this.walk.step();
    if (step === undefined || step.direction === 'portal') return;
    /*
     * The server names the direction it searched, and a search the *player*
     * typed some other way is not this step's news. `Your search revealed
     * nothing.` names none, and an unnamed direction is taken as this one —
     * the walk is holding on a search of its own, and it is the only search
     * this client has out.
     */
    /*
     * Read through `asSpokenDirection`, because the server has more than one
     * word for the same way: `You found an exit downwards!` is the corpus's
     * only successful search and it says neither `down` nor `d`. A word this
     * client cannot read at all is treated as **this** step's, which is the
     * safe direction — the walk is holding on a search of its own and it is
     * the only search this client has out, so acting is at worst one bare
     * Enter and refusing would be the stuck search all over again.
     */
    const said = block.groups['direction']?.trim();
    const about = said === undefined ? null : asSpokenDirection(said);
    if (about !== null && about !== step.direction) return;

    if (block.type === 'user-search-succeeded') {
      // The one fact that ends the searching. See `found`.
      this.found = true;
    } else {
      const every = tuning().walk.searchRecheckEvery;
      if (every <= 0 || this.searched % every !== 0) return;
    }
    // On the step nudge's key: both are *make the server reprint this room*,
    // and two bare Enters queued together would be one wasted and one
    // resolved against a step it does not answer.
    this.walk.reprint(t('automation.walk.reasonRereading', { stepName: step.name }));
    this.armSearchBeat();
  }

  /**
   * Whether the room on screen has yet to print the hidden exit this step
   * needs — in which case the step is a command spent to be refused.
   *
   * *"Do not try the direction first unless it is available"* (todo 04): a
   * found exit joins the room's own `Obvious exits:` line — `secret passage
   * south`, which `parseExit` reads as `s` — so the room the character is
   * standing in already answers *is it open yet*. That is what keeps this from
   * being the pre-emptive search the reactive rung was written against: a lap
   * that found the exit once pays no search on the next lap, because the exit
   * is printed.
   *
   * **A room whose exits were never read proves nothing.** `exitsUnseen` —
   * a blinding room prints no list at all — so the step goes out and the
   * refusal, if it comes, is answered the way it always was.
   */
  mustSearchFirst(state: CharacterState, step: RouteStep): boolean {
    const need = step.requirement;
    if (need?.kind !== 'hidden' || need.searchable !== true) return false;
    // The server said it found this one. That outranks reading it back off a
    // list the client may not be able to parse -- see `found`.
    if (this.found) return false;
    if (state.room.exits.length === 0) return false;
    return !state.room.exits.some((exit) => exit.direction === step.direction);
  }

  /**
   * The barrier the room has already said stands in this step's way, or null.
   *
   * *"When a door is closed don't try the direction first"* (todo 01): the
   * room the character is standing in prints the state of every door leading
   * out of it — `Obvious exits: north, closed door south` — so the step into
   * one is a command spent to be told `The door is closed!`, and the `open`
   * that answers it was a fact the client already held.
   *
   * **`closed ` is the whole test, and it is the server's own word.**
   * `Door.ExitName` is `(open ? "open door " : "closed door ") + direction`,
   * `gate` for the other door type, and no other exit class qualifies itself
   * that way — a `TollExit` and a `NormalExit` print the bare direction and a
   * `HiddenExit` prints its own description (`secret passage south`). The
   * corpus agrees: 251 qualified exits across the captures, every one of them
   * `open`/`closed` + `door`/`gate`/`trap door`, never a bare `door` and never
   * a third state. A lock is **not** one of them — a locked door prints
   * `closed door` like any other — which is what leaves the ladder below with
   * something to do.
   *
   * Returns the noun alone (`door`, `gate`), because that is what the
   * refusal's own `barrier` group carries and the two label the same door.
   *
   * **A room whose exits were never read proves nothing** — `mustSearchFirst`
   * makes the same allowance for the same reason: a blinding room prints no
   * list at all, so the step goes out and the refusal, if it comes, is
   * answered the way it always was.
   */
  private shutAhead(state: CharacterState, step: RouteStep): string | null {
    if (state.room.exits.length === 0) return null;
    const exit = state.room.exits.find((one) => one.direction === step.direction);
    const note = exit?.note ?? null;
    if (note === null) return null;
    const shut = /^closed\s+(?<barrier>.+)$/.exec(note);
    return shut?.groups?.['barrier'] ?? null;
  }

  /**
   * Opens the door the room says is shut, in place of the step. Returns
   * whether anything was sent.
   *
   * The ladder in `onRefusedStep` is unchanged and still answers a door the
   * room did not warn about — a door another player shut between the room
   * block and the step, and every realm whose exits line this client cannot
   * read. This only spends the refusal's command before the server has to
   * print it.
   *
   * **Only on a fresh send**, because the room block is the evidence and it
   * does not reprint when the door opens: `The door is now open.` is the whole
   * of that news (`onBarrierChanged`), so a retry reading the same stale line
   * would ask again for a door that is already open, for ever.
   *
   * **And not at a door already known to be locked.** `open` at one answers
   * the same word every time, which is `forgetLock`'s whole argument; the
   * barrier round's retry comes through here fresh, with the budget forgotten
   * and the lock remembered, and falls through to the step so that
   * `onRefusedStep` reaches the forcing rungs exactly as it did before.
   */
  openShutWayFirst(step: RouteStep, state: CharacterState): boolean {
    if (this.locked || !this.config.movement.openDoors) return false;
    if (this.opened >= this.config.movement.openTries) return false;
    const barrier = this.shutAhead(state, step);
    if (barrier === null) return false;
    this.sendOpen(step, barrier);
    return true;
  }

  /**
   * Whether the refusal off the wire answers the step this walk has out.
   *
   * Nobody counting reads as "only this step" — the behaviour before the count
   * existed. Absent must not become the alarming answer either way.
   */
  private refusalIsOurs(): boolean {
    return (this.events.pendingMoves?.() ?? 1) === 1;
  }

  /**
   * A barrier changed state — and *which* change decides what follows.
   *
   * **Bashed is open and picked is only unlocked.** `You bashed the door
   * open.` leaves the character standing exactly where it was with the way
   * clear (`captures/005`: the room reprinted with `open door north` and the
   * door behind it still to the south), so the direction goes out again.
   * `You successfully unlocked the door.` leaves a shut door, so an `open`
   * goes first — unconditionally, whatever `openDoors` says, because the pick
   * that unlocked it was this module's own act and a lock picked for a door
   * left shut is a command spent for nothing.
   */
  onBarrierChanged(block: Block): void {
    if (this.forcing === null) return;
    const step = this.walk.step();
    if (step === undefined) return;

    if (block.groups['state2'] === 'unlocked') {
      this.forcing = null;
      this.forgetLock();
      this.queue.enqueue({
        command: `open ${step.direction}`,
        priority: 'movement',
        reason: t('automation.walk.reasonOpening', {
          barrier: t('automation.walk.fallbackBarrier'),
          stepName: step.name
        })
      });
      this.walk.stepAgain();
      return;
    }
    if (block.groups['state'] === 'open') {
      this.forcing = null;
      this.forgetLock();
      this.walk.stepAgain();
    }
  }

  /**
   * The forcing attempt in flight came back a failure. Try the next one, or
   * stand at the door and run the whole ladder again in a moment.
   */
  private forceAgainOrHold(): void {
    this.forcing = null;
    const step = this.walk.step();
    if (step === undefined) {
      this.stopRefused(step, undefined);
      return;
    }
    const barrier = t('automation.walk.fallbackBarrier');
    if (this.force(step, barrier)) return;
    this.holdAtBarrier(step, barrier);
  }

  /**
   * Spends one attempt on the barrier in the way, if either skill is worth
   * spending it. Returns whether anything was sent.
   *
   * **Picking first when both are open.** A failed pick costs a command; a
   * failed bash costs a command and some health, and the server prints the
   * damage in the room. The cheaper question is asked first.
   */
  private force(step: RouteStep, barrier: string): boolean {
    const { movement } = this.config;
    const need = step.requirement;

    /*
     * **The key first, and gated by neither switch.**
     *
     * Reported 2026-09-06 standing at a locked door in `Crypt, Sealed Tomb`
     * with two bone keys in the pack and a hundred and forty-three more on the
     * floor: the walk sent `n`, `open n`, and then bashed the door six times,
     * taking damage each time, and never once tried the key it was carrying.
     *
     * It is not a rung like the other two, and that is why it goes above them
     * and answers to neither `pickLocks` nor `bashDoors`:
     *
     * - **It cannot fail on a roll.** `Door.TryUnlock` compares the key's row
     *   against the door's `KeyItemID` and unlocks it. A pick is a skill check
     *   and a bash is a skill check paid for in hit points; this is neither.
     * - **The route exists *because* the key is held.** `edgePenalty` prunes a
     *   keyed edge outright once a listing has landed and the pack does not
     *   hold the key, so a step in front of a keyed door is one the router
     *   planned on the strength of that key being carried. Refusing to use it
     *   makes the plan a promise the walk breaks — the same argument the
     *   `stated` flag below already makes about a barrier the realm names no
     *   number for.
     * - **`AutoKeys` bent down for it.** That shipped hours earlier, on
     *   instruction, and picking a key up and then bashing the door it opens
     *   is the more expensive half of a feature doing nothing.
     *
     * One attempt per run of the ladder: a key that did not work will not work
     * on being sent again. `holdAtBarrier` runs the whole ladder afresh a
     * moment later, and `forget` gives this its attempt back with the
     * rest — which is what covers the door the server re-locks on its own
     * timer (`TryUnlock` arms a `LockDoor` event for `openTime`).
     */
    if (need?.keyId !== undefined && !this.keyed) {
      const name = this.events.keyToUse?.(need.keyId);
      if (name !== null && name !== undefined) {
        this.keyed = true;
        this.sendForcing('key', `use ${name} ${step.direction}`, step, barrier);
        return true;
      }
    }
    // The realm records a number for some barriers and nothing for others. No
    // number at all is not "impossible" — it is the plain `Door` the router
    // already priced as ordinary when it planned this route through it, so
    // refusing to force one would make the plan a promise the walk breaks.
    const stated = need?.pickDifficulty !== undefined || need?.bashDifficulty !== undefined;

    if (
      movement.pickLocks &&
      this.picked < movement.pickTries &&
      meetsBarrier(need?.pickDifficulty, this.picklocks, tuning().walk.pickMargin, stated)
    ) {
      this.picked += 1;
      this.sendForcing('pick', `pi ${step.direction}`, step, barrier);
      return true;
    }
    if (
      movement.bashDoors &&
      this.bashed < movement.bashTries &&
      !this.tooHurtToBash() &&
      meetsBarrier(need?.bashDifficulty, this.strength, tuning().walk.bashMargin, stated)
    ) {
      this.bashed += 1;
      this.sendForcing('bash', `bas ${step.direction}`, step, barrier);
      return true;
    }
    return false;
  }

  /**
   * Whether a bash costs more health than this character has to spend.
   *
   * *"You take 1 damage for bashing the gate!"* — the server prints it in the
   * room, and a bash is the one rung of the ladder that is paid for in hit
   * points. Before the ladder could be run again that was bounded by
   * `bashTries` and then the walk ended; now it repeats, and `bashTries` a
   * round for `barrierRetries` rounds is a character that can knock itself out
   * at a door with nothing else in the room threatening it.
   *
   * `restBelow` is the figure that already says *this character does not
   * travel below this*, and forcing a door is how this step travels — so it is
   * the same line, applied to the one rung that spends health. The pick is
   * ungated: it costs a command and nothing else.
   *
   * Read straight off the config rather than through `Holds.wantsHealthHold`, which
   * is gated on `holdWhenHurt`. That option answers *who is responsible for
   * resting this walk*, and the walk that turns it off — a loop's leg, held
   * for health by `LoopRunner` **between** legs and not within one — is
   * exactly the walk that would otherwise stand at a door bashing all night.
   *
   * Unknown never refuses, the rule every threshold here follows: a null
   * maximum is absence, not a low number.
   */
  private tooHurtToBash(): boolean {
    const { restBelow } = this.config.health;
    if (restBelow <= 0) return false;
    const state = this.events.stateNow?.();
    if (state === undefined) return false;
    const { hp, hpMax } = state.vitals;
    if (hp === null || hpMax === null || hpMax <= 0) return false;
    return hp / hpMax < restBelow;
  }

  /**
   * Stand at a shut door the ladder could not get past, and run the whole
   * ladder again in a moment.
   *
   * *"we shouldn't actually stop we should just wait and retry in case health
   * low"* — reported with the transcript in `onOpenRefused`. Every reason the
   * ladder runs out is a reason that may not be true a moment later: the bash
   * that was refused because the character is under `restBelow` is affordable
   * once `Recovery` has sat it down, the lock that took three failed rolls may
   * take the fourth, and a gate is a thing other people walk through. Ending
   * the journey at the first exhausted round meant a lap died at a shut door
   * and an unattended character stood in a corridor until somebody looked.
   *
   * On the health hold's terms, and it deliberately differs in one:
   *
   * - **A hold is not an ending.** The route, the destination and the step
   *   count all survive, and `WalkProgress.hold` says why the character is
   *   standing still.
   * - **The retry goes through `Walker.holdBeforeSending`**, so health, a stated
   *   affliction and the quarry beat all outrank it — which is what makes
   *   *wait in case health is low* mean something rather than merely
   *   describing the delay.
   * - **`forget` gives the ladder its budget back**, because the round
   *   is the same three questions asked again of a door whose answers may
   *   have changed. That is why the bound is counted here and not in the
   *   per-step counters, which the retry itself resets.
   * - **It is bounded, unlike the health hold.** What ends that one is the
   *   character healing, which `Recovery` is doing precisely because the walk
   *   is standing still. Nothing in this client is working on the door, so
   *   this is `fightHoldMs`'s argument in another shape: a floor under a hold
   *   whose end nobody here can bring about. Past `walk.barrierRetries` the
   *   walk stops the way it always did, saying which door and what it wanted.
   *
   * Said out loud once per barrier rather than once per round: a line every
   * five seconds about the same shut door is the chrome talking over the room.
   */
  private holdAtBarrier(step: RouteStep, barrier: string): void {
    /*
     * The last rung, and the only one that is not a command sent at this door:
     * the realm may name a lever that opens it, in this room or in another.
     * Ahead of the wait, because standing here running the ladder again is
     * what the errand exists instead of — and reached from all three callers
     * at once, which is why it is here rather than beside each of them.
     */
    if (this.levers.fetchLever(step)) return;
    if (this.barrierRounds >= tuning().walk.barrierRetries) {
      this.stopRefused(step, barrier);
      return;
    }
    if (this.barrierRounds === 0 && !this.walk.quiet()) {
      this.events.notice?.(
        t('automation.walk.barrierHolding', { barrier, detail: this.barrierDetail(step) })
      );
    }
    this.barrierRounds += 1;
    // The step's deadline was timing a move the refusal has already answered.
    this.clock.clear();
    this.slot.take('barrier');
    this.walk.publish();
    this.roundAfter(tuning().walk.barrierRetryMs);
  }

  /**
   * Ask the barrier to open, and wait for the answer rather than queueing the
   * step behind it.
   *
   * The step used to go out behind the `open` unconditionally, so a locked
   * door cost a move to be refused a second time before the ladder moved on
   * (`onOpenRefused` has the transcript). Waiting means the two answers that
   * decide the next rung — `door-changed` and `open-failed` — are read before
   * anything else is spent.
   *
   * **And the deadline sends the step rather than giving up**, which is the
   * difference between this and `sendForcing`. A bash and a pick have their
   * successes and their failures in the corpus; `The <…> is now open.` is
   * read out of the server's source with only `door` ever captured, so a
   * realm that phrases it some third way would leave this waiting on a
   * sentence nothing matches. Falling back to the step is exactly what this
   * did before, one round trip later — the old behaviour as the *worst* case
   * instead of the only one.
   */
  private sendOpen(step: RouteStep, barrier: string): void {
    this.opened += 1;
    this.forcing = 'open';
    this.walk.dispatch(
      step,
      `open ${step.direction}`,
      t('automation.walk.reasonOpening', { barrier, stepName: step.name }),
      () => this.noteOpenSent(step)
    );
  }

  /**
   * The `open` is on the wire. Give the realm its round, and take the step
   * anyway if nothing this client reads comes back — see `sendOpen`.
   */
  private noteOpenSent(step: RouteStep): void {
    // A late `onSent` from an attempt this walk has moved past decides
    // nothing, exactly as in `Walker.noteStepSent`.
    if (!this.walk.onWire(step)) return;
    this.clock.clear();
    this.clock.afterStep(this.walk.nudgeAfter(), () => {
      if (!this.walk.walking() || this.forcing !== 'open') return;
      this.forcing = null;
      /*
       * Through the holds, because this fires on a clock rather than on an
       * answer: a fight, low health or a stated affliction may have arrived
       * while the door was being asked, and a movement command released here
       * would walk the character out of a fight `Walker.cancelQueued` cannot
       * recall it from.
       */
      this.walk.retry(this.events.stateNow?.(), false);
    });
  }

  private sendForcing(
    kind: 'bash' | 'pick' | 'key',
    command: string,
    step: RouteStep,
    barrier: string
  ): void {
    this.forcing = kind;
    /*
     * Timed as the step is, and the direction is deliberately *not* queued
     * behind this one. Unlike `open`, a forcing attempt has an answer worth
     * reading — `door-changed` says the way is clear, the two failures say to
     * try again — so sending the step blind would spend a move to be refused
     * by the same shut door, once per attempt.
     *
     * The deadline is armed against `bas w` rather than against `w`, which is
     * what the step's own deadline would have said: a walk that gave up here
     * used to report `nothing came back after w` for a command nobody sent.
     */
    this.walk.dispatch(
      step,
      command,
      kind === 'pick'
        ? t('automation.walk.reasonPicking', { barrier, stepName: step.name })
        : kind === 'key'
          ? t('automation.walk.reasonUnlocking', { barrier, stepName: step.name })
          : t('automation.walk.reasonBashing', { barrier, stepName: step.name })
    );
  }

  /** Ends the walk at a barrier, saying what the realm asked for and what this character has. */
  private stopRefused(step: RouteStep | undefined, barrier: string | undefined): void {
    const command = step?.command ?? t('automation.walk.fallbackMove');
    if (step === undefined || barrier === undefined) {
      this.walk.stop(t('automation.walk.reasonRefused', { command }));
      return;
    }
    /*
     * Say what stood in the way. Somebody who turned bashing on and watched a
     * route stop at a door needs to see whether it was never tried, tried and
     * failed, or refused because the character is not strong enough — and the
     * three read identically from `the game refused w`.
     */
    this.walk.stop(
      t('automation.walk.reasonBarrier', {
        barrier,
        command,
        detail: this.barrierDetail(step)
      })
    );
  }

  /** Why this barrier was not forced, in as many words. */
  private barrierDetail(step: RouteStep): string {
    const { movement } = this.config;
    if (this.picked > 0 || this.bashed > 0) {
      return t('automation.walk.barrierHeld');
    }
    if (!movement.pickLocks && !movement.bashDoors) {
      return t('automation.walk.barrierNotAllowed');
    }
    /*
     * Before the skill comparison below, because it is a different answer: the
     * character may be strong enough and simply too hurt to spend the health
     * a bash costs. Reading `requires 41; this character has 60 strength`
     * there would be the client contradicting itself.
     */
    if (movement.bashDoors && this.tooHurtToBash()) {
      return t('automation.walk.barrierTooHurt');
    }
    const need = step.requirement;
    const wanted = need?.pickDifficulty ?? need?.bashDifficulty;
    if (wanted === undefined) return t('automation.walk.barrierNotAllowed');
    return t('automation.walk.barrierTooHard', {
      wanted,
      picklocks: this.picklocks ?? t('automation.walk.barrierUnknownSkill'),
      strength: this.strength ?? t('automation.walk.barrierUnknownSkill')
    });
  }

  /** Everything remembered about the barrier at the step in flight. */
  forget(): void {
    this.opened = 0;
    this.bashed = 0;
    this.picked = 0;
    this.keyed = false;
    this.searched = 0;
    this.searchSaidAt = 0;
    this.found = false;
    this.levers.forgetPulls();
    this.forcing = null;
  }

  /**
   * Forgets that the barrier ahead is locked.
   *
   * **Deliberately not part of `forget`.** That one is spent by every
   * retry behind the same door, and a lock does not unlock itself between two
   * of them: `open` at a locked door answers the same word every time, which
   * is written down two rungs up and was then thrown away five seconds later.
   * Reported from the wire as the whole of todo 01 — twelve rounds of
   *
   *     [HP=148/MA=26]:n          The gate is closed!
   *     [HP=148/MA=26]:open n     The gate is locked.
   *
   * on a gate whose 301 picklocks the character had 0 of. Twenty-four commands
   * to be told twice over what the first two already said.
   *
   * What clears it is a fact: the door changing state (`onBarrierChanged`), a
   * confirmed step — the character got past — or a fresh walk.
   */
  forgetLock(): void {
    this.locked = false;
  }
}

/**
 * Whether a skill is worth spending a command against a barrier's number.
 *
 * `stated` is whether the realm named *any* number for this barrier: when it
 * named none it asks for no skill, which is the plain `Door` the router
 * already priced as ordinary. When it named one for the other channel only —
 * `Key: 2126 [or 157 picklocks]` says nothing about strength — this channel is
 * closed rather than free, because the realm has been specific.
 *
 * `0` is the realm's `any`: whoever leans on it gets through.
 *
 * An unknown skill never meets a stated number. That is the same direction
 * every threshold in this client takes — unknown is not plenty — and here it
 * is also the cheap one: the stat sheet is one `st` away.
 */
function meetsBarrier(
  need: number | undefined,
  skill: number | null,
  margin: number,
  stated: boolean
): boolean {
  if (!stated) return true;
  if (need === undefined) return false;
  if (need <= 0) return true;
  return skill !== null && skill >= need - margin;
}

/**
 * Whether this refusal is the way being **shut** rather than the corridor
 * being absent, which are two different things said two different ways.
 *
 * `There is no exit in that direction!` is the sentence a hidden exit gives
 * until it is opened — the realm data's own promise, kept. Only an exit the
 * realm records nothing about is the data having been wrong.
 */
function shutRatherThanMissing(step: RouteStep): 'missing' | 'shut' {
  return step.requirement?.kind === 'hidden' ? 'shut' : 'missing';
}
