import { describe, expect, it } from 'vitest';

import { AutoRank, rankCommand } from '../AutoRank';
import type { Intent, Offered } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type PartyRank } from '../../../shared/config';
import {
  EMPTY_CHARACTER,
  NO_AFFLICTIONS,
  type CharacterState,
  type PartyMember
} from '../../../shared/character';

const member = (name: string, rank: PartyMember['rank'], invited = false): PartyMember => ({
  name,
  className: null,
  health: 100,
  mana: null,
  pool: null,
  rank,
  activity: null,
  invited,
  vitals: null,
  sheet: null,
  afflictions: NO_AFFLICTIONS
});

function state(rows: PartyMember[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', name: 'Vaelor', party: { ...base.party, members: rows } };
}

const joined = (own: PartyMember['rank']) =>
  state([member('Baby', 'front'), member('Vaelor', own)]);

function rig(preferredRank: PartyRank, answer: Offered = 'queued') {
  const offered: Intent[] = [];
  const notices: string[] = [];
  let reply: Offered = answer;
  const config: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    party: { ...DEFAULT_CONFIG.automation.party, preferredRank }
  };
  const rank = new AutoRank(
    config,
    {
      offer: (intent) => {
        offered.push(intent);
        return reply;
      }
    },
    { notice: (message) => notices.push(message) }
  );
  return { rank, offered, notices, answer: (next: Offered) => (reply = next) };
}

describe('AutoRank', () => {
  it('names the server commands', () => {
    expect(rankCommand('front')).toBe('frontrank');
    expect(rankCommand('mid')).toBe('midrank');
    expect(rankCommand('back')).toBe('backrank');
  });

  it('sends backrank once when the own row says mid', () => {
    const { rank, offered } = rig('back');
    rank.onCharacter(joined('mid'));
    rank.onCharacter(joined('mid'));
    expect(offered.map((intent) => intent.command)).toEqual(['backrank']);
    expect(offered[0]?.decision).toBe('party-rank');
  });

  it('sends nothing for mid, whatever the row says', () => {
    const { rank, offered } = rig('mid');
    rank.onCharacter(joined('front'));
    expect(offered).toEqual([]);
  });

  it('waits while its own rank is unknown, then sends', () => {
    const { rank, offered } = rig('front');
    rank.onCharacter(joined(null));
    expect(offered).toEqual([]);
    rank.onCharacter(joined('mid'));
    expect(offered.map((intent) => intent.command)).toEqual(['frontrank']);
  });

  it('sends nothing when the row already holds the rank', () => {
    const { rank, offered } = rig('back');
    rank.onCharacter(joined('back'));
    rank.onCharacter(joined('mid'));
    expect(offered).toEqual([]);
  });

  it('sends nothing for an invitation still out, and again after a new join', () => {
    const { rank, offered } = rig('back');
    rank.onCharacter(state([member('Baby', 'front'), member('Vaelor', 'mid', true)]));
    expect(offered).toEqual([]);
    rank.onCharacter(joined('mid'));
    rank.onCharacter(state([]));
    rank.onCharacter(joined('mid'));
    expect(offered.map((intent) => intent.command)).toEqual(['backrank', 'backrank']);
  });

  it('does not spend the join on a refusal, and says it once', () => {
    const { rank, offered, notices, answer } = rig('back', 'switched-off');
    rank.onCharacter(joined('mid'));
    rank.onCharacter(joined('mid'));
    expect(offered).toHaveLength(2);
    expect(notices).toHaveLength(1);
    answer('queued');
    rank.onCharacter(joined('mid'));
    rank.onCharacter(joined('mid'));
    expect(offered).toHaveLength(3);
  });
});
