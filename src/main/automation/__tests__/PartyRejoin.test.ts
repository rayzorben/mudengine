import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { PartyRejoin } from '../PartyRejoin';
import { Remotes } from '../Remotes';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { asUnderway, type CarriedParty } from '../../../shared/underway';
import type { Block } from '../../../shared/blocks';

const MINUTES = DEFAULT_CONFIG.automation.party.reinviteMinutes;
const LEADER_GAP = DEFAULT_INTERNAL.tuning.remotes.leaderDroppedMs;

const config: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  // Nothing granted, Auto-Join and the remotes switch off: a rejoin needs none of them.
  remotes: {
    ...DEFAULT_CONFIG.automation.remotes,
    enabled: false,
    autoJoin: false,
    players: {},
    party: []
  },
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const block = (type: string, groups: Record<string, string>): Block =>
  ({
    type,
    domain: 'presence',
    raw: '',
    plain: '',
    text: '',
    groups,
    confidence: 1,
    at: 0,
    seq: 1
  }) as unknown as Block;

const occupant = (name: string): RoomOccupant => ({
  name,
  kind: 'player',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
});

const row = (name: string) => ({
  name,
  className: null,
  health: 1,
  mana: null,
  rank: null,
  activity: null,
  invited: false,
  vitals: null,
  pool: null,
  sheet: null
});

/** Rayzor in room `room` with `here`; `members` joined, or following `following`. */
function state(
  room: number,
  here: string[],
  { members = [], following = null }: { members?: string[]; following?: string | null } = {}
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  const listed = following === null ? members : [following, ...members];
  return {
    ...base,
    phase: 'in-game',
    name: 'Rayzor',
    room: { ...base.room, map: 7, number: room, occupants: here.map(occupant) },
    party: {
      ...base.party,
      following,
      members: listed.length === 0 ? [] : [row('Rayzor'), ...listed.map(row)]
    }
  };
}

let sent: string[];
let notices: string[];
let queue: CommandQueue;
let remotes: Remotes;
let writes: number;
const drain = (): void => void vi.advanceTimersByTime(500);

function make(over: Partial<AutomationConfig['party']> = {}): Remotes {
  const made = new Remotes({ ...config, party: { ...config.party, ...over } }, queue, {
    notice: (m) => notices.push(m)
  });
  made.party.writeWith(() => writes++);
  return made;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  writes = 0;
  queue = new CommandQueue(config, { send: (command) => sent.push(command) });
  remotes = make();
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

/* 2026-10-25: Rayzor led Brakkle, the client restarted, and nobody invited Brakkle back. */
describe('leading, after this character reconnects', () => {
  it('invites every member the record carried once they are in the room, said', () => {
    remotes.party.carry({
      kind: 'leading',
      members: [{ name: 'Brakkle', droppedAt: null, quit: false }]
    });
    remotes.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toEqual(['invite Brakkle']);
    expect(notices).toEqual([
      t('automation.party.reformLeading', { members: 'Brakkle', minutes: MINUTES })
    ]);
  });

  it('carries the party it leads, and stops owing a member once they join', () => {
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    expect(remotes.party.carried).toEqual({
      kind: 'leading',
      members: [{ name: 'Brakkle', droppedAt: null, quit: false }]
    });
    expect(writes).toBe(1);
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    expect(writes).toBe(1);
  });

  it('gives a member up after the window, said, and invites nobody', () => {
    remotes.party.carry({
      kind: 'leading',
      members: [{ name: 'Brakkle', droppedAt: null, quit: false }]
    });
    vi.advanceTimersByTime(MINUTES * 60_000 + 1);
    remotes.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toEqual([]);
    expect(remotes.party.carried).toBeNull();
    expect(notices).toContain(
      t('automation.party.memberGaveUp', { member: 'Brakkle', minutes: MINUTES })
    );
  });

  it('owes nobody with the window at 0', () => {
    const off = make({ reinviteMinutes: 0 });
    off.party.carry({
      kind: 'leading',
      members: [{ name: 'Brakkle', droppedAt: null, quit: false }]
    });
    off.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('leading, when a member hangs up or quits', () => {
  it('invites back a member who disconnected, not one who left', () => {
    remotes.onCharacter(state(754, ['Brakkle', 'Soul'], { members: ['Brakkle', 'Soul'] }));
    remotes.onBlock(block('party-left', { player: 'Soul' }), state(754, ['Brakkle', 'Soul']));
    remotes.onBlock(block('player-disconnects', { player: 'Brakkle' }), state(754, ['Soul']));
    expect(notices).toEqual([
      t('automation.party.memberDropped', { member: 'Brakkle', minutes: MINUTES })
    ]);
    remotes.onCharacter(state(754, []));
    // Both come back into the room; only the one the link dropped is invited.
    remotes.onCharacter(state(754, ['Brakkle', 'Soul']));
    drain();
    expect(sent).toEqual([config.onPartyChange, 'invite Brakkle']);
  });

  /* 2026-10-28, the user's log: the leave line comes first, and Brakkle was never invited back. */
  it('owes a member whose hangup follows their leave line, until a party list prints them', () => {
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    remotes.onBlock(block('party-left', { player: 'Brakkle' }), state(754, ['Brakkle']));
    remotes.onBlock(block('player-disconnects', { player: 'Brakkle' }), state(754, []));
    remotes.onBlock(block('party-alone', {}), state(754, []));
    remotes.onCharacter(state(754, []));
    expect(remotes.away).toEqual(['Brakkle']);
    remotes.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toEqual([config.onPartyChange, 'invite Brakkle']);
    // The join line alone is not the party whole: the list is asked, once.
    remotes.onBlock(block('party-joined', { player: 'Brakkle' }), state(754, ['Brakkle']));
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    drain();
    expect(sent).toEqual([config.onPartyChange, 'invite Brakkle', config.onPartyChange]);
    expect(remotes.away).toEqual(['Brakkle']);
    remotes.onBlock(block('party-roster', {}), state(754, ['Brakkle']));
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    expect(remotes.away).toEqual([]);
  });

  /* 2026-10-28, the user's second log: the disconnect line twice, and the room shown mid-fight. */
  it('owes a member once whose disconnect is printed twice', () => {
    remotes.onBlock(block('party-roster', {}), state(754, ['Brakkle']));
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    remotes.onBlock(block('party-left', { player: 'Brakkle' }), state(754, ['Brakkle']));
    remotes.onBlock(block('player-disconnects', { player: 'Brakkle' }), state(754, []));
    remotes.onBlock(block('player-disconnects', { player: 'Brakkle' }), state(754, []));
    remotes.onBlock(block('party-alone', {}), state(754, []));
    remotes.onCharacter(state(754, []));
    expect(remotes.away).toEqual(['Brakkle']);
    expect(notices).toEqual([
      t('automation.party.memberDropped', { member: 'Brakkle', minutes: MINUTES })
    ]);
    remotes.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toEqual([config.onPartyChange, 'invite Brakkle']);
  });

  it('does not owe a member who left long before they disconnect', () => {
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    remotes.onBlock(block('party-left', { player: 'Brakkle' }), state(754, ['Brakkle']));
    vi.advanceTimersByTime(LEADER_GAP + 1);
    remotes.onBlock(block('player-disconnects', { player: 'Brakkle' }), state(754, []));
    expect(remotes.away).toEqual([]);
    expect(remotes.party.carried).toBeNull();
  });

  it('forgets a member the party list no longer prints, and keeps one who hung up', () => {
    remotes.onCharacter(state(754, ['Brakkle', 'Soul'], { members: ['Brakkle', 'Soul'] }));
    remotes.onBlock(block('player-disconnects', { player: 'Brakkle' }), state(754, ['Soul']));
    remotes.onBlock(block('party-alone', {}), state(754, []));
    remotes.onCharacter(state(754, []));
    expect(remotes.party.carried).toEqual({
      kind: 'leading',
      members: [{ name: 'Brakkle', droppedAt: Date.now(), quit: false }]
    });
  });

  /* 2026-11-02, the user's log: Brakkle left the Realm to train, came back, and was not invited. */
  it('invites back a member who left the Realm and came back, without the lap waiting for them', () => {
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    remotes.onBlock(block('party-left', { player: 'Brakkle' }), state(754, ['Brakkle']));
    // 01:48:23 to 01:48:27 in the log.
    vi.advanceTimersByTime(4_000);
    remotes.onBlock(
      block('party-left', { disbanded: 'Your party has been disbanded' }),
      state(754, ['Brakkle'])
    );
    remotes.onBlock(block('player-exits', { player: 'Brakkle' }), state(754, []));
    expect(notices).toEqual([
      t('automation.party.memberQuit', { member: 'Brakkle', minutes: MINUTES })
    ]);
    remotes.onBlock(block('party-alone', {}), state(754, []));
    remotes.onCharacter(state(754, []));
    // Not waited for (the user, 2026-11-02), as a hangup is (above); still invited below.
    expect(remotes.away).toEqual([]);
    // `Brakkle walks into the room from nowhere.`
    remotes.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toEqual([config.onPartyChange, 'invite Brakkle']);
  });

  it('still does not wait for a member who quit after this character reconnects', () => {
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    remotes.onBlock(block('party-left', { player: 'Brakkle' }), state(754, ['Brakkle']));
    remotes.onBlock(block('player-exits', { player: 'Brakkle' }), state(754, []));
    remotes.party.carry(remotes.party.carried);
    remotes.onCharacter(state(754, []));
    expect(remotes.away).toEqual([]);
    remotes.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toContain('invite Brakkle');
  });

  it('stops waiting for a member owed for a hangup who then quits', () => {
    remotes.onCharacter(state(754, ['Brakkle'], { members: ['Brakkle'] }));
    remotes.onBlock(block('party-left', { player: 'Brakkle' }), state(754, ['Brakkle']));
    remotes.onBlock(block('player-disconnects', { player: 'Brakkle' }), state(754, []));
    remotes.onCharacter(state(754, []));
    // Positive control: the hangup is waited for.
    expect(remotes.away).toEqual(['Brakkle']);
    remotes.onBlock(block('player-exits', { player: 'Brakkle' }), state(754, []));
    expect(remotes.away).toEqual([]);
    remotes.onCharacter(state(754, ['Brakkle']));
    drain();
    expect(sent).toContain('invite Brakkle');
  });

  it('does not owe a member who left the party long before they left the Realm', () => {
    remotes.onCharacter(state(754, ['Brakkle', 'Soul'], { members: ['Brakkle', 'Soul'] }));
    remotes.onBlock(block('party-left', { player: 'Brakkle' }), state(754, ['Brakkle', 'Soul']));
    vi.advanceTimersByTime(LEADER_GAP + 1);
    remotes.onBlock(block('player-exits', { player: 'Brakkle' }), state(754, ['Soul']));
    remotes.onCharacter(state(754, ['Soul'], { members: ['Soul'] }));
    // Positive control: Soul is still carried, so the record was written after the quit.
    expect(remotes.party.carried).toEqual({
      kind: 'leading',
      members: [{ name: 'Soul', droppedAt: null, quit: false }]
    });
    remotes.onCharacter(state(754, ['Brakkle', 'Soul'], { members: ['Soul'] }));
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('following, when the leader hangs up or quits', () => {
  const leaderHangsUp = (): void => {
    remotes.onCharacter(state(754, ['Rand'], { following: 'Rand' }));
    remotes.onBlock(block('party-left', { leader: 'Rand' }), state(754, ['Rand']));
    remotes.onBlock(block('player-disconnects', { player: 'Rand' }), state(754, []));
  };

  it('joins them again when they invite, with Auto-Join off and nothing granted', () => {
    leaderHangsUp();
    expect(notices).toEqual([
      t('automation.party.leaderDropped', { leader: 'Rand', minutes: MINUTES })
    ]);
    remotes.onBlock(block('party-invited', { leader: 'Rand' }), state(754, ['Rand']));
    // Positive control for the switch: somebody else's invitation is still left alone.
    remotes.onBlock(block('party-invited', { leader: 'Soul' }), state(754, ['Rand']));
    drain();
    expect(sent).toEqual(['join Rand']);
  });

  it('does not join a leader denied @join by name', () => {
    const denied = new Remotes(
      {
        ...config,
        remotes: {
          ...config.remotes,
          players: { rand: { allow: [], deny: ['join'], allowAll: false, autoInvite: false } }
        }
      },
      queue,
      { notice: (m) => notices.push(m) }
    );
    remotes = denied;
    leaderHangsUp();
    denied.onBlock(block('party-invited', { leader: 'Rand' }), state(754, ['Rand']));
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.autoJoinDenied', { from: 'Rand' }));
  });

  it('joins a leader again who left the Realm and came back', () => {
    remotes.onCharacter(state(754, ['Rand'], { following: 'Rand' }));
    remotes.onBlock(block('party-left', { leader: 'Rand' }), state(754, ['Rand']));
    vi.advanceTimersByTime(4_000);
    remotes.onBlock(block('player-exits', { player: 'Rand' }), state(754, []));
    expect(notices).toEqual([
      t('automation.party.leaderQuit', { leader: 'Rand', minutes: MINUTES })
    ]);
    remotes.onBlock(block('party-invited', { leader: 'Rand' }), state(754, ['Rand']));
    drain();
    expect(sent).toEqual(['join Rand']);
  });

  it('does not count a leader left long before they disconnect', () => {
    remotes.onCharacter(state(754, ['Rand'], { following: 'Rand' }));
    remotes.onBlock(block('party-left', { leader: 'Rand' }), state(754, ['Rand']));
    vi.advanceTimersByTime(LEADER_GAP + 1);
    remotes.onBlock(block('player-disconnects', { player: 'Rand' }), state(754, []));
    remotes.onBlock(block('party-invited', { leader: 'Rand' }), state(754, ['Rand']));
    drain();
    expect(sent).toEqual([]);
    expect(remotes.party.carried).toBeNull();
  });

  it('joins the leader the record carried after this character reconnects', () => {
    remotes.party.carry({
      kind: 'following',
      leader: { name: 'Rand', droppedAt: null, quit: false }
    });
    expect(notices).toEqual([
      t('automation.party.reformFollowing', { leader: 'Rand', minutes: MINUTES })
    ]);
    remotes.onBlock(block('party-invited', { leader: 'Rand' }), state(754, ['Rand']));
    drain();
    expect(sent).toEqual(['join Rand']);
  });
});

describe('the carried party on disk', () => {
  it('reads back what was written, and nothing from a malformed record', () => {
    const party: CarriedParty = {
      kind: 'leading',
      members: [{ name: 'Brakkle', droppedAt: 5, quit: false }]
    };
    expect(asUnderway({ party }).party).toEqual(party);
    expect(
      asUnderway({ party: { kind: 'leading', members: [{ name: 'two words' }] } }).party
    ).toBeNull();
    expect(asUnderway({ party: { kind: 'following' } }).party).toBeNull();
    expect(asUnderway({}).party).toBeNull();
  });

  it('keeps a member the party had already lost on the clock it lost them', () => {
    const rejoin = new PartyRejoin(config, {}, () => 10 * 60_000);
    rejoin.carry({ kind: 'leading', members: [{ name: 'Brakkle', droppedAt: 1, quit: false }] });
    expect(rejoin.carried).toEqual({
      kind: 'leading',
      members: [{ name: 'Brakkle', droppedAt: 1, quit: false }]
    });
  });
});
