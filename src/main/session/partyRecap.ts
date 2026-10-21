/**
 * The party recap in words: a heading for the monster, then one notice line
 * per member, most damage first (todo 20261020-1654-01). The figures are
 * `partyRecap`'s; this only says them, and leaves out what was never measured.
 */
import type { PartyRecap, RecapRow } from '../../shared/partyRecap';
import { t } from '../app/i18n';

function rowLine(row: RecapRow): string {
  const line = t('notices.fights.recap.row', {
    name: row.name,
    damage: row.damage,
    share: Math.round(row.share * 100),
    hits: row.hits,
    misses: row.misses,
    crits: row.crits,
    backstabs: row.backstabs
  });
  const biggest = row.most === null ? '' : t('notices.fights.recap.biggest', { most: row.most });
  return line + biggest + (row.killingBlow ? t('notices.fights.recap.killingBlow') : '');
}

function heading(recap: PartyRecap): string {
  const params = { mob: recap.mob, total: recap.total };
  const what = recap.killed
    ? t('notices.fights.recap.killed', params)
    : t('notices.fights.recap.ended', params);
  return recap.ms === null
    ? what
    : what + t('notices.fights.recap.took', { seconds: Math.round(recap.ms / 1000) });
}

export function recapLines(recap: PartyRecap): string[] {
  return [
    heading(recap),
    ...recap.rows.map(rowLine),
    ...(recap.outside > 0 ? [t('notices.fights.recap.outside', { damage: recap.outside })] : [])
  ];
}
