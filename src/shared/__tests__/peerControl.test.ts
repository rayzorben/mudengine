import { describe, expect, it } from 'vitest';

import {
  actionFrame,
  asControlAction,
  asControlAnswer,
  CONTROL_ACTIONS,
  CONTROL_SWITCHES,
  CONTROL_VERSION,
  type ControlAction
} from '../peerControl';

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const every: ControlAction[] = [
  { a: 'line', text: 'cast mihe Soul' },
  { a: 'move', dir: 'ne' },
  { a: 'rest' },
  { a: 'stop' },
  { a: 'play', loop: 'Orc caves', confirmed: null },
  { a: 'play', loop: null, confirmed: 12 },
  { a: 'switch', name: 'combat', on: false }
];

describe('the remote control contract', () => {
  it('reads every action as it was written, and lists each kind', () => {
    for (const action of every) {
      expect(asControlAction(wire(actionFrame(action)))).toEqual({ ok: true, action });
    }
    expect(new Set(every.map((action) => action.a))).toEqual(new Set(CONTROL_ACTIONS));
  });

  it('holds no action that reaches the settings, the loops, the account or the shares', () => {
    expect(CONTROL_ACTIONS).toEqual(['line', 'move', 'rest', 'stop', 'play', 'switch']);
    expect(CONTROL_SWITCHES).toEqual(['automation', 'combat']);
  });

  it('ignores a field this build does not know', () => {
    expect(asControlAction({ v: 1, a: 'move', dir: 'n', speed: 'fast' })).toEqual({
      ok: true,
      action: { a: 'move', dir: 'n' }
    });
  });

  it('names an action another build has and this one lacks, and refuses one malformed', () => {
    expect(asControlAction({ v: 1, a: 'dance', with: 'Soul' })).toEqual({
      ok: false,
      why: 'unknown',
      name: 'dance'
    });
    expect(asControlAction({ v: 1, a: 'move', dir: 'sideways' })).toEqual({
      ok: false,
      why: 'malformed'
    });
    expect(asControlAction({ v: 1, a: 'line' })).toEqual({ ok: false, why: 'malformed' });
    expect(asControlAction({ v: 1, a: 'switch', name: 'hangUp', on: true })).toEqual({
      ok: false,
      why: 'malformed'
    });
    expect(asControlAction({ a: 'rest' })).toEqual({ ok: false, why: 'malformed' });
    expect(asControlAction({ v: CONTROL_VERSION + 1, a: 'rest' })).toEqual({
      ok: false,
      why: 'version'
    });
  });

  it('reads each answer, and nothing it does not know as one', () => {
    expect(asControlAnswer({ r: 'done', extra: true })).toEqual({ r: 'done' });
    expect(asControlAnswer({ r: 'refused', why: 'Not connected.' })).toEqual({
      r: 'refused',
      why: 'Not connected.'
    });
    expect(asControlAnswer({ r: 'confirm', name: 'Orc caves', steps: 14 })).toEqual({
      r: 'confirm',
      name: 'Orc caves',
      steps: 14
    });
    expect(asControlAnswer({ r: 'maybe' })).toBeNull();
    expect(asControlAnswer({ r: 'refused' })).toBeNull();
  });
});
