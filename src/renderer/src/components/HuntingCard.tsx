import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import { tuning } from '../lib/tuning';
import { useRememberedChoice } from '../hooks/useRemembered';
import type { HuntingAdvice, HuntingSpot, HuntingUnknown } from '@shared/hunting';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { Loop } from '@shared/loops';
import type { LoopDestination } from '../lib/loops';

/**
 * Where to hunt: the lairs within reach of where this character stands, each
 * priced by the realm's own respawn clock and the same arithmetic the Room
 * card prices a fight with, best first (todo 05, 2026-09-12).
 *
 * **A table, because the player does not control its length** — the
 * neighbourhood decides how many lairs there are — and the rate is the one
 * dimension worth cutting it by. A row opens the figures the rate was decided
 * on (rounds a kill, what a cycle costs, the rest, the respawn, the walk), the
 * monsters with what each pays, and the rooms a loop would visit; from there
 * *Walk there* opens the route panel on the nearest room and *Loop it* hands
 * the rooms to the lap runner as a loop, filed nowhere or under this
 * character, said out loud either way as the builder's own save is.
 *
 * Nothing here is a prediction. A spot whose rate could not be finished says
 * which part was unknown and is ranked by its ceiling below every known rate;
 * a spot one cycle of which is expected to take the whole bar is *deadly*
 * and last. The radius is a choice remembered per character.
 */
export interface HuntingCardProps extends CardChrome {
  session: SessionId;
  /** Asks main, addressed at this card's own character. */
  loadHunting(radius: number): ReturnType<IpcApi['huntingGrounds']>;
  /** Opens the route panel on a room; null on a pinned float. */
  chooseOnMap: ((map: number, room: number) => void) | null;
  /** Walks a loop built here, filed or not; null on a pinned float. */
  runLoop: ((loop: Loop, destination: LoopDestination) => void) | null;
  /** The room the character stands in, so a move re-asks. */
  hereKey: string | null;
}

/** The three reaches offered, as multiples of the shipped default. */
const REACHES = ['near', 'usual', 'far'] as const;
type Reach = (typeof REACHES)[number];
const REACH_FACTOR: Record<Reach, number> = { near: 0.5, usual: 1, far: 2 };

/** Two literal calls per word, as the dictionary's coverage test reads them. */
const UNKNOWN_WORD: Record<HuntingUnknown, () => string> = {
  experience: () => t('cards.hunting.unknown.experience'),
  rounds: () => t('cards.hunting.unknown.rounds'),
  damage: () => t('cards.hunting.unknown.damage'),
  respawn: () => t('cards.hunting.unknown.respawn'),
  rest: () => t('cards.hunting.unknown.rest'),
  health: () => t('cards.hunting.unknown.health'),
  mana: () => t('cards.hunting.unknown.mana')
};
const REACH_WORD: Record<Reach, () => string> = {
  near: () => t('cards.hunting.reach.near'),
  usual: () => t('cards.hunting.reach.usual'),
  far: () => t('cards.hunting.reach.far')
};
const unknownWords = (parts: readonly HuntingUnknown[]): string =>
  parts.map((part) => UNKNOWN_WORD[part]()).join(', ');

const hours = (rate: number | null): string =>
  rate === null ? '?' : Math.round(rate).toLocaleString();
const seconds = (value: number | null): string => (value === null ? '?' : `${Math.round(value)}s`);
const percent = (share: number | null): string =>
  share === null ? '?' : `${Math.round(share * 100)}%`;

function mobsOf(spot: HuntingSpot): string {
  return spot.mobs.map((mob) => mob.name).join(', ');
}

/** The loop a suggestion would walk, in the stop grammar every loop uses. */
function loopOf(spot: HuntingSpot): Loop {
  return {
    name: t('cards.hunting.loopName', { mobs: mobsOf(spot) }),
    stops: spot.rooms.map((room) => ({ room: `${room.name} ${room.map}/${room.room}` }))
  };
}

export function huntingCopyText(advice: HuntingAdvice | null): string {
  if (advice === null) return t('cards.hunting.title');
  return [
    t('cards.hunting.title'),
    ...advice.spots.map((spot) =>
      t('cards.hunting.copyRow', {
        mobs: mobsOf(spot),
        rate: hours(spot.estimate.expPerHour),
        rooms: spot.roomCount,
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
  hereKey,
  ...chrome
}: HuntingCardProps) {
  const [reach, setReach] = useRememberedChoice(session, 'hunt-reach', REACHES, 'usual');
  const radius = Math.round(tuning().huntRadiusSteps * REACH_FACTOR[reach as Reach]);
  const [advice, setAdvice] = useState<HuntingAdvice | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void loadHunting(radius).then((answer) => {
      if (stale) return;
      setAdvice(answer);
      setLoading(false);
    });
    return () => {
      stale = true;
    };
    // `hereKey` is the room: a step re-asks, because the neighbourhood moved.
  }, [loadHunting, radius, asked, hereKey]);

  const refresh = useCallback(() => setAsked((n) => n + 1), []);

  const spotColumns: Array<Column<HuntingSpot>> = useMemo(
    () => [
      {
        id: 'mobs',
        label: t('cards.hunting.columns.lair'),
        wide: true,
        value: (spot) => `${mobsOf(spot)} ${spot.rooms.map((room) => room.name).join(' ')}`,
        cell: (spot) => (
          <button
            aria-expanded={open === spot.key}
            className="lookup"
            onClick={() => setOpen(open === spot.key ? null : spot.key)}
            onMouseDown={keepFocus}
            type="button"
          >
            {mobsOf(spot)}
          </button>
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
        value: (spot) => spot.roomCount
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
        value: (spot) =>
          spot.estimate.damageShare === null ? null : Math.round(spot.estimate.damageShare * 100),
        cell: (spot) => percent(spot.estimate.damageShare)
      }
    ],
    [open]
  );

  const opened = advice?.spots.find((spot) => spot.key === open) ?? null;
  const closeDetail = useCallback(() => setOpen(null), []);
  const copyText = useCallback(() => huntingCopyText(advice), [advice]);
  const actions = useMemo(
    () => [
      { id: 'refresh', icon: 'reset' as const, label: t('cards.hunting.refresh'), run: refresh }
    ],
    [refresh]
  );

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
                : t('cards.hunting.from', {
                    room: advice.from?.name ?? '',
                    radius: advice.radius,
                    count: advice.spots.length
                  })}
        </span>
        <div className="chips" role="group" aria-label={t('cards.hunting.reachLabel')}>
          {REACHES.map((option) => (
            <button
              aria-pressed={reach === option}
              className={`chip${reach === option ? ' on' : ''}`}
              key={option}
              onClick={() => setReach(option)}
              onMouseDown={keepFocus}
              type="button"
            >
              {REACH_WORD[option]()}
            </button>
          ))}
        </div>
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
        rows={advice?.spots ?? []}
        session={session}
      />
      {opened === null ? null : (
        <SpotDetail
          backstab={advice?.assumptions.backstab === true}
          chooseOnMap={chooseOnMap}
          runLoop={runLoop}
          spot={opened}
        />
      )}
    </BentoCard>
  );
}

function SpotDetail({
  spot,
  backstab,
  chooseOnMap,
  runLoop
}: {
  spot: HuntingSpot;
  backstab: boolean;
  chooseOnMap: HuntingCardProps['chooseOnMap'];
  runLoop: HuntingCardProps['runLoop'];
}) {
  const { estimate } = spot;
  const first = spot.rooms[0];
  return (
    <div className="hunt-detail">
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
            {estimate.damagePerRoom === null
              ? '?'
              : t('cards.hunting.detail.costValue', {
                  hp: Math.round(estimate.damagePerRoom),
                  share: percent(estimate.damageShare)
                })}
          </dd>
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
            <span>{mob.name}</span>
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
          <li key={room.id}>
            {chooseOnMap === null ? (
              <span>{room.name}</span>
            ) : (
              <button
                className="lookup"
                onClick={() => chooseOnMap(room.map, room.room)}
                onMouseDown={keepFocus}
                type="button"
              >
                {room.name}
              </button>
            )}
            <span className="quiet">
              {t('cards.hunting.roomFigures', {
                map: room.map,
                room: room.room,
                steps: room.steps
              })}
            </span>
          </li>
        ))}
        {spot.roomCount > spot.rooms.length ? (
          <li className="quiet">
            {spot.roomCount - spot.rooms.length === 1
              ? t('cards.hunting.moreRooms.one', { count: 1 })
              : t('cards.hunting.moreRooms.many', { count: spot.roomCount - spot.rooms.length })}
          </li>
        ) : null}
      </ul>
      {chooseOnMap !== null && runLoop !== null && first !== undefined ? (
        <div className="loop-controls hunt-actions">
          <button
            className="quiet"
            onClick={() => chooseOnMap(first.map, first.room)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('cards.hunting.walkThere')}
          </button>
          <button
            className="quiet"
            disabled={spot.rooms.length < 2}
            onClick={() => runLoop(loopOf(spot), 'none')}
            onMouseDown={keepFocus}
            title={spot.rooms.length < 2 ? t('cards.hunting.oneRoomNoLoop') : undefined}
            type="button"
          >
            {t('cards.hunting.loopIt')}
          </button>
          <button
            className="quiet"
            disabled={spot.rooms.length < 2}
            onClick={() => runLoop(loopOf(spot), 'profile')}
            onMouseDown={keepFocus}
            title={spot.rooms.length < 2 ? t('cards.hunting.oneRoomNoLoop') : undefined}
            type="button"
          >
            {t('cards.hunting.saveLoop')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default memo(HuntingCard);
