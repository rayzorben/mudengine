import { describe, expect, it } from 'vitest';

import { StatScreenHold } from '../StatScreenHold';
import { tuning } from '../../app/tuning';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';

/** The queue's hold as `CommandQueue` keeps it: idempotent, said by the return. */
function queue(): { hold(reason: string): boolean; release(): boolean; holding: string | null } {
  return {
    holding: null as string | null,
    hold(reason) {
      if (this.holding !== null) return false;
      this.holding = reason;
      return true;
    },
    release() {
      if (this.holding === null) return false;
      this.holding = null;
      return true;
    }
  };
}

function block(type: BlockType, text = ''): Block {
  return {
    seq: 0,
    at: 0,
    type,
    domain: domainOf(type),
    groups: {},
    text,
    terminator: 'newline',
    confidence: 0.8
  };
}

function build(): { hold: StatScreenHold; q: ReturnType<typeof queue>; notices: string[] } {
  const q = queue();
  const notices: string[] = [];
  const hold = new StatScreenHold(
    q,
    { noteSafety: () => {} },
    { notice: (message) => notices.push(message) },
    () => {}
  );
  return { hold, q, notices };
}

describe('the stat screen hold', () => {
  it('is not released by a prompt the server printed before it reached the ask', () => {
    const { hold, q } = build();
    hold.noteSent('train', 0);
    expect(q.holding).toBeNull();
    hold.noteSent('train stats', 0);
    expect(q.holding).not.toBeNull();
    // The prompt closing `train`'s own answer.
    hold.onBlock(block('status-line', '[HP=74/KAI=9]:'), 50);
    expect(q.holding).not.toBeNull();
    hold.onBlock(block('command-echo', 'train stats'), 100);
    hold.onBlock(block('user-stats-screen', 'Char. Creation … Point Cost Chart'), 110);
    expect(q.holding).not.toBeNull();
    // Leaving the form.
    hold.onBlock(block('status-line', '[HP=74/KAI=9]:'), 5000);
    expect(q.holding).toBeNull();
  });

  it('is released by the prompt after the echo when the realm refuses the ask', () => {
    const { hold, q } = build();
    hold.noteSent('train stats', 0);
    hold.onBlock(block('command-echo', 'train stats'), 100);
    hold.onBlock(block('status-line', '[HP=74/KAI=9]:'), 120);
    expect(q.holding).toBeNull();
  });

  it('stops waiting for an echo that never comes after train.echoMs', () => {
    const { hold, q } = build();
    hold.noteSent('train stats', 0);
    hold.onBlock(block('status-line', '[HP=74/KAI=9]:'), tuning().train.echoMs - 1);
    expect(q.holding).not.toBeNull();
    hold.onBlock(block('status-line', '[HP=74/KAI=9]:'), tuning().train.echoMs);
    expect(q.holding).toBeNull();
  });
});
