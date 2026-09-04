import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

import { WorldGraph } from '../WorldGraph';
import {
  ABILITY_INTERNAL,
  ABILITY_SHAPE,
  abilityIsClaimed,
  abilityIsNotable,
  abilityIsUnread,
  abilityName,
  type AbilityTable
} from '../../../shared/abilities';

/** Which of the realm's five tables each index came off. */
const TABLE_OF = {
  items: 'item',
  mobs: 'mob',
  spells: 'spell',
  races: 'race',
  classes: 'class'
} as const satisfies Record<string, AbilityTable>;

const file = path.resolve('resources/world/rooms.jsonl.gz');
const available = fs.existsSync(file);
const graph = available ? WorldGraph.load(file) : null;

/**
 * Every item row the realm file holds, read straight off disk.
 *
 * `WorldGraph` deliberately exposes items by *name*, which is what every
 * consumer wants and what the console's index is built from — so the two
 * whole-realm claims below read the file rather than widening the class's API
 * for a test. They are claims about the shipped data, not about the graph.
 */
function shippedItems(): Array<{ n: string; ab?: Array<[number, number]> }> {
  return shipped('items');
}

/** The same, for whichever of the five indexes carries effects. */
/** An item row as the file actually writes it, restrictions included. */
interface ShippedItem {
  n: string;
  ab?: Array<[number, number]>;
  cls?: number[];
  race?: number[];
  lvl?: number;
  worn?: number;
}

function shippedRestrictions(): ShippedItem[] {
  const header = zlib.gunzipSync(fs.readFileSync(file)).toString().split('\n', 1)[0]!;
  return JSON.parse(header)['items'] ?? [];
}

function shipped(which: 'items' | 'mobs' | 'spells' | 'races' | 'classes'): Array<{
  n: string;
  short?: string;
  ab?: Array<[number, number]>;
  /** A spell's own magnitude — format 16. See `BuiltSpell.pw`. */
  pw?: [number, number];
  cap?: number;
  /** Who it may be cast on — format 17. See `BuiltSpell.tg`. */
  tg?: number;
}> {
  const header = zlib.gunzipSync(fs.readFileSync(file)).toString().split('\n', 1)[0]!;
  return JSON.parse(header)[which] ?? [];
}

/**
 * These run against the real realm rather than a fixture, for the reason
 * `resolve.test.ts` gives: what is being asserted is a claim about the shipped
 * *data* — which effects the realm actually uses and how often — and a
 * hand-made item with two abilities on it cannot express that.
 *
 * The complaint they exist for was that `staff-sling` said `+2 more the client
 * cannot read` while MMUD-Explorer, working from the same database, printed
 * `ClassOK: Mage, Priest`. Nothing was missing from the enum: both ids were
 * named, and neither had a *shape*, so `abilityIsNotable` rejected them.
 */
describe.runIf(available)('the shipped realm reads its own effects', () => {
  /** The pairs a card would draw, and the count it would report as unread. */
  function read(name: string): { rows: Map<number, number[]>; unread: number } {
    const item = graph!.lookup(name).items.find((found) => found.name === name);
    expect(item, `the realm has an item called ${name}`).toBeDefined();
    const rows = new Map<number, number[]>();
    let unread = 0;
    for (const [id, value] of item!.abilities ?? []) {
      if (!abilityIsNotable(id, 'item')) {
        unread += 1;
        continue;
      }
      // Read, and read as "no" — see `EffectRows`. Draws nothing, admits nothing.
      if (!abilityIsClaimed(id, value, 'item')) continue;
      const already = rows.get(id);
      if (already) already.push(value);
      else rows.set(id, [value]);
    }
    return { rows, unread };
  }

  /*
   * The reported item. `[[59, 12], [59, 5]]` — usable by class 12 and class 5,
   * which the realm's own table names Mage and Priest.
   */
  it('reads every effect on staff-sling, and collects the repeated id', () => {
    const { rows, unread } = read('staff-sling');
    expect(unread).toBe(0);
    expect(rows.get(59)).toEqual([12, 5]);
    // One row, not two: `ClassOk Mage, Priest` rather than the heading twice.
    expect(rows.size).toBe(1);
  });

  /** The realm's class table rides on the lookup, so the ids can be named. */
  it('hands the class table over with the answer, so ClassOk can be named', () => {
    const { classNames } = graph!.lookup('staff-sling');
    expect(classNames[12]).toBe('Mage');
    expect(classNames[5]).toBe('Priest');
  });

  /* The other reported item: `Crits 1%, Dodge +1` and one more, which is `Magical`. */
  it('reads every effect on bone charm', () => {
    const { rows, unread } = read('bone charm');
    expect(unread).toBe(0);
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual([28, 34, 58]);
  });

  /*
   * The measurement that says the work was worth doing, and the guard against
   * it silently regressing: before this change 1,415 of the realm's 1,698
   * items with effects carried at least one the client would not draw.
   *
   * Asserted as a ceiling rather than an exact figure — a realm rebuild may
   * move it by a few — and what is left is almost entirely the server's own
   * housekeeping: `Del@Maint`, `Remove@Maint` and the gang-house bookkeeping,
   * which are cycle flags nobody standing in a shop can act on.
   */
  it('leaves only a small remainder unread, and it is three ids', () => {
    let withEffects = 0;
    let withUnread = 0;
    const remaining = new Set<number>();
    for (const item of shippedItems()) {
      const pairs = item.ab ?? [];
      if (pairs.length === 0) continue;
      withEffects += 1;
      const bad = pairs.filter(([id]) => !abilityIsNotable(id, 'item'));
      if (bad.length > 0) withUnread += 1;
      for (const [id] of bad) remaining.add(id);
    }
    expect(withEffects).toBeGreaterThan(1_000);
    expect(withUnread / withEffects).toBeLessThan(0.01);
    /*
     * And it is *exactly* these three, not merely few: `ShockMsg`,
     * `Shadowform` and `NotSellable`, whose values resolve against no table
     * this project has. Asserted as a set so that a realm rebuild introducing
     * a fourth unread id fails here rather than hiding under a percentage.
     *
     * `NotSellable` (1117) arrived with Paradigm's database on 2026-09-02, on
     * seven items and reading 0 on every one of them. It is named in
     * `ABILITY` and has no entry in `ABILITY_SHAPE`, which is what makes it
     * unread — and a shape is not being guessed at from seven zeroes.
     */
    expect([...remaining].sort((a, b) => a - b)).toEqual([137, 178, 1117]);
  });

  /*
   * The reported item, and the second half of the same complaint.
   *
   * `spiked gauntlets` carries `[[119, 0], [4, 1], [135, 20]]` and said `+1
   * more the client cannot read`. The unread pair was `Del@Maint 0` — the
   * realm promising the gauntlets are *kept* through maintenance, which is a
   * fact the client had. It went unread because 119 had no shape, and then was
   * *miscounted* because a flag reading zero was folded in with the ids nothing
   * could name.
   */
  it('reads every effect on spiked gauntlets, and admits no gap', () => {
    const { rows, unread } = read('spiked gauntlets');
    expect(unread).toBe(0);
    // `Del@Maint 0` draws nothing: a flag saying no has no row.
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual([4, 135]);
    expect(rows.get(4)).toEqual([1]);
    expect(rows.get(135)).toEqual([20]);
  });

  /*
   * The maintenance flags at scale. 386 of the 413 items carrying `Del@Maint`
   * carry it as zero, which is why it is a flag and not a count: drawn from
   * presence, the card would tell 386 players their item is destroyed nightly
   * when the row exists to promise it is not.
   */
  it('draws a maintenance flag only on the items the realm actually sets it on', () => {
    let carried = 0;
    let claimed = 0;
    for (const item of shippedItems()) {
      for (const [id, value] of item.ab ?? []) {
        if (id !== 119) continue;
        carried += 1;
        if (abilityIsClaimed(id, value, 'item')) claimed += 1;
      }
    }
    expect(carried).toBeGreaterThan(300);
    // A small minority — the flag is the exception, and the zero is the rule.
    expect(claimed).toBeLessThan(carried / 4);
  });

  /*
   * The gang-house deeds, which were the largest player-facing thing hidden
   * behind the counter: a deed showed its price and `+4 more the client cannot
   * read`, and those four were which house it buys and what it costs to keep.
   */
  it('reads a gang-house deed in full', () => {
    const { rows, unread } = read('red parchment deed');
    expect(unread).toBe(0);
    expect(rows.get(181)).toEqual([1]);
    expect(rows.get(182)).toEqual([250]);
  });

  /*
   * A shape claiming to read a value the realm never produces is a claim about
   * data that is not there. Every `class` value must be a row the class table
   * actually has, or the card would draw a bare id under a heading that says a
   * class was named.
   */
  /*
   * ── The other four tables, from format 14 ────────────────────────────────
   *
   * All five tables have carried `Abil-n` pairs since the realm was first
   * converted, and until 2026-08-31 only the item half was ever written to
   * disk — so a spell card gave its level and mana and was silent about what
   * casting it does, on 1,984 of the realm's 1,990 spells.
   */
  it('writes the effects of all five tables, not just items', () => {
    for (const which of ['items', 'mobs', 'spells', 'races', 'classes'] as const) {
      const carrying = shipped(which).filter((row) => (row.ab ?? []).length > 0);
      expect(carrying.length, `${which} carries effects`).toBeGreaterThan(0);
    }
  });

  /*
   * A class is its grants. `magery` and `combat` are two positions on a scale
   * and say nothing about picking locks; these are what make a Thief a Thief.
   *
   * `GrantPicklocks 10` on the Thief and `0` on the Missionary is the pair
   * that settled the `grant` shape: both have the grant, one has a bonus.
   */
  it('reads what a class grants, including the grants that carry no bonus', () => {
    const thief = shipped('classes').find((row) => row.n === 'Thief');
    expect(thief, 'the realm has a Thief').toBeDefined();
    const rows = new Map(thief!.ab);
    expect(rows.get(1003)).toBe(10); // GrantPicklocks, with a bonus
    expect(rows.get(1002)).toBe(0); // GrantTraps, without one
    expect(rows.get(31)).toBe(0); // Bash — every class has it
    // And every one of them is drawn: a grant is claimed at zero.
    for (const [id, value] of thief!.ab!) {
      expect(abilityIsNotable(id, 'item'), `Thief ability ${id}`).toBe(true);
      expect(abilityIsClaimed(id, value, 'item'), `Thief ability ${id}`).toBe(true);
    }
  });

  /*
   * A race's grants are the half its stat ranges cannot state — a Kang's
   * poison immunity, a Dwarf's infravision. Eleven of thirteen carry them and
   * none carries anything unreadable.
   */
  it('reads every race grant the realm states', () => {
    for (const race of shipped('races')) {
      for (const [id] of race.ab ?? []) {
        expect(abilityIsNotable(id, 'item'), `${race.n} ability ${id}`).toBe(true);
      }
    }
  });

  /*
   * A monster's effects are folded to the **worst** of the rows sharing its
   * name, the same rule `hp` follows — 100 of the 234 shared names disagree.
   *
   * `zombie` is the case that showed it: three rows, one 100% cold-resistant
   * and one not, one at -100% fire and one at -35%. The cautious reading takes
   * the highest of each, because the reassuring end of a range is the one that
   * gets a character killed.
   */
  it('keeps every value the rows behind a monster name state', () => {
    const zombie = shipped('mobs').find((row) => row.n === 'zombie');
    expect(zombie, 'the realm has a zombie').toBeDefined();
    /*
     * All three fire resistances, not the worst of them. The *file* records
     * what the realm said and the card reduces — see `BuiltMob.ab`, and the
     * `dwarven warrior` case below for why reducing here was wrong.
     */
    const fire = zombie!.ab!.filter(([id]) => id === 5).map(([, value]) => value);
    expect(fire.sort((a, b) => a - b)).toEqual([-100, -50, -35]);
    // An id any row states is stated: `NonLiving` is on one row of the three.
    expect(zombie!.ab!.some(([id]) => id === 109)).toBe(true);
  });

  /*
   * The case that showed reducing at build time was wrong.
   *
   * `dwarven warrior` is two rows, and one of them states `MonsGuards` twice
   * (424 and 426) in a single row — the realm naming two monsters that come to
   * help. A fold to the maximum kept 426 and silently dropped the other two,
   * because "worst is highest" is only true of a magnitude and these are row
   * ids. Same for `SpellImmu 40` and `45` on the two `ancient sand dragon`
   * rows: two different spells, not a bigger number.
   */
  it('never reduces a row id to the largest of them', () => {
    const guard = shipped('mobs').find((row) => row.n === 'dwarven warrior');
    expect(guard, 'the realm has a dwarven warrior').toBeDefined();
    const guards = guard!.ab!.filter(([id]) => id === 146).map(([, value]) => value);
    expect(guards.sort((a, b) => a - b)).toEqual([396, 424, 426]);

    const dragon = shipped('mobs').find((row) => row.n === 'ancient sand dragon');
    const immunities = dragon!.ab!.filter(([id]) => id === 139).map(([, value]) => value);
    expect(immunities.sort((a, b) => a - b)).toEqual([40, 45]);
  });

  /*
   * A spell's effect is the reason to look one up, and the magnitude of the
   * damage-family ids is **not** in `AbilVal-n`: `minor healing` states `Heal`
   * with no value and heals 2-8 from its own `MinBase`/`MaxBase`.
   */
  it('reads a healing spell as healing rather than as healing nothing', () => {
    const heal = shipped('spells').find((row) => row.n === 'minor healing');
    expect(heal, 'the realm has minor healing').toBeDefined();
    const rows = new Map(heal!.ab);
    expect(rows.get(18)).toBe(0);
    // Drawn, because a grant is claimed at zero — the row says *what* it does.
    expect(abilityIsClaimed(18, 0, 'item')).toBe(true);
  });

  /*
   * The whole-realm ceiling, across every table rather than items alone.
   *
   * Before format 14 the four other tables showed *nothing* — not a gap the
   * counter could report, because the rows never reached a card. After it, and
   * after `ABILITY_INTERNAL` took the server's message plumbing out of the
   * count, what is left is the same two ids everywhere.
   */
  it('leaves the same handful of ids unread across every table', () => {
    const remaining = new Set<number>();
    for (const which of ['items', 'mobs', 'spells', 'races', 'classes'] as const) {
      let withEffects = 0;
      let withUnread = 0;
      const table = TABLE_OF[which];
      for (const row of shipped(which)) {
        const pairs = (row.ab ?? []).filter(([id]) => !ABILITY_INTERNAL.has(id));
        if ((row.ab ?? []).length === 0) continue;
        withEffects += 1;
        const bad = pairs.filter(([id, value]) => abilityIsUnread(id, value, table));
        if (bad.length > 0) withUnread += 1;
        for (const [id] of bad) remaining.add(id);
      }
      /*
       * A proportion for the big indexes and a plain count for the small ones:
       * `classes` is fifteen rows, so the single `Druid` — whose `ClassOk 74`
       * is deliberately unread, see `abilityShape` — is 6.7% on its own and a
       * percentage says nothing useful about a table that size.
       */
      if (withEffects >= 100) {
        /*
         * Three per cent rather than two, and the extra one per cent is all
         * `NoFirstKillDrop` (1115) on twenty-three of Paradigm's monsters —
         * measured 2026-09-02, when the shipped world moved from GreaterMUD's
         * database to Paradigm's. Raised rather than exempted because the set
         * below is the assertion that actually bites: a *new* id fails there
         * whatever this ratio does, and a ratio nobody can breach is a
         * ceiling that has stopped measuring.
         */
        expect(withUnread / withEffects, `${which} still confessing`).toBeLessThan(0.03);
      } else {
        expect(withUnread, `${which} still confessing`).toBeLessThanOrEqual(1);
      }
    }
    /*
     * Every id the shipped realm states and this client cannot read, in one
     * place. Each is a value the client holds and cannot draw, which is what
     * the counter is for.
     *
     *   119   `Del@Maint`, on the two items that read 646 rather than 0 or 1
     *   137   `ShockMsg`
     *   178   `Shadowform`
     *   1115  `NoFirstKillDrop`, 23 monsters
     *   1117  `NotSellable`, 7 items, always 0
     *   1174  unnamed in `ABILITY` at all, one monster
     *
     * The last three arrived with Paradigm's database (2026-09-02). 1115 and
     * 1174 carry values in the 900–3,900 range on every row — the shape of a
     * *reference* into some table, not the flag their names suggest, and
     * which table is not known. `59` (`ClassOk`) left the list: it was here
     * for GreaterMUD's Druid, and Paradigm's class table reads clean.
     *
     * Guessing a shape for any of them is the one thing that must not happen
     * here: a wrong shape draws a confident sentence about an item somebody
     * decides to buy with, where an unread id draws an honest "1 more".
     */
    expect([...remaining].sort((a, b) => a - b)).toEqual([119, 137, 178, 1115, 1117, 1174]);
  });

  /*
   * The regression for the worst failure this work had.
   *
   * `flag`'s zero-means-no rule was measured on `Items` and left alone when
   * the other four tables were wired in, so `abilityIsClaimed` dropped a row
   * that had been read perfectly well — drawn nowhere and, because it never
   * reached the counter, *confessed* nowhere. **303 spells rendered no effects
   * row at all**, including the spell literally named `freedom` whose only
   * pair is `Freedom 0`; `AntiMagic` vanished from the Witchunter and from 35
   * monsters.
   *
   * The test is the symptom rather than the cause: a row the realm states
   * effects for must say *something* — a fact or an admission — and a card
   * that says neither is the failure whatever caused it.
   */
  it('never renders a row that has effects as though it had none', () => {
    const silent: string[] = [];
    for (const which of ['mobs', 'races', 'classes'] as const) {
      const table = TABLE_OF[which];
      for (const row of shipped(which)) {
        const pairs = (row.ab ?? []).filter(([id]) => !ABILITY_INTERNAL.has(id));
        if ((row.ab ?? []).length === 0 || pairs.length === 0) continue;
        const drawn = pairs.some(
          ([id, value]) =>
            !abilityIsUnread(id, value, table) &&
            abilityName(id, 'greatermud') !== null &&
            abilityIsClaimed(id, value, table)
        );
        const admitted = pairs.some(([id, value]) => abilityIsUnread(id, value, table));
        if (!drawn && !admitted) silent.push(`${which}/${row.n}`);
      }
    }
    /*
     * `sage` is the one allowed silence and it is honest: its only pair is
     * `Freedom 0`, a grant that draws its label. Anything joining it is the
     * bug above coming back.
     */
    expect(silent).toEqual([]);
  });

  /*
   * The two rows the reviewer's measurement named, pinned by name so that a
   * shape change which re-hides them fails here rather than on somebody's
   * screen.
   */
  it('shows the Witchunter its antimagic and the freedom spell its freedom', () => {
    const witchunter = shipped('classes').find((row) => row.n === 'Witchunter');
    expect(witchunter, 'the realm has a Witchunter').toBeDefined();
    // 44 rows realm-wide state `AntiMagic` and not one states a value.
    expect(witchunter!.ab!.some(([id]) => id === 51)).toBe(true);
    expect(abilityIsClaimed(51, 0, 'class')).toBe(true);

    const freedom = shipped('spells').find((row) => row.n === 'freedom');
    expect(freedom!.ab).toEqual([[81, 0]]);
    expect(abilityIsClaimed(81, 0, 'spell')).toBe(true);
  });

  /*
   * The realm's own class references, against the realm's own class table.
   *
   * It used to assert that every one resolves, and on GreaterMUD's database
   * every one did. Paradigm's does not: `lockpicks` restricts to class 23 and
   * Paradigm ships fifteen classes (2026-09-02). That is the realm being
   * inconsistent with itself, not the client misreading it — the Reference
   * card already renders an unresolvable id as `#23` rather than dropping the
   * restriction, deliberately, because an item that looks usable by anyone is
   * the worse lie.
   *
   * So the claim is stated as the exemption it is: one row, named, with the
   * date it was measured. A second one appearing is a realm file worth
   * looking at, and fails here.
   */
  it('names a class the realm does not have exactly once, and it is lockpicks', () => {
    const { classNames } = graph!.lookup('staff-sling');
    const dangling: string[] = [];
    for (const item of shippedItems()) {
      for (const [id, value] of item.ab ?? []) {
        if (ABILITY_SHAPE[id] !== 'class') continue;
        if (classNames[value] === undefined) dangling.push(`${item.n}/${value}`);
      }
    }
    expect(dangling).toEqual(['lockpicks/23']);
  });
});

/**
 * Who the realm lets wear a thing — format 15, against the shipped file.
 *
 * These are claims about the *data* and belong beside the other whole-realm
 * claims for the same reason: a hand-made item cannot say that 247 rows carry
 * a class restriction, and the failure these exist to catch is the restriction
 * columns silently ceasing to be written. That is not hypothetical — they were
 * in every realm database from the beginning and read by nothing until now,
 * which is why the pack offered a `wear` button for an item the realm had
 * already said this class could not have.
 */
describe.runIf(available)('the shipped realm carries its own restrictions', () => {
  it('writes the class allow-lists out', () => {
    const restricted = shippedRestrictions().filter((item) => item.cls !== undefined);
    // 247 of the 1,817 indexed items, measured 2026-08-31 against
    // `gmud20230902`. A floor rather than the exact figure: the assertion is
    // that the column is read at all, and an exact count would fail on a realm
    // rebuild that indexed one item more.
    expect(restricted.length).toBeGreaterThan(200);
    for (const item of restricted) {
      // Row ids in `Classes`, which has fifteen rows. A zero would be the
      // realm's empty slot leaking through as a class nobody is.
      expect(item.cls!.every((id) => id >= 1 && id <= 15)).toBe(true);
    }
  });

  /*
   * The one case there is a transcript for. A Mystic clicked the pack's own
   * button for this and the server answered `You may not wear that item!`;
   * the realm had said so all along, in a column nothing read.
   */
  it('restricts the silver holy amulet to the four holy classes', () => {
    const amulet = shippedRestrictions().find((item) => item.n === 'silver holy amulet');
    expect(amulet?.cls).toEqual([3, 4, 5, 6]);
  });

  /* The positive control from the same transcript, and the reason the list is
     read as an allow-list: this one went on without complaint. */
  it('leaves the silver ring unrestricted', () => {
    const ring = shippedRestrictions().find((item) => item.n === 'silver ring');
    expect(ring?.cls).toBeUndefined();
    expect(ring?.worn).toBeGreaterThan(0);
  });

  it('gives a glass jug no slot at all', () => {
    // `Worn` 0, so it is not kit and the pack draws no control for it.
    const jug = shippedRestrictions().find((item) => item.n === 'glass jug');
    expect(jug?.worn).toBeUndefined();
  });

  it('lifts the level gate out of the effect pairs', () => {
    const gated = shippedRestrictions().filter((item) => item.lvl !== undefined);
    expect(gated.length).toBeGreaterThan(500);
    for (const item of gated) {
      expect(item.lvl).toBeGreaterThan(0);
      /*
       * And it stays in `ab` as well: that array is what the realm said, and
       * the Reference card draws `MinLevel` from there. The field is a second
       * reading of one fact, never a move of it.
       */
      expect(item.ab?.some(([id, value]) => id === 135 && value === item.lvl)).toBe(true);
    }
  });
});

/*
 * Where a spell's numbers actually are — format 16.
 *
 * `way of the owl` is the case that was reported: the card read `M.R. 0`, and
 * it was reading the realm correctly. The 10 is in `MaxBase`, a column nothing
 * wrote out, and the `Abil-n` row holds a genuine zero.
 */
describe.runIf(available)('a spell states its own magnitude', () => {
  const spellOf = (name: string) => graph!.spellNamed(name);

  it('carries the power the ability row does not', () => {
    const owl = spellOf('way of the owl');
    expect(owl?.abilities).toContainEqual([36, 0]);
    expect(owl?.power).toEqual([10, 10]);
  });

  /* Power 0–0, and every number that matters in the growth and the cap. */
  it('carries a growth and a cap for a spell whose power is all scaling', () => {
    const cat = spellOf('way of the cat');
    expect(cat?.power).toBeUndefined();
    expect(cat?.cap).toBe(30);
    expect(cat?.minGrowth).toEqual([2, 1]);
    expect(cat?.maxGrowth).toEqual([2, 1]);
    expect(cat?.durationGrowth).toEqual([1, 1]);
  });

  /* A damage spell states a spread where a buff states one figure twice. */
  it('keeps a spread as a spread', () => {
    expect(spellOf('magic missile')?.power).toEqual([6, 15]);
  });

  /* 167 spells state a negative power, and a debuff drawn as a bonus would be
     the wrong sign on the one number the reader is looking at. */
  it('keeps a negative power negative', () => {
    const negative = shipped('spells').filter(
      (spell) => Array.isArray(spell.pw) && (spell.pw[0] < 0 || spell.pw[1] < 0)
    );
    expect(negative.length).toBeGreaterThan(100);
  });

  /* The claim the reading turns on: the realm genuinely holds these zeros, so
     a card drawing them is not misreading a column — it is drawing the wrong
     one. Measured on the shipped file rather than asserted from memory. */
  it('states a power on most of the realm, so a zero ability row is not the number', () => {
    const spells = shipped('spells');
    const withPower = spells.filter((spell) => spell.pw !== undefined || spell.cap !== undefined);
    expect(withPower.length).toBeGreaterThan(spells.length / 2);
  });

  /*
   * Who a spell may be cast on — format 17, and the column the two heal fields
   * are filtered by.
   *
   * Asserted against the shipped file rather than against the reading, because
   * the failure this guards is the *conversion* silently dropping the column:
   * the client would then classify every spell `unknown`, both pickers would
   * offer everything, and the whole point of splitting the heal in two would be
   * gone with nothing on screen to say so. These four are the realm's own
   * examples of each answer that matters.
   */
  describe('who a spell may be cast on', () => {
    const targetingOf = (name: string, short: string): number | undefined =>
      shipped('spells').find((spell) => spell.n === name && spell.short === short)?.tg;

    it('carries the realm’s targeting for the spells the heal fields sort by', () => {
      // The mystic's self heal: the reason the party field cannot offer it.
      expect(targetingOf('way of the swan', 'swan')).toBe(1);
      // The cleric's, castable on anybody — so both fields offer it.
      expect(targetingOf('minor healing', 'mihe')).toBe(2);
      // Party-wide, and therefore cast bare with no member named.
      expect(targetingOf('healing rain', 'rain')).toBe(13);
      // Offensive, and offered by neither heal field.
      expect(targetingOf('fireball', 'fbal')).toBe(12);
    });

    /* A conversion that dropped the column would leave every row absent, and
       every picker would silently widen back to the whole spell list. */
    it('states it for nearly every spell in the realm', () => {
      const spells = shipped('spells');
      const stated = spells.filter((spell) => spell.tg !== undefined);
      expect(stated.length).toBeGreaterThan(spells.length * 0.9);
    });
  });
});
