/**
 * Which self blessings are kept up under `automation.spells.autoChooseBlessings`
 * (todo 10): the fight being hunted (AutoHunt's spot, else the lair in the
 * room, else the last choice stands), the spellbook's self blessings as
 * candidates, and `chooseBlessings` over runs of that fight, one run a
 * `survivalSliceMs` slice as `OddsBook` runs them. Every run is on the bare
 * character (`bareStateOf`), so a buff going up or down asks for none again.
 * `blessingsFor` builds `Blessings` with this as its `chosen` port. See
 * mudengine-automation › *Recovery*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { Blessings, type BlessingsDeps } from '../automation/Blessings';
import type { AutoHunt } from '../automation/AutoHunt';
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import { choiceWords, refusalWords } from './blessingWords';
import type { Errands } from './Errands';
import type { FightSetup } from './FightSetup';
import type { SafetyDecision } from '../../shared/automation';
import type { BlessingConfig, BlessingSource } from '../../shared/blessings';
import {
  chooseBlessings,
  type BlessingCandidate,
  type BlessingChoice as Choice,
  type BlessingRefusal,
  type FightRun,
  type ManaIncome,
  type SpotCycle
} from '../../shared/blessingchoice';
import { bareStateOf, effectOf, sumEffects } from '../../shared/blessingeffects';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { atSpeed, sittingPerSecond, type HuntingSpot } from '../../shared/hunting';
import { measuredManaRate, NO_MANA_WATCH, watchMana, type ManaWatch } from '../../shared/manaregen';
import { effectSeconds, scaledDuration } from '../../shared/menace';
import { castOdds } from '../../shared/prowess';
import { castsOnSelf, sameSpell, spellTargeting } from '../../shared/spellcraft';
import { statedNow } from '../../shared/stated';
import { simulateFight } from '../../shared/survival';
import { prowessSheetOf } from '../../shared/verdict';
import { lairKey, parseLair, roomId, type WorldRoom, type WorldSpell } from '../../shared/world';

export interface BlessingChoiceParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly world: Pick<WorldGraph, 'spellNamed' | 'byId' | 'lairEntities'> | undefined;
  readonly errands: Pick<Errands, 'fitness' | 'realmClass' | 'realmSpeed'>;
  readonly setup: Pick<FightSetup, 'blessed' | 'foes' | 'settingsKey'>;
  readonly hunt: Pick<AutoHunt, 'quarry'>;
}

export interface BlessingChoiceSession {
  config(): AutomationConfig;
  /** This character's measured duration of its own cast, in seconds; null unmeasured. */
  learnedDuration(spell: string): number | null;
  notice(message: string): void;
  decided(decision: SafetyDecision): void;
}

/** The fight the choice is made for. */
interface Fight {
  key: string;
  room: WorldRoom;
  draw: number;
  cycle: SpotCycle | null;
}

/** A run asked for: the bare character and the fight it was asked against, and the set. */
interface Job {
  bare: CharacterState;
  fight: Fight;
  set: readonly BlessingCandidate[];
}

const ACTION = 'bless';

export class BlessingChoice implements SessionModule, BlessingSource {
  private readonly tracker: BlessingChoiceParts['tracker'];
  private readonly world: BlessingChoiceParts['world'];
  private readonly errands: BlessingChoiceParts['errands'];
  private readonly setup: BlessingChoiceParts['setup'];
  private readonly hunt: BlessingChoiceParts['hunt'];
  /** The rows chosen, or null where the list stands. */
  private rows: readonly BlessingConfig[] | null = null;
  /** The last fight chosen for, kept while nothing is hunted. */
  private fight: Fight | null = null;
  /** What the last choice was made from; the same again asks nothing. */
  private context: string | null = null;
  /** Runs of the fight, by fight and set, oldest first. Null is a fight that cannot be run. */
  private readonly runs = new Map<string, FightRun | null>();
  private readonly jobs = new Map<string, Job>();
  private slice: NodeJS.Immediate | null = null;
  private mana: ManaWatch = NO_MANA_WATCH;
  /** The last thing said, so a refusal or a choice is said once. */
  private said: string | null = null;

  constructor(
    parts: BlessingChoiceParts,
    private readonly session: BlessingChoiceSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.errands = parts.errands;
    this.setup = parts.setup;
    this.hunt = parts.hunt;
  }

  /** The rows `Blessings` keeps up while the switch is on; null keeps the list. */
  chosen(): readonly BlessingConfig[] | null {
    return this.rows;
  }

  /** Every character change, beside the odds book: nothing runs while the switch is off. */
  refresh(state: CharacterState): void {
    const config = this.session.config();
    if (!config.enabled || !config.spells.autoChooseBlessings) return;
    this.mana = watchMana(this.mana, sampleOf(state), tuning().spells.manaRegenGapSeconds);
    const world = this.world;
    if (world === undefined || state.phase !== 'in-game') return;

    // Nothing hunted and no lair here: the last choice stands, and nothing is run.
    const fight = this.fightOf(state, world);
    if (fight === null) {
      if (this.fight === null) this.refuse('no-fight', null);
      return;
    }
    this.fight = fight;

    const spellOf = (name: string): WorldSpell | null => world.spellNamed(name) ?? null;
    const bare = bareStateOf(state, spellOf);
    const candidates = this.candidatesOf(bare, config, spellOf);
    const income = incomeOf(state, this.mana, this.errands.realmSpeed);
    const base = [
      this.errands.fitness(bare),
      this.setup.settingsKey(bare),
      fight.key,
      fight.draw
    ].join('#');
    const context = [
      base,
      this.errands.realmSpeed,
      JSON.stringify(fight.cycle),
      JSON.stringify(income),
      JSON.stringify(candidates.map(({ name, cost, duration, row }) => [name, cost, duration, row]))
    ].join('#');
    if (context === this.context && this.jobs.size === 0) return;
    this.context = context;

    const first = this.setup.blessed(bare, null);
    const choice = chooseBlessings({
      candidates,
      run: (set) => this.runOf(bare, fight, base, set),
      cycle: fight.cycle,
      income,
      healCost: first?.heal?.cost ?? null,
      safeAbove: tuning().menace.survivalSafeAbove,
      minGain: tuning().spells.blessMinGain,
      manaMax: bare.vitals.manaMax,
      hpMax: bare.vitals.hpMax,
      healReserve: tuning().spells.blessHealReserve,
      roundSeconds: atSpeed(tuning().hunting, this.errands.realmSpeed).roundSeconds
    });
    this.take(choice, fight);
  }

  reset(): void {
    this.cancel();
    this.rows = null;
    this.fight = null;
    this.context = null;
    this.runs.clear();
    this.jobs.clear();
    this.mana = NO_MANA_WATCH;
    this.said = null;
  }

  dispose(): void {
    this.reset();
  }

  /** AutoHunt's spot, else a lair in the room; null where neither is. */
  private fightOf(
    state: CharacterState,
    world: NonNullable<BlessingChoiceParts['world']>
  ): Fight | null {
    const spot = this.hunt.quarry;
    if (spot !== null) {
      const room = spot.rooms
        .map((each) => world.byId(each.id))
        .find((each) => each?.lair !== undefined);
      if (room !== undefined) return fightAt(room, cycleOf(spot));
    }
    const { map, number } = state.room;
    if (map === null || number === null) return null;
    const here = world.byId(roomId(map, number));
    return here?.lair === undefined ? null : fightAt(here, null);
  }

  /**
   * The spellbook's blessings this character can cast on itself at its
   * level and that weigh something, each with its cost and how long it lasts.
   */
  private candidatesOf(
    bare: CharacterState,
    config: AutomationConfig,
    spellOf: (name: string) => WorldSpell | null
  ): BlessingCandidate[] {
    const level = bare.progress.level;
    if (bare.spellbook === null || level === null) return [];
    const { combat, magery, family } = this.errands.realmClass();
    const sheet = prowessSheetOf(bare, { combat, magery });
    const own = config.spells.blessings.filter((row) => row.target === 'self');
    return bare.spellbook.flatMap((known): BlessingCandidate[] => {
      const spell = spellOf(known.name);
      if (spell === null || (known.level ?? spell.level ?? 0) > level) return [];
      const aim = spellTargeting(spell.targets);
      if (aim === 'unknown' || !castsOnSelf(aim)) return [];
      const effect = effectOf(spell, level);
      if (effect === null) return [];
      const measured = this.session.learnedDuration(known.name);
      const ticks = scaledDuration(spell, level);
      const row = own.find((each) => sameSpell(each.spell, known.name, bare.spellbook, spellOf));
      return [
        {
          name: known.name,
          spell,
          effect,
          cost: castOdds(spell, sheet, family)?.expectedMana?.value ?? null,
          duration:
            measured !== null && measured > 0
              ? { seconds: measured, from: 'measured' }
              : ticks > 0
                ? { seconds: effectSeconds(ticks, this.errands.realmSpeed), from: 'realm' }
                : null,
          row: row ?? null
        }
      ];
    });
  }

  /** A run kept, or `pending` with the run queued for the next slice. */
  private runOf(
    bare: CharacterState,
    fight: Fight,
    base: string,
    set: readonly BlessingCandidate[]
  ): FightRun | 'pending' | null {
    const key = `${base}#${set
      .map((each) => each.name)
      .sort()
      .join('+')}`;
    const kept = this.runs.get(key);
    if (kept !== undefined) return kept;
    if (!this.jobs.has(key)) {
      this.jobs.set(key, { bare, fight, set });
      this.schedule();
    }
    return 'pending';
  }

  private schedule(): void {
    if (this.slice !== null) return;
    this.slice = setImmediate(() => {
      this.slice = null;
      this.work();
    });
  }

  private cancel(): void {
    if (this.slice !== null) clearImmediate(this.slice);
    this.slice = null;
  }

  /** Runs until the slice is spent, then chooses again with what was run. */
  private work(): void {
    const began = performance.now();
    const budget = tuning().menace.survivalSliceMs;
    for (const [key, job] of this.jobs) {
      if (performance.now() - began >= budget) break;
      this.jobs.delete(key);
      this.keep(key, this.run(job));
    }
    this.context = null;
    if (this.jobs.size > 0) this.schedule();
    this.refresh(this.tracker.current);
  }

  private run({ bare, fight, set }: Job): FightRun | null {
    const world = this.world;
    const character = this.setup.blessed(bare, sumEffects(set.map((each) => each.effect)));
    if (world === undefined || character === null) return null;
    const met = world
      .lairEntities(fight.room)
      .map((entity) => ({ name: entity.name, subject: entity }));
    if (met.length === 0) return null;
    const survival = simulateFight({
      ...character,
      ...this.setup.foes(bare, character, met),
      draw: fight.draw
    });
    return survival === null
      ? null
      : {
          survives: survival.survives,
          rounds: survival.rounds.value,
          lostMean: survival.lostMean,
          heals: survival.heals
        };
  }

  /** Remembered, the oldest forgotten past `blessChoiceRuns`. */
  private keep(key: string, run: FightRun | null): void {
    this.runs.set(key, run);
    const cap = tuning().spells.blessChoiceRuns;
    for (const oldest of this.runs.keys()) {
      if (this.runs.size <= cap) break;
      this.runs.delete(oldest);
    }
  }

  private take(choice: Choice, fight: Fight): void {
    if (choice.kind === 'refused') {
      if (choice.why !== 'pending') this.refuse(choice.why, fight);
      return;
    }
    this.rows = choice.picks.map((pick) => pick.row);
    this.say(choiceWords(choice, fight.room.name), true, undefined);
  }

  /** Refused: the last choice stands where there is one, the list otherwise. */
  private refuse(why: BlessingRefusal, fight: Fight | null): void {
    const { message, why: words } = refusalWords(why, fight?.room.name ?? null, this.rows !== null);
    this.say(message, false, words);
  }

  private say(message: string, acted: boolean, refused: string | undefined): void {
    if (this.said === message) return;
    this.said = message;
    this.session.notice(message);
    this.session.decided({
      at: Date.now(),
      action: ACTION,
      because: t('automation.blessing.because'),
      acted,
      ...(refused === undefined ? {} : { refused })
    });
  }
}

/**
 * `Blessings` with the choice as its source, built together as `fightBook`
 * builds the odds book with its setup.
 */
export function blessingsFor(
  parts: BlessingChoiceParts,
  deps: Omit<BlessingsDeps, 'source' | 'learnedDuration'> & { readonly queue: CommandQueue },
  session: Omit<BlessingChoiceSession, 'learnedDuration'> & {
    /** `Belongings.recallSpellDurations`, read at the point of use: the store arrives with `useRealm`. */
    durations(): Readonly<Record<string, number>>;
  },
  automation: AutomationConfig
): Blessings {
  /*
   * The measured duration of this character's own cast, null before any
   * measurement (the shipped watchdog covers that). The one fact here that
   * is not the realm's, which is why it is still its own.
   */
  const learnedDuration = (spell: string): number | null =>
    session.durations()[spell.trim().toLowerCase()] ?? null;
  const source = new BlessingChoice(parts, { ...session, learnedDuration });
  const { queue, ...rest } = deps;
  return new Blessings(automation.spells, automation.enabled, queue, {
    ...rest,
    learnedDuration,
    source
  });
}

function fightAt(room: WorldRoom, cycle: SpotCycle | null): Fight {
  const lair = room.lair ?? '';
  const draw = parseLair(lair).max ?? 1;
  return { key: lairKey(lair), room, draw, cycle };
}

/** The spot's cycle where its estimate states every part of it. */
function cycleOf(spot: HuntingSpot): SpotCycle | null {
  const { estimate } = spot;
  const expPerHour = estimate.measured?.perHour ?? estimate.expPerHour;
  const { cycleSeconds, combatSeconds, restSeconds, waitSeconds } = estimate;
  if (
    expPerHour === null ||
    cycleSeconds === null ||
    combatSeconds === null ||
    restSeconds === null ||
    waitSeconds === null
  )
    return null;
  return {
    expPerHour,
    cycleSeconds,
    combatSeconds,
    restSeconds,
    waitSeconds,
    fights: Math.max(1, spot.walk.length)
  };
}

function sampleOf(state: CharacterState): Parameters<typeof watchMana>[1] {
  return {
    at: state.lastStatusAt ?? state.updatedAt ?? Date.now(),
    mana: state.vitals.mana,
    manaMax: state.vitals.manaMax,
    inCombat: state.inCombat,
    resting: state.vitals.resting,
    meditating: state.vitals.meditating
  };
}

/**
 * What comes back: the stated `MA Regen` on the standing tick, kai and mana
 * alike, else the rise measured standing. Meditating adds the base figure on
 * every rest tick (`CalcRestTick`, `GetBaseMARegen`) to the standing tick;
 * with no stated `MA Regen`, the standing rate is its floor. Both ticks are
 * the realm's, the server's over `speed`. Null while neither is known.
 */
function incomeOf(state: CharacterState, watch: ManaWatch, speed: number): ManaIncome | null {
  const stated = statedNow(state);
  const ticks = atSpeed(tuning().hunting, speed);
  const measured = measuredManaRate(watch, tuning().spells.manaRegenLeastSeconds);
  const standing = stated?.mana !== undefined ? stated.mana / ticks.passiveTickSeconds : measured;
  if (standing === null) return null;
  const meditating =
    stated?.meditating !== undefined && stated.mana !== undefined
      ? sittingPerSecond(stated.meditating, stated.mana, ticks)
      : standing;
  // Whole mana an hour, so a measurement refining by a fraction asks for no new choice.
  return {
    perHour: Math.round(standing * 3600),
    meditatingPerSecond: Math.round(meditating * 3600) / 3600
  };
}
