import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoStealth, type StealthEvents } from '../AutoStealth';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type CombatConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { classifyOccupant } from '../../../shared/mobs';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

/** A backstabber with the switch on, unless told otherwise. */
const combat = (over: Partial<CombatConfig> = {}): CombatConfig => ({
  ...DEFAULT_CONFIG.automation.combat,
  enabled: true,
  opener: 'bs',
  hideForOpener: true,
  ...over
});

const mob = (name: string): RoomOccupant =>
  classifyOccupant(name, {
    players: new Set<string>(),
    mob: () => ({ disposition: 'hostile', uncertain: false, costly: 'never' })
  });

/** Standing seen in an empty, placed room, nothing swinging. */
function seen(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    stealth: 'seen',
    room: { ...base.room, map: 7, number: 1241, name: 'Small Room', occupants: [] },
    ...over
  };
}

let sent: string[];
let notices: string[];
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = combat(), events: StealthEvents = {}, enabled = true): AutoStealth =>
  new AutoStealth(config, enabled, queue, { notice: (m) => notices.push(m), ...events });
const drain = (): void => void vi.advanceTimersByTime(500);

describe('standing still in an empty room', () => {
  it('hides a seen backstabber', () => {
    make().onCharacter(seen());
    drain();
    expect(sent).toEqual(['hide']);
  });

  /* The server's own precondition: `Room.Mobs.Count == 0`. */
  it('does nothing with a monster in the room', () => {
    make().onCharacter(seen({ room: { ...seen().room, occupants: [mob('mutant')] } }));
    drain();
    expect(sent).toEqual([]);
  });

  it('does nothing while something is swinging', () => {
    const state = seen();
    make().onCharacter({ ...state, combat: { ...state.combat, attackers: ['mutant'] } });
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * `hide` clears `Resting` (`HideCommand.cs:20`), so standing a hurt
   * character up to hide it is the wrong trade — unless the class carries
   * `ShadowHome`, below.
   */
  it('does nothing while resting', () => {
    const state = seen();
    make().onCharacter({ ...state, vitals: { ...state.vitals, resting: true } });
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * With `ShadowHome` the two do not undo each other in either direction
   * (`HideCommand.cs:20`, `SneakCommand.cs:28`, `RestCommand.cs:31`), so the
   * character stays seated *and* gains the shadows — which is the whole of the
   * hide-rest-backstab loop the ability exists for (todo 17).
   */
  it('hides a resting character whose class rests in the shadows', () => {
    const state = seen();
    make(combat(), { restsHidden: () => true }).onCharacter({
      ...state,
      vitals: { ...state.vitals, resting: true }
    });
    drain();
    expect(sent).toEqual(['hide']);
  });

  it('does nothing once the answer is unknown or sneaking', () => {
    const auto = make();
    auto.onCharacter(seen({ stealth: 'unknown' }));
    auto.onCharacter(seen({ stealth: 'sneaking' }));
    drain();
    expect(sent).toEqual([]);
  });

  /* The sheet's figure is the roll for both commands (todo 104). */
  it('does nothing for a sheet that says Stealth 0, and says so once', () => {
    const stealth = make();
    const base = seen();
    const noSkill = { ...base, progress: { ...base.progress, stealthSkill: 0 } };
    stealth.onCharacter(noSkill);
    stealth.onCharacter(noSkill);
    drain();
    expect(sent).toEqual([]);
    expect(notices.filter((line) => /no Stealth/.test(line))).toHaveLength(1);
  });

  it('does nothing across a move in flight, an escape, or a refused opener', () => {
    make(combat(), { moveInFlight: () => true }).onCharacter(seen());
    make(combat(), { escaping: () => true }).onCharacter(seen());
    make(combat(), { openerRefused: () => true }).onCharacter(seen());
    drain();
    expect(sent).toEqual([]);
  });

  it('is off by default, and only for a bs opener', () => {
    make(combat({ hideForOpener: false })).onCharacter(seen());
    make(combat({ opener: 'ju' })).onCharacter(seen());
    make(combat({ opener: '' })).onCharacter(seen());
    make(combat(), {}, false).onCharacter(seen());
    drain();
    expect(sent).toEqual([]);
  });

  /* The combat block's master switch governs everything under it. */
  it('stands down with auto-combat off, unless a lap has the character', () => {
    make(combat({ enabled: false })).onCharacter(seen());
    drain();
    expect(sent).toEqual([]);
    make(combat({ enabled: false }), { moving: () => true }).onCharacter(seen());
    drain();
    expect(sent).toEqual(['sn']);
  });

  /* A failed roll says `seen` again; the retry is floored, not once a prompt. */
  it('asks again at the stated rate, not once per status line', () => {
    const auto = make();
    auto.onCharacter(seen());
    vi.advanceTimersByTime(1000);
    auto.onCharacter(seen());
    drain();
    expect(sent).toEqual(['hide']);
    vi.advanceTimersByTime(4000);
    auto.onCharacter(seen());
    drain();
    expect(sent).toEqual(['hide', 'hide']);
  });
});

describe('while a lap or a route has the character', () => {
  it('sneaks instead', () => {
    make(combat(), { moving: () => true }).onCharacter(seen());
    drain();
    expect(sent).toEqual(['sn']);
  });
});

describe('the Stealth ceiling', () => {
  it('is said once, to a backstabber past 100, whatever the switch says', () => {
    const auto = make(combat({ hideForOpener: false }));
    const state = seen({ progress: { ...seen().progress, stealthSkill: 123 } });
    auto.onCharacter(state);
    auto.onCharacter(state);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('123');
  });

  it('is not said at or under 100, nor to a class with no backstab', () => {
    make().onCharacter(seen({ progress: { ...seen().progress, stealthSkill: 100 } }));
    make(combat({ opener: 'ju' })).onCharacter(
      seen({ progress: { ...seen().progress, stealthSkill: 140 } })
    );
    expect(notices).toEqual([]);
  });
});
