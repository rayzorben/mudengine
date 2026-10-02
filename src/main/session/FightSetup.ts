/**
 * The character's half of a simulated fight (`simulateFight`): the sheet, the
 * weapon, the heal `AutoHeal` would cast, the regeneration tick, the
 * blessings that lapse, and each foe's price where only a spell hurts it.
 * One builder, so the room as it stands (`Appraisal`) and every monster and
 * lair run at full health (`OddsBook`) meet the same character. See
 * mudengine-automation › *The verdict is also run as a fight*.
 */
import { tuning } from '../app/tuning';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import { HAZARD_ABILITY } from '../../shared/abilities';
import { blessedPlayer, type BlessingEffect } from '../../shared/blessingeffects';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { ROUND_SECONDS, scaledPower } from '../../shared/menace';
import { regeneration } from '../../shared/prowess';
import { healFloor, resolveSpell, spellCost } from '../../shared/spellcraft';
import { castsToKill } from '../../shared/spellchoice';
import {
  SURVIVAL_HORIZONS,
  type SurvivalFoe,
  type SurvivalHeal,
  type SurvivalInput
} from '../../shared/survival';
import { prowessSheetOf, wieldedWeapon } from '../../shared/verdict';

export interface FightSetupParts {
  readonly world: Pick<WorldGraph, 'spellNamed'> | undefined;
  readonly errands: Pick<Errands, 'castingInput' | 'menacePlayer' | 'realmClass'>;
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

  constructor(
    parts: FightSetupParts,
    private readonly session: FightSetupSession
  ) {
    this.world = parts.world;
    this.errands = parts.errands;
  }

  /**
   * The character as it stands (`now`: its health and mana, the blessings
   * lapsing on their clocks), or as it walks into a fight rested (`rested`:
   * full health and mana, nothing lapsing), which is what the odds for every
   * monster and lair are run at. Null while the health is unread.
   */
  character(state: CharacterState, at: 'now' | 'rested'): FightCharacter | null {
    return this.build(state, at, undefined);
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
    set: BlessingEffect | null | undefined
  ): FightCharacter | null {
    const { hp, mana, manaMax } = state.vitals;
    if (state.vitals.hpMax === null) return null;
    const { combat, magery, family, attack } = this.errands.realmClass();
    const read = prowessSheetOf(state, { combat, magery });
    const blessed = set !== undefined && set !== null;
    const player = blessed
      ? blessedPlayer(this.errands.menacePlayer(state), set)
      : this.errands.menacePlayer(state);
    const hpMax = state.vitals.hpMax + (blessed ? set.maxHp : 0);
    const sheet = set === undefined ? read : { ...read, stated: null, effects: set };
    if (hpMax <= 0) return null;
    const health = at === 'rested' ? hpMax : hp;
    if (health === null) return null;
    const regen = regeneration(sheet, null, family);
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
      heal: this.heal(state, at === 'rested' ? manaMax : mana),
      regenPerRound: regen === null ? 0 : (regen.health.value * ROUND_SECONDS) / regen.tickSeconds,
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
          : { perRound: subject.hp / kill.rounds, manaPerRound: (kill.mana ?? 0) / kill.rounds };
      })
    };
  }

  /**
   * What the heal and the casting add to `Errands.fitness`: the settings a
   * fight's odds move with that the sheet does not show.
   */
  settingsKey(state: CharacterState): string {
    const { spells, combat } = this.session.config();
    return [
      combat.attack,
      spells.heal,
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
   * The heal as `AutoHeal` would cast it: the in-combat threshold where one
   * is set, the configured spell's own range at this level, its cost. Only
   * with the mana known; a heal that cannot be budgeted is not modelled,
   * which errs towards the fight being harder than it is.
   */
  private heal(state: CharacterState, mana: number | null): SurvivalHeal | null {
    const spells = this.session.config().spells;
    const below = healFloor(spells, true);
    if (below <= 0 || spells.heal.trim().length === 0 || mana === null) return null;
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
    if (realm === null || cost === null || !heals || realm.power === undefined) return null;
    return {
      below,
      to: spells.healTo,
      restores: scaledPower(realm, state.progress.level ?? 0),
      cost,
      minMana: spells.healMinMana
    };
  }

  /** The blessings that lapse before a fight this long is over, and what each recast costs. */
  private recasts(state: CharacterState, roundCap: number): SurvivalInput['recasts'] {
    const now = Date.now();
    return state.buffs.flatMap((buff) => {
      if (buff.expiresAt === undefined) return [];
      const round = Math.ceil((buff.expiresAt - now) / (ROUND_SECONDS * 1000));
      if (round <= 0 || round > roundCap) return [];
      const cost = this.world?.spellNamed(buff.spell)?.mana ?? null;
      return cost === null || cost <= 0 ? [] : [{ round, cost }];
    });
  }
}
