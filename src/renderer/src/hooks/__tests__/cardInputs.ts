/**
 * Every input `App` hands the card context, each one object for the whole
 * test, for the tests that build contexts (`cardContext`, `keptWork`).
 */
import type { CardContextInputs } from '../useCardContext';
import { ZERO_METER } from '../useStreamPressure';
import type { SessionId } from '@shared/ipc';

export const noop = (): void => undefined;
/** A bridge call that never settles: none of these cases makes or waits on one. */
export const pending = (): Promise<never> => new Promise<never>(noop);

export function cardInputs(
  session: SessionId,
  sessions: readonly SessionId[]
): Omit<CardContextInputs, 'nameIndexes'> {
  return {
    api: new Proxy({}, { get: () => pending }) as CardContextInputs['api'],
    session,
    sessions: sessions.map((id) => ({ id })),
    thresholds: {} as CardContextInputs['thresholds'],
    navigationVisible: false,
    size: { cols: 80, rows: 24 },
    meter: ZERO_METER,
    pressure: 'calm',
    realmAt: 1,
    flyout: null,
    loops: [],
    toolbarPins: { pinned: new Set(), toggle: noop },
    remotesFor: () => ({}) as ReturnType<CardContextInputs['remotesFor']>,
    switchesFor: () => ({}) as ReturnType<CardContextInputs['switchesFor']>,
    suppliesFor: () => [],
    dropFor: () => [],
    profileNameFor: () => '',
    ask: noop,
    forget: noop,
    inspect: noop,
    loadWearer: pending,
    loadMap: pending,
    lookupName: pending,
    chooseOnMap: noop,
    peekRoom: noop,
    endPeek: noop,
    goToRoom: noop,
    runHunt: noop,
    createHunt: noop,
    builder: {} as CardContextInputs['builder'],
    openBuilder: noop,
    startMoving: noop,
    stopMoving: noop,
    startLoop: noop,
    reverseLoop: noop,
    openLoops: noop,
    openAreaSearch: noop,
    dial: noop,
    hangUp: noop,
    say: noop,
    startMovingIn: noop,
    stepBackIn: noop,
    selectPlayer: noop,
    selectGang: noop,
    resetStats: noop
  };
}
