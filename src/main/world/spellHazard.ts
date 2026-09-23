/**
 * What a room's own spell does to whoever stands in it, and what stops it.
 *
 * `Rooms.Spell` is a spell row; the harm is usually one step down a chain the
 * runtime cannot walk (`TextBlock` → `TBInfo` → `cast`), so the chain is
 * followed here at build time and the answer written onto the spell. A plain
 * magnitude prices as `resolveSpells` prices an exit; `failitem` names what
 * stops the script; a roll table is dice; `summon` is a fact; a gate on who
 * the character is (`GATES`) is followed at full weight, since what stands
 * behind it happens to somebody. A chain this cannot follow is `unread`,
 * never harmless.
 *
 * See `mudengine-world` › *The world knowledge base*, the room-spell bullets.
 */
import { HAZARD_ABILITY } from '../../shared/abilities';
import type { LevelBand } from '../../shared/world';
import type { BuiltSpellHazard } from './buildRealm';
import { number, text } from './values';
import type { RealmSource } from './RealmSource';

/**
 * The abilities that take hit points off whoever the spell lands on.
 *
 * The same four `WorldGraph`'s `HURTS` names, and deliberately a second
 * spelling rather than an import: this runs in the converter, which must not
 * depend on the graph that reads what it writes. The pair is asserted against
 * each other in `spellHazard.test.ts`.
 */
const HURTS: ReadonlySet<number> = new Set([
  HAZARD_ABILITY.damage,
  HAZARD_ABILITY.damageWithMr,
  HAZARD_ABILITY.drain,
  HAZARD_ABILITY.poison
]);

/** A band on disk: `[min, max]`, `null` for unbounded on either side. */
const pair = (band: LevelBand): [number | null, number | null] => [
  band.min ?? null,
  band.max ?? null
];

/** How deep a chain of blocks and spells is followed before it is called unread. */
const DEPTH = 8;

/**
 * Steps that only decide whether the rest of the line runs — for *this*
 * character (the sheet: `checkitem` at `TextBlockPart.cs:103`, `checkability`
 * 394, `checkabilityexact` 416, `testability` 437 — `Sum <= value`, the
 * mirror of `checkability` and not a roll — `failability` 459, `class` 523,
 * the alignment pair 590/604, `maxlevel` 748, `minlevel` 774, `race` 891) or
 * at *this* moment (`checklives` 268, `needmonster` 800, `monsters` 852).
 * Each answers `Succeeded` or `Failed` and nothing else, so what stands behind
 * one happens to somebody, and the pessimistic reading — the one this reader
 * owes — is to follow it at full weight, as `random` already is. Format 43:
 * the oasis pools' `checkspell 512 4099:cast 515` — which removes a spell and
 * hurts nobody — was a hazard on every route to the Golden Spire. A roll
 * (`testskill`) stays unread: it is not a fact about anybody.
 */
const GATES: ReadonlySet<string> = new Set([
  'checkitem',
  'checkability',
  'checkabilityexact',
  'testability',
  'failability',
  'minlevel',
  'maxlevel',
  'class',
  'race',
  'goodaligned',
  'evilaligned',
  'checklives',
  'monsters',
  'needmonster'
]);

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
  /** Items that stop the script outright, in the realm's order. */
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
   * The level bands the realm gates some of these effects behind (todo 01).
   *
   * A gate is followed at full weight because what stands behind one happens
   * to *somebody* — but which somebody is stated, and the router knows which
   * character it is planning for. The desert's sandstorm is
   * `86:maxlevel 19:cast 713`: a one-in-a-hundred teleport that cannot happen
   * to a level 21 character at all, and the plan said *it moves you somewhere
   * else* on every one of 979 rooms.
   *
   * Absent per fact is **ungated**, which is the answer for anything recorded
   * outside a level gate as well as for anything recorded both ways: an
   * effect that can reach this character by any path is one it can reach.
   */
  levels: { damage?: LevelBand; relocates?: LevelBand; summons?: LevelBand };
}

/**
 * Every room spell in the realm, resolved, keyed by spell id.
 *
 * Only the spells rooms actually cast: 159 of the shipped realm's 1,990 rows
 * over 13,603 rooms, so following every chain is a few hundred lookups rather
 * than a walk of the whole spell table.
 */
export function indexSpellHazards(source: RealmSource): Map<number, BuiltSpellHazard> {
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

  const blocks = new Map<number, string>();
  for (const row of source.table('TBInfo')?.rows ?? []) {
    const id = number(row['Number']);
    // Stored with trailing NULs; they are padding, not text — the same strip
    // `buildRealm` makes when it reads a room's own script.
    const action = text(row['Action']).replaceAll('\u0000', '').trim();
    // An empty block the realm holds is kept as empty: run, it does nothing.
    // Only an id the table lacks is a chain this cannot follow (`walkBlock`).
    if (id !== null) blocks.set(id, action);
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
    if (hazard.avoidedBy.length > 0) written.av = hazard.avoidedBy;
    if (hazard.avoidedBySpell.length > 0) written.sp = hazard.avoidedBySpell;
    if (hazard.relocates) written.tp = 1;
    if (hazard.summons) written.sm = 1;
    if (hazard.unread) written.u = 1;
    const lv: NonNullable<BuiltSpellHazard['lv']> = {};
    if (hazard.levels.damage !== undefined) lv.d = pair(hazard.levels.damage);
    if (hazard.levels.relocates !== undefined) lv.tp = pair(hazard.levels.relocates);
    if (hazard.levels.summons !== undefined) lv.sm = pair(hazard.levels.summons);
    if (Object.keys(lv).length > 0) written.lv = lv;
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
  blocks: ReadonlyMap<number, string>
): SpellHazardFacts {
  const avoidedBy: number[] = [];
  const avoidedBySpell: number[] = [];
  /*
   * Keyed on the id **and the band it was reached under**, not on the id.
   *
   * Memoising on the id alone stops the recursion and also stops the
   * recording: a spell reached once behind `maxlevel 19` and once outside any
   * gate would keep the band the first visit gave it, and the effect would be
   * dropped for exactly the characters it can reach. The band space is a
   * handful of gates per chain and `DEPTH` still bounds it, so the pair is
   * cheap; a cycle repeats its own pair and is caught as before.
   */
  const seenSpells = new Set<string>();
  const seenBlocks = new Set<string>();
  const visit = (id: number): string => `${id}|${band?.min ?? ''}|${band?.max ?? ''}`;
  let damage = 0;
  let relocates = false;
  let summons = false;
  let unread = false;

  /*
   * The level gate in force where the reader currently is, and what each fact
   * was recorded under (todo 01).
   *
   * `band` is pushed by a `minlevel` / `maxlevel` step and popped at the end
   * of the line it gated, because a gate governs the rest of *its* line and
   * nothing else — `86:maxlevel 19:cast 713` is one roll-table line, and the
   * next line is not gated by it.
   *
   * `widen` is the merge, and it is deliberately the generous direction: a
   * fact recorded once behind a gate and once outside one can reach every
   * character, so the second recording erases the band. Unknown is never the
   * reassuring answer, and here the reassuring answer is *it cannot happen to
   * you*.
   */
  let band: LevelBand | null = null;
  const bands: SpellHazardFacts['levels'] = {};
  const widen = (fact: 'damage' | 'relocates' | 'summons'): void => {
    if (band === null) {
      bands[fact] = undefined;
      delete bands[fact];
      seenUngated.add(fact);
      return;
    }
    if (seenUngated.has(fact)) return;
    const held = bands[fact];
    if (held === undefined) {
      bands[fact] = { ...band };
      return;
    }
    // Two bands on one fact: whichever character either admits, it can reach.
    bands[fact] = {
      ...(held.min !== undefined && band.min !== undefined
        ? { min: Math.min(held.min, band.min) }
        : {}),
      ...(held.max !== undefined && band.max !== undefined
        ? { max: Math.max(held.max, band.max) }
        : {})
    };
  };
  const seenUngated = new Set<string>();

  const walkSpell = (spell: number, depth: number): void => {
    if (depth > DEPTH) return void (unread = true);
    const key = visit(spell);
    if (seenSpells.has(key)) return;
    seenSpells.add(key);
    const row = facts.get(spell);
    /*
     * A spell the realm's own table does not hold is unread, not harmless —
     * the reassuring answer here is *walk through it*, and the whole point of
     * this reader is that the river was being walked through for free.
     */
    if (row === undefined) return void (unread = true);
    const mean = Math.abs(row.power[0] + row.power[1]) / 2;
    for (const [ability, value] of row.abilities) {
      if (ability === HAZARD_ABILITY.textBlock) {
        // `TextBlock 0` is the realm's *no script*, not a script it lost.
        if (value > 0) walkBlock(value, depth + 1);
        continue;
      }
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
        if (value > 0) unread = true;
        continue;
      }
      if (ability === HAZARD_ABILITY.teleportRoom || ability === HAZARD_ABILITY.teleportMap) {
        relocates = true;
        widen('relocates');
        continue;
      }
      if (!HURTS.has(ability) && !(ability === HAZARD_ABILITY.heal && value < 0)) continue;
      // `abil.Sum == 0 ? rolledPower : abil.Sum`, the server's own choice of
      // which figure to use — the same one `resolveSpells` makes.
      const magnitude = value !== 0 ? Math.abs(value) : mean;
      if (magnitude > damage) damage = magnitude;
      widen('damage');
    }
  };

  const walkBlock = (block: number, depth: number): void => {
    if (depth > DEPTH) return void (unread = true);
    const key = visit(block);
    if (seenBlocks.has(key)) return;
    seenBlocks.add(key);
    const action = blocks.get(block);
    if (action === undefined) return void (unread = true);
    for (const line of action.split('\n')) {
      /*
       * A gate governs the rest of *its own line* and nothing else, so the
       * band is taken back at the end of each one — `86:maxlevel 19:cast 713`
       * gates the cast beside it and not the line under it. Restored rather
       * than cleared, because a block reached from inside a gated line is
       * still inside that gate.
       */
      const outer = band;
      for (const [index, step] of line.split(':').entries()) {
        const [verb, first, second] = step.trim().split(/\s+/);
        if (verb === undefined || verb.length === 0) continue;
        /*
         * A roll table. A block reached by `random` is a list of lines each
         * led by a cumulative threshold — `77:addexp 0`, `81:message 2645`,
         * … `100:message 2650` — and one roll of a hundred picks the first
         * line at or under it (the Silvermere spell, todo 01: 77% nothing,
         * then four percent for one message, two for the next). The number is
         * the roll, not a verb, and reading it as one called every roll table
         * in the realm unread — 29 rooms of scenery priced as a hazard.
         * Every line is followed at full weight, as `random` already is.
         */
        if (index === 0 && /^\d+$/.test(verb)) continue;
        switch (verb) {
          case 'failitem':
          case 'failroomitem': {
            /*
             * *Stop if they have this.* The raft on the Silver River: the
             * script goes no further, so the cast at the end of it never
             * happens. This is the client's whole answer to "unless of course
             * you have the item".
             */
            const item = number(first);
            if (item === null || item <= 0) unread = true;
            else if (!avoidedBy.includes(item)) avoidedBy.push(item);
            break;
          }
          case 'failspell': {
            const spell = number(first);
            if (spell === null || spell <= 0) unread = true;
            else if (!avoidedBySpell.includes(spell)) avoidedBySpell.push(spell);
            /*
             * The second operand is a **block**, not a message id as
             * `failitem`'s is: `TextBlockPart.cs:485` runs it for a character
             * *without* the spell and hands back its status, and the line goes
             * on from there. So it is what such a character gets, followed at
             * full weight — the oasis pools' 4099 is empty, and a derivative
             * that put a wound there would otherwise read as scenery.
             */
            const fallback = number(second);
            if (fallback !== null && fallback > 0) walkBlock(fallback, depth + 1);
            break;
          }
          case 'checkspell': {
            /*
             * **The spell half of `failspell` after all** (2026-09-22). The
             * claim it is not was dated to the two servers disagreeing, and
             * the capture that dissolves it has arrived.
             *
             * `TextBlockPart.cs:479` returns `Failed` *unconditionally* and
             * runs the second operand's block only for a character the spell
             * is **not** on; `ExecuteOnMatch` breaks the line on `Failed`
             * (`TextBlockPart.cs:1358`), so the rest of the line never runs
             * for anybody and the whole of what the room does is inside that
             * block. Which is `failspell`'s shape exactly: *without this
             * spell, here is what happens to you*.
             *
             * Live (`logs/2026-09-22_08-02-35_festus.mudcap.jsonl`): the
             * Scorching Desert is `checkspell 711 2654:random 2655`, and
             * `2654` is `failitem 1180:cast 712:…`. Festus took *You
             * suffer in the desert heat…* 24 times, typed `drink water`
             * — which casts 711 — and crossed 26 more desert rooms with
             * the sentence never printed again. Wire beats the server's
             * source; `GreaterMUD2`'s inverted reading would have the
             * waterskin *cause* the harm and would never run the block at
             * all, which is not the game anybody plays.
             */
            const spell = number(first);
            if (spell === null || spell <= 0) unread = true;
            else if (!avoidedBySpell.includes(spell)) avoidedBySpell.push(spell);
            const fallback = number(second);
            if (fallback !== null && fallback > 0) walkBlock(fallback, depth + 1);
            break;
          }
          case 'cast':
            walkSpell(number(first) ?? 0, depth + 1);
            break;
          case 'random':
            /*
             * `random <block>` and `random <chance> <block>` are both written.
             * Followed at full weight either way: the chance is how often the
             * room hurts you and a route is walked more than once, so pricing
             * a one-in-ten drowning at a tenth would be a number the realm
             * never gave about a walk nobody makes once.
             */
            walkBlock(number(second) ?? number(first) ?? 0, depth + 1);
            break;
          case 'teleport':
            relocates = true;
            widen('relocates');
            break;
          case 'summon':
            // A monster put in the room: a lair by another name, and read as
            // one rather than as a verb this cannot follow. See `summons`.
            summons = true;
            widen('summons');
            break;
          case 'message':
          case 'text':
          case 'delay':
          case 'adddelay':
          case 'addexp':
          case 'nomonsters':
            // The server narrating, a gift of experience (`addexp 0` is the
            // roll table's *nothing happens*), or a condition on the room
            // rather than on the person standing in it. None of them is harm.
            break;
          case 'minlevel':
          case 'maxlevel': {
            /*
             * A gate on *who*, and the one gate the router can answer for the
             * character it is planning for. Still followed at full weight —
             * what stands behind it happens to somebody — but the band is
             * recorded with whatever is recorded under it, so `hazardFor` can
             * drop it for a character the realm has already excluded.
             *
             * A figure the reader cannot make sense of is the ordinary unread
             * case: the gate stands, and nothing claims to know its band.
             */
            const level = number(first);
            if (level === null) {
              unread = true;
              break;
            }
            const edge: LevelBand = verb === 'minlevel' ? { min: level } : { max: level };
            band = band === null ? edge : { ...band, ...edge };
            break;
          }
          default:
            // A gate on the character: the line goes on, at full weight.
            if (GATES.has(verb)) break;
            /*
             * Everything else this reader holds and has not looked up —
             * `takeitem`, `remoteaction`, `testskill`, `addevil`. Each of them
             * can lead somewhere unpleasant and none of them is a number this
             * can price, so the room is discouraged rather than priced at
             * nothing.
             */
            unread = true;
        }
      }
      band = outer;
    }
  };

  walkSpell(id, 0);
  return {
    damage: Math.round(damage),
    avoidedBy,
    avoidedBySpell,
    relocates,
    summons,
    unread,
    levels: bands
  };
}
