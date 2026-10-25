/**
 * What a room's own spell does to whoever stands in it, and what stops it.
 *
 * `Rooms.Spell` is a spell row; the harm is usually one step down a chain the
 * runtime cannot walk (`TextBlock` → `TBInfo` → `cast`), so the chain is
 * followed here at build time and the answer written onto the spell. A plain
 * magnitude prices as `resolveSpells` prices an exit; `failitem` names what
 * stops the script where it stops every line that does something; a roll
 * table is dice; `summon` is a fact; a gate on who
 * the character is (a `gate` step) is followed at full weight, since what stands
 * behind it happens to somebody. A chain this cannot follow is `unread`,
 * never harmless.
 *
 * See `mudengine-world` › *The world knowledge base*, the room-spell bullets.
 */
import { HAZARD_ABILITY, abilityHurts } from '../../shared/abilities';
import {
  outrightStoppers,
  type HazardEffect,
  type HazardReachMap,
  type LevelBand
} from '../../shared/world';
import type { BuiltSpellHazard } from './buildRealm';
import { behind, builtEffects, joinReach } from './hazardReach';
import { number } from './values';
import type { RealmSource } from './RealmSource';
import { castMoves, SCRIPT_DEPTH, scriptsOf } from './navigation/scriptWays';
import { linesRun, roleOf, stepsRun, type Textblock } from './navigation/textblock';

/** A band on disk: `[min, max]`, `null` for unbounded on either side. */
const pair = (band: LevelBand): [number | null, number | null] => [
  band.min ?? null,
  band.max ?? null
];

/** One `Spells` row, in the two forms this reader needs it. */
interface SpellFacts {
  abilities: Array<[number, number]>;
  power: [number, number];
}

/**
 * A room's spell, resolved: what a tick in the room costs and what stops it.
 *
 * Both halves matter to the router. `damage` prices the room; `avoidedBy`
 * un-prices it for a character carrying one of the items, which is the whole
 * difference between the river being a corridor and a wall.
 */
export interface SpellHazardFacts {
  /** Hit points a tick is expected to cost. `0` where the chain does none. */
  damage: number;
  /** Items that stop the script outright, in the realm's order (`outrightStoppers`). */
  avoidedBy: number[];
  /** Spells that stop it. Recorded, never evaluated — see `WorldSpell`. */
  avoidedBySpell: number[];
  /** Whether the spell moves the character somewhere the exit table does not. */
  relocates: boolean;
  /**
   * Whether the chain can put a monster in the room.
   *
   * Read, not unread: `summon 48` is a verb this reader understands, and what
   * it does is exactly what a lair does — so the router discourages the room
   * as it does a chain it cannot follow, and the panel says *may summon
   * something* rather than *cannot read what it does*, which was the darkwood
   * forest's answer for six rooms on every route east of the gates.
   */
  summons: boolean;
  /** Whether the chain ran into something this reader cannot follow. */
  unread: boolean;
  /**
   * Each effect's ways in: the level band and the `failitem`s each sits behind
   * (todo 01, format 75). A gate is followed at full weight because what stands
   * behind one happens to *somebody*, and which somebody is stated: the
   * desert's sandstorm is `86:maxlevel 19:cast 713`, a one-in-a-hundred
   * teleport that cannot happen to a level 21 character, and the plan said *it
   * moves you somewhere else* on every one of 979 rooms.
   */
  reach: HazardReachMap;
}

/**
 * Every room spell in the realm, resolved, keyed by spell id.
 *
 * Only the spells rooms actually cast: 159 of the shipped realm's 1,990 rows
 * over 13,603 rooms, so following every chain is a few hundred lookups rather
 * than a walk of the whole spell table.
 */
export function indexSpellHazards(
  source: RealmSource,
  blocks: ReadonlyMap<number, Pick<Textblock, 'lines' | 'linkTo'>>
): Map<number, BuiltSpellHazard> {
  const rooms = source.table('Rooms');
  const spells = source.table('Spells');
  if (rooms === null || spells === null) return new Map();

  const facts = new Map<number, SpellFacts>();
  for (const row of spells.rows) {
    const id = number(row['Number']);
    if (id === null) continue;
    const abilities: Array<[number, number]> = [];
    for (let slot = 0; slot < 8; slot += 1) {
      const ability = number(row[`Abil-${slot}`]);
      if (ability === null || ability <= 0) continue;
      abilities.push([ability, number(row[`AbilVal-${slot}`]) ?? 0]);
    }
    facts.set(id, {
      abilities,
      power: [number(row['MinBase']) ?? 0, number(row['MaxBase']) ?? 0]
    });
  }

  const cast = new Set<number>();
  for (const row of rooms.rows) {
    const id = number(row['Spell']);
    if (id !== null && id > 0) cast.add(id);
  }

  const index = new Map<number, BuiltSpellHazard>();
  for (const id of cast) {
    const hazard = resolveHazard(id, facts, blocks);
    // A spell that does nothing to anybody standing in the room is not written
    // out: 13,603 rooms name one and most of them are scenery. Absent reads
    // back as *this room's spell is harmless*, which is what it is.
    if (hazard.damage === 0 && !hazard.unread && !hazard.relocates && !hazard.summons) continue;
    const written: BuiltSpellHazard = {};
    if (hazard.damage > 0) written.d = hazard.damage;
    if (hazard.avoidedBySpell.length > 0) written.sp = hazard.avoidedBySpell;
    if (hazard.relocates) written.tp = 1;
    if (hazard.summons) written.sm = 1;
    if (hazard.unread) written.u = 1;
    const ways: NonNullable<BuiltSpellHazard['r']> = {};
    for (const [effect, key] of builtEffects()) {
      const reach = hazard.reach[effect];
      // One way that reaches everybody is what an absent effect reads back as.
      if (
        reach === undefined ||
        reach.some((way) => way.band === undefined && way.fails === undefined)
      )
        continue;
      ways[key] = reach.map((way) => [...pair(way.band ?? {}), ...(way.fails ?? [])]);
    }
    if (Object.keys(ways).length > 0) written.r = ways;
    index.set(id, written);
  }
  return index;
}

/**
 * One spell's chain, followed.
 *
 * Exported for the tests, which drive it off hand-written tables rather than a
 * real database: the arithmetic is the claim, and a claim asserted only against
 * a file that ships is a claim nobody can see fail.
 */
export function resolveHazard(
  id: number,
  facts: ReadonlyMap<number, SpellFacts>,
  blocks: ReadonlyMap<number, Pick<Textblock, 'lines' | 'linkTo'>>
): SpellHazardFacts {
  const avoidedBySpell: number[] = [];
  /*
   * Keyed on the id **and the band it was reached under**, not on the id.
   *
   * Memoising on the id alone stops the recursion and also stops the
   * recording: a spell reached once behind `maxlevel 19` and once outside any
   * gate would keep the band the first visit gave it, and the effect would be
   * dropped for exactly the characters it can reach. The band space is a
   * handful of gates per chain and `SCRIPT_DEPTH` still bounds it, so the pair is
   * cheap; a cycle repeats its own pair and is caught as before.
   */
  const seenSpells = new Set<string>();
  const seenBlocks = new Set<string>();
  /*
   * Each one's ways, once walked. One still being walked (a cycle) adds none
   * where it is met again, so every node between it and the meeting is short
   * of its ways and is not kept, and the next path to one walks it again.
   * `low` is the shallowest open node met below the current one; a node is
   * kept where nothing below it reached above it.
   */
  const spellStops = new Map<string, HazardReachMap>();
  const blockStops = new Map<string, HazardReachMap>();
  const open = new Map<string, number>();
  let stack = 0;
  let low = Infinity;
  const met = (
    memo: ReadonlyMap<string, HazardReachMap>,
    key: string,
    name: string
  ): HazardReachMap => {
    const held = memo.get(key);
    if (held !== undefined) return held;
    low = Math.min(low, open.get(name) ?? Infinity);
    return {};
  };
  const enter = (name: string): { depth: number; lowBefore: number } => {
    stack += 1;
    open.set(name, stack);
    const lowBefore = low;
    low = Infinity;
    return { depth: stack, lowBefore };
  };
  const settle = (
    seen: Set<string>,
    memo: Map<string, HazardReachMap>,
    key: string,
    name: string,
    entry: { depth: number; lowBefore: number },
    ways: HazardReachMap
  ): HazardReachMap => {
    open.delete(name);
    stack -= 1;
    const whole = low >= entry.depth;
    if (whole) memo.set(key, ways);
    else seen.delete(key);
    low = Math.min(entry.lowBefore, whole ? Infinity : low);
    return ways;
  };
  const visit = (id: number): string => `${id}|${band?.min ?? ''}|${band?.max ?? ''}`;
  let damage = 0;
  let relocates = false;
  let summons = false;
  let unread = false;

  /*
   * The level gate in force where the reader currently is (todo 01).
   *
   * `band` is pushed by a `minlevel` / `maxlevel` step and popped at the end
   * of the line it gated, because a gate governs the rest of *its* line and
   * nothing else — `86:maxlevel 19:cast 713` is one roll-table line, and the
   * next line is not gated by it.
   */
  let band: LevelBand | null = null;
  /** One way in for an effect met here: the band in force, no `failitem` ahead of it yet. */
  const here = (effect: HazardEffect): HazardReachMap => ({
    [effect]: [band === null ? {} : { band: { ...band } }]
  });
  const cannotRead = (): HazardReachMap => {
    unread = true;
    return here('unread');
  };

  const walkSpell = (spell: number, depth: number): HazardReachMap => {
    if (depth > SCRIPT_DEPTH) return cannotRead();
    const key = visit(spell);
    const name = `spell ${key}`;
    if (seenSpells.has(key)) return met(spellStops, key, name);
    seenSpells.add(key);
    const entry = enter(name);
    const row = facts.get(spell);
    /*
     * A spell the realm's own table does not hold is unread, not harmless —
     * the reassuring answer here is *walk through it*, and the whole point of
     * this reader is that the river was being walked through for free.
     */
    if (row === undefined) return settle(seenSpells, spellStops, key, name, entry, cannotRead());
    const mean = Math.abs(row.power[0] + row.power[1]) / 2;
    let ways: HazardReachMap = {};
    // `TextBlock 0` is the spell's own roll (`columnRows`), and with no power it is no script.
    for (const script of scriptsOf(row).flat()) {
      ways = joinReach(ways, walkBlock(script, depth + 1, 'steps'));
    }
    if (castMoves(row.abilities)) {
      relocates = true;
      ways = joinReach(ways, here('relocates'));
    }
    for (const [ability, value] of row.abilities) {
      if (ability === HAZARD_ABILITY.textBlock) continue;
      if (ability === HAZARD_ABILITY.endCast) {
        /*
         * **Not followed, and that is the whole difference between a pass and
         * a stay.** `EndCast` is what the realm hands the character when this
         * spell *runs out*: `freezing water` ends in `holding breath` (25
         * ticks), which ends in `drowning` (5), which ends in `drowned to
         * death` — power 9,999. Following the chain and keeping the largest
         * magnitude priced one tick of standing in the water at certain death,
         * and walled 145 rooms of the two shipped worlds.
         *
         * The router prices *one pass*, exactly as `lairPassage` does. So the
         * chain is not walked — but it is not free either: what is at the end
         * of it is worse than what this reader priced, and a route that stalls
         * there is in real trouble. `unread` says so, and costs
         * `unreadHazardShare`.
         */
        if (value > 0) ways = joinReach(ways, cannotRead());
        continue;
      }
      if (ability === HAZARD_ABILITY.teleportRoom || ability === HAZARD_ABILITY.teleportMap)
        continue;
      if (!abilityHurts(ability, value)) continue;
      // `abil.Sum == 0 ? rolledPower : abil.Sum`, the server's own choice of
      // which figure to use — the same one `resolveSpells` makes.
      const magnitude = value !== 0 ? Math.abs(value) : mean;
      if (magnitude > damage) damage = magnitude;
      ways = joinReach(ways, here('damage'));
    }
    return settle(seenSpells, spellStops, key, name, entry, ways);
  };

  const walkBlock = (block: number, depth: number, use: 'steps' | 'roll'): HazardReachMap => {
    if (depth > SCRIPT_DEPTH) return cannotRead();
    const key = visit(block);
    const name = `block ${key}`;
    if (seenBlocks.has(key)) return met(blockStops, key, name);
    seenBlocks.add(key);
    const entry = enter(name);
    const read = blocks.get(block);
    if (read === undefined) return settle(seenBlocks, blockStops, key, name, entry, cannotRead());
    let ways: HazardReachMap = {};
    const done = (): HazardReachMap => settle(seenBlocks, blockStops, key, name, entry, ways);
    for (const line of linesRun(read, use)) {
      /*
       * A gate governs the rest of *its own line* and nothing else, so the
       * band is taken back at the end of each one — `86:maxlevel 19:cast 713`
       * gates the cast beside it and not the line under it. Restored rather
       * than cleared, because a block reached from inside a gated line is
       * still inside that gate.
       */
      const outer = band;
      // The items this line fails on so far, and the ways in of what it has done.
      const fails: number[] = [];
      let lineWays: HazardReachMap = {};
      const does = (step: HazardReachMap): void => {
        lineWays = joinReach(lineWays, behind(fails, step));
      };
      // A roll table's lines are all followed at full weight, as `random` is.
      walkLine: for (const step of stepsRun(line, use)) {
        switch (step.verb) {
          case 'failitem':
            /*
             * *Stop if they have this.* The raft on the Silver River: the
             * line goes no further, so the cast at the end of it never
             * happens. This is the client's whole answer to "unless of course
             * you have the item", where every other way in fails for the
             * carrier too (`outrightStoppers`). `failroomitem` is not
             * this: it checks the room's floor (`TextBlockPart.cs:998`), and
             * `rock check` drops the outcropping it looks for itself, so it is
             * a gate (todo 135).
             */
            if (step.item <= 0) does(cannotRead());
            else fails.push(step.item);
            break;
          case 'checkspell':
          case 'failspell':
            /*
             * The same code in the server (`TextBlockPart.cs:471`, `:497`):
             * fails while the spell is on the character, otherwise runs the
             * second operand's block and takes its answer. So the spell is
             * what stops the room, and the block is what a character without
             * it gets, followed at full weight. Live, 2026-09-22: the
             * Scorching Desert is `checkspell 711 2654:random 2655`; festus
             * took the heat 24 times, typed `drink water` (which casts 711),
             * and crossed 26 more desert rooms without it.
             */
            if (step.spell <= 0) does(cannotRead());
            else if (!avoidedBySpell.includes(step.spell)) avoidedBySpell.push(step.spell);
            if (step.otherwise !== undefined && step.otherwise > 0) {
              does(walkBlock(step.otherwise, depth + 1, 'steps'));
            }
            break;
          case 'cast':
            does(walkSpell(step.spell, depth + 1));
            break;
          case 'random':
            // Followed at full weight: a route is walked more than once, and a
            // one-in-ten drowning priced at a tenth is a number the realm never gave.
            does(walkBlock(step.block, depth + 1, 'roll'));
            break;
          case 'show': {
            // Showing a block runs what it links to (`TextBlock.Display`).
            const linked = blocks.get(step.block)?.linkTo ?? null;
            if (linked !== null && linked > 0) does(walkBlock(linked, depth + 1, 'steps'));
            break;
          }
          case 'teleport':
            relocates = true;
            does(here('relocates'));
            break;
          case 'summon':
            // A monster put in the room: a lair by another name. See `summons`.
            summons = true;
            does(here('summons'));
            break;
          case 'minlevel':
          case 'maxlevel': {
            /*
             * A gate on *who*, and the one gate the router can answer for the
             * character it is planning for. Still followed at full weight —
             * what stands behind it happens to somebody — but the band is
             * recorded on every way in under it, so `hazardFor` can
             * drop it for a character the realm has already excluded.
             */
            const edge: LevelBand =
              step.verb === 'minlevel' ? { min: step.level } : { max: step.level };
            band = band === null ? edge : { ...band, ...edge };
            break;
          }
          // An unknown verb fails its line; arguments the server cannot read
          // throw and abandon the block. Nothing after either happens.
          case 'unknown':
            if (step.why === 'arguments') {
              band = outer;
              ways = joinReach(ways, lineWays);
              return done();
            }
            break walkLine;
          case 'testskill':
            // A roll is not a fact about anybody, and what it leads to is unread.
            does(cannotRead());
            break;
          default: {
            /*
             * A gate, or a gate that pays, decides whether the rest of the line
             * runs for somebody, so the line goes on at full weight (format 43:
             * the oasis pools' `checkspell 512 4099:cast 515` was a hazard on
             * every route to the Golden Spire). Narration and a gift of
             * experience are no harm. Any other effect is one this cannot
             * price, so the room is discouraged rather than priced at nothing.
             */
            const role = roleOf(step);
            if (role === 'gate' || role === 'pays' || role === 'say' || role === 'flow') break;
            if (step.verb === 'addexp') break;
            does(cannotRead());
          }
        }
      }
      band = outer;
      ways = joinReach(ways, lineWays);
    }
    return done();
  };

  const reach = walkSpell(id, 0);
  return {
    damage: Math.round(damage),
    avoidedBy: outrightStoppers(reach),
    avoidedBySpell,
    relocates,
    summons,
    unread,
    reach
  };
}
