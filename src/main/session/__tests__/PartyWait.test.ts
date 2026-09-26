import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PartyWait } from '../PartyWait';
import { t } from '../../app/i18n';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

const ASKED = (who: string): string => `pause:${t('session.loop.pausedForRemote', { who })}`;
const HURT = (who: string): string => `pause:${t('session.loop.pausedForHealth', { who })}`;

/* Todo 831: why a leader's lap waits for its party, and for how long. */
describe('a leader waiting for its party', () => {
  let moves: string[];
  let running: boolean;
  let minutes: number;
  let wait: PartyWait;
  beforeEach(() => {
    vi.useFakeTimers();
    moves = [];
    running = true;
    minutes = 2;
    wait = new PartyWait({
      pauseLap: (why) => {
        if (!running) return false;
        running = false;
        moves.push(`pause:${why}`);
        return true;
      },
      lapStopped: () => !running,
      resumeLap: (who) => {
        running = true;
        moves.push(`resume:${who}`);
      },
      notice: (message) => moves.push(message),
      waitMinutes: () => minutes
    });
  });
  afterEach(() => vi.useRealTimers());

  it('stops the lap once and walks on when the last reason is gone', () => {
    wait.pace('Soul', false, 'asked');
    wait.pace('Yang', false, 'hurt');
    expect(moves).toEqual([ASKED('Soul')]);
    wait.pace('Soul', true, 'asked');
    expect(moves).toEqual([ASKED('Soul')]);
    wait.pace('Yang', true, 'hurt');
    expect(moves).toEqual([ASKED('Soul'), 'resume:Yang']);
  });

  it("keeps a member's @ok from ending a wait its health still asks for", () => {
    wait.pace('Soul', false, 'hurt');
    wait.pace('Soul', true, 'asked');
    expect(moves).toEqual([HURT('Soul')]);
    expect(wait.holding).toBe(true);
  });

  it('gives the wait up after its limit, and says for whom', () => {
    wait.pace('Soul', false, 'asked');
    vi.advanceTimersByTime(2 * 60_000 - 1);
    expect(moves).toEqual([ASKED('Soul')]);
    vi.advanceTimersByTime(1);
    expect(moves).toEqual([
      ASKED('Soul'),
      t('session.loop.partyWaitGaveUp', { minutes: 2, who: 'Soul' }),
      'resume:Soul'
    ]);
    expect(wait.holding).toBe(false);
  });

  it('waits for ever at 0, stops nothing with no lap running, and forgets on close', () => {
    minutes = 0;
    wait.pace('Soul', false, 'asked');
    vi.advanceTimersByTime(60 * 60_000);
    expect(moves).toEqual([ASKED('Soul')]);
    wait.forget();
    expect(wait.holding).toBe(false);
    running = false;
    moves = [];
    wait.pace('Yang', false, 'asked');
    expect(moves).toEqual([]);
    expect(wait.holding).toBe(false);
  });

  describe('for a member under Wait For Party Members', () => {
    const member = (name: string, health: number | null) => ({
      name,
      className: null,
      health,
      mana: null,
      rank: null,
      activity: null,
      invited: false,
      vitals: null
    });
    const leading = (soul: number | null, here = ['Vaelor', 'Soul']): CharacterState => {
      const base = structuredClone(EMPTY_CHARACTER);
      return {
        ...base,
        name: 'Vaelor',
        party: {
          ...base.party,
          following: null,
          members: [member('Vaelor', 1), member('Soul', soul)]
        },
        room: { ...base.room, occupants: here.map((name) => ({ name, kind: 'player' }) as never) }
      };
    };

    it('stops the lap while a member here is under the line, and walks on when it is over', () => {
      wait.onCharacter(leading(0.3), 0.5);
      wait.onCharacter(leading(0.2), 0.5);
      expect(moves).toEqual([HURT('Soul')]);
      wait.onCharacter(leading(0.8), 0.5);
      expect(moves).toEqual([HURT('Soul'), 'resume:Soul']);
    });

    it('lets a member who walked out go, and waits for nobody at 0', () => {
      wait.onCharacter(leading(0.3), 0.5);
      wait.onCharacter(leading(0.3, ['Vaelor']), 0.5);
      expect(moves).toEqual([HURT('Soul'), 'resume:Soul']);
      moves = [];
      wait.onCharacter(leading(0.1), 0);
      expect(moves).toEqual([]);
    });

    it('stops a lap started while a member is still hurt', () => {
      running = false;
      wait.onCharacter(leading(0.3), 0.5);
      expect(moves).toEqual([]);
      running = true;
      wait.onCharacter(leading(0.3), 0.5);
      expect(moves).toEqual([HURT('Soul')]);
    });

    it('walks on for good when the player resumes the lap by hand, until the member recovers', () => {
      wait.onCharacter(leading(0.3), 0.5);
      running = true;
      wait.noteLap({ status: 'running' } as never);
      wait.onCharacter(leading(0.3), 0.5);
      expect(moves).toEqual([HURT('Soul')]);
      wait.onCharacter(leading(0.8), 0.5);
      wait.onCharacter(leading(0.3), 0.5);
      expect(moves).toEqual([HURT('Soul'), HURT('Soul')]);
    });

    it('does not stop again for a member a wait gave up on, until it recovers', () => {
      wait.onCharacter(leading(0.3), 0.5);
      vi.advanceTimersByTime(2 * 60_000);
      wait.onCharacter(leading(0.3), 0.5);
      expect(moves.filter((move) => move.startsWith('pause:'))).toHaveLength(1);
      wait.onCharacter(leading(0.8), 0.5);
      wait.onCharacter(leading(0.3), 0.5);
      expect(moves.filter((move) => move.startsWith('pause:'))).toHaveLength(2);
    });
  });
});
