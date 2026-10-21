import { describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import { recapLines } from '../partyRecap';
import type { PartyRecap, RecapRow } from '../../../shared/partyRecap';

const row = (over: Partial<RecapRow>): RecapRow => ({
  name: 'Faramir',
  damage: 25,
  share: 0.58,
  hits: 2,
  misses: 1,
  crits: 1,
  backstabs: 0,
  most: 22,
  killingBlow: false,
  ...over
});

const recap = (over: Partial<PartyRecap>): PartyRecap => ({
  mob: 'thrag',
  killed: true,
  ms: 9_400,
  total: 43,
  rows: [
    row({}),
    row({ name: 'Glorfindel', damage: 18, share: 0.42, crits: 0, most: 9, killingBlow: true })
  ],
  outside: 0,
  ...over
});

describe('the party recap in words', () => {
  it('says the heading, a row per member and the outside damage, each clause from its key', () => {
    const lines = recapLines(recap({ outside: 5 }));
    expect(lines).toEqual([
      t('notices.fights.recap.killed', { mob: 'thrag', total: 43 }) +
        t('notices.fights.recap.took', { seconds: 9 }),
      t('notices.fights.recap.row', {
        name: 'Faramir',
        damage: 25,
        share: 58,
        hits: 2,
        misses: 1,
        crits: 1,
        backstabs: 0
      }) + t('notices.fights.recap.biggest', { most: 22 }),
      t('notices.fights.recap.row', {
        name: 'Glorfindel',
        damage: 18,
        share: 42,
        hits: 2,
        misses: 1,
        crits: 0,
        backstabs: 0
      }) +
        t('notices.fights.recap.biggest', { most: 9 }) +
        t('notices.fights.recap.killingBlow'),
      t('notices.fights.recap.outside', { damage: 5 })
    ]);
  });

  /* Unknown is left out, never shown as 0: no duration, no landed blow, nobody outside. */
  it('leaves out a clause nothing measured', () => {
    const lines = recapLines(
      recap({ killed: false, ms: null, rows: [row({ most: null, hits: 0, damage: 0, share: 0 })] })
    );
    expect(lines).toEqual([
      t('notices.fights.recap.ended', { mob: 'thrag', total: 43 }),
      t('notices.fights.recap.row', {
        name: 'Faramir',
        damage: 0,
        share: 0,
        hits: 0,
        misses: 1,
        crits: 1,
        backstabs: 0
      })
    ]);
  });
});
