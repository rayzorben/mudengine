import { beforeEach, describe, expect, it } from 'vitest';

import { PartyStoppers } from '../PartyStoppers';
import { t } from '../../app/i18n';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { parseRemoteReply } from '../../../shared/remotes';
import type { WayStopper } from '../../world/navigation/stoppers';

/* The Silver River's spell, with the two cheapest boats. */
const RIVER: WayStopper = {
  spell: 753,
  name: 'river damage',
  items: [
    { id: 690, name: 'log raft' },
    { id: 691, name: 'wooden skiff' }
  ]
};

let asked: string[];
let notices: string[];
let ours: Set<string>;
let now: number;
let party: PartyStoppers;

beforeEach(() => {
  asked = [];
  notices = [];
  ours = new Set(['brakkle']);
  now = 1_000;
  party = new PartyStoppers(
    {
      ask: (who, name, argument) => {
        asked.push(`${who} @${name}${argument === undefined ? '' : ` ${argument}`}`);
        return true;
      },
      runsThisClient: (who) => ours.has(who.toLowerCase()),
      notice: (message) => notices.push(message)
    },
    () => now
  );
});

const heard = (from: string, text: string): boolean => party.heard(from, parseRemoteReply(text)!);

describe('asking the party what stops the river', () => {
  it('asks a member on this client by row id, and reads which they carry', () => {
    expect(party.settle(RIVER, ['Brakkle'])).toEqual({ asking: ['Brakkle'], answers: new Map() });
    expect(asked).toEqual(['Brakkle @stoppers 690,691']);
    // Asked once while the question is out.
    expect(party.settle(RIVER, ['Brakkle']).asking).toEqual(['Brakkle']);
    expect(asked).toHaveLength(1);
    expect(heard('Brakkle', '{yes: 691}')).toBe(true);
    expect(party.settle(RIVER, ['Brakkle'])).toEqual({
      asking: [],
      answers: new Map([['Brakkle', { kind: 'has', item: 691 }]])
    });
  });

  it('asks anyone else @have per boat in order, stopping at the first yes', () => {
    party.settle(RIVER, ['Rand']);
    expect(asked).toEqual(['Rand @have log raft']);
    expect(heard('Rand', '{no}')).toBe(true);
    expect(asked).toEqual(['Rand @have log raft', 'Rand @have wooden skiff']);
    expect(heard('Rand', '{yes: 1}')).toBe(true);
    expect(party.settle(RIVER, ['Rand']).answers.get('Rand')).toEqual({ kind: 'has', item: 691 });
  });

  it('reads {no} to the last boat as lacking, and a lapse or a refusal as silence', () => {
    party.settle(RIVER, ['Rand', 'Soul', 'Brakkle']);
    heard('Rand', '{no}');
    heard('Rand', '{no}');
    heard('Brakkle', '{command invalid or not allowed}');
    now += DEFAULT_INTERNAL.tuning.remotes.replyMs + 1;
    party.sweep(now);
    const { answers } = party.settle(RIVER, ['Rand', 'Soul', 'Brakkle']);
    expect(answers.get('Rand')).toEqual({ kind: 'lacks' });
    expect(answers.get('Soul')).toEqual({ kind: 'silent' });
    expect(answers.get('Brakkle')).toEqual({ kind: 'silent' });
    expect(notices).toEqual([
      t('automation.stoppers.lapsed', { who: 'Soul', spell: 'river damage' })
    ]);
  });

  it('reads nothing from somebody not asked, and asks again once forgotten', () => {
    expect(heard('Rand', '{no}')).toBe(false);
    party.settle(RIVER, ['Rand']);
    heard('Rand', '{yes: 1}');
    party.forget('Rand');
    expect(party.settle(RIVER, ['Rand']).asking).toEqual(['Rand']);
    expect(asked).toEqual(['Rand @have log raft', 'Rand @have log raft']);
  });

  it('records silence where the queue would not ask', () => {
    const held = new PartyStoppers({ ask: () => false, runsThisClient: () => false });
    expect(held.settle(RIVER, ['Rand']).answers.get('Rand')).toEqual({ kind: 'silent' });
  });

  it('asks a purse once and reads the copper, or its lapse as null', () => {
    expect(party.askWealth('Rand')).toBe(true);
    expect(party.askWealth('Rand')).toBe(true);
    expect(asked).toEqual(['Rand @wealth']);
    expect(party.purseOf('Rand')).toBeUndefined();
    expect(heard('Rand', '{1234 copper}')).toBe(true);
    expect(party.purseOf('Rand')).toBe(1234);
    party.askWealth('Soul');
    now += DEFAULT_INTERNAL.tuning.remotes.replyMs + 1;
    party.sweep(now);
    expect(party.purseOf('Soul')).toBeNull();
  });
});
