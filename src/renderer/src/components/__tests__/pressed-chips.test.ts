import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A toggle that never says which way it is held.
 *
 * The two coin rows in the loot settings — *Coins to Collect* and *Coins to
 * Discard* — are buttons carrying `aria-pressed` and a constant `className`,
 * and the stylesheet had no rule that read either one. All five coins ship
 * collected, so the row drew five identical chips whether or not a coin was on,
 * and pressing one looked exactly like pressing nothing (todo 01, 2026-09-12,
 * reported as *"clicking on these coins does nothing"*). It had been toggling
 * correctly the whole time.
 *
 * That is the shape `debug-view.test.ts` guards for the pipeline chips: the
 * **hues live in the stylesheet, where nothing checks anything**, so a control
 * can compile, render, work and still be invisible. Every other pressed control
 * in the client varies a class or a `data-` attribute with the same boolean, or
 * sits inside an ancestor that does — these two are the pair whose only
 * statement of state is `aria-pressed`, so the rule is keyed on that, and this
 * asserts the two halves are still in step.
 *
 * Read out of the two sources rather than restated here, for the reason that
 * test gives: a copy of either half is a third half to keep in step.
 */
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('a chip that is a control says which way it is held', () => {
  it('draws its pressed state from the stylesheet', () => {
    const css = read('src/renderer/src/styles/index.css');
    expect(css).toMatch(/\.chip\.pick\[aria-pressed='true']\s*\{/);
  });

  it('and the coin rows are drawn by that rule', () => {
    const source = read('src/renderer/src/components/CarrySections.tsx');
    const pressed = [...source.matchAll(/aria-pressed=\{on\}\s*\n\s*className="([^"]+)"/g)].map(
      (match) => match[1]!
    );
    /*
     * The positive control: a regex that matched nothing would leave the list
     * empty and `every` would pass on it. Two rows, collect and discard.
     */
    expect(pressed).toHaveLength(2);
    expect(pressed.every((names) => names.split(/\s+/).includes('pick'))).toBe(true);
  });
});
