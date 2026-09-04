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
 *   the whole command budget. The room is keyed by where it *is* (`map/room`)
 *   and, when that is unknown, by the name plus the exits it printed, which is
 *   as much as the client has. Re-entering a room searches it again, because
 *   the realm may have changed and because a lap is the natural unit of "try
 *   again".
 * - **Search in a fight.** A command spent mid-round is one the fight paid for,
 *   and nothing found by it can be used until the fight ends.
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

/**
 * How this client addresses the room it is standing in, for the purpose of
 * remembering that it has looked here.
 *
 * Coordinates where the realm has settled them, because that is the one exact
 * statement of position; otherwise the name with the exits the server printed,
 * which is the same pair `resolve.ts` uses to tell one Sewer Tunnel from
 * another and is a great deal better than the name alone in a realm with 293
 * of them. Null when neither is known, and a null room is never searched.
 */
function whereIsThis(state: CharacterState): string | null {
  const { map, number, name, exits } = state.room;
  if (map !== null && number !== null) return `${map}/${number}`;
  if (name === null) return null;
  return `${name}|${exits.map((exit) => exit.direction).join(',')}`;
}

export class AutoSearch {
  /** The room last searched, as `whereIsThis` addresses it. */
  private room: string | null = null;
  /** How many searches have gone out for that room. */
  private tries = 0;

  constructor(
    private config: SearchConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue
  ) {}

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
    if (state.inCombat) return;
    if (this.tries >= this.config.tries) return;

    this.tries += 1;
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
      reason: t('automation.search.reason')
    });
  }
}
