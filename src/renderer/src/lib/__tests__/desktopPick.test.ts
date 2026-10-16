import { describe, expect, it } from 'vitest';

import { pickDesktopAlert, type DesktopMoment } from '../desktopPick';
import type { AlertRule, Notice } from '@shared/notifications';

/* Todo 157: which arrival goes out as a desktop notification, and what held the rest. */
describe('picking the desktop notification', () => {
  const rule = (over: Partial<AlertRule> & { on: AlertRule['on'] }): AlertRule => ({
    enabled: true,
    level: null,
    alert: true,
    notify: true,
    whileFocused: false,
    onlyAway: false,
    sound: false,
    side: 'below',
    value: 0,
    percent: false,
    name: '',
    quietSeconds: 0,
    ...over
  });
  const rules = [rule({ on: 'arrived' }), rule({ on: 'attacked' })];
  const arrival = (at: number, about: string, over: Partial<Notice> = {}): Notice => ({
    id: `a${at}`,
    at,
    severity: 'info',
    channel: 'movement',
    desktop: 'arrived',
    event: 'arrived',
    about,
    text: `Arrived at ${about}`,
    ...over
  });
  const GAP = 60_000;

  /* The window's clock between passes, as the hook keeps it. */
  function passes(inFront = false) {
    const spoke = new Map<string, number>();
    return (fresh: Notice[], now: number) => {
      const moment: DesktopMoment = {
        inFront,
        away: false,
        now,
        gapMs: GAP,
        spokeAt: (rests) => spoke.get(rests)
      };
      const pick = pickDesktopAlert(fresh, rules, moment);
      if (pick.raise !== null) spoke.set(pick.raise.rests, now);
      return pick;
    };
  }

  it('raises two arrivals for different rooms inside the gap', () => {
    const pass = passes();
    expect(pass([arrival(0, '7/1500')], 0).raise?.notice.id).toBe('a0');
    expect(pass([arrival(5_000, '7/1523')], 5_000).raise?.notice.id).toBe('a5000');
  });

  /* The control: the gap is live, and it holds the same room said again. */
  it('holds a second arrival in the same room inside the gap, and says so', () => {
    const pass = passes();
    pass([arrival(0, '7/1523')], 0);
    const again = pass([arrival(5_000, '7/1523')], 5_000);
    expect(again.raise).toBeNull();
    expect(again.held).toEqual([{ notice: arrival(5_000, '7/1523'), kind: 'arrived', why: 'gap' }]);
  });

  /*
   * The focus rule: an ordinary arrival is held while the window is in front
   * and reports nothing, since the row's `whileFocused` is the player's
   * choice; a stop-short one is raised.
   */
  it('raises a stop-short arrival while the window is in front', () => {
    const pass = passes(true);
    const plain = pass([arrival(0, '7/1500')], 0);
    expect(plain.raise).toBeNull();
    expect(plain.held).toEqual([]);

    const short = pass([arrival(1_000, '7/1523', { stoppedShort: true })], 1_000);
    expect(short.raise?.notice.id).toBe('a1000');
    expect(short.held).toEqual([]);
  });

  /*
   * A focused ordinary arrival is reported by nothing, with a gap-held arrival
   * in the same window as the control that holds are reported there.
   */
  it('reports a gap-held arrival and nothing for one held by focus', () => {
    const pass = passes(true);
    pass([arrival(0, '7/1523', { stoppedShort: true })], 0);
    const again = pass([arrival(5_000, '7/1523', { stoppedShort: true })], 5_000);
    expect(again.held.map((each) => each.why)).toEqual(['gap']);
    expect(pass([arrival(6_000, '7/1500')], 6_000).held).toEqual([]);
  });

  /* One per pass: an arrival passed over for a newer alert is said, not lost. */
  it('reports an arrival a newer alert replaced in the same pass', () => {
    const blow: Notice = {
      id: 'b1',
      at: 1,
      severity: 'critical',
      channel: 'combat',
      desktop: 'attacked',
      event: 'attacked',
      text: 'Rand hits you'
    };
    const pick = passes()([arrival(0, '7/1523'), blow], 1);
    expect(pick.raise?.notice.id).toBe('b1');
    expect(pick.held).toEqual([{ notice: arrival(0, '7/1523'), kind: 'arrived', why: 'newer' }]);
  });
});
