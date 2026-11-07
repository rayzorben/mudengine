import { describe, expect, it } from 'vitest';

import { IDLE_WALK, type WalkOwed, type WalkProgress } from '../../../shared/walk';
import { WalkPush } from '../WalkPush';

function pushing() {
  let owed: WalkOwed = { pickUpOwed: false, routeBehind: false };
  const pushed: WalkProgress[] = [];
  const push = new WalkPush(
    () => IDLE_WALK,
    () => owed,
    { walk: (progress) => void pushed.push(progress) }
  );
  return { push, pushed, owe: (next: WalkOwed) => (owed = next) };
}

describe('the walk as the window is told it', () => {
  it('pushes again when what is owed moved, and only then', () => {
    const { push, pushed, owe } = pushing();
    push.walked();
    expect(pushed).toHaveLength(1);
    push.settle();
    expect(pushed).toHaveLength(1);
    owe({ pickUpOwed: true, routeBehind: false });
    push.settle();
    expect(pushed.at(-1)).toMatchObject({ pickUpOwed: true });
    // The player's Stop ends the wait with no walk moving (the review, 2026-11-07).
    owe({ pickUpOwed: false, routeBehind: false });
    push.settle();
    expect(pushed.at(-1)).toMatchObject({ pickUpOwed: false });
    expect(pushed).toHaveLength(3);
  });

  /* A party wait takes hold after the lap's stop is published, inside the same handling. */
  it('reads again once the handling that moved the walk is done', async () => {
    const { push, pushed, owe } = pushing();
    push.walked();
    owe({ pickUpOwed: true, routeBehind: false });
    expect(pushed).toHaveLength(1);
    await Promise.resolve();
    expect(pushed).toHaveLength(2);
    expect(pushed.at(-1)).toMatchObject({ pickUpOwed: true });
  });
});
