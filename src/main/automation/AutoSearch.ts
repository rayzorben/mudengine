/**
 * Looking for what the room does not print.
 *
 * The realm hides exits — 249 of the shipped realm's are `Hidden/Searchable`,
 * and `WorldGraph.edgePenalty` prices one at "costs the search" precisely
 * because the router expects somebody to spend it. `Walker` spends it
 * **reactively**: a step it planned through a hidden edge is refused, and it
 * answers with `search <direction>` and the step again. That covers the exits
 * the router already knew about.
 *
 * This is the other half, and it is the half that finds the exit nothing
 * planned a route through in the first place: a bare `search`, once per room
 * arrived in.
 *
 * ## What it will not do
 *
 * - **Search the same room twice.** A room the character stands in for ten
 *   minutes, a `look` reprinting it, a fight ending with a courtesy reprint —
 *   all leave the room the same room, and a search per status line would be
 *   the whole command budget. The room is keyed by where it *is* (`map/room`),
 *   or by the name plus the exits it printed, **and by the arrival it was read
 *   on**, which is what keeps a corridor of namesakes from reading as one room
 *   (`whereIsThis`). Re-entering a room searches it again, because the realm
 *   may have changed and because a lap is the natural unit of "try again".
 * - **Search in a fight.** A command spent mid-round is one the fight paid for,
 *   and nothing found by it can be used until the fight ends. The server says
 *   so outright — `You may not search while attacking!` — and says it *after*
 *   spending the command, so this is asked twice: once when the search is
 *   proposed, and again immediately before it goes out (`Intent.stillWanted`).
 *   The second ask is the one that matters, because a search proposed on
 *   arriving in a room is held behind the attack auto-combat proposed from the
 *   same status line and lands inside the fight that attack started (todo 13,
 *   2026-09-13). Dropped rather than held, so the next status line after the
 *   fight proposes it again — which is *do it after attacking*, arrived at
 *   without a second memory of having wanted to.
 * - **Search a room holding a monster auto-combat would open on**
 *   (`AutoCombat.quarry`, the walker's `holdAt`). Fighting is not yet true
 *   while the attack is unanswered: `festus` (2026-09-18) sent `search` 3ms
 *   behind `aa fierce orc fanatic`, released by the prompt closing the room
 *   its leader dragged it into, 65ms before `*Combat Engaged*`. The monster
 *   first, then the room — and a room whose monsters nobody will fight is
 *   searched as before.
 * - **Search while resting**, for `AutoLoot`'s reason and with the same date on
 *   it: whether `search` breaks a rest has never been asked of the wire, and
 *   refusing costs only a delay where being wrong costs the rest. `npm run
 *   probe:rest` is where to settle it.
 * - **Search a room it is only passing through blind.** A room the client
 *   cannot identify at all — no coordinates, no name — is one it cannot
 *   remember having searched, so searching it would be the per-status-line
 *   failure above wearing a different hat.
 *
 * `probe` band and coalesced, like every other unasked look: the least urgent
 * thing in the client, below the walk it usually happens during and far below a
 * escape. Nothing here touches a socket.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { SearchConfig } from '../../shared/config';
import { tuning } from '../app/tuning';
import { fightIsRunning } from './Walker';

/**
 * How this client addresses the room it is standing in, for the purpose of
 * remembering that it has looked here.
 *
 * Coordinates where the realm has settled them, because that is the one exact
 * statement of position; otherwise the name with the exits the server printed,
 * which is the same pair `resolve.ts` uses to tell one Sewer Tunnel from
 * another and is a great deal better than the name alone in a realm with 293
 * of them. Null when neither is known, and a null room is never searched.
 *
 * **And the arrival it was read on, because neither address is unique.** A
 * name and a set of exits is an address a maze repeats on purpose: three
 * rooms called `Secret Passage` printing `east, west` in a row (bearfather,
 * 2026-09-17) are one address, the first was searched, and the client then
 * believed it had already looked in the two it walked into afterwards — the
 * reported *it is skipping search in some rooms*. Coordinates repeat for the
 * honest reason instead: walking out and back in is the lap this feature
 * searches again on, and that used to work only because the room in between
 * happened to be addressed differently.
 *
 * `Room.arrival` is what separates the two questions. It moves when the
 * character arrives somewhere and not when the room is merely printed again,
 * so a `look`, a courtesy reprint after a fight and the idle Enter all leave
 * the address alone — which is the whole of what this key was guarding
 * against — while every step taken makes a new one.
 */
function whereIsThis(state: CharacterState): string | null {
  const { map, number, name, exits, arrival } = state.room;
  if (map !== null && number !== null) return `${arrival}@${map}/${number}`;
  if (name === null) return null;
  return `${arrival}@${name}|${exits.map((exit) => exit.direction).join(',')}`;
}

export class AutoSearch {
  /** The room last searched, as `whereIsThis` addresses it. */
  private room: string | null = null;
  /** How many searches have gone out for that room. */
  private tries = 0;

  constructor(
    private config: SearchConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    /**
     * The character as it is *now*, for the ask made at the send.
     *
     * The state handed to `onCharacter` is the state the proposal was made
     * against, and the whole point of the second ask is that it is no longer
     * true. `Walker` takes its own `stateNow` for the same reason.
     */
    private readonly stateNow: () => CharacterState,
    /** `AutoCombat.quarry`: asked rather than worked out, for `holdAt`'s reason. */
    private readonly quarry: (state: CharacterState) => boolean
  ) {}

  /** A fight running here, or one auto-combat is about to open. */
  private fightHere(state: CharacterState): boolean {
    return fightIsRunning(state) || this.quarry(state);
  }

  configure(config: SearchConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  /**
   * A new session or a closed socket. Forgetting is right rather than merely
   * safe: the character comes back somewhere, and a room remembered across the
   * gap would be one this character never searched in this life.
   */
  reset(): void {
    this.room = null;
    this.tries = 0;
  }

  onCharacter(state: CharacterState): void {
    if (state.phase !== 'in-game') return;
    const here = whereIsThis(state);
    if (here === null) return;

    // A different room is a fresh budget, whether or not the switch is on —
    // otherwise turning it on mid-corridor would find a spent counter.
    if (here !== this.room) {
      this.room = here;
      this.tries = 0;
    }

    // Both gates: the master switch, and this feature's own.
    if (!this.enabled || !this.config.enabled) return;
    // Unmeasured rather than settled, like `AutoLoot`: waiting costs the wait.
    if (state.vitals.resting || state.vitals.meditating) return;
    /*
     * **One reading of *fighting*, used here and at the send.** This asked
     * `state.inCombat`, which is the server's flag alone; `fightIsRunning` is
     * this codebase's own definition everywhere a walk, a rest or a retreat
     * asks the question — the flag, something recorded swinging, or a target.
     * Two spellings of one gate agree exactly until one of them is edited, and
     * the send-time ask below has to be the same question as this one or the
     * pair would disagree about the round between a kill and the next swing.
     */
    if (this.fightHere(state)) return;
    if (this.tries >= this.config.tries) return;

    this.queue.enqueue({
      /*
       * Bare, and deliberately not `search <direction>`.
       *
       * The walker's rung names a direction because it is answering a refusal
       * about one particular edge. Here nothing has been refused and no
       * direction is suspected — the question is *what is in this room that
       * was not printed* — and asking it once per direction would be ten
       * commands a room.
       */
      command: 'search',
      priority: 'probe',
      /*
       * Per room, so the several status lines one arrival produces cannot
       * queue several searches. By intent and never by command text: two
       * searches in two rooms are two different intents that happen to spell
       * the same word, which is the distinction the queue exists to make.
       */
      coalesceKey: `search:${here}`,
      expiresAt: Date.now() + tuning().search.expiresMs,
      /*
       * The fight that started between the proposal and the send. Dropped
       * rather than held: the next status line after the fight proposes it
       * again, and the budget below is spent on what actually went out.
       */
      stillWanted: () => !this.fightHere(this.stateNow()),
      /*
       * **Counted at the send, never at the proposal.** A search the guard
       * above dropped never reached the server, and charging it to the room's
       * budget would mean a room entered during a fight was never searched at
       * all. Coalescing is what stops a second proposal queueing beside the
       * first while it waits: one intent per room, whatever the status lines do.
       */
      onSent: () => {
        this.tries += 1;
      },
      reason: t('automation.search.reason')
    });
  }
}
