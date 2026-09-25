/**
 * What this character has been seen to do about each quest this sitting: a
 * line sent that reaches a step and a monster watched die, each only ever
 * forward, and refused where a complete `abil` listing's own counter gates
 * say the step cannot have run. Never the realm's count, which stays
 * `CharacterState.abilities` and outranks it on the card. See
 * `mudengine-world` › `parts/quests.md` and `mudengine-ui` ›
 * `parts/quests.md`.
 */
import type { SessionModule } from '../automation/Module';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { SessionSink } from './SessionSink';
import type { AbilitySums } from '../../shared/character';
import {
  countersNow,
  countersRefuse,
  stepKilled,
  stepSaid,
  type Quest,
  type QuestSeen,
  type QuestStep,
  type QuestWatched
} from '../../shared/quests';
import { roomAddress } from '../../shared/world';

/** Where the character stands and what `abil` last listed, and the realm's quests. */
export interface QuestWatchParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly world: Pick<WorldGraph, 'quests'> | undefined;
}

export class QuestWatch implements SessionModule {
  private readonly tracker: QuestWatchParts['tracker'];
  private readonly world: QuestWatchParts['world'];
  /**
   * The rank each quest's counter has been *seen* to reach, and **when**.
   *
   * Per session: it is a record of this sitting's actions. The clock is what
   * lets it be ranked against the realm's own count rather than simply losing
   * to it — a listing read before the act is older evidence than the act. See
   * `questReading`.
   */
  private questSaid: Record<number, QuestSeen> = {};

  constructor(
    parts: QuestWatchParts,
    private readonly sink: Pick<SessionSink, 'questSaid'>
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
  }

  /** The rank each quest has been seen to reach, and when. */
  get watched(): QuestWatched {
    return this.questSaid;
  }

  /**
   * The character that was is put down: on connect, on leaving the realm (a
   * reroll at the menu walks back in as somebody else) and on forgetting it.
   * The card is told only when it held something, so an empty reset is silent.
   */
  reset(): void {
    if (Object.keys(this.questSaid).length === 0) return;
    this.questSaid = {};
    this.sink.questSaid?.(this.questSaid);
  }

  /**
   * A typed line that reaches a quest step, so the book moves as the character
   * plays rather than only when somebody spends an `abil`.
   *
   * Reported 2026-09-07: `ask markus letter` advanced the quest and the card
   * said nothing until an `abil` was typed. Nothing on the wire announces a
   * counter moving — that is the whole reason `abil` exists — so the only fact
   * available at the moment it happens is the **player's own action**, and this
   * is that fact and no more. It never touches `CharacterState.abilities`,
   * which is the realm's own count and stays the realm's: what crosses is a
   * separate reading the card ranks *under* it.
   *
   * The step must name its asker and the line must carry both the asker and one
   * of the words that reach the step — see `stepSaid` for why the pair, and why
   * this does not claim the ask succeeded. **Where the character is standing
   * and what `abil` last stated are handed over too**, because one asker and
   * one phrase routinely reach several steps: `ask old man prophecy` reaches
   * four, three of them in a room on another map, and taking the first
   * credited the Good quest to somebody doing the Phoenix one (2026-09-15).
   */
  noteSaid(command: string): void {
    const quests = this.world?.quests();
    if (quests === undefined || quests.length === 0) return;
    // Where the character is standing, for a step the realm scripts onto a room
    // rather than onto somebody: the room is that step's anchor (todo 12).
    this.reached(
      stepSaid(quests, command, roomAddress(this.tracker.current.room), this.countersNow())
    );
  }

  /**
   * A monster this character watched die, which is the other way a step runs.
   *
   * Reported 2026-09-15: the dread mystic died in the Meditation Chamber and
   * the quest book stayed at one of nine. A boss's `DeathSpell` chains into a
   * text block and that block is a quest step (realm format 37) — so *kill the
   * dread mystic* is the whole act, there is nothing to say and nobody to say
   * it to, and `noteSaid` above could never reach the kind. The death is
   * the fact available at the moment it happens, exactly as the typed line is
   * for an ask, and it is read the same way and ranked the same way.
   *
   * Taken from the tracker rather than read off the block here, because
   * *whether* a monster died is a judgement `FightTracker` makes — from the
   * room's own death sentence, or from the experience line against the thing
   * this character was hitting — and the name is the realm's row, not the
   * spelling the room hung a modifier on.
   */
  noteKilled(name: string): void {
    const quests = this.world?.quests();
    if (quests === undefined || quests.length === 0) return;
    this.reached(
      stepKilled(quests, name, roomAddress(this.tracker.current.room), this.countersNow())
    );
  }

  /**
   * The counters as they stand: what `abil` last listed, walked forward by
   * what has been watched since. See `countersNow` for why the listing alone
   * is a photograph, and every reader of a counter here takes this one.
   */
  private countersNow(): AbilitySums | null {
    return countersNow(this.tracker.current.abilities, this.questSaid);
  }

  /**
   * The book has been seen to reach a rank. Both readings land here.
   *
   * **Only ever forward.** A keyword answered again at a later rank, or a boss
   * killed a second time, must not walk the book backwards — and `giveability`
   * is upward-only on the server too, so forward is what the counter does.
   *
   * **And a step the counters refuse did not run.** Neither reading claims the
   * ask succeeded, and until 2026-09-15 that risk was contained by the listing
   * always outranking them; now that a later observation can raise the book
   * above a listing, the listing is put to the one use it is exact for — a
   * *complete* one that fails this step's own counter gates says the server
   * cannot have run it, whatever the player typed. Unknown refuses nothing, as
   * everywhere: no listing, or half of one, and the act is taken as before.
   */
  private reached(found: { quest: Quest; step: QuestStep } | null): void {
    if (found === null || found.step.to === undefined) return;
    const known = this.questSaid[found.quest.id];
    if (known !== undefined && known.to >= found.step.to) return;
    if (countersRefuse(found.step, this.countersNow())) return;
    const seen: QuestSeen = { to: found.step.to, at: Date.now() };
    this.questSaid = { ...this.questSaid, [found.quest.id]: seen };
    this.sink.questSaid?.(this.questSaid);
  }
}
