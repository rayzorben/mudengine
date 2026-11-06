import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AimedHold } from '../AimedHold';
import { t } from '../../app/i18n';
import { setTuning, tuning } from '../../app/tuning';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { EMPTY_CHARACTER, partyMember, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';

const web = (target: string, spells = '237'): Block => ({
  seq: 1,
  at: 0,
  type: 'player-misses',
  domain: 'combat',
  groups: { target, spell: 'thick webbing', spells, message: '381' },
  text: '',
  terminator: 'newline',
  confidence: 1
});

function leading(following: string | null = null): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    name: 'Rayzor',
    party: {
      ...base.party,
      following,
      members: [partyMember('Rayzor'), partyMember('Brakkle')]
    }
  };
}

/* Rayzor, 2026-11-04: the lap's `se` went 82 ms after the web landed on Brakkle. */
describe('a hold aimed at a party member', () => {
  let paced: string[];
  let hold: AimedHold;
  let asked: Set<string>;
  beforeEach(() => {
    vi.useFakeTimers();
    setTuning(DEFAULT_INTERNAL.tuning);
    paced = [];
    asked = new Set();
    hold = new AimedHold({
      waiting: (who) => asked.has(who),
      holds: (spell) => spell === 237,
      pace: (who, waiting, said) => paced.push(`${waiting ? 'wait' : 'ok'}:${who}:${said ?? ''}`)
    });
  });
  afterEach(() => vi.useRealTimers());

  const said = t('session.loop.holdAimed', { who: 'Brakkle', spell: 'thick webbing' });

  it('stops the lap for a joined member, and not for a stranger or a spell that does not hold', () => {
    hold.onBlock(web('Soul'), leading());
    hold.onBlock(web('Brakkle', '79'), leading());
    expect(paced).toEqual([]);
    hold.onBlock(web('Brakkle'), leading());
    expect(paced).toEqual([`wait:Brakkle:${said}`]);
  });

  /* The reviewer, 2026-11-06: a resting member's `@wait` must not be ended by a web they resisted. */
  it('leaves a member already waited on by their own word to that wait', () => {
    asked.add('Brakkle');
    hold.onBlock(web('Brakkle'), leading());
    vi.advanceTimersByTime(tuning().remotes.replyMs);
    hold.onCharacter();
    expect(paced).toEqual([]);
    // Control: without it, the same line waits.
    asked.clear();
    hold.onBlock(web('Brakkle'), leading());
    expect(paced).toEqual([`wait:Brakkle:${said}`]);
  });

  it('leaves the wait to a leader when following', () => {
    hold.onBlock(web('Brakkle'), leading('Soul'));
    hold.onBlock(web('Brakkle'), leading());
    expect(paced).toEqual([`wait:Brakkle:${said}`]);
  });

  it('lets the wait go when no word from the member follows, and keeps it when one does', () => {
    hold.onBlock(web('Brakkle'), leading());
    vi.advanceTimersByTime(tuning().remotes.replyMs - 1);
    hold.onCharacter();
    expect(paced).toHaveLength(1);
    vi.advanceTimersByTime(1);
    hold.onCharacter();
    expect(paced.at(-1)).toBe('ok:Brakkle:');
    // Again, and this time Brakkle's own `@held` arrives: the wait is his.
    hold.onBlock(web('Brakkle'), leading());
    hold.said('Brakkle');
    vi.advanceTimersByTime(tuning().remotes.replyMs);
    hold.onCharacter();
    expect(paced.at(-1)).toBe(`wait:Brakkle:${said}`);
  });
});
