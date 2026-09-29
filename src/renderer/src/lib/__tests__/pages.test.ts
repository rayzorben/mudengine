import { describe, expect, it } from 'vitest';

import { edgeOf, onePage, widened } from '../pages';

describe('the console page', () => {
  it('reads the live edge, the oldest line held, and neither', () => {
    expect(edgeOf(500, 500)).toBe('latest');
    // Nothing above the screen yet: the live edge, not the top.
    expect(edgeOf(0, 0)).toBe('latest');
    expect(edgeOf(0, 500)).toBe('top');
    expect(edgeOf(120, 500)).toBe('between');
  });

  it('widens by a page and never past what main keeps', () => {
    expect(widened(10_000, 10_000, 100_000)).toBe(20_000);
    expect(widened(95_000, 10_000, 100_000)).toBe(100_000);
  });

  it('holds one page at the live edge, or everything main keeps when that is less', () => {
    expect(onePage(10_000, 100_000)).toBe(10_000);
    expect(onePage(10_000, 2_000)).toBe(2_000);
    expect(onePage(10_000, 0)).toBe(0);
  });
});
