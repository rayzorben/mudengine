import { describe, expect, it } from 'vitest';

import { EMPTY_UNSEEN, mentionMissed, missed, nothingUnseen } from '../unseen';
import { domainOf, type Block } from '@shared/blocks';

const gossip = (player: string, message: string): Block => ({
  seq: 3,
  at: 1000,
  type: 'conversation-gossip',
  domain: domainOf('conversation-gossip'),
  groups: { player, message },
  text: `${player} gossips: ${message}`,
  terminator: 'newline',
  confidence: 0.8
});

describe('a mention while the tab is not in front', () => {
  it('counts it with the newest line, apart from the alerts', () => {
    const once = mentionMissed(EMPTY_UNSEEN, gossip('Rayzor', 'hi @festus'), 'Festus', false);
    const twice = mentionMissed(once, gossip('Soul', '@Festus there?'), 'Festus', false);
    expect(twice).toMatchObject({ mentions: 2, mention: 'Soul gossips: @Festus there?' });
    expect(twice.warning).toBe(0);
  });

  it('counts nothing for the character on screen, or for a line that is no mention', () => {
    expect(mentionMissed(EMPTY_UNSEEN, gossip('Rayzor', '@festus'), 'Festus', true)).toBe(
      EMPTY_UNSEEN
    );
    expect(mentionMissed(EMPTY_UNSEEN, gossip('Rayzor', 'festus'), 'Festus', false)).toBe(
      EMPTY_UNSEEN
    );
  });

  it('clears with the alerts when the character is put on screen', () => {
    const heard = mentionMissed(EMPTY_UNSEEN, gossip('Rayzor', '@festus'), 'Festus', false);
    expect(nothingUnseen(heard)).toBe(false);
    expect(missed(heard, [], true)).toBe(EMPTY_UNSEEN);
  });
});
