import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Gear card's foot (the spend and *Plan the trip*, or *Run it* and *Walk
 * it*) is a sibling of the scrolling tiles and shrinks for nothing, the
 * Hunting card's rule for its buttons (`hunt-actions.test.ts`): a short card
 * clips what will not fit, and what must not be clipped is the press.
 */
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe("the gear card's foot", () => {
  it('is drawn after the scroller on both faces, never inside it', () => {
    for (const file of ['GearCard.tsx', 'GearTripFace.tsx']) {
      const source = read(`src/renderer/src/components/${file}`);
      const scroller = source.indexOf('className="scroller gear-scroller"');
      const bar = source.indexOf('className="gear-bar"');
      expect(scroller, file).toBeGreaterThan(-1);
      expect(bar, file).toBeGreaterThan(scroller);
    }
  });

  it('shrinks for nothing, whatever height the card is at', () => {
    const css = read('src/renderer/src/styles/index.css');
    const rule = css.slice(css.indexOf('.gear-bar {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('flex: 0 0 auto');
  });
});
