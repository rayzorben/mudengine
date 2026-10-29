import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';
import { monsterIn, roundGap, type RoomVerdict } from '@shared/verdict';

/**
 * The server's own round against a monster, off a `stat all <number>` sheet
 * that still holds, beside the client's own figure for it (todo 2322-01). A
 * gap past `roundGapSaidPercent` is a warning chip, since the fight odds use
 * the client's figure. Nothing where no such sheet holds.
 */
export default function RoundChip({
  name,
  verdict
}: {
  name: string;
  verdict: RoomVerdict;
}): React.JSX.Element | null {
  const entry = monsterIn(verdict, name);
  if (entry?.stated === undefined) return null;
  const server = entry.stated;
  const dealt = entry.verdict.dealt;
  const gap = roundGap(dealt, server);
  const far = gap !== null && gap * 100 > tuning().roundGapSaidPercent;
  const title =
    dealt === null
      ? t('cards.room.occupant.roundUnpriced', { target: name, server })
      : far
        ? t('cards.room.occupant.roundDisagrees', {
            target: name,
            server,
            client: Math.round(dealt),
            gap: Math.round((gap ?? 0) * 100)
          })
        : t('cards.room.occupant.roundAgrees', { target: name, server, client: Math.round(dealt) });
  return (
    <span
      className={`chip ${far || dealt === null ? 'warn' : 'quiet'}`}
      data-round-gap={far}
      title={title}
    >
      {t('cards.room.occupant.roundChip', { server })}
    </span>
  );
}
