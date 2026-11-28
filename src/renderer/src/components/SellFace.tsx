import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Inspect } from './EntityName';
import Icon from './Icon';
import SellRunView from './SellRunView';
import SellTile from './SellTile';
import { useItemArt } from '../hooks/useItemArt';
import { copperWords } from '../lib/gearPicks';
import { t } from '../lib/i18n';
import {
  paysOf,
  pickedOf,
  picksOf,
  sellAskKey,
  sellRows,
  sells,
  weightOf,
  withAll,
  withPicked,
  type SellDesk,
  type SellPicked,
  type SellRow
} from '../lib/sellWords';
import type { CharacterState } from '@shared/character';
import type { SellChoice, SellFrom, SellRunPlan, SellRunProgress } from '@shared/sellRun';
import { errorMessage } from '@shared/values';

/**
 * The Inventory card's Sell face: a tile for each thing lying in the room,
 * then one for each thing carried and not worn. A tile says what the thing
 * pays and the nearest shop that buys it, and is its own control: a click
 * picks it, green, and a pile picked says how many of it go. The panel above
 * adds the picks up and weighs the floor's against what the pack still
 * holds. *Plan the sale* asks main for the stops and *Sell* walks them.
 */
export interface SellFaceProps {
  character: CharacterState;
  desk: SellDesk;
  run: SellRunProgress | null;
  inspect: Inspect | undefined;
  goToRoom: ((room: string) => void) | null;
}

const NONE: SellPicked = new Map();

export default function SellFace({ character, desk, run, inspect, goToRoom }: SellFaceProps) {
  const [choices, setChoices] = useState<SellChoice[] | null>(null);
  const [picked, setPicked] = useState<SellPicked>(NONE);
  const [plan, setPlan] = useState<SellRunPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  /** Why the last ask of main failed, said on the face rather than left loading. */
  const [failed, setFailed] = useState<string | null>(null);
  const askKey = sellAskKey(character);
  const running = run !== null && run.stage !== 'ended';

  useEffect(() => {
    // A run moves the pack and the room at every step, and its stops are drawn, not the rows.
    if (running) return undefined;
    let stale = false;
    void desk.load().then(
      (answer) => {
        if (stale) return;
        setChoices(answer);
        setFailed(null);
      },
      (error: unknown) => {
        if (!stale) setFailed(errorMessage(error));
      }
    );
    return () => {
      stale = true;
    };
    // The pack, the floor or the room moving changes what sells and where.
  }, [desk, askKey, running]);

  const rows = useMemo(() => sellRows(character, choices ?? []), [character, choices]);
  const picks = useMemo(() => picksOf(rows, picked), [rows, picked]);
  const pays = useMemo(() => paysOf(rows, picked), [rows, picked]);
  const count = picks.reduce((sum, pick) => sum + pick.count, 0);
  const art = useItemArt();
  const pick = useCallback(
    (row: SellRow, some: number) => setPicked((was) => withPicked(was, row, some)),
    []
  );

  // A plan is for the pack, floor and room it was asked from: once any moves it is put away.
  const asked = useRef(askKey);
  useEffect(() => {
    asked.current = askKey;
    setPlan(null);
  }, [askKey]);

  const doPlan = (): void => {
    const from = askKey;
    setPlanning(true);
    void desk.plan(picks).then(
      (answer) => {
        setPlanning(false);
        if (asked.current !== from) return;
        setPlan(answer);
        setFailed(answer === null ? t('cards.sell.unplanned') : null);
      },
      (error: unknown) => {
        setFailed(errorMessage(error));
        setPlanning(false);
      }
    );
  };

  const shown = running ? run.plan : plan;
  if (shown !== null) {
    return (
      <SellRunView
        goToRoom={goToRoom}
        inspect={inspect}
        onBack={() => setPlan(null)}
        onGo={() => {
          // The run plans again from here; what it walks is what main pushes back.
          void desk.go(picks).then(
            (refused) => {
              if (refused === null) setPicked(NONE);
              // Why it did not set off, on the face as well as in the console.
              else setFailed(refused);
              setPlan(null);
            },
            (error: unknown) => {
              setFailed(errorMessage(error));
              setPlan(null);
            }
          );
        }}
        onStop={desk.stop}
        plan={shown}
        run={run}
      />
    );
  }

  const { encumbrance, encumbranceMax } = character.inventory;
  // What the pack still holds now; what the picks carried weigh comes off it on the way.
  const free =
    encumbrance === null || encumbranceMax === null ? null : encumbranceMax - encumbrance;
  const lifting = weightOf(rows, picked, 'floor');
  const section = (from: SellFrom): SellRow[] => rows.filter((row) => row.from === from);
  const floor = section('floor');
  const pack = section('pack');

  const tiles = (list: readonly SellRow[]) => (
    <ul className="sell-tiles">
      {list.map((row) => (
        <SellTile
          art={art}
          key={row.key}
          onPick={pick}
          picked={pickedOf(row, picked)}
          realm={character.realm}
          row={row}
        />
      ))}
    </ul>
  );
  const head = (from: SellFrom, list: readonly SellRow[], title: string) => (
    <header className="sell-head">
      <h3>{title}</h3>
      <span className="chip quiet">{list.reduce((sum, row) => sum + row.count, 0)}</span>
      <span className="gear-bar-spacer" />
      {from === 'floor' ? (
        <button
          data-action="sell-search"
          onClick={desk.search}
          title={t('cards.sell.searchTitle')}
          type="button"
        >
          <Icon name="search" /> {t('cards.sell.search')}
        </button>
      ) : null}
      <button
        data-action={`sell-all-${from}`}
        disabled={!list.some(sells)}
        onClick={() => setPicked((was) => withAll(was, list))}
        type="button"
      >
        {t('cards.sell.pickAll')}
      </button>
    </header>
  );

  return (
    <>
      <div className="gear-budget sell-sum">
        <div className="gear-budget-figure">
          <span>{t('cards.sell.sumPays')}</span>
          <strong className="sell-sum-figure">{copperWords(pays)}</strong>
        </div>
        <div className="gear-cash">
          <span className="chip cased">
            {count === 1 ? t('cards.sell.sumCount.one') : t('cards.sell.sumCount.many', { count })}
          </span>
          {free === null ? null : (
            <span className="chip cased quiet">
              {t('cards.sell.sumFree', { weight: free.toLocaleString() })}
            </span>
          )}
          {lifting === null || lifting === 0 ? null : (
            <span
              className={`chip cased ${free !== null && lifting > free ? 'warn' : 'quiet'}`}
              title={free !== null && lifting > free ? t('cards.sell.sumLiftingOver') : undefined}
            >
              {t('cards.sell.sumLifting', { weight: lifting.toLocaleString() })}
            </span>
          )}
        </div>
      </div>
      {failed === null ? null : <p className="gear-reach">{failed}</p>}
      {run?.ended == null ? null : <p className="gear-reach">{run.ended}</p>}
      <div className="scroller gear-scroller sell-scroller">
        {choices === null ? <p className="gear-reach">{t('cards.sell.loading')}</p> : null}
        <section className="sell-section" data-from="floor">
          {head('floor', floor, t('cards.sell.groupFloor'))}
          {floor.length === 0 ? (
            <p className="gear-reach">{t('cards.sell.floorNone')}</p>
          ) : (
            tiles(floor)
          )}
        </section>
        <section className="sell-section" data-from="pack">
          {head('pack', pack, t('cards.sell.groupPack'))}
          {pack.length === 0 ? (
            <p className="gear-reach">{t('cards.sell.packNone')}</p>
          ) : (
            tiles(pack)
          )}
        </section>
      </div>
      <footer className="sell-bar">
        <span className="gear-bar-words">
          {count === 0 ? t('cards.sell.pickedNone') : t('cards.sell.pickedHint')}
        </span>
        <span className="gear-bar-spacer" />
        <button
          className="primary gear-plan"
          data-action="sell-plan"
          disabled={count === 0 || planning}
          onClick={doPlan}
          type="button"
        >
          <Icon name="route" /> {planning ? t('cards.gear.planning') : t('cards.sell.plan')}
        </button>
      </footer>
    </>
  );
}
