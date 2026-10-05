/**
 * The character's half of a simulated fight (`simulateFight`): the sheet, the
 * weapon, the heal `AutoHeal` would cast, the regeneration tick, the
 * blessings that lapse, and each foe's price where only a spell hurts it.
 * One builder, so the room as it stands (`Appraisal`) and every monster and
 * lair run at full health (`OddsBook`) meet the same character. See
 * mudengine-automation › *The verdict is also run as a fight*.
 */
import { tuning } from '../app/tuning';
import type { Blessings } from '../automation/Blessings';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import {
  blessedPlayer,
  effectOf,
  effectsUp,
  NO_EFFECT,
  sumEffects,
  type BlessingEffect
} from '../../shared/blessingeffects';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { ROUND_SECONDS } from '../../shared/menace';
import { regeneration, type ProwessSheet } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import { healFloor, resolveSpell, spellCost } from '../../shared/spellcraft';
import { castsToKill, thresholdHeal } from '../../shared/spellchoice';
import {
  SURVIVAL_HORIZONS,
  type Recast,
  type SurvivalFoe,
  type SurvivalHeal,
  type SurvivalInput
} from '../../shared/survival';
import { prowessSheetOf, wieldedWeapon } from '../../shared/verdict';
import type { WorldSpell } from '../../shared/world';

export interface FightSetupParts {
  readonly world: Pick<WorldGraph, 'spellNamed'> | undefined;
  readonly errands: Pick<Errands, 'castingInput' | 'menacePlayer' | 'realmClass'>;
  /** Which lapsing blessings are recast mid-fight; built after the book, so asked for at use. */
  readonly blessings: () => Pick<Blessings, 'recastFloor'>;
}

export interface FightSetupSession {
  /** The automation settings as last loaded: the heal the fight is run with. */
  config(): AutomationConfig;
}

/** Everything a fight needs but the foes. */
export type FightCharacter = Omit<SurvivalInput, 'foes' | 'casting' | 'draw'>;

/** A foe as the room or the realm hands it over. */
export interface FightFoe {
  name: string;
  subject: SurvivalFoe['subject'] & { magicResist?: number };
}

export class FightSetup {
  private readonly world: FightSetupParts['world'];
  private readonly errands: FightSetupParts['errands'];
  private readonly blessings: FightSetupParts['blessings'];
  private readonly spellOf = (name: string): WorldSpell | null =>
    this.world?.spellNamed(name) ?? null;

  constructor(
    parts: FightSetupParts,
    private readonly session: FightSetupSession
  ) {
    this.world = parts.world;
    this.errands = parts.errands;
    this.blessings = parts.blessings;
  }

  /**
   * The character as it stands (`now`: its health and mana, the blessings
   * lapsing on their clocks), or as it walks into a fight rested (`rested`:
   * full health and mana, nothing lapsing), which is what the odds for every
   * monster and lair are run at. Null while the health is unread. `attack`
   * is the word fought with where it is not `combat.attack`'s (a what-if).
   */
  character(state: CharacterState, at: 'now' | 'rested', attack?: string): FightCharacter | null {
    return this.build(state, at, undefined, attack);
  }

  /**
   * The bare character (`bareStateOf`: what the sheet prints less what is up)
   * rested, with `set` up and nothing else, on the formula sheet: a `stat all`
   * figure carries what was up when it was read. The choice of blessings runs
   * both sides of every comparison through it.
   */
  blessed(bare: CharacterState, set: BlessingEffect | null): FightCharacter | null {
    return this.build(bare, 'rested', set);
  }

  /** `set` undefined is the character as it stands; null or an effect is `blessed`'s. */
  private build(
    state: CharacterState,
    at: 'now' | 'rested',
    set: BlessingEffect | null | undefined,
    verb?: string
  ): FightCharacter | null {
    const { hp, mana, manaMax } = state.vitals;
    if (state.vitals.hpMax === null) return null;
    const { combat, magery, mageryType, family, attack } = this.errands.realmClass(verb);
    const read = prowessSheetOf(state, { combat, magery });
    const own = this.errands.menacePlayer(state);
    const hpMax = state.vitals.hpMax + (set ? set.maxHp : 0);
    // What is up, or blessed, comes on top of what the gear worn adds (`gearEffect`).
    const extra = set === undefined ? this.up(state) : set;
    const effects = sumEffects([
      ...(read.effects ? [read.effects] : []),
      ...(extra ? [extra] : [])
    ]);
    /*
     * As it stands, the printed armour, resistances and bar and the `stat all`
     * figures carry what is up, so it reaches only the formula paths and the
     * dodge, which no sheet prints; a lapse mid-fight takes off the same. A
     * what-if is the bare character with the set on top, on the formula sheet.
     */
    const sheet = set === undefined ? { ...read, effects } : { ...read, stated: null, effects };
    const player =
      extra === null
        ? own
        : blessedPlayer(own, set === undefined ? { ...NO_EFFECT, dodge: extra.dodge } : extra);
    if (hpMax <= 0) return null;
    const health = at === 'rested' ? hpMax : hp;
    if (health === null) return null;
    const regen = regeneration(sheet, mageryType, family);
    const roundCap = tuning().menace.survivalRoundCap;
    return {
      hp: health,
      hpMax,
      mana: at === 'rested' ? manaMax : mana,
      manaMax,
      player,
      sheet,
      weapon: wieldedWeapon(state.inventory.items),
      attack,
      family,
      weights: tuning().menace,
      heal: this.heal(state, hpMax, at === 'rested' ? manaMax : mana, sheet, family),
      regenPerRound:
        regen === null
          ? 0
          : (regen.health.value * ROUND_SECONDS) / tuning().hunting.passiveTickSeconds,
      recasts: at === 'rested' ? [] : this.recasts(state, roundCap),
      levels: {
        safeAbove: tuning().menace.survivalSafeAbove,
        riskyAbove: tuning().menace.survivalRiskyAbove
      },
      trials: tuning().menace.survivalTrials,
      roundCap,
      horizons: SURVIVAL_HORIZONS
    };
  }

  /**
   * The foes, each with the casting price `castsToKill` gives where the
   * character's blow is a spell: expected damage a round and its mana.
   */
  foes(
    state: CharacterState,
    character: FightCharacter,
    met: readonly FightFoe[]
  ): Pick<SurvivalInput, 'foes' | 'casting'> {
    const casting = this.errands.castingInput(state, character.sheet, character.family);
    return {
      foes: met.map(({ name, subject }) => ({ name, subject })),
      casting: met.map(({ subject }) => {
        const kill =
          casting === null
            ? null
            : castsToKill(casting, {
                hp: subject.hp ?? null,
                magicRes: subject.magicResist ?? null,
                abilities: subject.abilities
              });
        return kill === null || subject.hp === undefined
          ? null
          : { perRound: subject.hp / kill.rounds, manaPerRound: kill.mana ?? 0 };
      })
    };
  }

  /**
   * What the heal, the casting and the blessings up add to `Errands.fitness`:
   * what a fight's odds move with that the sheet does not show.
   */
  settingsKey(state: CharacterState): string {
    const { spells, combat } = this.session.config();
    return [
      JSON.stringify(this.up(state)),
      combat.attack,
      spells.heal,
      spells.autoChooseHeal,
      spells.healTo,
      spells.minMana,
      spells.healMinMana,
      healFloor(spells, true),
      spells.attack,
      spells.autoChoose,
      state.spellbook?.length ?? -1,
      state.vitals.hpMax,
      state.vitals.manaMax
    ].join('|');
  }

  /**
   * The heal as `AutoHeal` would cast it at the in-combat threshold
   * (`thresholdHeal`: chosen against the deficit under Auto Choose Best Heal,
   * else the configured spell), its range at this level and its cost. Only
   * with the mana known; a heal that cannot be budgeted is not modelled,
   * which errs towards the fight being harder than it is.
   */
  private heal(
    state: CharacterState,
    hpMax: number,
    mana: number | null,
    sheet: ProwessSheet,
    family: RealmFamily | null
  ): SurvivalHeal | null {
    const spells = this.session.config().spells;
    const below = healFloor(spells, true);
    if (mana === null) return null;
    const heal = thresholdHeal({
      spells,
      below,
      hpMax,
      book: state.spellbook,
      realm: this.spellOf,
      level: state.progress.level,
      mana,
      sheet,
      family
    });
    if (heal === null || heal.cost === null) return null;
    return {
      below,
      to: spells.healTo,
      restores: heal.restores,
      cost: heal.cost,
      minMana: spells.healMinMana,
      chosenMends: heal.chosenMends
    };
  }

  /** What the blessings up add at the character's level; null with none weighed or the level unread. */
  private up(state: CharacterState): BlessingEffect | null {
    const level = state.progress.level;
    return level === null ? null : effectsUp(state.buffs, this.spellOf, level);
  }

  /**
   * The blessings that lapse before a fight this long is over: what each
   * adds, and what its recast costs and the mana floor it waits above where
   * this character recasts it in a fight (`recastFloor`). Anything else is
   * gone once it lapses.
   */
  private recasts(state: CharacterState, roundCap: number): Recast[] {
    const now = Date.now();
    const level = state.progress.level;
    return state.buffs.flatMap((buff): Recast[] => {
      if (buff.expiresAt === undefined) return [];
      const round = Math.ceil((buff.expiresAt - now) / (ROUND_SECONDS * 1000));
      if (round <= 0 || round > roundCap) return [];
      const spell = resolveSpell(buff.spell, state.spellbook, this.spellOf);
      const effect = spell.realm === null || level === null ? null : effectOf(spell.realm, level);
      const mana = spellCost(spell);
      const floor = mana === null ? null : this.blessings().recastFloor(buff.spell);
      const cost = mana === null || floor === null ? null : Math.max(0, mana);
      return effect === null && !cost ? [] : [{ round, cost, minMana: floor ?? 0, effect }];
    });
  }
}
