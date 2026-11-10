import { describe, expect, it } from 'vitest';

import { worldOf } from '../../world/__tests__/realmFile';
import { CharacterTracker } from '../CharacterTracker';
import { Classifier } from '../Classifier';

/*
 * Two tunnels that print `north` and cannot be told apart, each leading to a
 * tunnel that prints `south, east`. A third `south, east` tunnel far away
 * keeps the name and exits from placing the second room by themselves; only
 * 1/3 also prints what lies east of it.
 */
const realm = () =>
  worldOf([
    { m: 1, r: 1, n: 'Tunnel', x: { n: { m: 1, r: 3 } } },
    { m: 1, r: 2, n: 'Tunnel', x: { n: { m: 1, r: 4 } } },
    { m: 1, r: 3, n: 'Tunnel', x: { s: { m: 1, r: 1 }, e: { m: 1, r: 5 } } },
    { m: 1, r: 4, n: 'Tunnel', x: { s: { m: 1, r: 2 }, e: { m: 1, r: 6 } } },
    { m: 1, r: 5, n: 'Tunnel', x: { w: { m: 1, r: 3 } } },
    { m: 1, r: 6, n: 'Tunnel', x: { w: { m: 1, r: 4 }, d: { m: 1, r: 9 } } },
    { m: 1, r: 9, n: 'Tunnel', x: { s: { m: 1, r: 9 }, e: { m: 1, r: 9 } } }
  ]);

const PROMPT = '[HP=100]: ';
const START = ['Tunnel', 'Obvious exits: north'];
const MIDDLE = ['Tunnel', 'Obvious exits: south, east'];
const END = ['Tunnel', 'Obvious exits: west'];

type Step = string | { send: string };

function run(steps: readonly Step[]): CharacterTracker {
  const classifier = new Classifier();
  const tracker = new CharacterTracker(realm());
  let seq = 0;
  const feed = (plain: string) => {
    seq += 1;
    const { block, batch } = classifier.classify({
      seq,
      at: 1_700_000_000_000 + seq,
      text: plain,
      plain,
      terminator: 'newline'
    } as Parameters<Classifier['classify']>[0]);
    tracker.apply(block);
    if (batch) tracker.apply(batch);
  };
  feed(PROMPT);
  for (const step of steps) {
    if (typeof step === 'string') feed(step);
    else {
      tracker.observeCommand(step.send);
      classifier.observeCommand(step.send);
    }
  }
  return tracker;
}

describe('an unplaced room narrowed by the rooms after it', () => {
  it('cannot place either end alone (control)', () => {
    expect(run([...START, PROMPT]).current.room).toMatchObject({ number: null, ambiguous: 2 });
    expect(run([...MIDDLE, PROMPT]).current.room).toMatchObject({ number: null, ambiguous: 3 });
  });

  it('keeps the two rooms the walk can be in, then places the one whose east prints `west`', () => {
    const second = run([...START, PROMPT, { send: 'n' }, ...MIDDLE, PROMPT]);
    expect(second.current.room).toMatchObject({ number: null, ambiguous: 2 });
    expect(second.current.room.candidates.map((one) => one.room)).toEqual([3, 4]);

    const third = run([
      ...START,
      PROMPT,
      { send: 'n' },
      ...MIDDLE,
      PROMPT,
      { send: 'e' },
      ...END,
      PROMPT
    ]);
    expect(third.current.room).toMatchObject({ map: 1, number: 5, resolvedBy: 'chain' });
  });

  it('keeps the set across a reprint of the same room', () => {
    const tracker = run([
      ...START,
      PROMPT,
      { send: 'n' },
      ...MIDDLE,
      PROMPT,
      ...MIDDLE,
      PROMPT,
      { send: 'e' },
      ...END,
      PROMPT
    ]);
    expect(tracker.current.room).toMatchObject({ map: 1, number: 5, resolvedBy: 'chain' });
  });

  it('starts no chain from a block whose exits fit no room of that name', () => {
    const tracker = run(['Tunnel', 'Obvious exits: up', PROMPT, { send: 'n' }, ...MIDDLE, PROMPT]);
    // Stepped `n` from all seven tunnels this would be 1/3 and 1/4.
    expect(tracker.current.room).toMatchObject({ number: null, ambiguous: 3 });
  });

  it('steps from the placed room afterwards', () => {
    const tracker = run([
      ...START,
      PROMPT,
      { send: 'n' },
      ...MIDDLE,
      PROMPT,
      { send: 'e' },
      ...END,
      PROMPT,
      { send: 'w' },
      ...MIDDLE,
      PROMPT
    ]);
    expect(tracker.current.room).toMatchObject({ map: 1, number: 3, resolvedBy: 'movement' });
  });
});
