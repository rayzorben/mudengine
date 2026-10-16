/**
 * Auto-Rest turned off is put back on (todo 148, the user's answer of
 * 2026-10-15): at the start of a walk or a loop, on arriving where the player
 * asked to go, and on connecting. Off is for the walk under way; the next one
 * stops to rest again unless the player turns it off again. See
 * `mudengine-automation` › parts/recovery.md › *Auto-Rest is for the walk under way*.
 */
import { t } from '../app/i18n';
import type { TravelSession } from './Travel';
import { switchedOn } from './switchedOn';

/** Where the switch goes back on. */
export type RestBackAt = 'walk' | 'loop' | 'arrived' | 'connected';

/** What the switch is written through: `TravelSession`'s own three. */
export type AutoRestHost = Pick<TravelSession, 'config' | 'switchAutomation' | 'notice'>;

export class AutoRestBack {
  constructor(private readonly host: AutoRestHost) {}

  /** Writes it on where it is off, and says so, or says the file refused. */
  backOn(at: RestBackAt): void {
    if (this.host.config().health.autoRest) return;
    const on = this.host.switchAutomation('autoRest', true);
    this.host.notice(on ? said(at) : refused(at), 'auto-rest-back');
  }

  /**
   * `start` with the switch put back on first, so the first room is judged
   * with it on; a start refused anyway leaves it off as it was, and says
   * nothing. `start` answers its refusal or null.
   */
  around(at: 'walk' | 'loop', start: () => string | null): string | null {
    if (this.host.config().health.autoRest) return start();
    const run = switchedOn((on) => this.host.switchAutomation('autoRest', on), start);
    if (!run.written) {
      // The file refused: the start goes ahead with it off, said once it has.
      const answer = start();
      if (answer === null) this.host.notice(refused(at), 'auto-rest-back');
      return answer;
    }
    if (run.answer === null) this.host.notice(said(at), 'auto-rest-back');
    return run.answer;
  }
}

function said(at: RestBackAt): string {
  switch (at) {
    case 'walk':
      return t('automation.autoRest.onForWalk');
    case 'loop':
      return t('automation.autoRest.onForLoop');
    case 'arrived':
      return t('automation.autoRest.onArrived');
    case 'connected':
      return t('automation.autoRest.onConnected');
    default: {
      const unreachable: never = at;
      return unreachable;
    }
  }
}

function refused(at: RestBackAt): string {
  switch (at) {
    case 'walk':
      return t('automation.autoRest.onForWalkRefused');
    case 'loop':
      return t('automation.autoRest.onForLoopRefused');
    case 'arrived':
      return t('automation.autoRest.onArrivedRefused');
    case 'connected':
      return t('automation.autoRest.onConnectedRefused');
    default: {
      const unreachable: never = at;
      return unreachable;
    }
  }
}
