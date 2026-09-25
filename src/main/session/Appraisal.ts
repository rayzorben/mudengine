/**
 * The room as it stands appraised against the character as it stands: the
 * verdict, the fight it would be (`survivalOf`), a monster looked up by name,
 * and what the room's occupants answer to. Holds nothing; `Publisher` pushes
 * what it answers on change. See `mudengine-automation` › *The verdict is
 * also run as a fight*.
 */
import { tuning } from '../app/tuning';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import { HAZARD_ABILITY } from '../../shared/abilities';
import { ownAlignment, packRows, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { inTheFight } from '../../shared/guards';
import { ROUND_SECONDS, scaledPower } from '../../shared/menace';
import { attacksFirst, rowPeaceFor } from '../../shared/mobRules';
import { regeneration, type ProwessSheet, type ProwessWeapon } from '../../shared/prowess';
import { asksHere, type QuestWatched, type RoomAsk } from '../../shared/quests';
import type { RealmFamily } from '../../shared/realm';
import { healFloor, resolveSpell, spellCost } from '../../shared/spellcraft';
import { castsToKill } from '../../shared/spellchoice';
import {
  simulateFight,
  type Survival,
  type SurvivalFoe,
  type SurvivalHeal
} from '../../shared/survival';
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
  readonly world: Pick<WorldGraph, 'buildMobEntity' | 'quests' | 'spellNamed'> | undefined;
  readonly errands: Pick<Errands, 'castingInput' | 'menacePlayer' | 'realmClass'>;
}

/** What the session that built this answers for it. */
export interface AppraisalSession {
  /** The automation settings as last loaded: the heal the fight is run with. */
  config(): AutomationConfig;
  /** The rank each quest has been seen to reach this session. */
  watched(): QuestWatched;
}

export class Appraisal {
  private readonly tracker: AppraisalParts['tracker'];
  private readonly world: AppraisalParts['world'];
  private readonly errands: AppraisalParts['errands'];

  constructor(
    parts: AppraisalParts,
    private readonly session: AppraisalSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.errands = parts.errands;
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
    const { combat, magery, family } = this.errands.realmClass();
    const sheet = prowessSheetOf(state, { combat, magery });
    const weapon = wieldedWeapon(state.inventory.items);
    const appraisal = appraiseRoom(
      state.room.occupants,
      this.errands.menacePlayer(state),
      tuning().menace,
      sheet,
      weapon,
      family
    );
    // And the row's word beside the realm's, where one says it does not attack first.
    const rules = this.session.config().combat.mobRules;
    const monsters = appraisal.monsters.map((entry) => {
      const peace = rowPeaceFor(rules, entry.name);
      return peace === null ? entry : { ...entry, peace };
    });
    return { ...appraisal, monsters, survival: this.survivalOf(state, sheet, weapon, family) };
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
    const { combat, magery, family } = this.errands.realmClass();
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
      const [verdict] = weighVerdicts([entity], player, tuning().menace, sheet, weapon, family);
      if (verdict !== undefined) verdicts[name] = verdict;
    }
    return verdicts;
  }

  /**
   * The room's fight run for this character as it stands (todo 02): what
   * here would fight, the heal the automation would cast, the regeneration
   * tick and the blessings that lapse before it is over. Everything the
   * appraisal cannot see, because only the session holds the configuration
   * and the buffs. See `simulateFight` and mudengine-automation › *The
   * verdict is also run as a fight*.
   */
  private survivalOf(
    state: CharacterState,
    sheet: ProwessSheet,
    weapon: ProwessWeapon | null,
    family: RealmFamily | null
  ): Survival | null {
    const { hp, hpMax, mana, manaMax } = state.vitals;
    if (hp === null || hpMax === null || hpMax <= 0) return null;
    const standing = ownAlignment(state);
    const fighting = new Set(
      [...state.combat.attackers, state.combat.target ?? '']
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
    const casting = this.errands.castingInput(state, sheet, family);
    const foes: SurvivalFoe[] = [];
    const casts: Array<{ perRound: number; manaPerRound: number } | null> = [];
    const fights = inTheFight(
      state.room.occupants.filter((who) => who.kind !== 'player'),
      (who) => attacksFirst(who, standing, rules) !== false || fighting.has(who.name.toLowerCase()),
      () => true
    );
    for (const who of fights) {
      const subject: SurvivalFoe['subject'] = who.mob ?? {};
      foes.push({ name: who.name, subject });
      const kill =
        casting === null
          ? null
          : castsToKill(casting, {
              hp: subject.hp ?? null,
              magicRes: who.mob?.magicResist ?? null,
              abilities: subject.abilities
            });
      casts.push(
        kill === null || subject.hp === undefined
          ? null
          : { perRound: subject.hp / kill.rounds, manaPerRound: (kill.mana ?? 0) / kill.rounds }
      );
    }
    if (foes.length === 0) return null;

    /*
     * The heal as `AutoHeal` would cast it: the in-combat threshold where one
     * is set, the configured spell's own range at this level, its cost. Only
     * with the mana known — a heal that cannot be budgeted is not modelled,
     * which errs towards the fight being harder than it is.
     */
    const spells = this.session.config().spells;
    const below = healFloor(spells, true);
    let heal: SurvivalHeal | null = null;
    if (below > 0 && spells.heal.trim().length > 0 && mana !== null) {
      const found = resolveSpell(
        spells.heal,
        state.spellbook,
        (name) => this.world?.spellNamed(name) ?? null
      );
      const cost = spellCost(found);
      const realm = found.realm;
      const heals = (realm?.abilities ?? []).some(
        ([id, value]) => id === HAZARD_ABILITY.heal && value >= 0
      );
      if (realm !== null && cost !== null && heals && realm.power !== undefined) {
        heal = {
          below,
          to: spells.healTo,
          restores: scaledPower(realm, state.progress.level ?? 0),
          cost,
          minMana: spells.minMana
        };
      }
    }

    const regen = regeneration(sheet, null, family);
    const regenPerRound =
      regen === null ? 0 : (regen.health.value * ROUND_SECONDS) / regen.tickSeconds;
    const now = Date.now();
    const roundCap = tuning().menace.survivalRoundCap;
    const recasts = state.buffs.flatMap((buff) => {
      if (buff.expiresAt === undefined) return [];
      const round = Math.ceil((buff.expiresAt - now) / (ROUND_SECONDS * 1000));
      if (round <= 0 || round > roundCap) return [];
      const cost = this.world?.spellNamed(buff.spell)?.mana ?? null;
      return cost === null || cost <= 0 ? [] : [{ round, cost }];
    });

    return simulateFight({
      hp,
      hpMax,
      mana,
      manaMax,
      player: this.errands.menacePlayer(state),
      sheet,
      weapon,
      family,
      weights: tuning().menace,
      foes,
      casting: casts,
      heal,
      regenPerRound,
      recasts,
      levels: {
        safeAbove: tuning().menace.survivalSafeAbove,
        riskyAbove: tuning().menace.survivalRiskyAbove
      },
      trials: tuning().menace.survivalTrials,
      roundCap
    });
  }
}
