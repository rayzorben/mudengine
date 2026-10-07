import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import GearBudget from './GearBudget';
import GearSlotTile from './GearSlotTile';
import GearTripFace from './GearTripFace';
import Icon from './Icon';
import { t } from '../lib/i18n';
import {
  buysOf,
  cashAt,
  copperWords,
  costOf,
  declineKey,
  NO_SAY,
  sourceWords,
  suggestionsOf,
  toggled,
  tripPicks,
  unpricedWords,
  widthOf,
  type GearSay
} from '../lib/gearPicks';
import type { BankBalance } from '@shared/character';
import { bankedCopper } from '@shared/coins';
import type { GearPick, GearTripPlan, GearTripProgress } from '@shared/gearTrip';
import type { IpcApi } from '@shared/ipc';
import { errorMessage } from '@shared/values';
import type { GearChoice, GearChoices, GearSlot } from '@shared/upgrades';

/**
 * Gear: a tile per slot with what is worn, the best the character can wear at
 * its level from anywhere (sold, dropped, or neither, said which), and what
 * the cash it has suggests buying, green to buy and a click to decline. The
 * budget is the purse and every bank on record, set lower with a slider or a
 * figure; what it suggests is each slot's best the copper left still covers,
 * the slot giving most per copper first (`withinBudget`, shared with the
 * planner extension), after any item the player chose instead. *Plan the trip*
 * asks main for the banks and shops in the shortest order, each leg with what
 * it meets; the trip face walks or runs it. Put away by default and found in
 * the palette.
 */
export interface GearCardProps extends CardChrome {
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

/** Slots with something better first, the slots wearing their best after; never moved by a click. */
function inOrder(slots: readonly GearSlot[]): GearSlot[] {
  return [...slots].sort((a, b) => Number(a.items.length === 0) - Number(b.items.length === 0));
}

function GearCard({
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
  const [say, setSay] = useState<GearSay>(NO_SAY);
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
    // What is worn or the level moving changes every slot's answer.
  }, [loadGear, asked, kitKey]);

  const cash = cashAt(purse, banks);
  const budget = budgetSet ?? cash ?? 0;
  const suggested = useMemo(
    () =>
      choices === null
        ? new Map<string, GearChoice[]>()
        : suggestionsOf(choices, budget, say.chosen),
    [choices, budget, say.chosen]
  );
  const buys = useMemo(() => buysOf(suggested, say.declined), [suggested, say.declined]);
  const cost = costOf(buys);
  const picks = useMemo(() => (choices === null ? [] : tripPicks(choices, buys)), [choices, buys]);

  const decline = useCallback((slot: string, item: number) => {
    setSay((was) => {
      const declined = new Set(was.declined);
      const key = declineKey(slot, item);
      if (declined.has(key)) declined.delete(key);
      else declined.add(key);
      return { ...was, declined };
    });
  }, []);
  const choose = useCallback(
    (slot: GearSlot, item: number) =>
      setSay((was) => {
        const current = was.chosen[slot.slot] ?? suggested.get(slot.slot)?.map((each) => each.item);
        const declined = new Set(was.declined);
        declined.delete(declineKey(slot.slot, item));
        return {
          chosen: { ...was.chosen, [slot.slot]: toggled(slot, current ?? [], item) },
          declined
        };
      }),
    [suggested]
  );
  const reset = useCallback((slot: string) => {
    setSay((was) => {
      const chosen = { ...was.chosen };
      delete chosen[slot];
      return { ...was, chosen };
    });
  }, []);

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
  const running = trip !== null && trip.stage !== 'ended';
  const slots = useMemo(() => (choices === null ? [] : inOrder(choices.slots)), [choices]);

  const slotsFace = (
    <>
      <GearBudget
        banked={banks.length === 0 ? null : bankedCopper(banks)}
        budget={budget}
        cash={cash}
        onChange={setBudgetSet}
        purse={purse}
      />
      {choices?.unread || failed !== null ? (
        <p className="gear-reach">
          {failed === null ? t('cards.gear.unread') : t('cards.gear.failed', { why: failed })}
        </p>
      ) : null}
      <div className="scroller gear-scroller">
        {slots.length === 0 ? (
          <p className="gear-reach">{loading ? t('cards.gear.loading') : t('cards.gear.none')}</p>
        ) : (
          <ul className="gear-slots" data-loading={loading ? 'true' : 'false'}>
            {slots.map((slot) => (
              <GearSlotTile
                budget={budget}
                chosen={say.chosen[slot.slot] !== undefined}
                declined={say.declined}
                key={slot.slot}
                onChoose={choose}
                onDecline={decline}
                onReset={reset}
                slot={slot}
                suggested={suggested.get(slot.slot) ?? []}
              />
            ))}
          </ul>
        )}
      </div>
      <footer className="gear-bar">
        <div className="gear-bar-figures">
          <span className="gear-bar-words">
            {cost.count === 0
              ? t('cards.gear.pickedNone')
              : cost.count === 1
                ? t('cards.gear.pickedCost.one', {
                    cost: copperWords(cost.copper),
                    budget: copperWords(budget)
                  })
                : t('cards.gear.pickedCost.many', {
                    count: cost.count,
                    cost: copperWords(cost.copper),
                    budget: copperWords(budget)
                  })}
            {cost.unpriced > 0 ? ` ${unpricedWords(cost.unpriced)}` : ''}
          </span>
          <div className="meter gear-spend" aria-hidden="true">
            <div
              className="fill"
              style={{ width: widthOf(cost.copper, budget) } as CSSProperties}
            />
          </div>
        </div>
        <button
          className="primary gear-plan"
          disabled={cost.count === 0 || planning || running}
          onClick={doPlan}
          type="button"
        >
          <Icon name="route" /> {planning ? t('cards.gear.planning') : t('cards.gear.plan')}
        </button>
      </footer>
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

export default memo(GearCard);
