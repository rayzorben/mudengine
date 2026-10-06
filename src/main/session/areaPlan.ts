/**
 * The rooms an area search walks (`AreaSearch`): every room a trip reaches
 * within the radius (the navigation engine's `tripReach`, so a door the
 * character cannot open walls the rest off), less those whose own monsters it
 * loses to or has no odds for yet (`Errands.monstersIn`: its lair, its
 * residents and what the wire saw refill it). Those are walled for the whole
 * search, so the rooms only reached through one drop out too, and so is the
 * ring one step past the radius, so no walk leaves the rooms judged. The rest
 * are ordered by `orderTour`.
 */
import { t } from '../app/i18n';
import { orderTour, type AreaPlan } from '../../shared/areaSearch';
import type { RoomId } from '../../shared/world';
import type { Errands } from './Errands';

export interface AreaPlanParts {
  here(): RoomId | null;
  errands: Pick<Errands, 'tripReach' | 'monstersIn'>;
}

export function planArea(parts: AreaPlanParts, radius: number): AreaPlan | string {
  const origin = parts.here();
  if (origin === null) return t('session.loop.unknownRoom');
  const open = parts.errands.tripReach();
  if (open === null) return t('session.loop.noRealmData');
  const lose: RoomId[] = [];
  const unread: RoomId[] = [];
  const out = open.within(origin, radius + 1);
  const near = [...out].filter(([, moves]) => moves <= radius).map(([id]) => id);
  // Every way out of the radius steps into the ring first, so walling it keeps each walk in.
  const ring = [...out].filter(([, moves]) => moves > radius).map(([id]) => id);
  for (const id of near) {
    // Where it stands is searched whatever lives there: it is already there.
    if (id === origin) continue;
    const odds = parts.errands.monstersIn(id).map((name) => open.odds.fight(name, id));
    if (odds.some((fight) => fight.kind === 'lose')) lose.push(id);
    // A win nobody could weigh (`survives` null) is not known to be one.
    else if (odds.some((fight) => fight.kind === 'unread' || fight.survives === null)) {
      unread.push(id);
    }
  }
  const walled = new Set([...lose, ...unread, ...ring]);
  const reach = parts.errands.tripReach(walled);
  if (reach === null) return t('session.loop.noRealmData');
  const rooms = new Set(reach.within(origin, radius).keys());
  const behind = near.filter((id) => !rooms.has(id) && !walled.has(id));
  // The moves between two rooms can be more than the radius, never more than twice it.
  const { tour, steps, stranded } = orderTour(origin, rooms, reach.within, radius * 2);
  return { origin, radius, tour, steps, lose, unread, behind, walled: [...walled], stranded };
}
