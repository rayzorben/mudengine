import { beforeEach, describe, expect, it } from 'vitest';

import { SELF_LOOK_KEY, SelfLook } from '../SelfLook';
import type { Intent, Offered } from '../CommandQueue';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/* Todo 20261019-0931-01: `l <name>` once on the way in, for the portrait. */
describe('looking at yourself on the way in', () => {
  let offered: Intent[];
  let notices: string[];
  let on: boolean;
  let answer: Offered;
  let look: SelfLook;

  const IN: CharacterState = { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game' };
  const NAMED: CharacterState = { ...IN, name: 'Probe' };

  beforeEach(() => {
    offered = [];
    notices = [];
    on = true;
    answer = 'queued';
    look = new SelfLook(
      {
        offer: (intent) => {
          offered.push(intent);
          return answer;
        }
      },
      () => on,
      (message) => notices.push(message)
    );
  });

  it('waits for the name, then asks once in the probe band', () => {
    look.onCharacter(IN);
    expect(offered).toEqual([]);
    look.onCharacter(NAMED);
    look.onCharacter(NAMED);
    expect(offered.map((intent) => [intent.command, intent.priority, intent.coalesceKey])).toEqual([
      ['l Probe', 'probe', SELF_LOOK_KEY]
    ]);
  });

  it('asks again on the next entry, not on the same one', () => {
    look.onCharacter(NAMED);
    look.left();
    look.onCharacter(NAMED);
    expect(offered).toHaveLength(2);
  });

  it('asks nothing once the appearance is read', () => {
    look.onCharacter({ ...NAMED, appearance: { gender: 'male', hair: null, eyes: 'black' } });
    expect(offered).toEqual([]);
  });

  it('says once that portraits are off, and asks nothing', () => {
    on = false;
    look.onCharacter(NAMED);
    look.left();
    look.onCharacter(NAMED);
    expect(offered).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it('asks again when the queue took nothing', () => {
    answer = 'offline';
    look.onCharacter(NAMED);
    answer = 'queued';
    look.onCharacter(NAMED);
    expect(offered).toHaveLength(2);
  });
});
