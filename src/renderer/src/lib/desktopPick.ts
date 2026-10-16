/**
 * Which of one character's fresh alerts goes out as a desktop notification,
 * and which rule held back each of the others (`useDesktopAlerts`, todo 157).
 *
 * Pure, so the focus rule, the gap and the one-per-pass rule are tested
 * without a browser's `Notification`. See `mudengine-ui` › `parts/console.md`.
 */
import {
  heldTillAway,
  raisable,
  raisableWhileFocused,
  restsOn,
  type AlertRule,
  type DesktopAlert,
  type Notice
} from '@shared/notifications';

/**
 * What held a notification back that a row marked `notify`: the gap since that
 * kind last spoke, or a newer alert raised in the same pass in its place. The
 * window in front is not one: that is the row's own `whileFocused` doing what
 * the player set, so it is never reported.
 */
export type DesktopHold = 'gap' | 'newer';

export interface DesktopPick {
  /** The one to raise, with the key its kind now rests under. Null for none. */
  raise: { notice: Notice; rests: string } | null;
  /** The ones a row marked `notify` that a rule held back, newest first. */
  held: Array<{ notice: Notice; kind: DesktopAlert; why: DesktopHold }>;
}

export interface DesktopMoment {
  /** Whether the window is in front of the person at it. */
  inFront: boolean;
  /** Whether nobody is at this character's keyboard, for a row's `onlyAway`. */
  away: boolean;
  now: number;
  /** `tuning.desktopAlertGapMs`. */
  gapMs: number;
  /** When the kind under this key last spoke, if it has. */
  spokeAt(rests: string): number | undefined;
}

/**
 * The newest fresh notice a row raises that no rule holds, and why each other
 * one a row raises was held. A kind rests per thing it is about
 * (`Notice.about`), so an arrival in another room is not held by the last one.
 * A row's `onlyAway` and `whileFocused` are the player's own choice, not holds
 * to report.
 */
export function pickDesktopAlert(
  fresh: readonly Notice[],
  rules: readonly AlertRule[],
  moment: DesktopMoment
): DesktopPick {
  let raise: DesktopPick['raise'] = null;
  const held: DesktopPick['held'] = [];
  for (let at = fresh.length - 1; at >= 0; at -= 1) {
    const notice = fresh[at]!;
    const kind = raisable(notice, rules);
    if (kind === null || heldTillAway(notice, rules, moment.away)) continue;
    if (moment.inFront && !raisableWhileFocused(notice, rules)) continue;
    if (raise !== null) {
      held.push({ notice, kind, why: 'newer' });
      continue;
    }
    const rests = `${kind}${restsOn(notice)}`;
    if (moment.now - (moment.spokeAt(rests) ?? -Infinity) < moment.gapMs) {
      held.push({ notice, kind, why: 'gap' });
      continue;
    }
    raise = { notice, rests };
  }
  return { raise, held };
}
