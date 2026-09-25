/**
 * Play's refusals that no room can change, asked before a press waits to be
 * placed (todo 762). *Already moving*, *nothing to resume* and a name that is
 * no loop each cost an `rm` and up to `session.locateResolveMs` first, for an
 * answer the room never entered into. One reading, and `Travel.startMoving`
 * asks it too, so the press and the play cannot disagree; which movement the
 * character is on stays `movementOf`'s. See `mudengine-session` ›
 * `parts/composition.md`, *A refused word ends the wait*.
 */
import { t } from '../app/i18n';
import type { Locating } from './Locating';
import type { Loop, LoopProgress } from '../../shared/loops';
import type { Movement, MovementStart } from '../../shared/movement';

/** What play's refusals read; `SessionManager` answers it as it stands. */
export interface PlayReading {
  readonly movement: Movement;
  readonly loops: { readonly progress: Pick<LoopProgress, 'name'> };
  loopNamed(name: string): Loop | undefined;
}

/** The session a press plays: the reading, the wait to be placed, and the play. */
export interface PlaySession extends PlayReading {
  readonly locating: Pick<Locating, 'placed'>;
  startMoving(loopName: string | null, confirmed: number | null): MovementStart;
}

/**
 * Whether a name asks for a lap other than the one already stopped: that lap
 * named again is a resume, which is why the name is compared rather than
 * obeyed, and null is the picker's resume entry.
 */
function namesAnother(reading: PlayReading, loopName: string | null): loopName is string {
  return loopName !== null && loopName !== reading.loops.progress.name;
}

/** The loop a name starts, when it names another; undefined for a resume or no such loop. */
export function anotherLoop(reading: PlayReading, loopName: string | null): Loop | undefined {
  return namesAnother(reading, loopName) ? reading.loopNamed(loopName) : undefined;
}

/** Why play refuses wherever the character stands, or null. */
export function refusesToPlay(reading: PlayReading, loopName: string | null): string | null {
  const { movement } = reading;
  if (movement.moving) return t('session.move.alreadyMoving');
  if (namesAnother(reading, loopName)) {
    return reading.loopNamed(loopName) === undefined
      ? t('session.move.noSuchLoop', { name: loopName })
      : null;
  }
  if (movement.kind === 'loop' || (movement.kind === 'route' && movement.resumable)) return null;
  return t('session.move.nothingToResume');
}

/**
 * A press of play: refused at once where the room would not change the
 * answer, else placed first where the realm can say, then played. The
 * session is looked up afresh after the wait, which may outlive the tab;
 * null when there is none either time.
 */
export async function playPlaced(
  find: () => PlaySession | undefined,
  loopName: string | null,
  confirmed: number | null
): Promise<MovementStart | null> {
  const before = find();
  if (before === undefined) return null;
  const refused = refusesToPlay(before, loopName);
  if (refused !== null) return { refused };
  await before.locating.placed();
  return find()?.startMoving(loopName, confirmed) ?? null;
}
