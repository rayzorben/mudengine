import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  FOLD_VERSION,
  foldFight,
  foldOutput,
  mergeFolds,
  mergeOutputs,
  summarizeFolds,
  type FightFolds,
  type FightOutputs,
  type FightRecord
} from '../fights';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'fights.ts'), 'utf8');

/** One top-level declaration's text, comments and spacing taken out. */
const declaration = (opening: string): string => {
  const start = SOURCE.indexOf(opening);
  expect(start, opening).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end + 2)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
};

/**
 * What each `FOLD_VERSION` folded with. A saved fold is trusted by its
 * version alone, so a change to the fold code that kept the number would
 * have every segment answer from totals the new code would not make.
 */
const FOLDED_WITH: Readonly<Record<number, string>> = {
  1: '7937e008f3996b5f'
};

describe('the fold version', () => {
  it('moves whenever the fold code does', () => {
    const code = [
      'export interface FightFold {',
      'export function foldFight(',
      'export interface FightOutput {',
      'export function foldOutput('
    ]
      .map(declaration)
      .join('\n');
    const digest = crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
    expect(
      FOLDED_WITH[FOLD_VERSION],
      `the fold code changed: raise FOLD_VERSION and add ${digest} for it`
    ).toBe(digest);
  });
});

describe('merging folds', () => {
  const fight = (over: Partial<FightRecord>): FightRecord =>
    ({
      at: 1,
      ms: 1000,
      mob: 'rat',
      killed: true,
      mine: 10,
      others: 0,
      blows: 2,
      opened: true,
      level: 3,
      ...over
    }) as FightRecord;

  it('adds up to what one fold of every fight says', () => {
    const fights = [
      fight({ at: 5 }),
      fight({ mob: 'orc', ms: null, killed: false }),
      fight({ at: 9, mine: 30, level: 4 }),
      fight({ mob: 'orc', opened: false, at: 2 })
    ];
    const whole: FightFolds = new Map();
    const wholeOut: FightOutputs = new Map();
    for (const each of fights) {
      foldFight(whole, each);
      foldOutput(wholeOut, each);
    }
    const merged: FightFolds = new Map();
    const mergedOut: FightOutputs = new Map();
    for (const half of [fights.slice(0, 2), fights.slice(2)]) {
      const folds: FightFolds = new Map();
      const outputs: FightOutputs = new Map();
      for (const each of half) {
        foldFight(folds, each);
        foldOutput(outputs, each);
      }
      mergeFolds(merged, folds);
      mergeOutputs(mergedOut, outputs);
    }
    expect(merged).toEqual(whole);
    expect(mergedOut).toEqual(wholeOut);
    expect(summarizeFolds([merged], 'rat')).toEqual(summarizeFolds([whole], 'rat'));
  });
});
