import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { itemHitProcs, itemInvocation } from '../../../shared/items';
import { WorldGraph } from '../WorldGraph';

/**
 * The blessing a carried weapon can be asked for, end to end on the shipped
 * realm.
 *
 * `AutoInvoke.test.ts` proves the decision against a fixture. What a fixture
 * cannot prove is that the fixture is *true of the realm* — and this feature
 * has a long data path behind it: the realm's `Abil-n` slots, the conversion,
 * `UseCount: -1` surviving it (format 25), the shipped file, `WorldGraph`'s
 * reader, and only then the reading. Every one of those was changed for this,
 * and a break in any of them leaves a switch that is on and does nothing.
 *
 * So this loads what actually ships and asks it the question the automation
 * asks. It skips where the file is absent, like every other realm-backed test
 * here.
 */
const file = path.resolve('resources/world/rooms.jsonl.gz');
const available = fs.existsSync(file);
const graph = available ? WorldGraph.load(file) : null;

describe.skipIf(!available)('a weapon that blesses, on the shipped realm', () => {
  /*
   * The item this was reported from. It is the interesting case as well as the
   * reported one, because it carries **both** shapes: a bare `CastsSp` that
   * `use` invokes, and a `PercentSpell`/`CastsSp` pair that is a chance on hit
   * and that no command can trigger.
   */
  it('finds the bless on a shimmering longsword, and not its hit-proc', () => {
    const item = graph!.itemsNamed(['shimmering longsword'])['shimmering longsword'];
    expect(item, 'the shipped realm should index this weapon').toBeDefined();

    const invocation = itemInvocation(item!);
    expect(invocation).not.toBeNull();
    // 114 is `weapon major bless`; 170 is the proc, and must not be offered.
    expect(invocation!.spell).toBe(114);
    expect(invocation!.unlimited).toBe(true);
  });

  /*
   * The spell it casts has to be one the realm can name and can time, because
   * `AutoInvoke` refuses anything without a duration: an item that casts a
   * fireball is not a blessing, and `use`-ing it at nothing spends a command
   * to be refused in the room.
   */
  it('and the spell it casts is a blessing the realm can time', () => {
    const spell = graph!.spellById(114);
    expect(spell).not.toBeNull();
    expect(spell!.name).toBe('weapon major bless');
    expect(spell!.duration).toBeGreaterThan(0);
  });

  /*
   * `UseCount: -1` reaching the client at all is format 25. Before it the
   * column was dropped as "unlimited is not a count", which made *unlimited*
   * and *the realm says nothing* the same absence — and this whole feature
   * turns on telling those apart, because the refusal it makes is *only an
   * unlimited item*.
   */
  it('carries the realm’s unlimited through the conversion', () => {
    const item = graph!.itemsNamed(['shimmering longsword'])['shimmering longsword'];
    expect(item?.uses).toBe(-1);
  });

  /*
   * And the feature is worth having: the shipped realm holds a useful number
   * of these, not one. Asserted as a floor rather than an exact count, so
   * rebuilding from a newer database does not fail a test about behaviour.
   */
  it('is not a feature for one item', () => {
    /*
     * Counted off the file rather than through the graph, which exposes items
     * by *name* — the shape every consumer wants. This is a claim about the
     * shipped data rather than about the class, so it reads the data, exactly
     * as `abilities-realm.test.ts` does and for the reason stated there:
     * widening an API for a test is the wrong direction.
     */
    const body = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const header = JSON.parse(body.slice(0, body.indexOf('\n'))) as {
      items?: Array<{ ab?: Array<[number, number]>; uses?: number }>;
    };
    const found = (header.items ?? []).filter((row) => {
      const invocation = itemInvocation({ abilities: row.ab, uses: row.uses });
      return invocation !== null && invocation.unlimited;
    });
    expect(found.length).toBeGreaterThanOrEqual(20);
  });
});

/**
 * And the other half of the same pair, on the same shipped realm.
 *
 * `Damage.others` was being handed every damage line the server printed with
 * no attacker in it, which for a character alone in a cave meant its own
 * weapon's proc (todo 02). The realm row is the only thing that can attribute
 * such a line, so what it says has to survive the conversion and the shipped
 * file — the same long data path `itemInvocation` needed proving, and a break
 * anywhere in it leaves the blow filed under the rest of the room again.
 */
describe.skipIf(!available)('a weapon that fires on a hit, on the shipped realm', () => {
  it('states the proc on the longsword, with the realm’s own percentage', () => {
    const item = graph!.itemsNamed(['shimmering longsword'])['shimmering longsword'];
    expect(item, 'the shipped realm should index this weapon').toBeDefined();
    expect(itemHitProcs(item!)).toEqual([{ spell: 170, chance: 40 }]);
  });

  /*
   * And the spell it fires is one whose numbers match what the wire carried:
   * `A shining spark strikes fierce cave worm for 3 damage!`, and 1, 2 and 3
   * are every figure the 538 recorded procs of 2026-09-06 printed.
   */
  it('and the spell it fires is the small one the spark line carried', () => {
    const spell = graph!.spellById(170);
    expect(spell).not.toBeNull();
    expect(spell!.power).toEqual([1, 3]);
  });

  /*
   * Worth having for more than one weapon. A floor rather than an exact count,
   * so rebuilding from a newer database does not fail a test about behaviour.
   */
  it('is not a feature for one item', () => {
    const body = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const header = JSON.parse(body.slice(0, body.indexOf('\n'))) as {
      items?: Array<{ ab?: Array<[number, number]> }>;
    };
    const found = (header.items ?? []).filter(
      (row) => itemHitProcs({ abilities: row.ab }).length > 0
    );
    expect(found.length).toBeGreaterThanOrEqual(20);
  });
});
