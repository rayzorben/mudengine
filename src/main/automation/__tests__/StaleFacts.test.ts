import { describe, expect, it } from 'vitest';

import { StaleFacts } from '../StaleFacts';
import type { Intent, Offered } from '../CommandQueue';

describe('what is owed until it is sent', () => {
  const build = (): { stale: StaleFacts; offered: Intent[]; answer: { as: Offered } } => {
    const offered: Intent[] = [];
    const answer: { as: Offered } = { as: 'queued' };
    const stale = new StaleFacts({
      offer: (intent) => {
        offered.push(intent);
        return answer.as;
      }
    });
    return { stale, offered, answer };
  };

  /* The stat screen's hold drops what is queued, so an ask not sent is offered again. */
  it('offers a fact again until a send carries it', () => {
    const { stale, offered } = build();
    stale.owe(['abilities'], 'why');
    stale.ask();
    expect(offered.map((intent) => intent.command)).toEqual(['abil', 'abil']);
    offered.at(-1)?.onSent?.();
    stale.ask();
    expect(offered).toHaveLength(2);
  });

  it('stops offering a word the realm does not have', () => {
    const { stale, offered, answer } = build();
    answer.as = 'unavailable';
    stale.owe(['abilities'], 'why');
    answer.as = 'queued';
    stale.ask();
    expect(offered).toHaveLength(1);
  });
});
