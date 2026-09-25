import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { cureGates, holdsMovement } from '../../../shared/spellcraft';
import { WorldGraph } from '../WorldGraph';

/**
 * The Freedom cure (todo 810), on the realm that ships.
 *
 * `Cures.test.ts` proves the decision against rows it writes itself; what a
 * fixture cannot prove is that the rows are *true of the realm*. So this asks
 * the shipped file the questions the cure asks: which spells carry `Freedom`
 * (81), which items cast one, and that the spells that hold are not among
 * them. Skips where the file is absent, like every realm-backed test here.
 */
const file = path.resolve('resources/world/paradigm.jsonl.gz');
const available = fs.existsSync(file);
const graph = available ? WorldGraph.load(file) : null;

describe.skipIf(!available)('the Freedom mark, on the shipped realm', () => {
  it('is on freedom and cure paralysis, both castable on the caster', () => {
    for (const name of ['freedom', 'cure paralysis']) {
      const spell = graph!.spellNamed(name);
      expect(spell, `the shipped realm should name ${name}`).not.toBeNull();
      expect(cureGates([spell!.abilities]).freedom).toBe(true);
      // `friendly`: self or another, so a bare cast lands on the caster.
      expect(spell!.targets).toBe(2);
    }
  });

  /* The other end of the family: what holds is not what frees. */
  it('is not on the spells that hold', () => {
    const hold = graph!.spellNamed('hold person');
    expect(holdsMovement(hold)).toBe(true);
    expect(cureGates([hold!.abilities]).freedom).toBe(false);
  });

  it('offers the three items that cast it for a hold, and not a scroll that teaches it', () => {
    const names = graph!.itemsServing('held').map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining(['diamond-studded ring', 'heavy black boots', 'pine wand'])
    );
    // `LearnSpell` (42), not `CastsSp` (43): reading it teaches `cure paralysis`.
    expect(names).not.toContain('scroll of cure paralysis');
  });
});
