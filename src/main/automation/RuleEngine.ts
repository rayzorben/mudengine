/**
 * Evaluates rules over character state and proposes intents.
 *
 * A loop, not a listener graph: take a snapshot, test the guards, emit. That is
 * what a rule engine *is*, and it is why `docs/legacy-assessment.md` §6 puts
 * the decision on the outbound side where one owner arbitrates — rules propose,
 * `CommandQueue` decides when and whether.
 *
 * Nothing here writes to a socket, keeps a listener, or sleeps.
 */
import { PRIORITY, type CommandQueue } from './CommandQueue';
import type { Block } from '../../shared/blocks';
import {
  isHostile,
  ownAlignment,
  type CharacterState,
  type RoomOccupant
} from '../../shared/character';
import { attacksOnSight } from '../../shared/mobs';
import { playersHere } from './HangUp';
import type { Guard, Rule, RuleFiring } from '../../shared/rules';
import { tuning } from '../app/tuning';

/** Block types that mean a combat round is in progress. */
const COMBAT_BLOCKS = new Set(['user-hits', 'mob-hits', 'mob-misses', 'combat-status']);

/**
 * Things in the room that are monsters rather than people.
 *
 * This was the capitalisation heuristic carried over from `tproxy` — entries on
 * `Also here:` with no capital letter — and it still is, for the entries
 * nothing better can place. What changed is that something better usually can:
 * the realm's own monster table names 1,500 of them, the roster names the
 * players, and the listing marks both. See `RoomOccupant`.
 *
 * The guard field keeps its meaning and its name; it is only more often right.
 */
export function countMobs(occupants: readonly RoomOccupant[]): number {
  return occupants.filter((who) => who.kind === 'mob').length;
}

/**
 * Monsters in the room that will start the fight themselves.
 *
 * The number auto-combat acts on, and the one a rule wants when it asks "is it
 * safe to rest here" — `mobs` counts a shopkeeper and a guard dog alike, and
 * only one of them is a reason to keep moving.
 *
 * Counted against **this character's own standing**, because two of the realm's
 * seven monster alignments decide by it: a `LawfulGood` guard attacks an outlaw
 * and nobody else. An alignment nothing has read yet makes those *unknown*
 * rather than harmless, and an unknown is not counted — the same direction
 * `playersHere` errs in, and for the same reason: this guard decides whether to
 * act, and acting on a guess is worse than not acting.
 */
export function countThreats(state: CharacterState): number {
  const mine = ownAlignment(state);
  return state.room.occupants.filter(
    (who) => who.kind === 'mob' && attacksOnSight(who.disposition, mine) === true
  ).length;
}

/**
 * Reads a guard field out of state. `undefined` means "not known".
 *
 * `extra` carries what state alone cannot answer — currently whether a hangup
 * looks clean, which depends on a five-minute window nothing on screen shows.
 * Absent, that guard reads as unknown rather than as `true`, and an unknown
 * value fails every comparison except `!=`: a rule that would hang up "when it
 * is safe" must not fire because nobody told it whether it was.
 */
export function readField(
  field: string,
  state: CharacterState,
  extra?: { hangUpClean?: boolean }
): number | string | boolean | undefined {
  const { vitals, progress, room, inventory } = state;
  switch (field) {
    case 'hp':
      return vitals.hp ?? undefined;
    case 'hp.percent':
      return vitals.hp !== null && vitals.hpMax ? vitals.hp / vitals.hpMax : undefined;
    case 'mana':
      return vitals.mana ?? undefined;
    case 'mana.percent':
      return vitals.mana !== null && vitals.manaMax ? vitals.mana / vitals.manaMax : undefined;
    case 'level':
      return progress.level ?? undefined;
    case 'inCombat':
      return state.inCombat;
    case 'resting':
      return vitals.resting;
    case 'meditating':
      return vitals.meditating;
    case 'occupants':
      return room.occupants.length;
    case 'mobs':
      return countMobs(room.occupants);
    case 'threats':
      return countThreats(state);
    case 'players':
      return playersHere(state).length;
    case 'hostiles': {
      const roster = new Map(state.online.map((entry) => [entry.name.toLowerCase(), entry]));
      return playersHere(state).filter((who) =>
        isHostile(roster.get(who.toLowerCase())?.alignment ?? null)
      ).length;
    }
    case 'realm':
      // Which member of the family the wire said this is; unknown until it has.
      return state.realm ?? undefined;
    /*
     * What the realm says about this room. All five read off entities the
     * tracker attached when the room resolved, so none of them costs a lookup
     * here and none is available before the room is placed — which is right:
     * an unresolved room is one the realm has said nothing about, and these
     * answer `undefined` rather than a reassuring `false`.
     */
    case 'shopHere':
      return room.shop == null ? undefined : true;
    case 'lairHere':
      return room.lair == null ? undefined : true;
    case 'undeadHere':
      return room.occupants.filter((there) => there.mob?.undead === true).length;
    case 'deathSpellHere':
      return room.occupants.filter((there) => there.mob?.deathSpell !== undefined).length;
    /*
     * Whether the character can see, and what it has to see by — the pair that
     * makes automatic lighting expressible as a rule, which is where `Walker`
     * has always said it belongs.
     */
    case 'dark': {
      // The server's own phrase leads: it is what actually happened. The
      // realm's recorded level answers only where the server printed nothing,
      // and neither saying anything is unknown rather than "lit".
      if (room.light !== null) return true;
      if (room.lightLevel === undefined) return undefined;
      return room.lightLevel < 0;
    }
    case 'light': {
      let spent = false;
      for (const item of state.inventory.items) {
        if (item.kind !== 'light') continue;
        // Charges unstated is not zero — the listing simply did not count, and
        // a rule fired on an unknown would light a torch that is already lit.
        if (item.charges !== 0) return 'carried';
        spent = true;
      }
      return spent ? 'spent' : 'none';
    }
    case 'toughestHere': {
      /*
       * Unknown when the realm can place none of them, never 0: zero would
       * read as an empty room, and `toughestHere < 100` would then fire in a
       * room full of things nothing has heard of — which is the reassuring
       * answer this client refuses everywhere.
       */
      const known = room.occupants
        .map((there) => there.mob?.hp)
        .filter((hp): hp is number => hp !== undefined);
      return known.length === 0 ? undefined : Math.max(...known);
    }
    case 'hangUpClean':
      return extra?.hangUpClean;
    case 'target':
      // Null is *unknown*, not the empty string: an unknown value fails every
      // comparison but `!=`, which is what stops `attack {target}` firing at
      // nothing.
      return state.combat.target ?? undefined;
    case 'attackers':
      return state.combat.attackers.length;
    case 'stealth':
      // Unknown reads as unknown, not as `seen`.
      return state.stealth === 'unknown' ? undefined : state.stealth;
    case 'partySize':
      // A measurement, not an absence: zero members is "alone", which a rule
      // can legitimately compare against.
      return state.party.members.length;
    case 'wealth':
      return inventory.wealth ?? undefined;
    case 'phase':
      return state.phase;
    default:
      return undefined;
  }
}

/**
 * Tests one guard.
 *
 * An unknown value fails every comparison except `!=`. Treating "not known yet"
 * as zero is how a bot decides it is on 0% health and runs from a fight it was
 * winning — the same reason `CharacterState` is nullable throughout.
 */
export function testGuard(
  guard: Guard,
  state: CharacterState,
  extra?: { hangUpClean?: boolean }
): boolean {
  const actual = readField(guard.field, state, extra);
  if (actual === undefined) return guard.op === '!=';

  if (typeof actual === 'number' && typeof guard.value === 'number') {
    switch (guard.op) {
      case '<':
        return actual < guard.value;
      case '<=':
        return actual <= guard.value;
      case '>':
        return actual > guard.value;
      case '>=':
        return actual >= guard.value;
      case '==':
        return actual === guard.value;
      case '!=':
        return actual !== guard.value;
    }
  }

  const left = String(actual);
  const right = String(guard.value);
  if (guard.op === '==') return left === right;
  if (guard.op === '!=') return left !== right;
  // Ordering a boolean or a phase name is a rule-authoring mistake, not a
  // comparison worth inventing an answer for.
  return false;
}

/** Fills `{name}` from the triggering block's captures, then from state. */
export function interpolate(template: string, block: Block | null, state: CharacterState): string {
  return template.replace(/\{([\w.]+)\}/g, (whole, name: string) => {
    const captured = block?.groups[name];
    if (captured !== undefined) return captured;
    const field = readField(name, state);
    return field === undefined ? whole : String(field);
  });
}

export interface RuleEngineEvents {
  notice?(message: string): void;
}

export class RuleEngine {
  private rules: Rule[] = [];
  private readonly lastFired = new Map<string, number>();
  private readonly trace: RuleFiring[] = [];
  private midRoundTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private state: CharacterState | null = null;
  /**
   * What state alone cannot answer.
   *
   * Currently only whether a hangup looks clean, which turns on a five-minute
   * window nothing on screen shows. Left undefined until something says so, so
   * a guard on it reads as *unknown* rather than as `true` — and an unknown
   * value fails every comparison but `!=`, which is what stops a rule that
   * would hang up "when it is safe" firing because nobody told it whether it
   * was.
   */
  private extra: { hangUpClean?: boolean } = {};
  /**
   * Rules already reported as matching with nothing to send.
   *
   * Said once each: the trigger is usually a state change, and a rule reading
   * `{target}` with no target has one of those every few hundred milliseconds.
   */
  private readonly unresolvedSaid = new Set<string>();

  constructor(
    private readonly queue: CommandQueue,
    private readonly events: RuleEngineEvents = {}
  ) {}

  get firings(): RuleFiring[] {
    return [...this.trace];
  }

  /** Replaces the rule set. Timers are rebuilt, cooldowns are kept. */
  load(rules: Rule[]): void {
    this.rules = rules.filter((rule) => rule.enabled);
    this.rearmTimers();
  }

  reset(): void {
    this.lastFired.clear();
    this.trace.length = 0;
    this.state = null;
    this.extra = {};
    this.unresolvedSaid.clear();
    this.clearMidRound();
  }

  dispose(): void {
    this.clearMidRound();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** State changed: run the `state` rules and remember the snapshot. */
  onState(state: CharacterState): void {
    this.state = state;
    this.run({ kind: 'state' }, null);
  }

  /** Facts about the session that are not facts about the character. */
  observe(extra: { hangUpClean?: boolean }): void {
    this.extra = { ...this.extra, ...extra };
  }

  /** A line was classified: run its `block` rules, and track combat timing. */
  onBlock(block: Block): void {
    this.run({ kind: 'block', type: block.type }, block);
    if (COMBAT_BLOCKS.has(block.type)) this.armMidRound();
  }

  private armMidRound(): void {
    this.clearMidRound();
    this.midRoundTimer = setTimeout(() => {
      this.midRoundTimer = null;
      this.run({ kind: 'mid-round' }, null);
    }, tuning().queue.midRoundMs);
    this.midRoundTimer.unref?.();
  }

  private clearMidRound(): void {
    if (!this.midRoundTimer) return;
    clearTimeout(this.midRoundTimer);
    this.midRoundTimer = null;
  }

  private rearmTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];

    for (const rule of this.rules) {
      if (rule.when.kind !== 'timer') continue;
      const every = Math.max(1000, rule.when.everyMs);
      const timer = setInterval(() => this.fire(rule, null), every);
      timer.unref?.();
      this.timers.push(timer);
    }
  }

  /** Runs every rule whose trigger matches. */
  private run(trigger: { kind: string; type?: string }, block: Block | null): void {
    for (const rule of this.rules) {
      if (rule.when.kind !== trigger.kind) continue;
      if (rule.when.kind === 'block' && rule.when.type !== trigger.type) continue;
      this.fire(rule, block);
    }
  }

  private fire(rule: Rule, block: Block | null): void {
    const state = this.state;
    // Rules describe what to do about a situation; with no state there is no
    // situation yet, and firing would be acting on nothing.
    if (!state) return;
    if (state.phase !== 'in-game') return;

    const now = Date.now();
    const since = now - (this.lastFired.get(rule.name) ?? -Infinity);
    if (since < rule.cooldownMs) return;

    const failed = rule.if.find((guard) => !testGuard(guard, state, this.extra));
    if (failed) {
      this.record({
        at: now,
        rule: rule.name,
        commands: [],
        blockedBy: `${failed.field} ${failed.op} ${String(failed.value)}`
      });
      return;
    }

    const commands: string[] = [];
    let unresolved: string | null = null;
    for (const action of rule.then) {
      const command = interpolate(action.command, block, state).trim();
      // An unresolved placeholder means the capture the rule wanted was not
      // there. Sending the template verbatim would type `attack {target}` into
      // the game, which is worse than doing nothing.
      if (command.length === 0 || /\{[\w.]+\}/.test(command)) {
        unresolved ??= action.command;
        continue;
      }

      this.queue.enqueue({
        command,
        priority: action.priority,
        ...(action.coalesce === undefined ? {} : { coalesceKey: action.coalesce }),
        ...(action.expiresMs === undefined ? {} : { expiresAt: now + action.expiresMs }),
        reason: `rule: ${rule.name}`
      });
      commands.push(command);
    }

    if (commands.length === 0) {
      /*
       * A rule whose guards all passed and whose every action came out empty.
       *
       * The commonest way to write one is `attack {target}` with no target yet,
       * and until now it was **completely silent**: nothing was sent, nothing
       * reached the trace — `record` is below this return — and the only
       * symptom was a rule the player was sure should have fired. That is the
       * silent decline this codebase refuses everywhere else.
       *
       * **Once per rule**, because the trigger is usually a state change and a
       * character with no target has a great many of those. `unsaid` is cleared
       * on `reset`, so a fresh connection says it again.
       */
      if (unresolved !== null && !this.unresolvedSaid.has(rule.name)) {
        this.unresolvedSaid.add(rule.name);
        this.events.notice?.(
          `Rule "${rule.name}" matched, but "${unresolved}" has nothing to fill it in with yet, ` +
            `so nothing was sent.`
        );
      }
      return;
    }
    this.lastFired.set(rule.name, now);
    this.record({ at: now, rule: rule.name, commands });
  }

  private record(firing: RuleFiring): void {
    this.trace.push(firing);
    if (this.trace.length > tuning().queue.traceLimit) this.trace.shift();
  }
}

export { PRIORITY };
