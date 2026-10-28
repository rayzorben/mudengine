import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PartyWait } from '../PartyWait';
import { t } from '../../app/i18n';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG } from '../../../shared/config';
import type { Block, BlockType } from '../../../shared/blocks';

const ASKED = (who: string): string => `pause:${t('session.loop.pausedForRemote', { who })}`;
const HURT = (who: string): string => `pause:${t('session.loop.pausedForHealth', { who })}`;

/** A member's party line as the leader reads it; `removed` marks the leader's uninvite. */
const partyLine = (type: BlockType, player: string, removed = false): Block => ({
  seq: 1,
  at: 0,
  type,
  domain: 'presence',
  groups: removed ? { player, removed: 'has been removed' } : { player },
  text: '',
  terminator: 'newline',
  confidence: 1
});

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
      pauseMoving: (why) => {
        if (!running) return false;
        running = false;
        moves.push(`pause:${why}`);
        return true;
      },
      stopped: () => !running,
      resume: (who) => {
        running = true;
        moves.push(`resume:${who}`);
      },
      notice: (message, decision) => moves.push(`${decision}:${message}`),
      waitMinutes: () => minutes,
      leftBehind: (who) => moves.push(`leftBehind:${who}`)
    });
  });
  afterEach(() => vi.useRealTimers());

  it('stops the lap once and walks on when the last reason is gone', () => {
    wait.pace('Soul', false, 'asked');
    wait.pace('Yang', false, 'hurt');
    wait.pace('Brakkle', false, 'asked');
    // A second member's word is said; their health is not, and neither stops anything again.
    const brakkle = `party-wait:${t('session.loop.pausedForRemote', { who: 'Brakkle' })}`;
    expect(moves).toEqual([ASKED('Soul'), brakkle]);
    wait.pace('Soul', true, 'asked');
    wait.pace('Brakkle', true, 'asked');
    expect(moves).toEqual([ASKED('Soul'), brakkle]);
    wait.pace('Yang', true, 'hurt');
    expect(moves).toEqual([ASKED('Soul'), brakkle, 'resume:Yang']);
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
      `party-wait:${t('session.loop.partyWaitGaveUp', { minutes: 2, who: 'Soul' })}`,
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

  /* The user, 2026-10-26: Brakkle's `@wait (can't move)` landed after the leader's `sw` went. */
  it('walks back for a member who asked to wait and dropped out behind the step', () => {
    const left = (who: string) => partyLine('party-left', who);
    wait.onBlock(left('Brakkle'));
    wait.pace('Brakkle', false, 'asked');
    wait.onBlock(left('Soul'));
    // The leader's own uninvite is not a member left behind.
    wait.onBlock(partyLine('party-left', 'Brakkle', true));
    expect(moves).toEqual([ASKED('Brakkle')]);
    wait.onBlock(left('Brakkle'));
    expect(moves).toEqual([ASKED('Brakkle'), 'leftBehind:Brakkle']);
  });

  it('walks back for a member whose @wait lands after the drop', () => {
    wait.leftParty('Brakkle');
    expect(moves).toEqual([]);
    wait.pace('Brakkle', false, 'asked');
    wait.leftParty('Brakkle');
    expect(moves).toEqual([ASKED('Brakkle'), 'leftBehind:Brakkle']);
  });

  it('holds for a member invited back until they join and say @ok', () => {
    const joined = (who: string) => partyLine('party-joined', who);
    wait.pace('Brakkle', false, 'asked');
    wait.pace('Brakkle', false, 'invited');
    wait.pace('Brakkle', true, 'asked');
    // Somebody else joining ends nothing.
    wait.onBlock(joined('Soul'));
    expect(wait.holding).toBe(true);
    wait.onBlock(joined('Brakkle'));
    expect(moves).toEqual([
      ASKED('Brakkle'),
      `party-wait:${t('session.loop.pausedForJoin', { who: 'Brakkle' })}`,
      'resume:Brakkle'
    ]);
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
      vitals: null,
      pool: null,
      sheet: null
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
      wait.onCharacter(leading(0.3), 0.5, null, []);
      wait.onCharacter(leading(0.2), 0.5, null, []);
      expect(moves).toEqual([HURT('Soul')]);
      wait.onCharacter(leading(0.8), 0.5, null, []);
      expect(moves).toEqual([HURT('Soul'), 'resume:Soul']);
    });

    it('lets a member who walked out go, and waits for nobody at 0', () => {
      wait.onCharacter(leading(0.3), 0.5, null, []);
      wait.onCharacter(leading(0.3, ['Vaelor']), 0.5, null, []);
      expect(moves).toEqual([HURT('Soul'), 'resume:Soul']);
      moves = [];
      wait.onCharacter(leading(0.1), 0, null, []);
      expect(moves).toEqual([]);
    });

    it('stops a lap started while a member is still hurt', () => {
      running = false;
      wait.onCharacter(leading(0.3), 0.5, null, []);
      expect(moves).toEqual([]);
      running = true;
      wait.onCharacter(leading(0.3), 0.5, null, []);
      expect(moves).toEqual([HURT('Soul')]);
    });

    it('walks on for good when the player resumes the lap by hand, until the member recovers', () => {
      wait.onCharacter(leading(0.3), 0.5, null, []);
      running = true;
      wait.noteLap({ status: 'running' } as never);
      wait.onCharacter(leading(0.3), 0.5, null, []);
      expect(moves).toEqual([HURT('Soul')]);
      wait.onCharacter(leading(0.8), 0.5, null, []);
      wait.onCharacter(leading(0.3), 0.5, null, []);
      expect(moves).toEqual([HURT('Soul'), HURT('Soul')]);
    });

    it('does not stop again for a member a wait gave up on, until it recovers', () => {
      wait.onCharacter(leading(0.3), 0.5, null, []);
      vi.advanceTimersByTime(2 * 60_000);
      wait.onCharacter(leading(0.3), 0.5, null, []);
      expect(moves.filter((move) => move.startsWith('pause:'))).toHaveLength(1);
      wait.onCharacter(leading(0.8), 0.5, null, []);
      wait.onCharacter(leading(0.3), 0.5, null, []);
      expect(moves.filter((move) => move.startsWith('pause:'))).toHaveLength(2);
    });

    /* The user, 2026-10-10: leading, members are held to this character's own rest settings. */
    it('under Manage Party Health, waits from the rest level up to the rest-up level', () => {
      const managed = {
        health: { ...DEFAULT_CONFIG.automation.health, restBelow: 0.5, restTo: 0.9 },
        marginWhenUncapped: 0.1
      };
      const LOW = `pause:${t('session.loop.pausedForRest', { who: 'Soul' })}`;
      wait.onCharacter(leading(0.6), 0, managed, []);
      expect(moves).toEqual([]);
      wait.onCharacter(leading(0.4), 0, managed, []);
      expect(moves).toEqual([LOW]);
      // Over the rest level is not enough: the lap waits for the rest-up level.
      wait.onCharacter(leading(0.7), 0, managed, []);
      expect(wait.holding).toBe(true);
      wait.onCharacter(leading(0.9), 0, managed, []);
      expect(moves).toEqual([LOW, 'resume:Soul']);
      // Off, the same member stops nothing.
      wait.onCharacter(leading(0.4), 0, null, []);
      expect(moves).toEqual([LOW, 'resume:Soul']);
    });

    /* 2026-10-28, the user: Brakkle hung up, the lap walked on, and Rayzor died alone. */
    it('waits for a member who hung up past Wait No Longer Than, until they are back', () => {
      const AWAY = `pause:${t('session.loop.pausedForRejoin', { who: 'Soul' })}`;
      wait.onCharacter(leading(1, ['Vaelor']), 0, null, ['Soul']);
      wait.pace('Yang', false, 'asked');
      expect(moves).toEqual([
        AWAY,
        `party-wait:${t('session.loop.pausedForRemote', { who: 'Yang' })}`
      ]);
      // The give-up clock lets go of Yang's word, and not of the member who hung up.
      vi.advanceTimersByTime(2 * 60_000);
      wait.onCharacter(leading(1, ['Vaelor']), 0, null, ['Soul']);
      expect(moves.slice(2)).toEqual([
        `party-wait:${t('session.loop.partyWaitGaveUp', { minutes: 2, who: 'Yang' })}`
      ]);
      expect(wait.holding).toBe(true);
      wait.onCharacter(leading(1), 0, null, []);
      expect(moves.slice(3)).toEqual(['resume:Soul']);
    });

    it("still gives up a member's @wait that comes after a long wait for one who hung up", () => {
      wait.onCharacter(leading(1, ['Vaelor']), 0, null, ['Soul']);
      vi.advanceTimersByTime(10 * 60_000);
      wait.onCharacter(leading(1, ['Vaelor']), 0, null, ['Soul']);
      expect(wait.holding).toBe(true);
      wait.pace('Soul', false, 'asked');
      wait.onCharacter(leading(1), 0, null, []);
      // Back in the party, still asking to wait: Wait No Longer Than bounds that.
      expect(wait.holding).toBe(true);
      vi.advanceTimersByTime(2 * 60_000);
      expect(moves.at(-1)).toBe('resume:Soul');
      expect(wait.holding).toBe(false);
    });
  });
});
