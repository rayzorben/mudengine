/**
 * Every item one slot takes that this character can use, best first, beside
 * the slot word that was clicked: `(Head)` in `i` or `look <player>`, the Slot
 * column of the pack, a person's equipment.
 *
 * A panel on `usePopoverFrame` like the other four, addressed at the character
 * whose listing it was. The list is main's (`world/slotGear.ts`): armour by AC
 * then DR, the weapon hand by damage a round with the character's attack. Each
 * name opens the realm's answer about it, which says where to get it.
 */
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';

import CardTable, { type Column } from './CardTable';
import EntityNumber from './EntityNumber';
import PopoverHead, { PopoverSizer } from './PopoverHead';
import { usePopoverFrame } from '../hooks/usePopoverFrame';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { PopoverAnchor } from '../lib/popover';
import type { CharacterState } from '@shared/character';
import type { SessionId } from '@shared/ipc';
import { sameItem } from '@shared/items';
import type { SwingMethod } from '@shared/prowess';
import { meanBlow, type SlotGear, type SlotGearRow, type SlotRanking } from '@shared/slotGear';
import { errorMessage } from '@shared/values';

/** A slot word clicked, whose character's listing it was, and where. Fresh per click. */
export interface SlotAsked {
  session: SessionId;
  slot: string;
  anchor: PopoverAnchor;
}

export interface SlotQuickViewProps {
  asked: SlotAsked;
  /** The character asked about, for the row it is wearing now. */
  character: CharacterState;
  load(session: SessionId, slot: string): Promise<SlotGear | null>;
  /** An item's name clicked: the realm's answer about it, replacing this panel. */
  inspect(name: string, anchor: HTMLElement): void;
  onDismiss(): void;
  returnFocus(): void;
}

function methodWord(method: SwingMethod): string {
  switch (method) {
    case 'attack':
      return t('cards.slotPeek.method.attack');
    case 'bash':
      return t('cards.slotPeek.method.bash');
    case 'smash':
      return t('cards.slotPeek.method.smash');
    default: {
      const unhandled: never = method;
      return String(unhandled);
    }
  }
}

function rankedBy(ranking: SlotRanking): string {
  if (ranking.by === 'armour') return t('cards.slotPeek.rankArmour');
  return ranking.rounds
    ? t('cards.slotPeek.rankWeapon', { method: methodWord(ranking.method) })
    : t('cards.slotPeek.rankBlow');
}

/** One decimal: a round's damage is an average, and a whole number would tie two weapons. */
function perRoundText(value: number): string {
  return value.toFixed(1);
}

export default function SlotQuickView({
  asked,
  character,
  load,
  inspect,
  onDismiss,
  returnFocus
}: SlotQuickViewProps) {
  // `failed` is the lookup going wrong, never a slot with nothing in it.
  const [gear, setGear] = useState<SlotGear | null | 'pending' | 'failed'>('pending');

  useEffect(() => {
    let live = true;
    setGear('pending');
    load(asked.session, asked.slot)
      .then((answer) => {
        if (live) setGear(answer);
      })
      .catch((error: unknown) => {
        // Settles, never *looking* for ever, and says it failed.
        if (!live) return;
        setGear('failed');
        console.error(`[slot] ${asked.slot}: ${errorMessage(error)}`);
      });
    return () => {
      live = false;
    };
  }, [asked, load]);

  const escape = useCallback(() => {
    onDismiss();
    returnFocus();
  }, [onDismiss, returnFocus]);
  const frame = usePopoverFrame({
    anchor: asked.anchor,
    measure: [gear],
    onDismiss,
    onEscape: escape
  });

  const worn = useMemo(
    () => character.inventory.items.filter((item) => item.equipped).map((item) => item.name),
    [character.inventory.items]
  );
  const answer = gear === 'pending' || gear === 'failed' ? null : gear;
  const columns = useMemo(
    () => (answer === null ? [] : columnsFor(answer.ranking, worn, inspect)),
    [answer, worn, inspect]
  );

  return createPortal(
    <div
      aria-label={t('cards.slotPeek.ariaLabel', { slot: answer?.slot ?? asked.slot })}
      className="surface popover slot-peek"
      role="dialog"
      {...frame.props}
    >
      <PopoverHead
        onClose={onDismiss}
        onGrab={frame.onGrab}
        onPin={frame.togglePin}
        pinned={frame.pinned}
      >
        {answer?.slot ?? asked.slot}
      </PopoverHead>

      <div className="popover-body">
        {gear === 'pending' ? (
          <div className="empty">{t('cards.slotPeek.pending')}</div>
        ) : gear === 'failed' ? (
          <div className="empty">{t('cards.slotPeek.failed')}</div>
        ) : gear === null ? (
          <div className="empty">{t('cards.slotPeek.noWorld')}</div>
        ) : (
          <>
            <CardTable
              caption={t('cards.slotPeek.tableCaption', { slot: gear.slot })}
              className="slot-gear"
              columns={columns}
              empty={t('cards.slotPeek.empty')}
              find={t('cards.slotPeek.findPlaceholder')}
              keyOf={(row) => String(row.id)}
              name={`slot-${gear.ranking.by}`}
              returnFocus={returnFocus}
              rows={gear.rows}
              session={asked.session}
            />
            <p className="quiet-note">{rankedBy(gear.ranking)}</p>
            {gear.unread && <p className="quiet-note">{t('cards.slotPeek.unread')}</p>}
            {gear.refused > 0 && (
              <p className="quiet-note">
                {gear.refused === 1
                  ? t('cards.slotPeek.refused.one')
                  : t('cards.slotPeek.refused.many', { count: gear.refused })}
              </p>
            )}
          </>
        )}
      </div>
      <PopoverSizer onReset={frame.onSizeReset} onSize={frame.onSize} />
    </div>,
    document.body
  );
}

/** The columns for how the slot ranks: armour's figures, or a weapon's. */
function columnsFor(
  ranking: SlotRanking,
  worn: readonly string[],
  inspect: SlotQuickViewProps['inspect']
): Column<SlotGearRow>[] {
  const item: Column<SlotGearRow> = {
    id: 'item',
    label: t('cards.slotPeek.columnItem'),
    wide: true,
    value: (row) => row.name,
    cell: (row) => (
      <>
        <button
          className="what lookup"
          onClick={(event) => inspect(row.name, event.currentTarget)}
          onMouseDown={keepFocus}
          title={t('cards.room.itemLookupTooltip')}
          type="button"
        >
          {row.name}
        </button>
        {worn.some((name) => sameItem(name, row.name)) && (
          <span className="chip on">{t('cards.slotPeek.wornChip')}</span>
        )}
      </>
    )
  };
  const number: Column<SlotGearRow> = {
    id: 'number',
    label: t('entity.numberColumn'),
    name: t('entity.numberColumnLabel'),
    numeric: true,
    value: (row) => row.id,
    cell: (row) => <EntityNumber of={{ id: row.id }} />
  };
  const level: Column<SlotGearRow> = {
    id: 'level',
    label: t('cards.slotPeek.columnLevel'),
    numeric: true,
    value: (row) => row.minLevel
  };
  if (ranking.by === 'armour') {
    return [
      item,
      number,
      level,
      { id: 'ac', label: t('cards.slotPeek.columnAc'), numeric: true, value: (row) => row.ac },
      { id: 'dr', label: t('cards.slotPeek.columnDr'), numeric: true, value: (row) => row.dr }
    ];
  }
  return [
    item,
    number,
    level,
    {
      id: 'damage',
      label: t('cards.slotPeek.columnDamage'),
      numeric: true,
      // Sorted by the mean blow, drawn as the range the realm states.
      value: (row) => meanBlow(row.damage),
      cell: (row) => (row.damage === null ? null : `${row.damage.min}–${row.damage.max}`)
    },
    {
      id: 'speed',
      label: t('cards.slotPeek.columnSpeed'),
      numeric: true,
      value: (row) => row.speed
    },
    {
      id: 'round',
      label: t('cards.slotPeek.columnPerRound'),
      numeric: true,
      value: (row) => row.perRound?.value ?? null,
      cell: (row) =>
        row.perRound === null ? null : (
          <span title={t('cards.slotPeek.perRoundTooltip')}>
            {perRoundText(row.perRound.value)}
          </span>
        )
    }
  ];
}
