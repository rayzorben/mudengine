import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { sourceFiles as sources } from './sources';

/**
 * A pattern built at runtime is compiled at runtime — every time the line
 * that builds it runs.
 *
 * A regex literal is compiled once by the engine wherever it is written; a
 * `new RegExp(string)` is parsed and compiled on each evaluation, which in a
 * per-line path is a cost paid for every line the server prints. Measured
 * 2026-09-04 (todo 01): 287ns a call against 32ns for a hoisted literal. So
 * the rule is that a runtime-built pattern is built **once, at module load**,
 * and each one is listed here with the reason it has to be built from a
 * string at all. A new one fails this test until it is argued for — the
 * exemption shape `vocabulary.test.ts` already uses for an unread block type.
 */
const BUILT_ONCE: Record<string, { count: number; because: string }> = {
  'src/main/parse/patterns.ts': {
    count: 1,
    because:
      'the room-light alternation is built from `ROOM_LIGHTS` so the union the tracker ' +
      'branches on and the pattern that produces it cannot drift; module-level, in `RULES`'
  },
  'src/shared/statline.ts': {
    count: 1,
    because:
      'the exact status-line matcher is generated from the template `pro` reports, which ' +
      'is only known at runtime; built once per report in `statlineMatcher`, held by ' +
      '`StatusLine` (`parse/sheet.ts`), and never called in a per-line path'
  },
  'src/shared/messages.ts': {
    count: 1,
    because:
      "the server's message table is data — 3,979 rows of three templates (`%s`, `%d`) — " +
      'so each is compiled once when the shipped table is read (`MessageBook.add`) and held; ' +
      'the per-line path runs only the compiled ones a word index selects (todo 109)'
  },
  'src/main/app/copyMatch.ts': {
    count: 1,
    because:
      'the UI copy as a pattern, for tests and harnesses only: nothing the app ships imports ' +
      'it, and each pattern is built from a dictionary string known only when it is read'
  },
  'src/shared/template.ts': {
    count: 2,
    because:
      'user-authored templates may specify regex patterns for grouping and filtering ' +
      '({group ...}, `=~`), which are user input unknown at compile time; compiled on demand ' +
      'and cached by string in `compileRegex`'
  }
};

describe('runtime-built regular expressions', () => {
  it('are built once, at module load, and each is listed with its reason', () => {
    const root = path.resolve('src');
    const found: Record<string, number> = {};
    for (const file of sources(root)) {
      const text = fs.readFileSync(file, 'utf8');
      const count = text.match(/\bnew RegExp\(/g)?.length ?? 0;
      if (count > 0) found[path.relative(process.cwd(), file)] = count;
    }
    const expected = Object.fromEntries(
      Object.entries(BUILT_ONCE).map(([file, { count }]) => [file, count])
    );
    expect(found).toEqual(expected);
  });

  /*
   * The listed one really is module-level: the line that builds it sits inside
   * the `RULES` table literal, not inside a function body. Read off the source
   * rather than asserted by hand, so moving it into a function would fail here.
   */
  it('the listed pattern is built inside the RULES table, not a function', () => {
    const text = fs.readFileSync(path.resolve('src/main/parse/patterns.ts'), 'utf8');
    const at = text.indexOf('new RegExp(');
    const before = text.slice(0, at);
    const rulesAt = before.lastIndexOf('export const RULES');
    const nextTopLevel = before.lastIndexOf('\nexport ');
    expect(rulesAt).toBeGreaterThan(-1);
    expect(nextTopLevel + 1).toBe(rulesAt);
  });
});
