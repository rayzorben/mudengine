import { describe, expect, it } from 'vitest';

import { WorldGraph } from '../WorldGraph';
import { worldOf } from './realmFile';
import { coordinateTail, readMegamudPath, startRoom, stepLines } from '../megamudImport';

/** A ring of four rooms on map 1: 1 e 2, 2 s 4, 4 w 3, 3 n 1. */
function ring(): WorldGraph {
  return worldOf([
    { m: 1, r: 1, n: 'NW', x: { e: { m: 1, r: 2 }, s: { m: 1, r: 3 } } },
    { m: 1, r: 2, n: 'NE', x: { w: { m: 1, r: 1 }, s: { m: 1, r: 4 } } },
    { m: 1, r: 3, n: 'SW', x: { n: { m: 1, r: 1 }, e: { m: 1, r: 4 } } },
    { m: 1, r: 4, n: 'SE', x: { n: { m: 1, r: 2 }, w: { m: 1, r: 3 } } }
  ]);
}

const path = (header: string, commands: string[]): string =>
  [
    '[Square Dance-1 1][Someone]',
    header,
    '3C900060:3C900060:32:-1:0:::',
    ...commands.map((command) => `3C900060:0000:${command}`)
  ].join('\r\n');

describe('reading a MegaMUD path', () => {
  it('finds the start from the coordinates in its name', () => {
    expect(startRoom(ring(), 'Anywhere-1 3')?.name).toBe('SW');
  });

  it('keeps a trailing number that is not a room as part of the name', () => {
    expect(coordinateTail(ring(), 'Level 11').id).toBeNull();
    expect(coordinateTail(ring(), 'Hall-1 2')).toEqual({ name: 'Hall', id: '1/2' });
  });

  it('reads step lines from the first one, whatever the header', () => {
    const lines = path('[SQ:Plaza:Square-1 1]', ['e', 's']).split('\r\n');
    expect(stepLines(lines).map((step) => step.command)).toEqual(['e', 's']);
  });

  it('turns a ring into picks closed on the first room', () => {
    const read = readMegamudPath(
      ring(),
      'SQUARELOOP.mp',
      path('[SQ:Plaza:Square-1 1]', ['e', 's', 'w', 'n'])
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.closed).toBe(true);
    expect(read.name).toBe('Plaza: Square Dance');
    expect(read.picks[0]).toBe('1/1');
    expect(read.picks.at(-1)).toBe('1/1');
  });

  it('keeps a path that does not return as a route', () => {
    const read = readMegamudPath(ring(), 'GOTO.mp', path('[SQ:Plaza:Square-1 1]', ['e', 's']));
    expect(read.ok && read.closed).toBe(false);
    if (read.ok) expect(read.picks.at(-1)).toBe('1/4');
  });

  it('refuses with a reason rather than guessing', () => {
    const header = readMegamudPath(ring(), 'A.mp', 'nothing here');
    expect(header).toEqual({ ok: false, file: 'A.mp', reason: 'header' });
    const start = readMegamudPath(ring(), 'B.mp', path('[SQ:Plaza:Nowhere-9 9]', ['e']));
    expect(start.ok ? null : start.reason).toBe('start');
    const steps = readMegamudPath(ring(), 'C.mp', path('[SQ:Plaza:Square-1 1]', ['n']));
    expect(steps.ok ? null : steps.reason).toBe('steps');
  });
});
