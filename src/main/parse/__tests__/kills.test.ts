import { describe, expect, it } from 'vitest';

import { blockOf } from '../../../shared/__tests__/blocks';
import { CharacterTracker } from '../CharacterTracker';
import { Kills } from '../kills';

/*
 * What the kills register keeps and when it lets go (todo 700: *order is a
 * decision*). The session drains it straight after every block, so neither
 * its tests nor a replay ever reach a reset, a closed socket or the menu with
 * a kill still in it. So these hand the letting go to a real tracker.
 */

const T = 1_700_000_000_000;

describe('what the register keeps', () => {
  it('files a death under the realm’s row, once however many die, and hands it over once', () => {
    const kills = new Kills((name) => name === 'giant rat');
    kills.noted('thin giant rat');
    kills.noted('Giant Rat');
    kills.noted('kobold');
    expect(kills.take()).toEqual(['giant rat', 'kobold']);
    expect(kills.take()).toEqual([]);
  });

  it('keeps the whole spelling where the realm does not know the shorter one', () => {
    const kills = new Kills(() => false);
    kills.noted('thin giant rat');
    expect(kills.take()).toEqual(['thin giant rat']);
  });
});

describe('when the tracker lets go of a kill nobody took', () => {
  /** A giant rat just died to this character's blow, not yet taken. */
  const killed = (): CharacterTracker => {
    const tracker = new CharacterTracker();
    tracker.reset();
    tracker.apply(blockOf('status-line', '[HP=10/20]:', {}, T));
    tracker.apply(blockOf('combat-status', '*Combat Engaged*', { status: 'Engaged' }, T + 1));
    tracker.apply(
      blockOf(
        'user-hits',
        'You slash the giant rat for 40 damage!',
        { attacker: 'You', target: 'giant rat', damage: '40' },
        T + 2
      )
    );
    tracker.apply(blockOf('user-gain-experience', 'You gain 25 experience.', { exp: '25' }, T + 3));
    return tracker;
  };

  it('keeps it while nothing has let go', () => {
    expect(killed().takeDeaths()).toEqual(['giant rat']);
  });

  it('at a new connection', () => {
    const tracker = killed();
    tracker.reset();
    expect(tracker.takeDeaths()).toEqual([]);
  });

  it('when the socket closes', () => {
    const tracker = killed();
    tracker.leaveRealm(T + 4);
    expect(tracker.takeDeaths()).toEqual([]);
  });

  /*
   * Pinned as it stood before 724, not endorsed: whether the menu should let
   * go of an untaken kill is open. The shipped wiring cannot reach it —
   * `SessionManager` drains `takeDeaths` after every block — so it is
   * observable only at the tracker's own contract.
   */
  it('never at the menu, where the kill is still this session’s', () => {
    const tracker = killed();
    tracker.apply(blockOf('prompt-character', 'Please select a character:', {}, T + 4));
    expect(tracker.current.phase).toBe('authenticating');
    expect(tracker.takeDeaths()).toEqual(['giant rat']);
  });
});
