import { describe, expect, it } from 'vitest';

import { domainOf, type Block, type BlockType } from '../blocks';
import { mentionNotice, mentions, mentionSpans } from '../mentions';
import { raisable, STARTER_ALERTS, wanted, alertQuiet } from '../notifications';

/** A talk block as `patterns.ts` builds it: the speaker in `player`, the words in `message`. */
function said(type: BlockType, text: string, groups: Record<string, string>): Block {
  return {
    seq: 7,
    at: 1000,
    type,
    domain: domainOf(type),
    groups,
    text,
    terminator: 'newline',
    confidence: 0.8
  };
}

const gossip = (player: string, message: string): Block =>
  said('conversation-gossip', `${player} gossips: ${message}`, { player, message });

describe('mentions', () => {
  it('finds @name in any case, as a whole word', () => {
    for (const message of ['@festus hi', 'hey @Festus', 'yo @FESTUS!', '(@festus)']) {
      expect(mentions(gossip('Rayzor', message), 'Festus')).toBe(true);
    }
  });

  it('leaves a longer name, a bare name and an address alone', () => {
    for (const message of ['@Festuss hi', 'Festus hi', 'mail festus@x.net', 'see a/@festus']) {
      expect(mentions(gossip('Rayzor', message), 'Festus')).toBe(false);
    }
  });

  it('leaves out the character’s own echoed line and its own say', () => {
    expect(mentions(gossip('Festus', 'hi @festus'), 'Festus')).toBe(false);
    const own = said('conversation-local', 'You say "@festus"', { message: '@festus' });
    expect(mentions(own, 'Festus')).toBe(false);
  });

  it('reads a line from somebody unseen, like a yell from the next room', () => {
    const yell = said('conversation-yell', 'Someone yells from the north "@festus help"', {
      direction: 'north',
      message: '@festus help'
    });
    expect(mentions(yell, 'Festus')).toBe(true);
  });

  it('takes a remote call for a remote, even when the name is a remote word', () => {
    const call = said('conversation-telepath', 'Celyn telepaths: @wait (can’t move)', {
      player: 'Celyn',
      message: '@wait (can’t move)'
    });
    expect(mentions(call, 'Wait')).toBe(false);
    // The positive control: the same name, called out in a sentence.
    expect(mentions(gossip('Celyn', 'hold on @wait'), 'Wait')).toBe(true);
  });

  it('matches nothing before the name is known, and nothing on a receipt', () => {
    expect(mentions(gossip('Rayzor', '@festus'), null)).toBe(false);
    const receipt = said('conversation-telepath', '--- Telepath Sent to Festus ---', {
      player: 'Festus'
    });
    expect(mentions(receipt, 'Festus')).toBe(false);
  });

  it('says where each mention sits, for the Talk card to mark', () => {
    expect(mentionSpans('a @Festus b @festus', 'Festus')).toEqual([
      [2, 9],
      [12, 19]
    ]);
  });
});

describe('mentionNotice', () => {
  it('is the server’s line, notified by the shipped row', () => {
    const notice = mentionNotice(gossip('Rayzor', 'hey @festus'), 'Festus', STARTER_ALERTS);
    expect(notice).toMatchObject({ event: 'mentioned', text: 'Rayzor gossips: hey @festus' });
    expect(raisable(notice!, STARTER_ALERTS)).toBe('mentioned');
  });

  it('rests the row after the first of a burst', () => {
    const quiet = alertQuiet();
    const burst = [1, 2, 3].map((seq) => ({
      ...mentionNotice(gossip('Rayzor', '@festus'), 'Festus', STARTER_ALERTS)!,
      id: `m${seq}`,
      at: 1000 + seq
    }));
    expect(wanted({ rules: STARTER_ALERTS }, burst, quiet)).toHaveLength(1);
  });

  it('raises nothing while no row asks, so talk stays on the Talk card', () => {
    const line = gossip('Rayzor', 'hey @festus');
    // Positive control: the line is a mention, and a row would raise it.
    expect(mentions(line, 'Festus')).toBe(true);
    expect(mentionNotice(line, 'Festus', STARTER_ALERTS)).not.toBeNull();
    const without = STARTER_ALERTS.filter((rule) => rule.on !== 'mentioned');
    expect(mentionNotice(line, 'Festus', without)).toBeNull();
    const off = STARTER_ALERTS.map((rule) =>
      rule.on === 'mentioned' ? { ...rule, enabled: false } : rule
    );
    expect(mentionNotice(line, 'Festus', off)).toBeNull();
  });

  it('leaves a telepath to the telepath row, so one line raises one alert', () => {
    const tele = said('conversation-telepath', 'Rayzor telepaths: hey @festus', {
      player: 'Rayzor',
      message: 'hey @festus'
    });
    expect(mentionNotice(tele, 'Festus', STARTER_ALERTS)).not.toBeNull();
    const withTelepath = [
      ...STARTER_ALERTS,
      { ...STARTER_ALERTS.find((rule) => rule.on === 'mentioned')!, on: 'telepath' as const }
    ];
    expect(mentionNotice(tele, 'Festus', withTelepath)).toBeNull();
  });

  it('raises a telepath opening on @name, which the telepath row skips', () => {
    const tele = said('conversation-telepath', 'Rayzor telepaths: @festus you there?', {
      player: 'Rayzor',
      message: '@festus you there?'
    });
    const withTelepath = [
      ...STARTER_ALERTS,
      { ...STARTER_ALERTS.find((rule) => rule.on === 'mentioned')!, on: 'telepath' as const }
    ];
    expect(mentionNotice(tele, 'Festus', withTelepath)).not.toBeNull();
  });
});
