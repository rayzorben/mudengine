import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_AUTOMATION } from '../../../shared/automation';
import { EMPTY_CHARACTER } from '../../../shared/character';
import type { DebugRecord } from '../../../shared/debug';
import { t } from '../../app/i18n';
import { reportSections, writeBugReport, type BugReportInputs } from '../BugReport';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-bugreport-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const sent = (text: string): DebugRecord => ({ seq: 1, at: 0, kind: 'out', tag: 'user', text });

function inputs(over: Partial<BugReportInputs> = {}): BugReportInputs {
  return {
    directory: dir,
    slug: 'hero',
    header: {
      title: 'report',
      version: '0.0.0',
      platform: 'test',
      character: 'Hero',
      realm: 'Local',
      at: Date.UTC(2026, 9, 10, 12, 0, 0),
      dropped: 0
    },
    character: EMPTY_CHARACTER,
    automation: {
      ...EMPTY_AUTOMATION,
      safety: [{ at: 0, action: 'hang up', because: 'hp 10%', acted: false, refused: 'no exit' }]
    },
    build: null,
    records: [sent('look')],
    secrets: [{ owner: 'Hero', value: 'hunter22' }],
    deliver: () => null,
    ...over
  };
}

describe('the bug report', () => {
  it('writes the character, the refusals and the trace into the logs directory', async () => {
    const saved = await writeBugReport(inputs());
    expect('path' in saved).toBe(true);
    if (!('path' in saved)) return;
    expect(path.dirname(saved.path)).toBe(dir);
    const text = fs.readFileSync(saved.path, 'utf8');
    expect(text).toContain(t('app.debug.section.character'));
    expect(text).toContain('hang up refused: no exit');
    expect(text).toContain('look');
  });

  it('writes nothing when the text holds a configured password', async () => {
    // Positive control above: the same inputs without the password are written.
    const saved = await writeBugReport(inputs({ records: [sent('hunter22')] }));
    expect(saved).toEqual({ error: t('app.debug.secretFound', { owner: 'Hero' }) });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('shows an unknown maximum as unknown, never as 0', () => {
    const [character] = reportSections(inputs());
    expect(character?.lines.find((line) => line.startsWith('hp'))).toBe('hp         — / —');
  });
});
