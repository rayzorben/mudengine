import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import { tuning } from '../lib/tuning';
import {
  compareSpots,
  fightUnpriced,
  huntLoop,
  loopNameOf,
  type HuntingAdvice,
  type HuntingRoom,
  type HuntingSpot,
  type HuntingUnknown
} from '@shared/hunting';
import type { AfflictionKind } from '@shared/menace';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { Loop } from '@shared/loops';
import type { LoopDestination } from '../lib/loops';

/**
 * Where to hunt: every lair the exits reach from where this character
 * stands, priced by the realm's own respawn clock and the same arithmetic
 * the Room card prices a fight with, the loop sized to the clock and filled
 * from the lairs beside it, best first (todo 05, 2026-09-12; revamped todo
 * 00, 2026-09-13).
 *
 * **A table, because the player does not control its length** — the realm
 * decides how many lairs there are — and the rate is the one dimension worth
 * cutting it by. Distance is a column: the walk there is automated, so how
 * far a lair is decides nothing but the walk. A row opens the figures the
 * rate was decided on, the monsters with what each pays and puts on the
 * character, and the rooms the loop would walk; from there *Walk there*
 * opens the route panel on the first room, *Loop it* hands the stops to the
 * lap runner unsaved, and *Create loop* opens the builder with them picked
 * and a name offered, where the loop is drawn, edited and filed.
 *
 * Nothing here is a prediction. What was left out before the ranking — too
 * dangerous, or beneath this level — is counted in the head; a spot whose
 * rate could not be finished says which part was unknown and ranks below
 * every known rate; one whose fight itself could not be priced ranks below
 * those, nearest first and never by what it pays, and the head says how many;
 * a deadly spot is last. A move re-asks on `huntReaskMs`, since only the
 * steps column moves with the character.
 */
export interface HuntingCardProps extends CardChrome {
  session: SessionId;
  /** Asks main, addressed at this card's own character; `measure` is a rough row opened. */
  loadHunting(measure: string | null): ReturnType<IpcApi['huntingGrounds']>;
  /** Opens the route panel on a room; null on a pinned float. */
  chooseOnMap: ((map: number, room: number) => void) | null;
  /** Walks a loop built here, filed or not; null on a pinned float. */
  runLoop: ((loop: Loop, destination: LoopDestination) => void) | null;
  /** Opens the builder with these stops picked and this name offered; null on a pinned float. */
  createLoop: ((rooms: HuntingRoom[], name: string) => void) | null;
  /** The room the character stands in, so a move re-asks. */
  hereKey: string | null;
}

/** Two literal calls per word, as the dictionary's coverage test reads them. */
const UNKNOWN_WORD: Record<HuntingUnknown, () => string> = {
  experience: () => t('cards.hunting.unknown.experience'),
  rounds: () => t('cards.hunting.unknown.rounds'),
  damage: () => t('cards.hunting.unknown.damage'),
  respawn: () => t('cards.hunting.unknown.respawn'),
  rest: () => t('cards.hunting.unknown.rest'),
  health: () => t('cards.hunting.unknown.health'),
  mana: () => t('cards.hunting.unknown.mana'),
  poison: () => t('cards.hunting.unknown.poison')
};
const AFFLICTION_WORD: Record<AfflictionKind, () => string> = {
  poison: () => t('cards.hunting.afflicts.poison'),
  blinded: () => t('cards.hunting.afflicts.blinded'),
  held: () => t('cards.hunting.afflicts.held')
};
const unknownWords = (parts: readonly HuntingUnknown[]): string =>
  parts.map((part) => UNKNOWN_WORD[part]()).join(', ');

const hours = (rate: number | null): string =>
  rate === null ? '?' : Math.round(rate).toLocaleString();
const seconds = (value: number | null): string => (value === null ? '?' : `${Math.round(value)}s`);
const percent = (share: number | null): string =>
  share === null ? '?' : `${Math.round(share * 100)}%`;
/** A floor, marked as one: the least the room can cost where a spawn's rounds are unknown. */
const atLeast = (share: number | null): string =>
  share === null ? '?' : `\u2265 ${percent(share)}`;

function mobsOf(spot: HuntingSpot): string {
  return spot.mobs.map((mob) => mob.name).join(', ');
}

/** A monster's own regeneration clock, in the realm's own unit: hours. */
function mobClock(regenSeconds: number): string {
  const hoursOf = Math.round((regenSeconds / 3600) * 10) / 10;
  return hoursOf === 1
    ? t('cards.hunting.mobClock.one', { hours: hoursOf })
    : t('cards.hunting.mobClock.many', { hours: hoursOf });
}

/** Every lair the survey kept, measured or not, in one order. */
function everySpot(advice: HuntingAdvice): HuntingSpot[] {
  return [...advice.spots, ...advice.unmeasured].sort(compareSpots);
}

export function huntingCopyText(advice: HuntingAdvice | null): string {
  if (advice === null) return t('cards.hunting.title');
  return [
    t('cards.hunting.title'),
    ...everySpot(advice).map((spot) =>
      t('cards.hunting.copyRow', {
        mobs: mobsOf(spot),
        rate: hours(spot.estimate.expPerHour),
        rooms: spot.walk.length,
        steps: spot.rooms[0]?.steps ?? 0
      })
    )
  ].join('\n');
}

function HuntingCard({
  session,
  loadHunting,
  chooseOnMap,
  runLoop,
  createLoop,
  hereKey,
  ...chrome
}: HuntingCardProps) {
  const [advice, setAdvice] = useState<HuntingAdvice | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  /* A rough row opened, measured on the next ask so what it walks is a ring. */
  const [measure, setMeasure] = useState<string | null>(null);
  /* When main was last asked, and which press it answered: a move waits its turn, a press does not. */
  const lastAsk = useRef(0);
  const answered = useRef(asked);
  const answeredMeasure = useRef(measure);

  useEffect(() => {
    let stale = false;
    let timer: number | undefined;
    const run = (): void => {
      lastAsk.current = Date.now();
      setLoading(true);
      void loadHunting(measure).then((answer) => {
        if (stale) return;
        setAdvice(answer);
        setLoading(false);
      });
    };
    /*
     * The sweep is realm-wide and costs main a few hundred milliseconds, and
     * a lap moves every second and a quarter; a step changes nothing but the
     * steps column, so a move re-asks on `huntReaskMs` and *Ask again* at once.
     */
    const pressed = asked !== answered.current || measure !== answeredMeasure.current;
    answered.current = asked;
    answeredMeasure.current = measure;
    const due = lastAsk.current + tuning().huntReaskMs - Date.now();
    if (pressed || due <= 0) run();
    else timer = window.setTimeout(run, due);
    return () => {
      stale = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // `hereKey` is the room: a step re-asks, because the steps moved.
  }, [loadHunting, asked, hereKey, measure]);

  const refresh = useCallback(() => setAsked((n) => n + 1), []);

  const rows = useMemo(() => (advice === null ? [] : everySpot(advice)), [advice]);
  const rough = useMemo(() => new Set(advice?.unmeasured.map((spot) => spot.key) ?? []), [advice]);

  const spotColumns: Array<Column<HuntingSpot>> = useMemo(
    () => [
      {
        id: 'mobs',
        label: t('cards.hunting.columns.lair'),
        wide: true,
        value: (spot) => `${mobsOf(spot)} ${spot.walk.map((room) => room.name).join(' ')}`,
        cell: (spot) => (
          <span className="hunt-lair">
            <button
              aria-expanded={open === spot.key}
              className="lookup"
              onClick={() => {
                setOpen(open === spot.key ? null : spot.key);
                if (rough.has(spot.key)) setMeasure(spot.key);
              }}
              onMouseDown={keepFocus}
              type="button"
            >
              {mobsOf(spot)}
            </button>
            {spot.boss ? <span className="chip quiet">{t('cards.hunting.boss')}</span> : null}
            {rough.has(spot.key) ? (
              <span className="chip quiet" title={t('cards.hunting.roughLong')}>
                {t('cards.hunting.rough')}
              </span>
            ) : null}
          </span>
        )
      },
      {
        id: 'rate',
        label: t('cards.hunting.columns.rate'),
        numeric: true,
        value: (spot) => spot.estimate.expPerHour ?? spot.estimate.ceilingPerHour ?? null,
        cell: (spot) =>
          spot.estimate.deadly ? (
            <span className="chip bad">{t('cards.hunting.deadly')}</span>
          ) : spot.estimate.expPerHour === null ? (
            <span
              className="chip quiet"
              title={t('cards.hunting.unknownParts', {
                parts: unknownWords(spot.estimate.unknown)
              })}
            >
              {t('cards.hunting.ceiling', { rate: hours(spot.estimate.ceilingPerHour) })}
            </span>
          ) : (
            hours(spot.estimate.expPerHour)
          )
      },
      {
        id: 'rooms',
        label: t('cards.hunting.columns.rooms'),
        numeric: true,
        value: (spot) => spot.walk.length,
        cell: (spot) =>
          t('cards.hunting.roomsCell', { loop: spot.walk.length, total: spot.roomCount })
      },
      {
        id: 'steps',
        label: t('cards.hunting.columns.steps'),
        numeric: true,
        value: (spot) => spot.rooms[0]?.steps ?? null
      },
      {
        id: 'cost',
        label: t('cards.hunting.columns.cost'),
        numeric: true,
        // The worst the room can spawn, which is what the exclusions read and
        // what a person deciding whether to start there wants to know — and
        // the floor under it, marked as a floor, where a spawn's rounds are
        // unknown: a room that costs *at least* half the bar is not a room
        // whose cost is unknown.
        value: (spot) => {
          const share = spot.estimate.worstShare ?? spot.estimate.worstShareAtLeast;
          return share === null ? null : Math.round(share * 100);
        },
        cell: (spot) =>
          spot.estimate.worstShare === null
            ? atLeast(spot.estimate.worstShareAtLeast)
            : percent(spot.estimate.worstShare)
      }
    ],
    [open, rough]
  );

  const opened = rows.find((spot) => spot.key === open) ?? null;
  const closeDetail = useCallback(() => setOpen(null), []);
  const copyText = useCallback(() => huntingCopyText(advice), [advice]);
  const actions = useMemo(
    () => [
      { id: 'refresh', icon: 'reset' as const, label: t('cards.hunting.refresh'), run: refresh }
    ],
    [refresh]
  );

  const leftOut =
    advice !== null && advice.excluded.dangerous + advice.excluded.beneath > 0
      ? t('cards.hunting.excluded', {
          dangerous: advice.excluded.dangerous,
          beneath: advice.excluded.beneath
        })
      : '';
  /*
   * A fight nobody could price is listed nearest first rather than by what it
   * pays, and the head says so — on a realm whose kill arithmetic is not this
   * family's, that is every row, and a list that looked ranked was the bug.
   */
  const unpricedCount = rows.filter((spot) => fightUnpriced(spot.estimate)).length;
  const unpriced =
    unpricedCount === 0
      ? ''
      : unpricedCount === 1
        ? t('cards.hunting.unpricedOne')
        : t('cards.hunting.unpricedMany', { count: unpricedCount });
  const recorded = advice?.assumptions.measured ?? null;
  const measured =
    recorded === null
      ? ''
      : t('cards.hunting.measured', {
          perRound: Math.round(recorded.perRound),
          fights: recorded.fights.toLocaleString(),
          level: recorded.fromLevel
        });

  return (
    <BentoCard
      {...chrome}
      actions={actions}
      copyText={copyText}
      paned
      title={t('cards.hunting.title')}
    >
      <div className="hunt-head">
        <span className="hunt-note">
          {advice?.refusal !== null && advice?.refusal !== undefined
            ? advice.refusal
            : loading
              ? t('cards.hunting.loading')
              : advice === null
                ? ''
                : [
                    t('cards.hunting.from', {
                      room: advice.from?.name ?? '',
                      count: rows.length.toLocaleString(),
                      swept: advice.swept.toLocaleString()
                    }),
                    measured,
                    leftOut,
                    unpriced
                  ]
                    .filter((sentence) => sentence !== '')
                    .join(' ')}
        </span>
      </div>
      <CardTable
        caption={t('cards.hunting.caption')}
        className="hunt-table"
        columns={spotColumns}
        detailKey={open}
        empty={loading ? t('cards.hunting.loading') : t('cards.hunting.none')}
        find={t('cards.hunting.find')}
        keyOf={(spot) => spot.key}
        name="hunting"
        onDetailHidden={closeDetail}
        rowAttrs={(spot) => ({ 'data-open': open === spot.key ? 'true' : 'false' })}
        rows={rows}
        session={session}
      />
      {/*
        The figures scroll and the three buttons do not.

        Two panes rather than one block: the detail is as long as the lair's
        room list, the card body is `paned` and clips what will not fit, and
        what would not fit was the row of controls at the bottom — so a spot
        opened on a short card, or a card resized down, drew a lair nobody
        could walk to, loop or build from. The buttons are the card's own last
        row, outside the scrolling part and shrinking for nothing; anchoring
        them to the bottom rather than standing them in a column of their own
        keeps the rail's 260px narrow end readable, where three buttons beside
        a `.readout` would leave neither room to breathe.
      */}
      {opened === null ? null : (
        <>
          <SpotDetail
            backstab={advice?.assumptions.backstab === true}
            chooseOnMap={chooseOnMap}
            spot={opened}
          />
          <SpotActions
            chooseOnMap={chooseOnMap}
            createLoop={createLoop}
            rough={rough.has(opened.key)}
            runLoop={runLoop}
            spot={opened}
          />
        </>
      )}
    </BentoCard>
  );
}

function SpotDetail({
  spot,
  backstab,
  chooseOnMap
}: {
  spot: HuntingSpot;
  backstab: boolean;
  chooseOnMap: HuntingCardProps['chooseOnMap'];
}) {
  const { estimate } = spot;
  const poisonUnknown = estimate.unknown.includes('poison');
  return (
    // `scroller`, so the paned body gives it a bounded share and it moves
    // inside it — the card's own rule for anything of a length nobody controls.
    <div className="scroller hunt-detail">
      <div className="readout-box">
        <dl className="readout columns">
          <dt>{t('cards.hunting.detail.rate')}</dt>
          <dd>
            {estimate.deadly
              ? t('cards.hunting.deadlyLong')
              : estimate.expPerHour === null
                ? t('cards.hunting.unknownParts', { parts: unknownWords(estimate.unknown) })
                : t('cards.hunting.detail.rateValue', { rate: hours(estimate.expPerHour) })}
          </dd>
          <dt>{t('cards.hunting.detail.ceiling')}</dt>
          <dd>{t('cards.hunting.detail.rateValue', { rate: hours(estimate.ceilingPerHour) })}</dd>
          <dt>{t('cards.hunting.detail.spawns')}</dt>
          <dd>{spot.spawns ?? 1}</dd>
          <dt>{t('cards.hunting.detail.respawn')}</dt>
          <dd>
            {spot.respawnSeconds === null
              ? '?'
              : spot.clock === 'regenTime'
                ? t('cards.hunting.detail.respawnHours', {
                    hours: Math.round(spot.respawnSeconds / 360) / 10
                  })
                : seconds(spot.respawnSeconds)}
          </dd>
          <dt>{t('cards.hunting.detail.rounds')}</dt>
          <dd>
            {estimate.roundsPerKill === null
              ? '?'
              : t('cards.hunting.detail.roundsValue', {
                  rounds: Math.round(estimate.roundsPerKill * 10) / 10
                })}
            {backstab ? ` ${t('cards.hunting.detail.openerCredited')}` : ''}
          </dd>
          <dt>{t('cards.hunting.detail.cost')}</dt>
          <dd>
            {estimate.damagePerRoom !== null && estimate.worstDamagePerRoom !== null
              ? t('cards.hunting.detail.costValue', {
                  hp: Math.round(estimate.damagePerRoom),
                  share: percent(estimate.damageShare),
                  worst: Math.round(estimate.worstDamagePerRoom),
                  worstShare: percent(estimate.worstShare)
                })
              : estimate.worstDamageAtLeast === null
                ? '?'
                : t('cards.hunting.detail.costAtLeast', {
                    worst: Math.round(estimate.worstDamageAtLeast),
                    worstShare: percent(estimate.worstShareAtLeast)
                  })}
          </dd>
          <dt>{t('cards.hunting.detail.walk')}</dt>
          <dd>
            {t('cards.hunting.detail.walkValue', {
              steps: spot.loopSteps,
              ms: Math.round(estimate.stepMs)
            })}
          </dd>
          {/* Only where the cycle actually casts to recover: a row saying
           *rests* on every melee character would be chrome. */}
          {estimate.healCasts !== null && estimate.healCasts > 0 ? (
            <>
              <dt>{t('cards.hunting.detail.heal')}</dt>
              <dd>{t('cards.hunting.detail.healValue', { casts: estimate.healCasts })}</dd>
            </>
          ) : null}
          {/* And only where poison stands the character before a rest. */}
          {poisonUnknown || (estimate.poisonSeconds !== null && estimate.poisonSeconds > 0) ? (
            <>
              <dt>{t('cards.hunting.detail.poison')}</dt>
              <dd>
                {poisonUnknown
                  ? t('cards.hunting.detail.poisonUnknown')
                  : t('cards.hunting.detail.poisonValue', {
                      seconds: Math.round(estimate.poisonSeconds ?? 0)
                    })}
              </dd>
            </>
          ) : null}
          <dt>{t('cards.hunting.detail.cycle')}</dt>
          <dd className="span">
            {t('cards.hunting.detail.cycleValue', {
              combat: seconds(estimate.combatSeconds),
              rest: seconds(estimate.restSeconds),
              walk: seconds(estimate.walkSeconds),
              wait: seconds(estimate.waitSeconds)
            })}
            {/* The caster's half, only where the character casts: `meditate 0`
                on every melee character would be noise (todo 26). */}
            {estimate.meditateSeconds !== null &&
              estimate.meditateSeconds > 0 &&
              t('cards.hunting.detail.cycleMeditate', {
                meditate: seconds(estimate.meditateSeconds)
              })}
          </dd>
        </dl>
      </div>
      <ul className="hunt-mobs">
        {spot.mobs.map((mob) => (
          <li key={mob.name}>
            <span>
              {mob.name}
              {mob.afflictions.length > 0 ? (
                <span className="hunt-afflicts">
                  {' '}
                  {mob.afflictions.map((each) => AFFLICTION_WORD[each.kind]()).join(', ')}
                </span>
              ) : null}
              {/*
               * A monster on a clock of its own is up on only some laps, and
               * its experience is weighed by how often — so the figure beside
               * it is not what a lap pays. Say which, rather than leave a rate
               * that does not match the list to be puzzled over.
               */}
              {mob.regenSeconds !== null && mob.regenSeconds > 0 ? (
                <span className="hunt-afflicts"> {mobClock(mob.regenSeconds)}</span>
              ) : null}
            </span>
            <span className="quiet">
              {t('cards.hunting.mobFigures', {
                exp: mob.experience === null ? '?' : mob.experience.toLocaleString(),
                rounds: mob.rounds === null ? '?' : Math.round(mob.rounds * 10) / 10,
                perRound: mob.perRound === null ? '?' : Math.round(mob.perRound)
              })}
            </span>
          </li>
        ))}
      </ul>
      <ul className="hunt-rooms">
        {spot.rooms.map((room) => (
          <RoomRow chooseOnMap={chooseOnMap} key={room.id} room={room} />
        ))}
        {spot.roomCount > spot.rooms.length ? (
          <li className="quiet">
            {spot.roomCount - spot.rooms.length === 1
              ? t('cards.hunting.moreRooms.one', { count: 1 })
              : t('cards.hunting.moreRooms.many', { count: spot.roomCount - spot.rooms.length })}
          </li>
        ) : null}
        {spot.filler.length > 0 ? (
          <li className="hunt-subhead">{t('cards.hunting.fillerHead')}</li>
        ) : null}
        {spot.filler.map((room) => (
          <RoomRow chooseOnMap={chooseOnMap} key={room.id} room={room} />
        ))}
      </ul>
    </div>
  );
}

/**
 * What can be done with the lair on screen: go there, run it, build it.
 *
 * The card's last row rather than the tail of the detail above it, so the
 * three are drawn whatever height the card is at — see the note at the call
 * site. Drawn only for a card that can act: a pinned float has no `runLoop`
 * and offers none of them (`HuntingCardProps`), and a spot whose first room
 * the sweep could not place has nowhere to walk to.
 */
function SpotActions({
  spot,
  rough,
  chooseOnMap,
  runLoop,
  createLoop
}: {
  spot: HuntingSpot;
  /** Not measured yet: its walk is a guess, so nothing loops it until the ask that measures it lands. */
  rough: boolean;
  chooseOnMap: HuntingCardProps['chooseOnMap'];
  runLoop: HuntingCardProps['runLoop'];
  createLoop: HuntingCardProps['createLoop'];
}) {
  const first = spot.walk[0];
  if (chooseOnMap === null || runLoop === null || createLoop === null || first === undefined) {
    return null;
  }
  return (
    <div className="loop-controls hunt-actions">
      <button
        className="quiet"
        onClick={() => chooseOnMap(first.map, first.room)}
        onMouseDown={keepFocus}
        type="button"
      >
        {t('cards.hunting.walkThere')}
      </button>
      {/* A one-room spot is a camp, and the runner keeps a one-stop loop
          (todo 108): it dwells, steps to the same stop and dwells again. */}
      <button
        className="quiet"
        disabled={rough}
        onClick={() => runLoop(huntLoop(spot, t), 'none')}
        onMouseDown={keepFocus}
        title={rough ? t('cards.hunting.measuring') : undefined}
        type="button"
      >
        {t('cards.hunting.loopIt')}
      </button>
      {/* The builder draws a way between two places at least, so a camp has
          nothing for it to draw. */}
      <button
        className="quiet"
        disabled={rough || spot.walk.length < 2}
        onClick={() => createLoop(spot.walk, loopNameOf(spot, t))}
        onMouseDown={keepFocus}
        title={
          rough
            ? t('cards.hunting.measuring')
            : spot.walk.length < 2
              ? t('cards.hunting.oneRoomNoLoop')
              : undefined
        }
        type="button"
      >
        {t('cards.hunting.createLoop')}
      </button>
    </div>
  );
}

/** One room of the loop: a control where the panel can open on it, its figures quiet at the end. */
function RoomRow({
  room,
  chooseOnMap
}: {
  room: HuntingRoom;
  chooseOnMap: HuntingCardProps['chooseOnMap'];
}) {
  const label = room.mobs === undefined ? room.name : `${room.name} (${room.mobs.join(', ')})`;
  return (
    <li>
      {chooseOnMap === null ? (
        <span>{label}</span>
      ) : (
        <button
          className="lookup"
          onClick={() => chooseOnMap(room.map, room.room)}
          onMouseDown={keepFocus}
          type="button"
        >
          {label}
        </button>
      )}
      <span className="quiet">
        {room.detour === undefined
          ? t('cards.hunting.roomFigures', { map: room.map, room: room.room, steps: room.steps })
          : t('cards.hunting.fillerFigures', {
              map: room.map,
              room: room.room,
              detour: room.detour
            })}
      </span>
    </li>
  );
}

export default memo(HuntingCard);
