/**
 * The switches a session holds rather than a file (`HeldSwitch`, todo
 * 20261102-1830-01): auto-combat is on unless the toolbar, `@auto-combat` or
 * *Run it* turned it off for now, and a lap, an arrival and a dial turn it
 * back on. Nothing here writes the character's file, so nothing can refuse.
 * The window draws the answers from the trace (`AutomationSnapshot.held`).
 * See `mudengine-settings` › *Settings and the toolbar switches are separate*
 * and `mudengine-automation` › *Auto-combat off is off*.
 */
import {
  HELD_DEFAULTS,
  isHeldSwitch,
  type AutomationSwitch,
  type ConfigSwitch,
  type HeldSwitch,
  type HeldSwitchPort,
  type HeldSwitches
} from '../../shared/automationSwitches';
import { t } from '../app/i18n';

export interface SessionSwitchEvents {
  notice(message: string): void;
  /** A switch flipped: the trace is published again so the toolbar draws it. */
  changed(): void;
}

/** What a dial says for each held switch it turns back on, one literal key each. */
function dialSaid(name: HeldSwitch): string {
  switch (name) {
    case 'combat':
      return t('automation.combat.onAtDial');
    default: {
      const never: never = name;
      return never;
    }
  }
}

export class SessionSwitches implements HeldSwitchPort {
  private held: HeldSwitches = { ...HELD_DEFAULTS };

  constructor(private readonly events: SessionSwitchEvents) {}

  on(name: HeldSwitch): boolean {
    return this.held[name];
  }

  /** Every held switch, for the trace. */
  get snapshot(): HeldSwitches {
    return this.held;
  }

  set(name: HeldSwitch, on: boolean): void {
    if (this.held[name] === on) return;
    this.held = { ...this.held, [name]: on };
    this.events.changed();
  }

  /** Any switch by name: a held one flips here, a file's goes to `write`. Whether it took. */
  flip(
    name: AutomationSwitch,
    on: boolean,
    write: (name: ConfigSwitch, on: boolean) => boolean
  ): boolean {
    if (!isHeldSwitch(name)) return write(name, on);
    this.set(name, on);
    return true;
  }

  backOn(name: HeldSwitch, said: string): boolean {
    if (this.held[name]) return false;
    this.set(name, true);
    this.events.notice(said);
    return true;
  }

  /** A new dial: every switch turned off for the last connection is back on, each said. */
  dialled(): void {
    for (const name of Object.keys(this.held) as HeldSwitch[]) this.backOn(name, dialSaid(name));
  }
}
