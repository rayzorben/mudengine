import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import ts from 'typescript';

import { DEFAULT_INTERNAL, normalizeInternal, pinnedMatches } from '../internal';

/*
 * The shipped `internal.yaml` and `DEFAULT_INTERNAL` are the two halves of one
 * closed pair: a first run copies the template, and everything that never had
 * a file -- the unit suite included -- runs on the constant. They drifted once
 * (2026-08-28): the template said `quiet.enabled: false` while the constant
 * said `true`, so a `SessionManager` test withheld the entry probe's `rm` and
 * the smoke run, on a fresh home, watched the console show it. Two checks
 * failed on a clean tree for a day with nothing in the diff to blame.
 */
describe('the shipped internal.yaml', () => {
  it('says exactly what DEFAULT_INTERNAL says', () => {
    const text = fs.readFileSync(path.resolve('resources/config/internal.yaml'), 'utf8');
    expect(normalizeInternal(YAML.parse(text))).toEqual(DEFAULT_INTERNAL);
  });

  /*
   * And *states* every one of them, which the assertion above cannot see.
   *
   * An absent key normalises to its default, so a number added to the constant
   * and forgotten in the template passes that test exactly — and this file is
   * the one somebody edits when a timeout is too short for their link. Both
   * keys added on 2026-09-02 (`rest.askedMs`, `session.reconsiderMs`) were
   * missed that way. The same gap `template.test.ts` covers for the options
   * file, at the grain this file needs: every leaf, not every block.
   */
  it('states every tuning key, not merely enough of them to normalise', () => {
    const text = fs.readFileSync(path.resolve('resources/config/internal.yaml'), 'utf8');
    const stated = YAML.parse(text) as Record<string, unknown>;

    const leaves = (value: unknown, at: string[] = []): string[] =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, [...at, key]))
        : [at.join('.')];

    const has = (path: string[]): boolean => {
      let node: unknown = stated['tuning'];
      for (const key of path) {
        if (node === null || typeof node !== 'object') return false;
        if (!(key in (node as Record<string, unknown>))) return false;
        node = (node as Record<string, unknown>)[key];
      }
      return true;
    };

    const missing = leaves(DEFAULT_INTERNAL.tuning).filter((key) => !has(key.split('.')));
    expect(missing).toEqual([]);
  });
});

describe('the pinned palette', () => {
  it('reads a stated block whole, replacing the default', () => {
    const config = normalizeInternal({
      palette: { pinned: { navigate: ['route', 'loop:*'] } }
    });
    // A curation replaces: merging a curation with a default is nobody's list.
    expect(config.palette.pinned).toEqual({ navigate: ['route', 'loop:*'] });
  });

  it('falls back to the default when nothing is stated, or nonsense is', () => {
    expect(normalizeInternal({}).palette.pinned).toEqual(DEFAULT_INTERNAL.palette.pinned);
    expect(normalizeInternal({ palette: { pinned: 'nope' } }).palette.pinned).toEqual(
      DEFAULT_INTERNAL.palette.pinned
    );
  });

  it('drops what is not a pattern and keeps the group', () => {
    const config = normalizeInternal({
      palette: { pinned: { Layout: ['  pane:* ', 7, ''] } }
    });
    expect(config.palette.pinned).toEqual({ layout: ['pane:*'] });
  });
});

describe('what a pattern names', () => {
  it('matches exactly, or by prefix with a trailing star', () => {
    expect(pinnedMatches('route', 'route')).toBe(true);
    expect(pinnedMatches('route', 'router')).toBe(false);
    expect(pinnedMatches('loop:*', 'loop:Sewer loop')).toBe(true);
    expect(pinnedMatches('loop:*', 'loop:stop')).toBe(true);
    expect(pinnedMatches('pane:*', 'panel')).toBe(false);
  });
});

/*
 * The tuning block: every number the client uses to decide something.
 *
 * The rule it exists for is that no such value is written into the code that
 * acts on it — a timeout too short for somebody's link used to be a code
 * change. The coercion **walks the defaults** rather than naming keys, which is
 * what stops the half that validates falling behind the half that declares; the
 * cases below are about the rules that walk applies, not about any one key.
 */
describe('the tuning block', () => {
  it('takes a number the file states, in its place', () => {
    const config = normalizeInternal({ tuning: { net: { connectTimeoutMs: 4000 } } });
    expect(config.tuning.net.connectTimeoutMs).toBe(4000);
    // And leaves everything beside it alone: this is a map, not a curation, so
    // it merges where the palette's list replaces.
    expect(config.tuning.net.nawsCoalesceMs).toBe(DEFAULT_INTERNAL.tuning.net.nawsCoalesceMs);
    expect(config.tuning.walk).toEqual(DEFAULT_INTERNAL.tuning.walk);
  });

  it('falls back for anything missing or unreadable', () => {
    expect(normalizeInternal({}).tuning).toEqual(DEFAULT_INTERNAL.tuning);
    expect(normalizeInternal({ tuning: 'nope' }).tuning).toEqual(DEFAULT_INTERNAL.tuning);
    expect(
      normalizeInternal({ tuning: { walk: { maxHolds: 'three' } } }).tuning.walk.maxHolds
    ).toBe(DEFAULT_INTERNAL.tuning.walk.maxHolds);
  });

  /* A zero-millisecond timer spins a core, and this is a file edited by hand. */
  it('floors a duration at one millisecond', () => {
    expect(
      normalizeInternal({ tuning: { files: { pollIntervalMs: 0 } } }).tuning.files.pollIntervalMs
    ).toBe(1);
    expect(
      normalizeInternal({ tuning: { files: { pollIntervalMs: -50 } } }).tuning.files.pollIntervalMs
    ).toBe(1);
  });

  /*
   * Except the one the template says 0 switches off. Floored, it became a
   * one-millisecond deadline, and a client told to stop hanging up on a silent
   * link hung up on every connection a millisecond after its first command.
   */
  it('keeps zero where zero means off', () => {
    expect(
      normalizeInternal({ tuning: { reconnect: { silentForMs: 0 } } }).tuning.reconnect.silentForMs
    ).toBe(0);
    expect(
      normalizeInternal({ tuning: { reconnect: { silentForMs: -5 } } }).tuning.reconnect.silentForMs
    ).toBe(0);
  });

  /* A count may be zero — "no holds", "nothing quiet" — and is a whole number. */
  it('lets a count be zero, and rounds one that is not whole', () => {
    expect(normalizeInternal({ tuning: { walk: { maxHolds: 0 } } }).tuning.walk.maxHolds).toBe(0);
    expect(normalizeInternal({ tuning: { walk: { maxHolds: 2.6 } } }).tuning.walk.maxHolds).toBe(3);
  });

  /* A fractional default means a fraction: a confidence, a threshold, a tolerance. */
  it('keeps a fraction fractional and clamps it to 0–1', () => {
    expect(
      normalizeInternal({ tuning: { parse: { baseConfidence: 0.55 } } }).tuning.parse.baseConfidence
    ).toBe(0.55);
    expect(
      normalizeInternal({ tuning: { parse: { baseConfidence: 9 } } }).tuning.parse.baseConfidence
    ).toBe(1);
    expect(
      normalizeInternal({ tuning: { parse: { baseConfidence: -1 } } }).tuning.parse.baseConfidence
    ).toBe(0);
  });

  /*
   * A key this client has never heard of is ignored rather than carried. The
   * shape is the defaults', so a typo is a value that does not apply — visible
   * as "my edit did nothing" — rather than a key nothing validates.
   */
  it('ignores a group and a key it does not know', () => {
    const config = normalizeInternal({
      tuning: { walk: { maxHolds: 9, maxHoldz: 1 }, somewhereElse: { thing: 1 } }
    });
    expect(config.tuning.walk.maxHolds).toBe(9);
    expect(config.tuning).not.toHaveProperty('somewhereElse');
    expect(config.tuning.walk).not.toHaveProperty('maxHoldz');
  });

  /*
   * And every number in it is read by something.
   *
   * A value nobody reads is a value the client does not have — the rule this
   * project states for facts, applied to the block that exists so a number can
   * be changed without a code change. A key here that nothing looks up is a
   * setting somebody will edit and then wait to see work.
   */
  it('has a reader for every key', () => {
    const sources = ['src/main', 'src/renderer', 'src/shared']
      .flatMap((dir) => walk(path.resolve(dir)))
      .filter((file) => /\.tsx?$/.test(file) && !file.includes('__tests__'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    const unread: string[] = [];
    for (const [group, fields] of Object.entries(DEFAULT_INTERNAL.tuning)) {
      // Main reads `tuning().<group>.<key>`; the renderer's accessor is already
      // narrowed to `view`, so it reads `tuning().<key>`.
      const suffix = group === 'view' ? '' : `.${group}`;
      // A hot path reads the block once and destructures it, which is the same
      // read spelled shorter — `{ popoverGap: gap } = tuning()`.
      const taken = new Set(
        [...sources.matchAll(new RegExp(`\\{([^{}]*)\\} = tuning\\(\\)${suffix};`, 'g'))].flatMap(
          (match) => (match[1] ?? '').split(',').map((name) => name.split(':')[0]!.trim())
        )
      );
      for (const key of Object.keys(fields)) {
        if (sources.includes(`tuning()${suffix}.${key}`) || taken.has(key)) continue;
        unread.push(`${group}.${key}`);
      }
    }
    expect(unread).toEqual([]);
  });

  /*
   * And the number a timer runs on is one of them.
   *
   * `setInterval` is the polling primitive, and a period typed at the call is
   * exactly the constant this block exists to keep out of the code that acts
   * on it. Every period in the tree is a *name* — `tuning()`, or the player's
   * own configuration (a rule's `every`, a routine's idle threshold) — and
   * this holds it by walking the calls rather than counting them: a cap of ten
   * was proposed (2026-09-11, todo 01) and declined, because a count cannot
   * tell a clock from a poll, and a poll on a named period is one somebody can
   * tune. Tests are exempt; a fake host may tick however it likes.
   */
  it('names every interval period, never a bare number', () => {
    // The detector on a snippet it must and must not flag: the positive
    // control an empty list of offenders needs before it can mean anything.
    const probe = ts.createSourceFile(
      'probe.ts',
      [
        'setInterval(f, 1000);',
        'window.setInterval(f, 60 * 1000);',
        'setInterval(f, tuning().files.pollIntervalMs);',
        'setInterval(f, every);'
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true
    );
    expect(barePeriods(probe)).toEqual([1, 2]);

    const offenders: string[] = [];
    const files = walk(path.resolve('src')).filter(
      (file) => /\.tsx?$/.test(file) && !file.includes('__tests__') && !/\.test\.tsx?$/.test(file)
    );
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      // A file without the word has no call to walk.
      if (!text.includes('setInterval')) continue;
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      for (const line of barePeriods(source)) {
        offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** The line of every `setInterval` in a file whose period is literals through and through. */
function barePeriods(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeOf(node) === 'setInterval') {
      const period = node.arguments[1];
      if (period === undefined || !namesSomething(period)) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/** What a call is a call to: `setInterval(...)` and `window.setInterval(...)` alike. */
function calleeOf(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Whether an expression names anything — a call, a field, a variable — or is literals through and through. */
function namesSomething(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return true;
  return ts.forEachChild(node, namesSomething) === true;
}
