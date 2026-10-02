/**
 * The room as it stands appraised against the character as it stands: the
 * verdict, the fight it would be (`survivalOf`), each monster alone out of the
 * odds book (`OddsBook`), a monster looked up by name, and what the room's
 * occupants answer to. Holds nothing but its last run; `Publisher` pushes what
 * it answers on change. See `mudengine-automation` › *The verdict is also run
 * as a fight*.
 */
import { tuning } from '../app/tuning';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import type { FightSetup } from './FightSetup';
import type { OddsReader } from './OddsBook';
import { ownAlignment, packRows, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { inTheFight } from '../../shared/guards';
import { attacksFirst, rowPeaceFor } from '../../shared/mobRules';
import { asksHere, type QuestWatched, type RoomAsk } from '../../shared/quests';
import { simulateFight, type Survival } from '../../shared/survival';
import {
  appraiseRoom,
  EMPTY_ROOM_VERDICT,
  prowessSheetOf,
  weighVerdicts,
  wieldedWeapon,
  type RoomVerdict,
  type Verdict
} from '../../shared/verdict';
import { roomId } from '../../shared/world';

/** What the appraisal reads: the character, the realm, and the realm's answers about both. */
export interface AppraisalParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly world: Pick<WorldGraph, 'buildMobEntity' | 'quests'> | undefined;
  readonly errands: Pick<Errands, 'menacePlayer' | 'realmClass'>;
  /** The character half of a fight, as the odds book builds it too. */
  readonly setup: Pick<FightSetup, 'character' | 'foes'>;
  /** Each monster fought alone, rested. */
  readonly odds: OddsReader;
}

/** What the session that built this answers for it. */
export interface AppraisalSession {
  /** The automation settings as last loaded: the rows the room is read with. */
  config(): AutomationConfig;
  /** The rank each quest has been seen to reach this session. */
  watched(): QuestWatched;
}

export class Appraisal {
  private readonly tracker: AppraisalParts['tracker'];
  private readonly world: AppraisalParts['world'];
  private readonly errands: AppraisalParts['errands'];
  private readonly setup: AppraisalParts['setup'];
  private readonly odds: AppraisalParts['odds'];
  /** The room's last run and what it was run on, so a status line that moves nothing reruns nothing. */
  private ran: { key: string; survival: Survival | null } | null = null;
  /** The same for the fight an opening would make (`opening`). */
  private ranOpening: { key: string; survival: Survival | null } | null = null;

  constructor(
    parts: AppraisalParts,
    private readonly session: AppraisalSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.errands = parts.errands;
    this.setup = parts.setup;
    this.odds = parts.odds;
  }

  /**
   * What this room's occupants answer to, for this character. See `asksHere`.
   *
   * The occupants are read **first**, and an empty room leaves before the book
   * is joined or the pack is walked: this runs on every status line, like the
   * verdict beside it, and most rooms have nobody in them.
   *
   * Computed here for the reason the verdict is: the quest book, the counters
   * `abil` stated, the asks this session watched and the listed pack are four
   * facts that live only in main, and three of them move without the room
   * moving. A join made in the card would need the book over IPC on every
   * room, and would still be looking at the rank from before the `abil` the
   * player just sent.
   */
  get asks(): readonly RoomAsk[] {
    const state = this.tracker.current;
    if (state.phase !== 'in-game') return [];
    const here = state.room.occupants.filter((who) => who.kind !== 'player').map((who) => who.name);
    if (here.length === 0) return [];
    const book = this.world?.quests();
    if (book === undefined || book.length === 0) return [];
    return asksHere(
      book,
      here,
      {
        className: state.className ?? null,
        race: state.race ?? null,
        level: state.progress.level ?? null,
        counters: state.abilities ?? null
      },
      this.session.watched(),
      // The pack as an answer or as a silence — never as an empty pack, which
      // would say *you are not carrying this* about a pack nobody has read.
      packRows(state.inventory)
    );
  }

  /**
   * The room as it stands, appraised against the character as it stands. See
   * `appraiseRoom`.
   *
   * Computed here and not in the renderer because three of its inputs live
   * only in main: the class row, the server's family and the menace prices in
   * `internal.yaml`. And computed here rather than inside `AutoCombat` because
   * the answer is owed to a player with automation **off** — the Room card is
   * for a person deciding whether to open, and the engine's ranking is one
   * consumer of the same function, not its owner.
   */
  get verdict(): RoomVerdict {
    const state = this.tracker.current;
    if (state.phase !== 'in-game' || state.room.occupants.length === 0) return EMPTY_ROOM_VERDICT;
    const { combat, magery, family, attack } = this.errands.realmClass();
    const sheet = prowessSheetOf(state, { combat, magery });
    const weapon = wieldedWeapon(state.inventory.items);
    const appraisal = appraiseRoom(
      state.room.occupants,
      this.errands.menacePlayer(state),
      tuning().menace,
      sheet,
      weapon,
      family,
      attack
    );
    // And the row's word beside the realm's, where one says it does not attack first.
    const rules = this.session.config().combat.mobRules;
    // And each one fought alone, rested, out of the odds book.
    const monsters = appraisal.monsters.map((entry) => {
      const peace = rowPeaceFor(rules, entry.name);
      const alone = this.odds.mob(entry.name);
      return peace === null ? { ...entry, alone } : { ...entry, peace, alone };
    });
    return { ...appraisal, monsters, survival: this.survivalOf(state) };
  }

  /**
   * One monster each, by name, for the Reference card's lookup — the same
   * arithmetic as the room's, run on a room of one, so a monster looked up
   * from the console reads exactly as it would standing in front of it.
   *
   * A name the realm cannot place gets no key: the lookup already answers only
   * with the realm's own rows, so an unplaceable name here is one the caller
   * invented rather than one the card will draw.
   */
  appraise(names: readonly string[]): Record<string, Verdict> {
    const state = this.tracker.current;
    const { combat, magery, family, attack } = this.errands.realmClass();
    const sheet = prowessSheetOf(state, { combat, magery });
    const weapon = wieldedWeapon(state.inventory.items);
    const player = this.errands.menacePlayer(state);
    const verdicts: Record<string, Verdict> = {};
    // Weighed as the row the character's own room resolves each name to: a
    // name holding two of the realm's rows was weighed as the worse of them
    // wherever the room says which it is. See `WorldGraph.resolveMobRow`.
    const at =
      state.room.map === null || state.room.number === null
        ? null
        : roomId(state.room.map, state.room.number);
    for (const name of names) {
      const entity = this.world?.buildMobEntity(name, { at });
      if (entity === undefined || entity.source === 'wire') continue;
      const [verdict] = weighVerdicts(
        [entity],
        player,
        tuning().menace,
        sheet,
        weapon,
        family,
        attack
      );
      if (verdict !== undefined) verdicts[name] = verdict;
    }
    return verdicts;
  }

  /**
   * The fight opening on `target` would make: the room's, with the target in
   * it whether or not it would have started one. What `AutoCombat` asks
   * before it swings (`openingRefusal`).
   */
  opening(target: string): Survival | null {
    const state = this.tracker.current;
    return state.phase === 'in-game' ? this.survivalOf(state, target) : null;
  }

  /**
   * The room's fight run for this character as it stands (todo 02): what
   * here would fight, with the character half `FightSetup` builds, and
   * `also` with it when an opening is being weighed. Run again only when what
   * it is run on moved. See `simulateFight` and mudengine-automation › *The
   * verdict is also run as a fight*.
   */
  private survivalOf(state: CharacterState, also: string | null = null): Survival | null {
    const character = this.setup.character(state, 'now');
    if (character === null) return null;
    const standing = ownAlignment(state);
    const fighting = new Set(
      [...state.combat.attackers, state.combat.target ?? '', also ?? '']
        .filter((name) => name.length > 0)
        .map((name) => name.toLowerCase())
    );
    /*
     * What would fight: everything the realm says attacks on sight, anything
     * it cannot say about (unknown never reassures), and whatever is already
     * swinging or being swung at. A passive resident standing by is not a
     * foe, or every shop would read as a fight — unless it is certain to
     * protect one, when the server brings it in (`guards.ts`) — and nor is
     * one the player's row says does not attack first (`attacksFirst`).
     */
    const rules = this.session.config().combat.mobRules;
    const fights = inTheFight(
      state.room.occupants.filter((who) => who.kind !== 'player'),
      (who) => attacksFirst(who, standing, rules) !== false || fighting.has(who.name.toLowerCase()),
      () => true
    );
    if (fights.length === 0) return null;
    const met = fights.map((who) => ({ name: who.name, subject: who.mob ?? {} }));
    const input = { ...character, ...this.setup.foes(state, character, met) };
    // The recasts' rounds count down with the clock, so the key is what is drawn from, not the time.
    const key = JSON.stringify({ ...input, recasts: input.recasts.length });
    const kept = also === null ? this.ran : this.ranOpening;
    if (kept?.key === key) return kept.survival;
    const run = { key, survival: simulateFight(input) };
    if (also === null) this.ran = run;
    else this.ranOpening = run;
    return run.survival;
  }
}
