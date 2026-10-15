import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { DECISION_KINDS, FIELDLESS_SETTINGS, settingsOf } from '../decisionSettings';
import { sourceFiles } from './sources';

/**
 * Every setting a decision reads has a field that names it, so a console
 * line's gear opens something (todo 119), or is listed in
 * `FIELDLESS_SETTINGS` as a line in a file only. Read as source text, as
 * `structure.test.ts` does: a field names its setting as a literal.
 */
const NAMED =
  /\bsetting(?:=\{?|:\s*)['"]((?:automation|connection|profile|server|loop)\.[a-zA-Z.]+|extensions)['"]/g;

function namedSettings(): Set<string> {
  const named = new Set<string>();
  for (const file of sourceFiles('src/renderer/src')) {
    if (file.includes('__tests__')) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(NAMED)) named.add(match[1]!);
  }
  return named;
}

describe('setting fields', () => {
  const named = namedSettings();
  const governing = new Set<string>(DECISION_KINDS.flatMap((kind) => settingsOf(kind)));

  it('draws a field for every setting a decision reads, or lists it as fieldless', () => {
    const missing = [...governing].filter(
      (path) => !named.has(path) && !Object.hasOwn(FIELDLESS_SETTINGS, path)
    );
    expect(missing).toEqual([]);
  });

  it('lists as fieldless only settings no field names', () => {
    expect(Object.keys(FIELDLESS_SETTINGS).filter((path) => named.has(path))).toEqual([]);
  });

  it('names only settings a decision reads', () => {
    expect([...named].filter((path) => !governing.has(path))).toEqual([]);
  });
});
