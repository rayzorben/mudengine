import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config';
import {
  DECISION_KINDS,
  DECISION_SETTINGS,
  settingsOf,
  type DecisionSettings
} from '../decisionSettings';

/** The value at a dotted path in the shipped options, or undefined. */
function at(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      DEFAULT_CONFIG
    );
}

const rows: ReadonlyArray<[string, DecisionSettings]> = Object.entries(DECISION_SETTINGS);

describe('every automated decision has a setting (todo 118)', () => {
  it('names at least one setting for each decision, or the date it was found to have none', () => {
    const bare = rows
      .filter(([, row]) => !('awaiting' in row) && row.length === 0)
      .map(([kind]) => kind);
    expect(bare).toEqual([]);
  });

  it('dates every decision still awaiting a setting', () => {
    const undated = rows
      .filter(([, row]) => 'awaiting' in row && !/^\d{4}-\d{2}-\d{2}$/.test(row.awaiting))
      .map(([kind]) => kind);
    expect(undated).toEqual([]);
  });

  it('names options paths the shipped options hold', () => {
    const missing = DECISION_KINDS.flatMap((kind) => settingsOf(kind))
      .filter((path) => path.startsWith('automation.') || path.startsWith('connection.'))
      .filter((path) => at(path) === undefined);
    expect(missing).toEqual([]);
  });

  it('never names the master switch, which stands behind every decision', () => {
    const named = DECISION_KINDS.filter((kind) => settingsOf(kind).includes('automation.enabled'));
    expect(named).toEqual([]);
  });
});
