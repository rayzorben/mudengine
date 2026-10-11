import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../character';
import type { ExperienceTable } from '../experience';
import { domainOf, type Block } from '../blocks';
import { levelReadyNotices, levelWaiting, telepathNotice } from '../characterNotices';
import { sounds, STARTER_ALERTS, wanted, type AlertRule } from '../notifications';

const t = (key: string, params?: Record<string, unknown>): string =>
  `${key}${params === undefined ? '' : JSON.stringify(params)}`;

const TABLE = {
  rows: [
    { level: 10, experience: 1000, source: 'realm' as const },
    { level: 11, experience: 2000, source: 'realm' as const },
    { level: 12, experience: 4000, source: 'realm' as const }
  ]
};

const at = (
  exp: number | null,
  expNeeded: number | null = null,
  table: ExperienceTable | null = TABLE
): CharacterState => ({
  ...EMPTY_CHARACTER,
  progress: { ...EMPTY_CHARACTER.progress, level: 10, exp, expNeeded, expTable: table }
});

const telepath = (message: string): Block => ({
  seq: 7,
  at: 500,
  type: 'conversation-telepath',
  domain: domainOf('conversation-telepath'),
  groups: { player: 'Soul', message },
  text: `Soul telepaths: ${message}`,
  terminator: 'newline',
  confidence: 1
});

describe('a level waiting at a trainer (todo 80)', () => {
  it('reads the highest level the experience pays for from the table', () => {
    expect(levelWaiting(at(1500).progress)).toBeNull();
    expect(levelWaiting(at(2500).progress)).toBe(11);
    expect(levelWaiting(at(4000).progress)).toBe(12);
  });

  it('reads the realm’s Exp needed of 0 where no table is read, and unknown as nothing', () => {
    expect(levelWaiting(at(2500, 1, null).progress)).toBeNull();
    const bare = (needed: number | null): CharacterState => ({
      ...EMPTY_CHARACTER,
      progress: { ...EMPTY_CHARACTER.progress, level: 10, exp: null, expNeeded: needed }
    });
    expect(levelWaiting(bare(0).progress)).toBe(11);
    expect(levelWaiting(bare(null).progress)).toBeNull();
  });

  it('says so as a level comes due, once, and again for the next', () => {
    expect(levelReadyNotices(at(1500), at(2500), 1, t)).toEqual([
      expect.objectContaining({
        event: 'level-ready',
        text: t('cards.alerts.level.ready', { level: 11 })
      })
    ]);
    expect(levelReadyNotices(at(2500), at(2600), 2, t)).toEqual([]);
    expect(levelReadyNotices(at(2600), at(4000), 3, t)).toHaveLength(1);
  });
});

describe('a telepath to this character (todo 80)', () => {
  const row: AlertRule = { ...STARTER_ALERTS[0]!, on: 'telepath', alert: true };

  it('is a notice while a row asks, and an @ command is not', () => {
    expect(telepathNotice(telepath('hi there'), [row])).toMatchObject({
      event: 'telepath',
      text: 'Soul telepaths: hi there'
    });
    expect(telepathNotice(telepath('@health'), [row])).toBeNull();
  });

  it('stays on the Talk card with no telepath row', () => {
    expect(telepathNotice(telepath('hi there'), [])).toBeNull();
    expect(telepathNotice(telepath('hi there'), STARTER_ALERTS)).toBeNull();
    expect(telepathNotice(telepath('hi there'), [{ ...row, enabled: false }])).toBeNull();
  });

  it('is shown on the Alerts card by a telepath row with alert on', () => {
    expect(wanted({ rules: [row] }, [telepathNotice(telepath('hi'), [row])])).toHaveLength(1);
  });
});

describe('a row that sounds', () => {
  it('sounds for a telepath row that asks, and not for an unclaimed notice', () => {
    const row: AlertRule = { ...STARTER_ALERTS[0]!, on: 'telepath', sound: true };
    const notice = telepathNotice(telepath('hi'), [row]);
    expect(notice).not.toBeNull();
    if (notice === null) return;
    expect(sounds(notice, [row])).toBe(true);
    expect(sounds(notice, [{ ...row, sound: false }])).toBe(false);
    expect(sounds(notice, [])).toBe(false);
  });
});
