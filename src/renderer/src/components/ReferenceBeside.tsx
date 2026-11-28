/**
 * What the character wears in a looked-up item's slot, a card per worn piece
 * beside the item's panel (`WornBeside`): every stat of the piece against the
 * item, and the change where it is a number. Drawn only where the character
 * can wear the item. The rows are `lib/wornBeside.ts`'s; the placement
 * `useBesidePlacement`'s.
 */
import type { CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';

import EntityNumber from './EntityNumber';
import { useBesidePlacement } from '../hooks/useBesidePlacement';
import { signed } from '../lib/figures';
import { t } from '../lib/i18n';
import { compareRows, replacedIndex, type CompareNames } from '../lib/wornBeside';
import type { WornBeside, WornPiece } from '@shared/wornBeside';
import type { WorldItem } from '@shared/world';

function Verdict({ beside }: { beside: WornBeside }) {
  const replaces = beside.replaces;
  if (replaces === null || beside.verdict === null) return null;
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

function PieceCard({
  piece,
  replaced,
  beside,
  item,
  names
}: {
  piece: WornPiece;
  replaced: boolean;
  beside: WornBeside;
  item: WorldItem;
  names: CompareNames;
}) {
  const theirs = piece.item;
  const rows =
    theirs === null
      ? []
      : compareRows(
          { item: theirs, figures: piece.figures },
          { item, figures: beside.item },
          beside.ranking,
          names
        );
  return (
    <section className="beside-card" data-replaced={replaced}>
      <header className="beside-head">
        <h3>{piece.name}</h3>
        <span className="chip quiet">{t('cards.slotPeek.wornChip')}</span>
        {piece.id !== null && <EntityNumber of={{ id: piece.id }} />}
      </header>
      {replaced && <Verdict beside={beside} />}
      {theirs === null ? (
        <p className="quiet">{t('cards.reference.item.beside.rowUnknown', { item: piece.name })}</p>
      ) : (
        <table>
          <caption>{t('cards.reference.item.beside.caption', { slot: beside.slot })}</caption>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{piece.name}</th>
              <th scope="col">{item.name}</th>
              <th scope="col">{t('cards.reference.item.beside.change')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td data-absent={row.worn === null}>
                  {row.worn ?? t('cards.reference.item.beside.none')}
                </td>
                <td data-absent={row.item === null}>
                  {row.item ?? t('cards.reference.item.beside.none')}
                </td>
                <td className="beside-change" data-tone={row.change?.tone ?? undefined}>
                  {row.change !== null && row.change.by !== 0 ? signed(row.change.by) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Why there is no piece to set beside it: the pack unread, or nothing worn there. */
function NothingWorn({ beside }: { beside: WornBeside }) {
  return (
    <section className="beside-card">
      <p className="quiet">
        {beside.worn === null
          ? t('cards.reference.item.beside.unlisted')
          : t('cards.reference.item.beside.nothing', { slot: beside.slot })}
      </p>
    </section>
  );
}

/** The cards themselves: inline on the Reference card, beside the panel a clicked name opens. */
export function BesideCards({
  beside,
  item,
  names
}: {
  beside: WornBeside;
  item: WorldItem;
  names: CompareNames;
}) {
  const worn = beside.worn ?? [];
  const against = replacedIndex(beside);
  const notes = [
    ...(worn.length > 0 && beside.replaces === null
      ? [t('cards.reference.item.beside.free', { slot: beside.slot })]
      : []),
    ...(beside.handsFree === null
      ? []
      : [t('cards.reference.item.beside.handsFree', { item: beside.handsFree })]),
    ...(beside.unread ? [t('cards.slotPeek.unread')] : [])
  ];
  return (
    <>
      {worn.length === 0 && <NothingWorn beside={beside} />}
      {notes.length > 0 && (
        <section className="beside-card beside-notes">
          {notes.map((note) => (
            <p className="quiet" key={note}>
              {note}
            </p>
          ))}
        </section>
      )}
      {worn.map((piece, index) => (
        <PieceCard
          beside={beside}
          item={item}
          key={`${piece.name}-${index}`}
          names={names}
          piece={piece}
          replaced={index === against}
        />
      ))}
    </>
  );
}

export default function ReferenceBeside({
  beside,
  item,
  names,
  panel,
  at
}: {
  beside: WornBeside;
  item: WorldItem;
  names: CompareNames;
  /** The item panel, which this sits beside. */
  panel: RefObject<HTMLDivElement | null>;
  /** The item panel's geometry as its frame wrote it: a change moves this too. */
  at: CSSProperties;
}) {
  const place = useBesidePlacement(panel, [beside, at.top, at.left, at.width, at.height]);
  return createPortal(
    // A child of the panel for its click-away: a press here keeps the panel.
    <div className="reference-beside" data-panel-child="" ref={place.ref} style={place.style}>
      <BesideCards beside={beside} item={item} names={names} />
    </div>,
    document.body
  );
}
