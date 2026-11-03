import { describe, expect, it } from 'vitest';

import type { MovementStart } from '../../../shared/movement';
import type { ControlSwitch } from '../../../shared/peerControl';
import type { Intent, Offered } from '../../automation/CommandQueue';
import { runControl, type ControlledSession } from '../controlActions';

/** A character whose queue keeps what it was offered and answers `offered`. */
function session(offered: Offered = 'queued', play: MovementStart | null = { started: true }) {
  const intents: Intent[] = [];
  const stops: string[] = [];
  const switches: Array<[ControlSwitch, boolean]> = [];
  const notices: string[] = [];
  const subject: ControlledSession = {
    queue: {
      offer: (intent) => {
        intents.push(intent);
        return offered;
      }
    },
    reports: { notice: (message) => notices.push(message), decided: () => undefined },
    lineMax: 40,
    stopMoving: (by) => stops.push(by),
    play: () => Promise.resolve(play),
    setSwitch: (name, on) => {
      switches.push([name, on]);
      return name === 'automation' ? 'the file could not be written' : null;
    }
  };
  return { subject, intents, stops, switches, notices };
}

describe('a remote control action on the character', () => {
  it('queues a line, a move and rest at the band a typed command uses', async () => {
    const { subject, intents } = session();
    expect(await runControl(subject, { a: 'line', text: 'cast mihe Soul' }, 'Soul')).toEqual({
      r: 'done'
    });
    await runControl(subject, { a: 'move', dir: 'ne' }, 'Soul');
    await runControl(subject, { a: 'rest' }, 'Soul');
    expect(intents.map((each) => [each.command, each.priority, each.decision])).toEqual([
      ['cast mihe Soul', 'user', 'remote-control'],
      ['ne', 'user', 'remote-control'],
      ['rest', 'user', 'remote-control']
    ]);
  });

  it('refuses a line that would pass an @ command on, or is no line, and sends nothing', async () => {
    const { subject, intents, notices } = session();
    expect((await runControl(subject, { a: 'line', text: '/Rand @do drop all' }, 'Soul')).r).toBe(
      'refused'
    );
    expect(notices).toHaveLength(1);
    expect((await runControl(subject, { a: 'line', text: 'x'.repeat(41) }, 'Soul')).r).toBe(
      'refused'
    );
    expect(intents).toEqual([]);
  });

  it("says what the queue did with it in the sharer's words", async () => {
    const { subject } = session('offline');
    expect(await runControl(subject, { a: 'rest' }, 'Soul')).toEqual({
      r: 'refused',
      why: 'the character is not connected'
    });
  });

  it('stops, plays and flips a switch as the toolbar does, refusals included', async () => {
    const { subject, stops, switches } = session('queued', {
      confirm: { kind: 'loop', name: 'Orc caves', steps: 14 }
    });
    expect(await runControl(subject, { a: 'stop' }, 'Soul')).toEqual({ r: 'done' });
    expect(stops).toEqual(['Soul']);
    expect(await runControl(subject, { a: 'play', loop: null, confirmed: null }, 'Soul')).toEqual({
      r: 'confirm',
      name: 'Orc caves',
      steps: 14
    });
    expect(await runControl(subject, { a: 'switch', name: 'combat', on: false }, 'Soul')).toEqual({
      r: 'done'
    });
    expect(
      await runControl(subject, { a: 'switch', name: 'automation', on: true }, 'Soul')
    ).toEqual({ r: 'refused', why: 'the file could not be written' });
    expect(switches).toEqual([
      ['combat', false],
      ['automation', true]
    ]);
  });
});
