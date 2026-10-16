import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoInvite } from '../AutoInvite';
import { CommandQueue } from '../CommandQueue';
import { CONFIG } from '../walk/__tests__/walking';
import { t } from '../../app/i18n';
import { NO_GRANT } from '../../../shared/remotes';
import { type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';

const AGAIN = DEFAULT_INTERNAL.tuning.remotes.inviteSeenAgainMs;

const occupant = (name: string, kind: RoomOccupant['kind'] = 'player'): RoomOccupant => ({
  name,
  kind,
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
});

const row = (name: string, invited = false) => ({
  name,
  className: null,
  health: invited ? null : 1,
  mana: null,
  rank: null,
  activity: null,
  invited,
  vitals: null,
  sheet: null
});

/** Standing in `room` with `here`; `members` joined, `invited` printed `[Invited]`. */
function state(
  room: number,
  here: RoomOccupant[],
  {
    members = [],
    invited = [],
    following = null
  }: {
    members?: string[];
    invited?: string[];
    following?: string | null;
  } = {}
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    room: { ...base.room, map: 1, number: room, occupants: here },
    party: {
      ...base.party,
      following,
      members: [
        row('Vaelor'),
        ...members.map((name) => row(name)),
        ...invited.map((name) => row(name, true))
      ]
    }
  };
}

/* Todo 851: a player marked Invite When Seen is invited when they are in the room. */
describe('inviting a player marked Invite When Seen', () => {
  let sent: string[];
  let said: string[];
  let queue: CommandQueue;
  const config = (players: string[], enabled = true): AutomationConfig => ({
    ...CONFIG,
    enabled,
    pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 },
    remotes: {
      ...CONFIG.remotes,
      players: Object.fromEntries(players.map((name) => [name, { ...NO_GRANT, autoInvite: true }]))
    }
  });
  const make = (players = ['soul'], enabled = true): AutoInvite =>
    new AutoInvite(config(players, enabled), queue, { notice: (line) => said.push(line) });
  const drain = (): void => void vi.advanceTimersByTime(500);

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    said = [];
    queue = new CommandQueue(config([]), { send: (command) => sent.push(command) });
  });
  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  it('invites them when they walk in, once while they stay, and nobody unmarked', () => {
    const it = make();
    it.onCharacter(state(1, [occupant('Yang')]));
    it.onCharacter(state(1, [occupant('Yang'), occupant('Soul')]));
    it.onCharacter(state(1, [occupant('Yang'), occupant('Soul')]));
    drain();
    expect(sent).toEqual(['invite Soul']);
  });

  it('invites them when this character walks in on them', () => {
    const it = make();
    it.onCharacter(state(1, []));
    it.onCharacter(state(2, [occupant('Soul')]));
    drain();
    expect(sent).toEqual(['invite Soul']);
  });

  it('skips a monster of the same name, somebody joined and somebody already invited', () => {
    const it = make(['soul', 'yang']);
    it.onCharacter(state(1, [occupant('Soul', 'mob')]));
    it.onCharacter(
      state(2, [occupant('Soul'), occupant('Yang')], { members: ['Soul'], invited: ['Yang'] })
    );
    drain();
    // Positive control: the same arrival unjoined is invited.
    it.onCharacter(state(3, []));
    it.onCharacter(state(4, [occupant('Soul')]));
    drain();
    expect(sent).toEqual(['invite Soul']);
  });

  it('invites nobody while following, and says so', () => {
    const it = make();
    it.onCharacter(state(1, [occupant('Soul')], { following: 'Yang' }));
    drain();
    expect(sent).toEqual([]);
    expect(said).toEqual([
      t('automation.remotes.autoInviteFollowing', { who: 'Soul', leader: 'Yang' })
    ]);
  });

  it('waits before inviting the same player again, and says so', () => {
    const it = make();
    it.onCharacter(state(1, [occupant('Soul')]));
    drain();
    expect(sent).toEqual(['invite Soul']);
    it.onCharacter(state(1, []));
    it.onCharacter(state(1, [occupant('Soul')]));
    drain();
    expect(sent).toEqual(['invite Soul']);
    expect(said).toHaveLength(1);

    vi.advanceTimersByTime(AGAIN);
    it.onCharacter(state(1, []));
    it.onCharacter(state(1, [occupant('Soul')]));
    drain();
    expect(sent).toEqual(['invite Soul', 'invite Soul']);
  });

  it('sends nothing with automation off, and forgets who was here on reset', () => {
    const off = make(['soul'], false);
    off.onCharacter(state(1, [occupant('Soul')]));
    drain();
    expect(sent).toEqual([]);

    const it = make();
    it.onCharacter(state(1, [occupant('Soul')]));
    drain();
    it.reset();
    vi.advanceTimersByTime(AGAIN);
    it.onCharacter(state(1, [occupant('Soul')]));
    drain();
    expect(sent).toEqual(['invite Soul', 'invite Soul']);
  });
});
