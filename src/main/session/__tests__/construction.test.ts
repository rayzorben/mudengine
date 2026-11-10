import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';

import { filesUnder, repoPath } from '../../../shared/__tests__/sources';

/**
 * `SessionManager` is handed its sink and one `SessionDeps`, never a position.
 * The probes under `scripts/` are `.mjs` that nothing typechecks, so a
 * reordered or inserted parameter broke them silently until one ran against
 * the realm; this is their one guard (`mudengine-session` › *A session is
 * handed its ports by name*). A probe builds one through `probeSession`
 * (`scripts/lib/probe-session.mjs`), which passes its deps on, so a call to it
 * is a site too.
 *
 * Read as source text through the compiler, which parses `.mjs` as JavaScript.
 */
const CODE = /\.(?:[cm]?[jt]s|tsx)$/;

interface Site {
  readonly at: string;
  readonly args: number;
  /** Whether the second argument, where there is one, is written as an object literal. */
  readonly depsLiteral: boolean;
}

/** Whether a node builds a session: `new SessionManager(...)`, or a probe's `probeSession(...)`. */
const buildsSession = (node: ts.Node): node is ts.NewExpression | ts.CallExpression =>
  (ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'SessionManager') ||
  (ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'probeSession');

/** Every session built under a directory, where it is and what it passes. */
const sitesUnder = (dir: string): Site[] =>
  filesUnder(dir, CODE).flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('SessionManager') && !text.includes('probeSession')) return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: Site[] = [];
    const visit = (node: ts.Node): void => {
      if (buildsSession(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        const deps = node.arguments?.[1];
        found.push({
          at: `${repoPath(file)}:${line + 1}`,
          args: node.arguments?.length ?? 0,
          depsLiteral: deps === undefined || ts.isObjectLiteralExpression(deps)
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });

describe('every session is built from a sink and one deps object', () => {
  const sites = [...sitesUnder('src'), ...sitesUnder('scripts')];

  it('finds the call sites it rules on, the probes among them, so a pass means something', () => {
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.some((site) => site.at.startsWith('scripts/'))).toBe(true);
    expect(sites.some((site) => site.args === 2)).toBe(true);
    // And one whose deps is not a literal (the test file's `build` helper passes it through).
    expect(sites.some((site) => !site.depsLiteral)).toBe(true);
  });

  it('passes at most two arguments at every one', () => {
    const positional = sites
      .filter((site) => site.args > 2)
      .map((site) => `${site.at}: ${site.args} arguments`);
    expect(positional, positional.join('\n')).toEqual([]);
  });

  /*
   * The mistake two arguments still allow in a file nothing typechecks:
   * `new SessionManager(sink, world)`, the old second position, read as a
   * deps object with no world, the default automation and the default login.
   */
  it('writes the deps as an object literal in every probe', () => {
    const bare = sites
      .filter((site) => site.at.startsWith('scripts/') && !site.depsLiteral)
      .map((site) => `${site.at}: deps is not an object literal`);
    expect(bare, bare.join('\n')).toEqual([]);
  });
});

/*
 * With automation off the login stops at the realm's menu, so a player is never
 * left in the realm unattended (`98af3b22`). A probe is watched, and its login
 * goes on in (todo 20261105-1600-01); the switch must stay out of a player's reach.
 */
describe('only a probe enters the realm with automation off', () => {
  const SWITCH = 'entersRealmWithAutomationOff';
  const shipped = new Set(['__tests__']);
  const naming = [...filesUnder('src', CODE, shipped), ...filesUnder('scripts', CODE, shipped)]
    .filter((file) => fs.readFileSync(file, 'utf8').includes(SWITCH))
    .map(repoPath)
    .sort();

  it('is named only where it is declared and where the probes turn it on', () => {
    expect(naming).toEqual(['scripts/lib/probe-session.mjs', 'src/main/session/SessionManager.ts']);
  });
});
