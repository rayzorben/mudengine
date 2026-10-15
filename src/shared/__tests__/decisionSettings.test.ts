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
  it('names at least one setting for each decision, or why it has none', () => {
    const bare = rows
      .filter(([, row]) => Array.isArray(row) && row.length === 0)
      .map(([kind]) => kind);
    expect(bare).toEqual([]);
  });

  it('says why, and since when, a decision has no setting of its own', () => {
    const bare = rows
      .filter(([, row]) => 'exempt' in row)
      .filter(([, row]) => {
        const { exempt, since } = row as { exempt: string; since: string };
        return exempt.trim().length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(since);
      })
      .map(([kind]) => kind);
    expect(bare).toEqual([]);
  });

  it('leaves no decision awaiting a setting', () => {
    const awaiting = rows.filter(([, row]) => 'awaiting' in row).map(([kind]) => kind);
    expect(awaiting).toEqual([]);
  });

  it('names options paths the shipped options hold', () => {
    const missing = DECISION_KINDS.flatMap((kind) => settingsOf(kind))
      .filter(
        (path) =>
          path.startsWith('automation.') || path.startsWith('connection.') || path === 'extensions'
      )
      .filter((path) => at(path) === undefined);
    expect(missing).toEqual([]);
  });

  it('never names the master switch, which stands behind every decision', () => {
    const named = DECISION_KINDS.filter((kind) => settingsOf(kind).includes('automation.enabled'));
    expect(named).toEqual([]);
  });
});
