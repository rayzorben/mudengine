/**
 * An item looked up, side by side with what this character wears in its slot
 * (`WornBeside`): a column for the item, one per worn piece, and the change
 * against the piece it would replace. Drawn only where the character can wear
 * it. The rows are `lib/wornBeside.ts`'s.
 */
import type { RealmFamily } from '@shared/character';
import type { WornBeside } from '@shared/wornBeside';
import { signed } from '../lib/figures';
import { t } from '../lib/i18n';
import { besideRows, changeOf, replacedIndex } from '../lib/wornBeside';

function Summary({ beside }: { beside: WornBeside }) {
  const replaces = beside.replaces;
  if (beside.worn === null)
    return <p className="quiet">{t('cards.reference.item.beside.unlisted')}</p>;
  if (replaces !== null && beside.verdict !== null) {
    const words = {
      better: t('cards.reference.item.beside.better', { item: replaces }),
      same: t('cards.reference.item.beside.same', { item: replaces }),
      worse: t('cards.reference.item.beside.worse', { item: replaces })
    } satisfies Record<typeof beside.verdict, string>;
    return (
      <p className="beside-verdict" data-tone={beside.verdict}>
        {words[beside.verdict]}
      </p>
    );
  }
  if (beside.worn.length === 0) {
    return (
      <p className="quiet">{t('cards.reference.item.beside.nothing', { slot: beside.slot })}</p>
    );
  }
  return <p className="quiet">{t('cards.reference.item.beside.free', { slot: beside.slot })}</p>;
}

export default function ReferenceWorn({
  beside,
  realm
}: {
  beside: WornBeside;
  realm: RealmFamily | null;
}) {
  const rows = besideRows(beside, realm);
  const worn = beside.worn ?? [];
  const against = replacedIndex(beside);
  return (
    <section className="reference-worn">
      <Summary beside={beside} />
      {beside.handsFree !== null && (
        <p className="quiet">
          {t('cards.reference.item.beside.handsFree', { item: beside.handsFree })}
        </p>
      )}
      {beside.unread && <p className="quiet">{t('cards.slotPeek.unread')}</p>}
      {worn.length > 0 && rows.length > 0 && (
        <table>
          <caption>{t('cards.reference.item.beside.caption', { slot: beside.slot })}</caption>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{beside.item.name}</th>
              {worn.map((piece, index) => (
                <th data-replaced={index === against} key={`${piece.name}-${index}`} scope="col">
                  {piece.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const change = against < 0 ? null : changeOf(row, against);
              return (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td>
                    {row.text(0)}
                    {change !== null && change.by !== 0 && (
                      <span className="beside-change" data-tone={change.tone}>
                        {' '}
                        {signed(change.by)}
                      </span>
                    )}
                  </td>
                  {worn.map((piece, index) => (
                    <td key={`${piece.name}-${index}`}>{row.text(index + 1)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
