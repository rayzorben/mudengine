import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import GearTripFace from './GearTripFace';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import {
  basketOf,
  copperWords,
  unpricedWords,
  cashAt,
  costOf,
  picksOf,
  toggled,
  tripPicks,
  type PickOverrides
} from '../lib/gearPicks';
import type { BankBalance } from '@shared/character';
import type { GearPick, GearTripPlan, GearTripProgress } from '@shared/gearTrip';
import type { GearGain } from '@shared/gearWorth';
import type { IpcApi, SessionId } from '@shared/ipc';
import { errorMessage } from '@shared/values';
import type { GearChoice, GearChoices, GearSlot } from '@shared/upgrades';

/**
 * Gear: per slot what is worn, the best the character can wear at its level
 * from anywhere (sold, dropped, or neither, said which), and what the cash it
 * has buys now. The budget is the purse and every vault on record, and a
 * slider and a figure set it lower; what it buys is each slot's best the
 * copper left still covers, the slot giving most per copper first
 * (`withinBudget`, shared with the planner extension). A row's own items can
 * be picked instead. *Plan the trip* asks main for the vaults and counters in
 * the shortest order, each leg with what it meets; the trip face walks or
 * runs it. Put away by default and found in the palette.
 */
export interface GearCardProps extends CardChrome {
  session: SessionId;
  loadGear(): ReturnType<IpcApi['gearChoices']>;
  planGear(picks: GearPick[]): ReturnType<IpcApi['gearPlan']>;
  goGear(picks: GearPick[], run: boolean): ReturnType<IpcApi['gearTrip']>;
  stopGear(): void;
  purse: number | null;
  banks: readonly BankBalance[];
  trip: GearTripProgress | null;
  /** What is worn and the level, so a change re-asks. */
  kitKey: string;
}

const copper = copperWords;

/** What an item adds, as the sheet says it. */
function gainWords(gain: GearGain): string {
  const parts: string[] = [];
  if (gain.armourClass !== null && gain.armourClass !== 0) {
    parts.push(t('cards.gear.gainArmour', { ac: Math.round(gain.armourClass * 10) / 10 }));
  }
  if (gain.perRound !== null && gain.perRound !== 0) {
    parts.push(t('cards.gear.gainRound', { damage: Math.round(gain.perRound * 10) / 10 }));
  }
  return parts.join(', ');
}

/** Where an item comes from: the counter and its price, else who drops it, else neither. */
function sourceWords(item: GearChoice): string {
  if (item.sold !== null) {
    const price = item.charged === null ? t('cards.gear.unpriced') : copper(item.charged);
    return item.counters > 1
      ? t('cards.gear.soldMore', { shop: item.sold.shop, price, more: item.counters - 1 })
      : t('cards.gear.sold', { shop: item.sold.shop, price });
  }
  if (item.droppedBy.length > 0) {
    return t('cards.gear.dropped', { monsters: item.droppedBy.slice(0, 3).join(', ') });
  }
  return t('cards.gear.nowhere');
}

export function gearCopyText(choices: GearChoices | null): string {
  if (choices === null) return t('cards.gear.title');
  return [
    t('cards.gear.title'),
    ...choices.slots.map((slot) =>
      t('cards.gear.copyRow', {
        slot: slot.slot,
        worn: slot.worn ?? t('cards.gear.nothingWorn'),
        best:
          slot.items[0] === undefined ? '' : `${slot.items[0].name} (${sourceWords(slot.items[0])})`
      })
    )
  ].join('\n');
}

function GearCard({
  session,
  loadGear,
  planGear,
  goGear,
  stopGear,
  purse,
  banks,
  trip,
  kitKey,
  ...chrome
}: GearCardProps) {
  const [choices, setChoices] = useState<GearChoices | null>(null);
  const [loading, setLoading] = useState(false);
  const [asked, setAsked] = useState(0);
  /** The budget typed or slid; null is all the cash there is. */
  const [budgetSet, setBudgetSet] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<PickOverrides>({});
  const [open, setOpen] = useState<string | null>(null);
  const [plan, setPlan] = useState<GearTripPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [face, setFace] = useState('slots');
  /** Why the last ask of main failed, said on the card rather than left loading. */
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void loadGear().then(
      (answer) => {
        if (stale) return;
        setChoices(answer);
        setFailed(null);
        setLoading(false);
      },
      (error: unknown) => {
        if (stale) return;
        setFailed(errorMessage(error));
        setLoading(false);
      }
    );
    return () => {
      stale = true;
    };
    // What is worn or the level moving changes every row's answer.
  }, [loadGear, asked, kitKey]);

  const cash = cashAt(purse, banks);
  const budget = budgetSet ?? cash ?? 0;
  const basket = useMemo(
    () => (choices === null ? new Map<string, GearChoice[]>() : basketOf(choices, budget)),
    [choices, budget]
  );
  const picked = useMemo(
    () =>
      choices === null ? new Map<string, GearChoice[]>() : picksOf(choices, basket, overrides),
    [choices, basket, overrides]
  );
  const cost = costOf(picked);
  const picks = useMemo(
    () => (choices === null ? [] : tripPicks(choices, picked)),
    [choices, picked]
  );

  const pick = useCallback((slot: GearSlot, current: readonly GearChoice[], item: number) => {
    const ids = current.map((each) => each.item);
    setOverrides((was) => ({ ...was, [slot.slot]: toggled(slot, ids, item) }));
  }, []);

  const columns: Array<Column<GearSlot>> = useMemo(
    () => [
      {
        id: 'slot',
        label: t('cards.gear.columns.slot'),
        value: (slot) => slot.slot,
        cell: (slot) => (
          <button
            aria-expanded={open === slot.slot}
            className="lookup"
            onClick={() => setOpen(open === slot.slot ? null : slot.slot)}
            onMouseDown={keepFocus}
            type="button"
          >
            {slot.slot}
          </button>
        )
      },
      {
        id: 'worn',
        from: 'medium',
        label: t('cards.gear.columns.worn'),
        value: (slot) => slot.worn ?? '',
        cell: (slot) => slot.worn ?? <span className="inert">{t('cards.gear.nothingWorn')}</span>
      },
      {
        id: 'best',
        from: 'large',
        wide: true,
        label: t('cards.gear.columns.best'),
        value: (slot) => slot.items[0]?.name ?? '',
        cell: (slot) => {
          const best = slot.items[0];
          if (best === undefined)
            return <span className="inert">{t('cards.gear.wornIsBest')}</span>;
          return (
            <span className="gear-item" title={sourceWords(best)}>
              {best.name} <span className="chip quiet">{sourceWords(best)}</span>
            </span>
          );
        }
      },
      {
        id: 'buy',
        wide: true,
        label: t('cards.gear.columns.buy'),
        value: (slot) => (picked.get(slot.slot) ?? []).map((item) => item.name).join(', '),
        cell: (slot) => {
          const items = picked.get(slot.slot) ?? [];
          if (items.length === 0)
            return <span className="inert">{t('cards.gear.nothingPicked')}</span>;
          return (
            <span className="gear-item">
              {items.map((item) => (
                <span key={item.item}>
                  {item.name}{' '}
                  <span className="chip">
                    {item.charged === null ? t('cards.gear.unpriced') : copper(item.charged)}
                  </span>{' '}
                </span>
              ))}
            </span>
          );
        }
      },
      {
        id: 'take',
        control: true,
        label: t('cards.gear.columns.take'),
        value: (slot) => (picked.has(slot.slot) ? 1 : 0),
        cell: (slot) => (
          <input
            aria-label={t('cards.gear.takeLabel', { slot: slot.slot })}
            checked={picked.has(slot.slot)}
            disabled={!picked.has(slot.slot) && !basket.has(slot.slot)}
            onChange={() =>
              setOverrides((was) => {
                const next = { ...was };
                if (picked.has(slot.slot)) next[slot.slot] = [];
                else delete next[slot.slot];
                return next;
              })
            }
            type="checkbox"
          />
        )
      }
    ],
    [open, picked, basket]
  );

  const doPlan = useCallback(() => {
    setPlanning(true);
    void planGear(picks).then(
      (answer) => {
        setPlan(answer);
        setPlanning(false);
        setFace('trip');
      },
      (error: unknown) => {
        setFailed(errorMessage(error));
        setPlanning(false);
      }
    );
  }, [planGear, picks]);

  const refresh = useCallback(() => setAsked((n) => n + 1), []);
  const actions = useMemo(
    () => [{ id: 'refresh', icon: 'reset' as const, label: t('cards.gear.refresh'), run: refresh }],
    [refresh]
  );
  const copyText = useCallback(() => gearCopyText(choices), [choices]);
  const opened = choices?.slots.find((slot) => slot.slot === open) ?? null;
  const running = trip !== null && trip.stage !== 'ended';

  const slotsFace = (
    <>
      <div className="gear-head">
        <BudgetField budget={budget} cash={cash} onChange={setBudgetSet} purse={purse} />
        {choices?.unread ? <span className="hunt-note">{t('cards.gear.unread')}</span> : null}
        {failed === null ? null : (
          <span className="hunt-note">{t('cards.gear.failed', { why: failed })}</span>
        )}
      </div>
      <CardTable
        caption={t('cards.gear.caption')}
        className="gear-table"
        columns={columns}
        detailKey={open}
        empty={loading ? t('cards.gear.loading') : t('cards.gear.none')}
        find={t('cards.gear.find')}
        keyOf={(slot) => slot.slot}
        name="gear"
        onDetailHidden={() => setOpen(null)}
        rows={choices?.slots ?? []}
        session={session}
      />
      {opened === null ? null : (
        <SlotDetail
          onPick={(item) => pick(opened, picked.get(opened.slot) ?? [], item)}
          picked={picked.get(opened.slot) ?? []}
          slot={opened}
        />
      )}
      <div className="loop-controls gear-actions">
        <span className="hunt-note">
          {cost.count === 0
            ? t('cards.gear.pickedNone')
            : cost.count === 1
              ? t('cards.gear.pickedCost.one', {
                  cost: copper(cost.copper),
                  budget: copper(budget)
                })
              : t('cards.gear.pickedCost.many', {
                  count: cost.count,
                  cost: copper(cost.copper),
                  budget: copper(budget)
                })}
          {cost.unpriced > 0 ? ` ${unpricedWords(cost.unpriced)}` : ''}
        </span>
        <button
          className="primary"
          disabled={cost.count === 0 || planning || running}
          onClick={doPlan}
          type="button"
        >
          {planning ? t('cards.gear.planning') : t('cards.gear.plan')}
        </button>
      </div>
    </>
  );

  const shown = running ? trip.plan : plan;
  const tabs: CardTab[] = [
    { id: 'slots', label: t('cards.gear.title'), content: slotsFace, paned: true },
    ...(shown === null
      ? []
      : [
          {
            id: 'trip',
            label: t('cards.gear.tripFace'),
            paned: true,
            content: (
              <GearTripFace
                onGo={(run) => void goGear(picks, run)}
                onReplan={doPlan}
                onStop={stopGear}
                plan={shown}
                trip={trip}
              />
            )
          }
        ])
  ];

  return (
    <BentoCard
      {...chrome}
      actions={actions}
      active={face}
      className="gear-card"
      copyText={copyText}
      onActive={setFace}
      tabs={tabs}
      title={t('cards.gear.title')}
    />
  );
}

/** The budget: a slider over the cash there is, and the figure beside it. */
function BudgetField({
  budget,
  cash,
  purse,
  onChange
}: {
  budget: number;
  cash: number | null;
  purse: number | null;
  onChange(value: number | null): void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const top = Math.max(cash ?? 0, budget);
  return (
    <div className="gear-budget">
      <label className="card-settings-field">
        <span>
          {cash === null
            ? t('cards.gear.cashUnread')
            : purse === null
              ? t('cards.gear.cashBanksOnly', { banked: copper(cash) })
              : t('cards.gear.cash', {
                  purse: copper(purse),
                  banked: copper(cash - purse)
                })}
        </span>
        <input
          aria-label={t('cards.gear.budget')}
          disabled={top === 0}
          max={top}
          min={0}
          onChange={(event) => {
            setTyped(null);
            const value = Number(event.target.value);
            onChange(cash !== null && value >= cash ? null : value);
          }}
          step={Math.max(1, Math.round(top / 200))}
          type="range"
          value={budget}
        />
      </label>
      <input
        aria-label={t('cards.gear.budget')}
        className="gear-budget-figure"
        inputMode="numeric"
        onBlur={() => setTyped(null)}
        onChange={(event) => {
          setTyped(event.target.value);
          const value = Number(event.target.value.replace(/[^0-9]/g, ''));
          if (Number.isFinite(value)) onChange(value);
        }}
        value={typed ?? String(budget)}
      />
    </div>
  );
}

/** A slot's better items, best first, each pickable in place of the budget's choice. */
function SlotDetail({
  slot,
  picked,
  onPick
}: {
  slot: GearSlot;
  picked: readonly GearChoice[];
  onPick(item: number): void;
}) {
  return (
    <div className="scroller gear-detail">
      <ul className="gear-options">
        {slot.items.map((item) => {
          const on = picked.some((each) => each.item === item.item);
          return (
            <li data-picked={on ? 'true' : 'false'} key={item.item}>
              <button
                aria-pressed={on}
                className="chip-button"
                disabled={item.sold === null}
                onClick={() => onPick(item.item)}
                onMouseDown={keepFocus}
                type="button"
              >
                {on ? t('cards.gear.unpick') : t('cards.gear.pick')}
              </button>{' '}
              <b>{item.name}</b> {gainWords(item.gain)}
              {item.minLevel === null ? '' : ` ${t('cards.gear.level', { level: item.minLevel })}`}
              <div className="aside">{sourceWords(item)}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default memo(GearCard);
