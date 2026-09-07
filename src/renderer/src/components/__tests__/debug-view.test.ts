import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DebugKind } from '@shared/debug';

/**
 * The third half of a closed union, which is the one a compiler cannot see.
 *
 * `DebugKind` is stated in `src/shared/debug.ts`; `KIND_LABEL` and `KIND_ORDER`
 * in `DebugView.tsx` are `Record<DebugKind, …>`, so those two are type-enforced
 * and the chip row is derived from them. The **hues** are in the stylesheet,
 * where nothing checks anything — so a ninth kind would compile, get a chip and
 * a label, and be drawn with no colour at all: a stage of the pipeline that
 * cannot be found by the eye and whose chip looks broken.
 *
 * That is `guard-fields.test.ts`'s shape, and it is written the same way: each
 * half is read out of its own source rather than restated here, because a test
 * that lists the kinds itself is a fourth half to keep in step.
 */
/** The repository root, so each half is named by the path a reader would use. */
const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

/** The union, off its own declaration. */
function declaredKinds(): string[] {
  const source = read('src/shared/debug.ts');
  const declaration = /export type DebugKind =([^;]+);/.exec(source);
  if (!declaration) throw new Error('DebugKind is not declared the way this test reads it');
  return [...declaration[1]!.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!).sort();
}

/** The hues, off the stylesheet's own rules. */
function styledKinds(): string[] {
  const css = read('src/renderer/src/styles/index.css');
  const rules = [...css.matchAll(/\.debug-kind\[data-kind='([a-z]+)']/g)].map((m) => m[1]!);
  return [...new Set(rules)].sort();
}

/** The order the chip row is drawn in, off the record that enforces it. */
function orderedKinds(): string[] {
  const source = read('src/renderer/src/components/DebugView.tsx');
  const block = /const KIND_ORDER: Record<DebugKind, number> = \{([^}]+)\}/.exec(source);
  if (!block) throw new Error('KIND_ORDER is not declared the way this test reads it');
  return [...block[1]!.matchAll(/^\s*([a-z]+):/gm)].map((match) => match[1]!).sort();
}

describe('every kind of debug record can be seen and muted', () => {
  it('is stated in the stylesheet as well as in the type', () => {
    // The positive control: a regex that matched nothing would make both sides
    // empty and equal, and prove nothing at all.
    expect(declaredKinds().length).toBeGreaterThan(4);
    expect(styledKinds()).toEqual(declaredKinds());
  });

  it('and has a place in the row, so it is drawn at all', () => {
    expect(orderedKinds()).toEqual(declaredKinds());
  });

  /*
   * A compile-time assertion of the half a compiler *can* see, kept beside the
   * two it cannot: a kind added to the union with no entry here fails to build
   * rather than failing this test with a worse message.
   */
  it('is exhaustive at the type level too', () => {
    const seen: Record<DebugKind, true> = {
      in: true,
      out: true,
      line: true,
      block: true,
      state: true,
      event: true,
      link: true,
      notice: true
    };
    expect(Object.keys(seen).sort()).toEqual(declaredKinds());
  });
});
