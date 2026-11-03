import { describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import { SessionSwitches } from '../SessionSwitches';

/*
 * Todo 20261102-1830-01: auto-combat is the session's switch, on unless
 * something turned it off for now, and back on at a lap, an arrival and a
 * dial. Nothing here writes a file.
 */
function made() {
  const notices: string[] = [];
  let changes = 0;
  const switches = new SessionSwitches({
    notice: (message) => void notices.push(message),
    changed: () => void (changes += 1)
  });
  return { switches, notices, changes: () => changes };
}

describe('the switches a session holds', () => {
  it('starts with auto-combat on', () => {
    const { switches } = made();
    expect(switches.on('combat')).toBe(true);
    expect(switches.snapshot).toEqual({ combat: true });
  });

  it('flips and tells the trace once per change', () => {
    const { switches, changes } = made();
    switches.set('combat', false);
    switches.set('combat', false);
    expect(switches.on('combat')).toBe(false);
    expect(changes()).toBe(1);
    switches.set('combat', true);
    expect(changes()).toBe(2);
  });

  it('turns it back on with the reason, only where it is off', () => {
    const { switches, notices } = made();
    // Positive control: on already, nothing is said or changed.
    expect(switches.backOn('combat', 'lap')).toBe(false);
    expect(notices).toEqual([]);
    switches.set('combat', false);
    expect(switches.backOn('combat', 'lap')).toBe(true);
    expect(switches.on('combat')).toBe(true);
    expect(notices).toEqual(['lap']);
  });

  it('is back on at a dial, and says so once', () => {
    const { switches, notices } = made();
    switches.dialled();
    // Positive control: a dial with it on says nothing.
    expect(notices).toEqual([]);
    switches.set('combat', false);
    switches.dialled();
    expect(switches.on('combat')).toBe(true);
    expect(notices).toEqual([t('automation.combat.onAtDial')]);
  });

  it("flips a held switch itself and hands the file's to the writer", () => {
    const { switches } = made();
    const written: string[] = [];
    const write = (name: string, on: boolean): boolean => {
      written.push(`${name}:${String(on)}`);
      return on;
    };
    expect(switches.flip('combat', false, write)).toBe(true);
    expect(switches.on('combat')).toBe(false);
    expect(written).toEqual([]);
    expect(switches.flip('sneak', true, write)).toBe(true);
    expect(switches.flip('sneak', false, write)).toBe(false);
    expect(written).toEqual(['sneak:true', 'sneak:false']);
  });
});
