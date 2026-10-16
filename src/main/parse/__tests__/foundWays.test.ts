import { describe, expect, it } from 'vitest';

import type { Discovery } from '../../../shared/memory';
import { worldOf } from '../../world/__tests__/realmFile';
import { CharacterTracker } from '../CharacterTracker';
import { Classifier } from '../Classifier';

/*
 * Todo 151: five found ways east from Silvermere into Newhaven's Village
 * Entrance, which no exit has. The rooms are orohost's (gmud.zip), cut down
 * to the ones the steps reach: Bank of Godfrey 1/297 (n, e to 1/225, w),
 * Halls of Training, Entrance 1/289 (s only), Newhaven, Narrow Path 1/2143
 * whose `e` is the real way into Village Entrance 1/2140.
 */
const realm = () =>
  worldOf([
    {
      m: 1,
      r: 297,
      n: 'Bank of Godfrey',
      x: { n: { m: 1, r: 296 }, e: { m: 1, r: 225 }, w: { m: 1, r: 298 } }
    },
    { m: 1, r: 296, n: 'Market Street', x: { s: { m: 1, r: 297 } } },
    { m: 1, r: 298, n: 'Bank Street', x: { e: { m: 1, r: 297 } } },
    { m: 1, r: 225, n: 'Silver Street', x: { w: { m: 1, r: 297 } } },
    { m: 1, r: 289, n: 'Halls of Training, Entrance', x: { s: { m: 1, r: 225 } } },
    {
      m: 1,
      r: 2143,
      n: 'Newhaven, Narrow Path',
      x: {
        n: { m: 1, r: 2144 },
        s: { m: 1, r: 2145 },
        e: { m: 1, r: 2140 },
        w: { m: 1, r: 2146 }
      }
    },
    { m: 1, r: 2144, n: 'Newhaven, Lane', x: { s: { m: 1, r: 2143 } } },
    { m: 1, r: 2145, n: 'Newhaven, Green', x: { n: { m: 1, r: 2143 } } },
    { m: 1, r: 2146, n: 'Newhaven, Docks', x: { e: { m: 1, r: 2143 } } },
    {
      m: 1,
      r: 2140,
      n: 'Newhaven, Village Entrance',
      x: {
        n: { m: 1, r: 2144 },
        s: { m: 1, r: 2145 },
        w: { m: 1, r: 2143 },
        se: { m: 1, r: 2146 }
      }
    }
  ]);

const PROMPT = '[HP=100]: ';
const BANK = ['Bank of Godfrey', 'Obvious exits: north, east, west'];
const STREET = ['Silver Street', 'Obvious exits: west'];
const VILLAGE = ['Newhaven, Village Entrance', 'Obvious exits: north, south, west, southeast'];
const NARROW = ['Newhaven, Narrow Path', 'Obvious exits: north, south, east, west'];

type Step = string | { send: string };

function run(steps: readonly Step[]): {
  found: Discovery[];
  tracker: CharacterTracker;
} {
  const classifier = new Classifier();
  const found: Discovery[] = [];
  const tracker = new CharacterTracker(realm(), undefined, (one) => found.push(one));
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
  return { found, tracker };
}

const atBank: Step[] = ['Location:            1,297', PROMPT, ...BANK, PROMPT];
const ways = (found: readonly Discovery[]) =>
  found.map((one) => `${one.from} ${one.command} ${one.to}`);

describe('what a found way is written from', () => {
  it('writes one for an `e` that lands where the realm has no `e` going (control)', () => {
    expect(ways(run([...atBank, { send: 'e' }, PROMPT, ...VILLAGE, PROMPT]).found)).toEqual([
      '1/297 e 1/2140'
    ]);
  });

  /*
   * `sys go` writes nothing, in each order the user could have typed it
   * (the analysis's nine cases); the control above is the positive half.
   */
  it.each<[string, Step[]]>([
    ['sys go alone', [{ send: 'sys go 1 2140' }, PROMPT, ...VILLAGE, PROMPT]],
    [
      'e answered, then sys go',
      [{ send: 'e' }, PROMPT, ...STREET, PROMPT, { send: 'sys go 1 2140' }, PROMPT, ...VILLAGE]
    ],
    [
      'e sent, sys go before e answers',
      [{ send: 'e' }, { send: 'sys go 1 2140' }, PROMPT, ...STREET, PROMPT, ...VILLAGE, PROMPT]
    ],
    [
      'e then sys go, the answer to e lost',
      [{ send: 'e' }, { send: 'sys go 1 2140' }, PROMPT, ...VILLAGE, PROMPT]
    ],
    [
      'e refused, then sys go',
      [
        { send: 'e' },
        'There is no exit in that direction!',
        PROMPT,
        { send: 'sys go 1 2140' },
        PROMPT,
        ...VILLAGE,
        PROMPT
      ]
    ],
    [
      'sys go with e typed right after',
      [{ send: 'sys go 1 2140' }, { send: 'e' }, PROMPT, ...VILLAGE]
    ],
    [
      'sys go, a landing name the realm lacks',
      [{ send: 'sys go 1 2140' }, PROMPT, 'Newhaven, Village Gate', VILLAGE[1]!, PROMPT]
    ],
    [
      'sys go to Narrow Path, then a real e',
      [{ send: 'sys go 1 2143' }, PROMPT, ...NARROW, PROMPT, { send: 'e' }, PROMPT, ...VILLAGE]
    ]
  ])('writes none for %s', (_name, steps) => {
    expect(ways(run([...atBank, ...steps, PROMPT]).found)).toEqual([]);
  });

  it('keeps a nameless reprint in place while its exits fit (control)', () => {
    const { tracker } = run([...atBank, BANK[1]!, PROMPT]);
    expect([tracker.current.room.map, tracker.current.room.number]).toEqual([1, 297]);
  });

  /*
   * An arrival nothing typed caused (the skiff), its name line lost: the
   * exits are Narrow Path's, which the bank cannot print, so the bank is not
   * kept, and the `e` after it is no way from the bank.
   */
  it('does not keep the room when a nameless block prints exits it lacks', () => {
    const { tracker, found } = run([
      ...atBank,
      NARROW[1]!,
      PROMPT,
      { send: 'e' },
      PROMPT,
      ...VILLAGE,
      PROMPT
    ]);
    expect(ways(found)).toEqual([]);
    expect([tracker.current.room.map, tracker.current.room.number]).toEqual([1, 2140]);
  });

  it('takes no pasted exit line for a way out, where another word is one', () => {
    const after = (typed: string) =>
      run([...atBank, { send: typed }, PROMPT, ...VILLAGE, PROMPT]).found.map((one) => one.command);
    // Control: a word the realm does not know, and the room it led to, is learned.
    expect(after('squeeze gap')).toEqual(['squeeze gap']);
    // A selection of an earlier screen, so the room's own exit line is not taken for its echo.
    expect(after(BANK[1]!)).toEqual([]);
  });
});
