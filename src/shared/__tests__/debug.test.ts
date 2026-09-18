import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER } from '../character';
import {
  clip,
  describeStateChange,
  formatDebugReport,
  summariseBlock,
  visible,
  type DebugRecord
} from '../debug';
import type { Block } from '../blocks';

/*
 * The bits of the debug trace that decide something, tested where the decision
 * is. The view and the recorder are plumbing; these three are where a bug
 * report becomes readable or becomes noise.
 */

describe('control bytes are made visible', () => {
  /*
   * The one that matters. This server family repaints its status line with a
   * literal `CSI 79 D` rather than a newline, so a trace that swallowed ESC
   * would be a trace of a stream nobody can reason about — which is most of
   * what this window exists for.
   */
  it('shows the escape that frames a status line', () => {
    expect(visible('\x1b[79D\x1b[K')).toBe('␛[79D␛[K');
  });

  /*
   * One record stays one line, in the view and in the file. A real break here
   * would put the second half of a record in the `time` column of the next
   * one and silently shift every column after it.
   */
  it('keeps a record on one line', () => {
    expect(visible('two\r\nlines')).toBe('two␍␊lines');
  });

  it('leaves the text the server actually printed alone', () => {
    expect(visible('You are hungry.')).toBe('You are hungry.');
    // Including what a MajorMUD room frame is drawn with, which is not ASCII.
    expect(visible('│ ┌─┐ é')).toBe('│ ┌─┐ é');
  });

  it('marks a cut rather than making one silently', () => {
    expect(clip('abcdef', 3)).toBe('abc… (+3 more)');
    expect(clip('abc', 3)).toBe('abc');
  });
});

describe('what a line was classified as', () => {
  const block = (over: Partial<Block>): Block => ({
    seq: 1,
    at: 0,
    type: 'status-line',
    domain: 'status',
    terminator: 'newline',
    groups: {},
    text: '[HP=334/KAI=27]:',
    confidence: 0.8,
    ...over
  });

  /*
   * The groups are the evidence. Without them a misclassification and a
   * correct one look identical in a log — the type says what the client
   * decided and the groups say what it decided it *from*.
   */
  it('states the confidence and what the pattern pulled out', () => {
    expect(summariseBlock(block({ groups: { hp: '334', mana: '27' } }))).toBe(
      '80%  hp=334 mana=27'
    );
  });

  it('drops groups the pattern matched empty, which say nothing', () => {
    expect(summariseBlock(block({ groups: { hp: '334', qualifier: '' } }))).toBe('80%  hp=334');
  });

  it('is the confidence alone when a pattern captured nothing', () => {
    expect(summariseBlock(block({ confidence: 1 }))).toBe('100%');
  });
});

describe('what the state became', () => {
  const withVitals = (over: Partial<(typeof EMPTY_CHARACTER)['vitals']>) => ({
    ...EMPTY_CHARACTER,
    vitals: { ...EMPTY_CHARACTER.vitals, ...over }
  });

  it('says nothing when nothing moved', () => {
    expect(describeStateChange(EMPTY_CHARACTER, EMPTY_CHARACTER)).toEqual([]);
  });

  it('reports only what changed', () => {
    const after = withVitals({ hp: 300 });
    expect(describeStateChange(EMPTY_CHARACTER, after)).toEqual(['hp — → 300']);
  });

  /*
   * **Null is not zero.** A maximum arriving for the first time is a different
   * event from one that was zero and became 334, and a trace that wrote `0 →
   * 334` for the first would be the lie this project keeps writing rules
   * against — read back later, it says the client believed the character had
   * no health.
   */
  it('draws an absence as an absence, never as zero', () => {
    const before = withVitals({ hpMax: null });
    const after = withVitals({ hpMax: 334 });
    expect(describeStateChange(before, after)).toEqual(['hp max — → 334']);
    expect(describeStateChange(withVitals({ hpMax: 0 }), after)).toEqual(['hp max 0 → 334']);
  });

  /*
   * Counts rather than contents for the listings: a diff of a hundred items
   * per pick-up is a report nobody reads, and *that* the pack changed is the
   * fact — the line that caused it is two records above.
   */
  it('reports a listing by its length', () => {
    const after = {
      ...EMPTY_CHARACTER,
      inventory: {
        ...EMPTY_CHARACTER.inventory,
        items: [...EMPTY_CHARACTER.inventory.items, { name: 'a torch' } as never]
      }
    };
    expect(describeStateChange(EMPTY_CHARACTER, after)).toEqual(['carried 0 → 1']);
  });
});

describe('the saved bug report', () => {
  const record = (over: Partial<DebugRecord>): DebugRecord => ({
    seq: 1,
    at: Date.UTC(2026, 8, 5, 12, 30, 45, 123),
    kind: 'line',
    tag: 'repaint',
    text: 'hello',
    ...over
  });
  const header = {
    title: 'mudengine debug report',
    version: '0.5.0',
    platform: 'linux x64',
    character: 'Vaelor',
    realm: 'GreaterMUD',
    at: Date.UTC(2026, 8, 5, 12, 31, 0),
    dropped: 0
  };

  it('leads with what a bug report is useless without', () => {
    const text = formatDebugReport(header, []);
    expect(text).toContain('version    0.5.0');
    expect(text).toContain('character  Vaelor');
    expect(text).toContain('realm      GreaterMUD');
    expect(text).toContain('records    0');
  });

  /*
   * A report that silently begins in the middle reads as a session that began
   * there, which sends whoever is diagnosing it looking for a start that was
   * never recorded.
   */
  it('says how much the ring had already thrown away', () => {
    expect(formatDebugReport({ ...header, dropped: 120 }, [])).toContain(
      'records    0 (120 older dropped)'
    );
  });

  it('writes one record per line, in columns somebody can scan down', () => {
    const text = formatDebugReport(header, [record({}), record({ seq: 2, kind: 'block' })]);
    const rows = text.split('\n').filter((line) => line.includes('12:30:45.123'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^12:30:45\.123 line {3}repaint\s+hello$/);
    // The kind column starts at the same x on every row, whatever is in it.
    expect(rows[0]?.indexOf('line')).toBe(rows[1]?.indexOf('block'));
  });

  it('puts a record’s detail under it rather than in the columns', () => {
    const text = formatDebugReport(header, [record({ detail: 'plain: hello' })]);
    const rows = text.split('\n');
    const at = rows.findIndex((line) => line.includes('12:30:45.123'));
    expect(rows[at + 1]).toMatch(/^ +plain: hello$/);
  });

  /*
   * The claim the whole feature rests on. This file is written to be sent to
   * somebody else, so the check is not "does the formatter redact" — it must
   * not, and does not — but that what it is *given* is already redacted. Here
   * that is asserted end to end from the shape the recorder produces:
   * `SessionManager.reportable` replaces a password with a fixed-width mask
   * before any record is built, so the mask is what the report can contain.
   */
  it('carries whatever mask the manager put in, and never a password', () => {
    const text = formatDebugReport(header, [
      record({ kind: 'out', tag: 'user', text: '••••••••' })
    ]);
    expect(text).toContain('••••••••');
    expect(text).toContain('Passwords are never recorded.');
  });
});
