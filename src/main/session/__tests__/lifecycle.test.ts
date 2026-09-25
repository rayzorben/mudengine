import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { importsOf } from '../../../shared/__tests__/imports';
import { methodBody } from '../../../shared/__tests__/sources';

/**
 * Every module `SessionManager` builds is put down from one list, and this
 * holds the list to the constructor: a module with a `reset()` or a
 * `dispose()` that is on neither the list nor the named exceptions is one
 * that `connect`, `leftTheRealm` or `dispose` forgets without a sound. That
 * happened twice (`Routines` on leaving the realm, 2026-08-31; `Events`'
 * interval never disposed, found by todo 702).
 *
 * Read as source text, as `ipc-wiring.test.ts` does: constructing the class
 * cannot say which fields a method forgot to name.
 */
const MANAGER = 'src/main/session/SessionManager.ts';
const source = fs.readFileSync(path.resolve(MANAGER), 'utf8');
const classBody = source.slice(source.indexOf('export class SessionManager'));

/**
 * Handled by name beside the loop, and why. Each one's `reset` is called by
 * `connect`, and each one's `dispose`, where it has one, by `dispose`.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  tokenizer: 'the line pipeline: put down on connect only, never on leaving the realm',
  feed: 'the line pipeline: put down on connect only, never on leaving the realm',
  paint: 'the line pipeline: put down on connect only, never on leaving the realm',
  classifier: 'the line pipeline: put down on connect only, never on leaving the realm',
  tracker: 'the line pipeline: put down on connect only, never on leaving the realm',
  link: 'the line pipeline: put down on connect only, never on leaving the realm',
  queue: 'the arbiter: cleared on connect and on leaving, which is not a reset',
  publisher:
    'the traces: put down on connect only; leaving the realm keeps them, which is when they are read',
  statlineReport:
    'what `pro` said, said once a connection: put down on connect only, as it always was',
  loops: 'carried across a same-realm reconnect; stopped before it is reset on leaving',
  login: 'never reset on leaving the realm: the menu it lands at has been logged in to',
  realmMenu: 'never reset on leaving the realm: the menu it lands at said what it said'
};

/** A method's body inside the class, from its declaration to its closing brace. */
const body = (declaration: RegExp): string => methodBody(classBody, declaration, MANAGER);

interface Built {
  field: string;
  cls: string;
  resets: boolean;
  disposes: boolean;
  configures: boolean;
}

/**
 * Every field the manager builds with `new` from a class it imports, and what
 * that class offers. A class imported from somewhere that is not a file here
 * fails rather than being skipped: a skip is how a module leaves the list
 * without a sound.
 */
const built = (): Built[] => {
  const files = new Map(
    importsOf(MANAGER).flatMap((imp) => imp.bindings.map(({ as }) => [as, imp.target] as const))
  );
  const pairs = [
    ...source.matchAll(/this\.(?<field>\w+)\s*=\s*new\s+(?<cls>[A-Z]\w*)\s*[(<]/g),
    ...source.matchAll(
      /^\s+(?:(?:private|public|protected|readonly)\s+)*(?<field>\w+)(?:\s*:\s*[^=;\n]+)?\s*=\s*new\s+(?<cls>[A-Z]\w*)\s*[(<]/gm
    )
  ].map((m) => ({ field: m.groups?.field ?? '', cls: m.groups?.cls ?? '' }));
  return pairs.flatMap(({ field, cls }) => {
    const file = files.get(cls);
    if (file === undefined) return []; // not imported: a global (`Map`, `Set`) or local
    if (!file.endsWith('.ts') || !fs.existsSync(file)) {
      throw new Error(`this.${field} = new ${cls}: imported from ${file}, not a file here`);
    }
    const text = fs.readFileSync(file, 'utf8');
    return [
      {
        field,
        cls,
        resets: /^\s+reset\(\): void/m.test(text),
        disposes: /^\s+dispose\(\): void/m.test(text),
        // `RuleEngine`'s reload is `load`.
        configures: /^\s+(?:configure|load)\(/m.test(text)
      }
    ];
  });
};

/** The list's rows, in order, and whether each carries its own reload. */
const rows = (): Array<{ field: string; reloads: boolean }> => {
  const start = source.indexOf('this.modules = [');
  const end = source.indexOf('\n    ];', start);
  expect(start, 'no `this.modules = [` in the constructor').toBeGreaterThan(0);
  const list = source.slice(start, end);
  const heads = [...list.matchAll(/module: this\.(?<field>\w+)/g)];
  return heads.map((m, i) => ({
    field: m.groups?.field ?? '',
    reloads: list.slice(m.index, heads[i + 1]?.index ?? list.length).includes('configure:')
  }));
};
const listed = (): string[] => rows().map((row) => row.field);

const connect = body(/^ {2}async connect\(/);
const leftTheRealm = body(/^ {2}private leftTheRealm\(/);
const configure = body(/^ {2}configure\(/);
const dispose = body(/^ {2}dispose\(\): void/);
const byHand = (text: string, field: string, verb: string): boolean =>
  new RegExp(`this\\.${field}\\.${verb}\\(`).test(text);

describe('the session puts its modules down from one list', () => {
  it('finds the modules it rules on, so a pass means something', () => {
    const fields = built().map((b) => b.field);
    expect(fields).toContain('events');
    expect(fields).toContain('walker');
    expect(listed()).toContain('events');
    expect(listed().length).toBeGreaterThan(25);
  });

  it('lists every module with a reset or a dispose, or names why not', () => {
    const onList = new Set(listed());
    const missing = built()
      .filter((b) => (b.resets || b.disposes) && !onList.has(b.field) && !(b.field in EXCEPTIONS))
      .map((b) => `this.${b.field} (${b.cls})`);
    expect(missing, `on neither the list nor the exceptions: ${missing.join(', ')}`).toEqual([]);
  });

  it('walks the list on connect, on leaving the realm, on a reload and on dispose', () => {
    for (const [name, text] of [
      ['connect', connect],
      ['leftTheRealm', leftTheRealm],
      ['configure', configure],
      ['dispose', dispose]
    ] as const) {
      expect(text, `${name} does not walk this.modules`).toMatch(/ of this\.modules\)/);
    }
  });

  it('never names a listed module by hand where the list is walked', () => {
    const doubled = listed().flatMap((field) =>
      [
        ['connect', connect, 'reset'],
        ['leftTheRealm', leftTheRealm, 'reset'],
        ['dispose', dispose, 'dispose']
      ]
        .filter(([, text, verb]) => byHand(text ?? '', field, verb ?? ''))
        .map(([name]) => `${name} calls this.${field} by hand`)
    );
    expect(doubled, doubled.join('\n')).toEqual([]);
  });

  it('reloads every listed module that takes a reload, once', () => {
    const byField = new Map(built().map((b) => [b.field, b]));
    const wrong = rows().flatMap(({ field, reloads }) => {
      const hand = byHand(configure, field, 'configure') || byHand(configure, field, 'load');
      if (byField.get(field)?.configures !== true) return [];
      if (reloads && hand) return [`${field}: reloaded on its row and by hand`];
      if (!reloads && !hand) return [`${field}: takes a reload and is never given one`];
      return [];
    });
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('puts the walker down before the quest run, whose reset stops a live walk', () => {
    expect(listed().indexOf('walker')).toBeLessThan(listed().indexOf('questRunner'));
  });

  /*
   * A module's reset may stop a walk or let an errand go, and what that sets
   * off (a walk home cut short re-arming the retreat, a plan made on the
   * refused edges) belongs to the character that was, so the travel and the
   * errands are put down after every module, as their fields were before
   * they were on the list.
   */
  it('puts the travel and the errands down last', () => {
    expect(listed().slice(-2)).toEqual(['travel', 'errands']);
  });

  it('puts every exception down by name', () => {
    const byField = new Map(built().map((b) => [b.field, b]));
    const forgotten = Object.keys(EXCEPTIONS).flatMap((field) => {
      const b = byField.get(field);
      if (b === undefined) return [`${field}: named as an exception but not built`];
      return [
        ...(b.resets && !byHand(connect, field, 'reset')
          ? [`${field}: never reset on connect`]
          : []),
        ...(b.disposes && !byHand(dispose, field, 'dispose') ? [`${field}: never disposed`] : [])
      ];
    });
    expect(forgotten, forgotten.join('\n')).toEqual([]);
  });
});
