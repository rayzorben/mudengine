import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The three things that can be done with a lair, drawn at every card height.
 *
 * *Walk there*, *Loop it* and *Create loop* sat at the bottom of the opened
 * spot's detail, which is as long as the lair's room list. The Hunting card's
 * body is `paned` and clips what will not fit (`.card > .body.paned` sets
 * `overflow: hidden`), and what did not fit was the row of controls — so a
 * spot opened on a short card, or a card resized down, drew a lair nobody
 * could act on (todo 01, 2026-09-14, reported as *"i want these buttons to
 * always show on a resize"*).
 *
 * Two halves hold it and they are in two files, which is the shape
 * `pressed-chips.test.ts` guards: the **row is a sibling of the scrolling
 * detail** rather than its last child, and the **stylesheet makes it shrink
 * for nothing**. Either half alone puts the buttons back under the clip — a
 * sibling that may shrink is squeezed to nothing, and a `flex: 0 0 auto` row
 * inside a scroller scrolls away with it — so both are read out of the sources
 * rather than restated here.
 */
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe("the hunting card's three buttons", () => {
  const source = read('src/renderer/src/components/HuntingCard.tsx');

  /*
   * The positive control for both assertions below: the row exists and is
   * drawn by a component of its own. A renamed class would otherwise leave
   * every regex here matching nothing and passing on the emptiness.
   */
  it('is a row of its own, beside the detail rather than inside it', () => {
    expect(source).toContain('function SpotActions(');
    expect(source).toContain('<div className="loop-controls hunt-actions">');
    // Inside `SpotDetail` the row would scroll away with the figures. The
    // detail's own element closes before the actions component is declared.
    const detail = source.slice(
      source.indexOf('function SpotDetail('),
      source.indexOf('function SpotActions(')
    );
    expect(detail).not.toContain('hunt-actions');
  });

  /* And the detail is the moving part, by the card's own rule for one. */
  it('scrolls the figures above it and not the buttons', () => {
    expect(source).toContain('<div className="scroller hunt-detail">');
  });

  it('shrinks for nothing, whatever height the card is at', () => {
    const css = read('src/renderer/src/styles/index.css');
    const rule = css.slice(css.indexOf('.hunt-actions {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('flex: 0 0 auto');
  });
});
