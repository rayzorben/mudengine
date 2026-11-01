import { memo, useCallback, useMemo, useState } from 'react';

import GearSlotRow from './GearSlotRow';
import GearSlotTile from './GearSlotTile';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import type { VizTone } from './viz/tones';
import { useCardSize } from '../hooks/useCardSize';
import { t } from '../lib/i18n';
import { SLOT_STATES, slotState, type GearSay, type SlotState } from '../lib/gearPicks';
import type { GearChoice, GearSlot } from '@shared/upgrades';

const STATE_PART: Readonly<Record<SlotState, { tone: VizTone; label: () => string }>> = {
  buy: { tone: 'ok', label: () => t('cards.gear.kit.buy') },
  declined: { tone: 'bad', label: () => t('cards.gear.kit.declined') },
  best: { tone: 'accent', label: () => t('cards.gear.kit.best') },
  reach: { tone: 'quiet', label: () => t('cards.gear.kit.reach') }
};

const EMPTY: readonly GearChoice[] = [];

/**
 * The Gear card's slots, drawn for the card's size: a tile a slot on a large
 * card, with how the kit stands over them as one split bar (slots buying,
 * declined, wearing their best, out of reach); a row a slot on a smaller one,
 * each opening into its tile in place. See `mudengine-ui` › `parts/cards.md`.
 */
function GearSlots({
  slots,
  suggested,
  say,
  budget,
  loading,
  onDecline,
  onChoose,
  onReset
}: {
  slots: readonly GearSlot[];
  suggested: ReadonlyMap<string, readonly GearChoice[]>;
  say: GearSay;
  budget: number;
  loading: boolean;
  onDecline(slot: string, item: number): void;
  onChoose(slot: GearSlot, item: number): void;
  onReset(slot: string): void;
}) {
  const tiles = useCardSize() === 'large';
  /** The slots opened from their rows into tiles. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const open = useCallback((slot: string) => setOpened((was) => new Set(was).add(slot)), []);
  const fold = useCallback(
    (slot: string) =>
      setOpened((was) => {
        const next = new Set(was);
        next.delete(slot);
        return next;
      }),
    []
  );

  const stateOf = (slot: GearSlot): SlotState =>
    slotState(slot, suggested.get(slot.slot) ?? EMPTY, say.declined);
  const parts = useMemo(
    (): SplitPart[] =>
      SLOT_STATES.map((state) => ({
        key: state,
        label: STATE_PART[state].label(),
        tone: STATE_PART[state].tone,
        value: slots.filter(
          (slot) => slotState(slot, suggested.get(slot.slot) ?? EMPTY, say.declined) === state
        ).length
      })),
    [slots, suggested, say.declined]
  );

  return (
    <>
      {tiles ? <SplitBar label={t('cards.gear.kit.label')} parts={parts} /> : null}
      <ul
        className={tiles ? 'gear-slots tile-grid' : 'gear-slots gear-rows'}
        data-loading={loading ? 'true' : 'false'}
      >
        {slots.map((slot) =>
          tiles || opened.has(slot.slot) ? (
            <GearSlotTile
              budget={budget}
              chosen={say.chosen[slot.slot] !== undefined}
              declined={say.declined}
              key={slot.slot}
              onChoose={onChoose}
              onDecline={onDecline}
              onFold={tiles ? undefined : fold}
              onReset={onReset}
              slot={slot}
              suggested={suggested.get(slot.slot) ?? EMPTY}
            />
          ) : (
            <GearSlotRow
              declined={say.declined}
              key={slot.slot}
              onDecline={onDecline}
              onOpen={open}
              slot={slot}
              state={stateOf(slot)}
              suggested={suggested.get(slot.slot) ?? EMPTY}
            />
          )
        )}
      </ul>
    </>
  );
}

export default memo(GearSlots);
