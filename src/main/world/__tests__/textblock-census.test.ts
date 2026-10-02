import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { HAZARD_ABILITY } from '../../../shared/abilities';
import {
  blockUses,
  linesRun,
  readTextblocks,
  roleOf,
  SERVER_LINE,
  stepsRun,
  type TbRole
} from '../navigation/textblock';
import { openRealm } from '../RealmSource';
import { number } from '../values';

/**
 * Every text block in every realm database on this machine, run through the
 * one reader the way the server would reach it. Each step the server can run
 * has a role; what it cannot run is counted, and the count is pinned, so a
 * reader change or a new database that leaves a step unread fails here.
 * Skips where an archive is absent, like every realm-backed test.
 */
const ARCHIVES = {
  'gmud.zip': { verb: 10, arguments: 2 },
  'pmud.zip': { verb: 8, arguments: 1 },
  'majormud-v1.11p.zip': { verb: 8, arguments: 4 }
} as const;

describe.each(Object.entries(ARCHIVES))('the text blocks of %s', (file, unknown) => {
  const archive = path.resolve('mdb', file);
  it.skipIf(!fs.existsSync(archive))('gives every step the server runs a role', () => {
    const source = openRealm(archive);
    const blocks = readTextblocks(source);
    const phrased = [
      ...(source.table('Rooms')?.rows ?? []).map((row) => number(row['CMD'])),
      ...(source.table('Monsters')?.rows ?? []).map((row) => number(row['GreetTXT']))
    ].filter((id): id is number => id !== null && id > 0);
    const steps: number[] = [];
    for (const row of source.table('Spells')?.rows ?? []) {
      for (let slot = 0; slot < 8; slot += 1) {
        const value = number(row[`AbilVal-${slot}`]);
        if (
          number(row[`Abil-${slot}`]) === HAZARD_ABILITY.textBlock &&
          value !== null &&
          value > 0
        ) {
          steps.push(value);
        }
      }
    }
    source.close();

    const uses = blockUses(blocks, { phrased, steps });
    const roles = new Map<TbRole, number>();
    const unrun = { verb: [] as string[], arguments: [] as string[] };
    for (const [id, ways] of uses) {
      for (const use of ways) {
        if (use === 'shown') continue;
        for (const line of linesRun(blocks.get(id)!, use)) {
          for (const step of stepsRun(line, use)) {
            const role = roleOf(step);
            roles.set(role, (roles.get(role) ?? 0) + 1);
            if (step.verb === 'unknown') unrun[step.why].push(`#${id} ${use}: ${step.text}`);
          }
        }
      }
    }
    // Most blocks are reached, and each kind of step is present.
    expect(uses.size / blocks.size).toBeGreaterThan(0.95);
    for (const role of ['gate', 'pays', 'effect', 'flow', 'say'] as const) {
      expect(roles.get(role) ?? 0, role).toBeGreaterThan(0);
    }
    expect(unrun.verb.length, unrun.verb.join('\n')).toBe(unknown.verb);
    expect(unrun.arguments.length, unrun.arguments.join('\n')).toBe(unknown.arguments);
  });
});

/*
 * The verbs and their lines against the server's own reader, where its source
 * is on this machine (`mudengine-world` › *The server's own source is on
 * disk*).
 */
const SERVER_SOURCE =
  '/home/rayben/Dropbox/Ray/Development/GreaterMUD/GreaterMUD/Textblocks/TextBlockPart.cs';

describe('the server’s verbs', () => {
  it.skipIf(!fs.existsSync(SERVER_SOURCE))('are the verbs the reader knows, at their lines', () => {
    const found = new Map<string, number>();
    fs.readFileSync(SERVER_SOURCE, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const match of line.matchAll(/command == "([a-z]+)"/g))
          found.set(match[1]!, index + 1);
      });
    expect(Object.fromEntries(found)).toEqual(SERVER_LINE);
  });
});
