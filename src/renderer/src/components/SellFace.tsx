import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import CardTable, { type Column } from './CardTable';
import type { Inspect } from './EntityName';
import Icon from './Icon';
import SellRunView from './SellRunView';
import { itemColumn, numberColumn, weightColumn } from './packColumns';
import { useItemArt } from '../hooks/useItemArt';
import { keepFocus } from '../lib/focus';
import { copperWords } from '../lib/gearPicks';
import { t } from '../lib/i18n';
import {
  keptWords,
  paysOf,
  picksOf,
  sellAskKey,
  sellRows,
  sells,
  type SellDesk,
  type SellRow
} from '../lib/sellWords';
import type { Group } from '../lib/table';
import type { CharacterState } from '@shared/character';
import type { SessionId } from '@shared/ipc';
import type { SellChoice, SellRunPlan, SellRunProgress } from '@shared/sellRun';
import { errorMessage } from '@shared/values';

/**
 * The Inventory card's Sell face: the pack as the pack face lists it, less
 * what is worn, and what lies on the floor of the room, each row with what it
 * pays and the nearest shop that buys it. A row is picked with its own
 * button; *Plan the sale* asks main for the rounds (what fits picked up, the
 * shops in the shortest order, back for the rest) and *Sell* walks them.
 */
export interface SellFaceProps {
  character: CharacterState;
  session: SessionId;
  desk: SellDesk;
  run: SellRunProgress | null;
  inspect: Inspect | undefined;
  goToRoom: ((room: string) => void) | null;
  returnFocus?: () => void;
}

const GROUPS: readonly Group[] = [
  { id: 'pack', label: t('cards.sell.groupPack') },
  { id: 'floor', label: t('cards.sell.groupFloor') }
];

const thingOf = (row: SellRow): SellRow['thing'] => row.thing;

export default function SellFace({
  character,
  session,
  desk,
  run,
  inspect,
  goToRoom,
  returnFocus
}: SellFaceProps) {
  const [choices, setChoices] = useState<SellChoice[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
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

  const toggle = useCallback((key: string) => {
    setPicked((was) => {
      const now = new Set(was);
      if (!now.delete(key)) now.add(key);
      return now;
    });
  }, []);

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
              if (refused === null) setPicked(new Set());
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

  const columns: Column<SellRow>[] = [
    {
      id: 'pick',
      label: '',
      control: true,
      unsortable: true,
      unsearchable: true,
      value: (row) => row.thing.name,
      // No control on a row that cannot go: the reason is in its last cell.
      cell: (row) =>
        sells(row) ? (
          <button
            aria-pressed={picked.has(row.key)}
            className={picked.has(row.key) ? 'row-action worn' : 'row-action'}
            data-action="sell-pick"
            onClick={() => toggle(row.key)}
            onMouseDown={keepFocus}
            title={t('cards.sell.pickTitle', { item: row.thing.name })}
            type="button"
          >
            <Icon name={picked.has(row.key) ? 'check' : 'plus'} />
          </button>
        ) : null
    },
    itemColumn(thingOf, { art, realm: character.realm, inspect }),
    numberColumn(thingOf),
    weightColumn(thingOf),
    {
      id: 'pays',
      label: t('cards.sell.columnPays'),
      numeric: true,
      value: (row) => (sells(row) ? (row.choice.copper ?? 0) * row.count : null),
      cell: (row) =>
        row.choice === null ? null : row.choice.kept === null ? (
          copperWords((row.choice.copper ?? 0) * row.count)
        ) : (
          <span className="chip quiet cased">{keptWords(row.choice.kept, row.choice.quest)}</span>
        )
    },
    {
      id: 'shop',
      label: t('cards.sell.columnShop'),
      from: 'medium',
      value: (row) => row.choice?.shop ?? null,
      cell: (row) =>
        row.choice?.shop == null ? null : (
          <span title={t('cards.sell.shopMoves', { moves: row.choice.moves ?? 0 })}>
            {row.choice.shop}
          </span>
        )
    }
  ];

  const sellable = rows.filter(sells);
  const everyPicked = sellable.length > 0 && sellable.every((row) => picked.has(row.key));
  return (
    <>
      {failed === null ? null : <p className="gear-reach">{failed}</p>}
      {run?.ended == null ? null : <p className="gear-reach">{run.ended}</p>}
      <CardTable
        caption={t('cards.sell.tableCaption')}
        className="carried"
        columns={columns}
        empty={choices === null ? t('cards.sell.loading') : t('cards.sell.none')}
        groupOf={(row) => row.from}
        groups={GROUPS}
        keyOf={(row) => row.key}
        name="sell"
        returnFocus={returnFocus}
        rows={rows}
        session={session}
      />
      <footer className="sell-bar">
        <span className="gear-bar-words">
          {count === 0
            ? t('cards.sell.pickedNone')
            : count === 1
              ? t('cards.sell.picked.one', { pays: copperWords(pays) })
              : t('cards.sell.picked.many', { count, pays: copperWords(pays) })}
        </span>
        <span className="gear-bar-spacer" />
        <button
          data-action="sell-pick-all"
          disabled={sellable.length === 0}
          onClick={() =>
            setPicked(everyPicked ? new Set() : new Set(sellable.map((row) => row.key)))
          }
          type="button"
        >
          {everyPicked ? t('cards.sell.pickNone') : t('cards.sell.pickAll')}
        </button>
        <button
          className="primary"
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
