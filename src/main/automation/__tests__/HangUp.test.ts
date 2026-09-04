import { describe, expect, it } from 'vitest';

import { HangUpWatch, MOB_ENGAGED_MS, PVP_WINDOW_MS, playersHere } from '../HangUp';
import {
  EMPTY_CHARACTER,
  type Adventurer,
  type CharacterState,
  type RoomOccupant
} from '../../../shared/character';
import { classifyOccupant, type MobDisposition } from '../../../shared/mobs';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';

const T0 = 1_700_000_000_000;

function block(type: BlockType, groups: Record<string, string>, at = T0): Block {
  return { seq: 1, at, type, domain: domainOf(type), groups, text: '', confidence: 0.8 };
}

function who(name: string, alignment: Adventurer['alignment'] = null): Adventurer {
  return { name, alignment, title: null, flags: null, gang: null, provisional: false };
}

function state(over: Partial<CharacterState> = {}): CharacterState {
  return { ...EMPTY_CHARACTER, phase: 'in-game', ...over };
}

/*
 * The classic MegaMUD panic button is "hang up when health is low", and on this
 * server family that is one of the more reliable ways to die: an unclean
 * disconnect costs a percentage of *maximum* HP. See docs/greatermud/combat.md.
 *
 * So the interesting cases here are all the ones where it refuses.
 */
describe('whether hanging up would be penalised', () => {
  it('finds no reason when nothing has happened', () => {
    const watch = new HangUpWatch();
    expect(watch.assess(state(), T0)).toMatchObject({ clean: true, reasons: [] });
  });

  it('refuses while in combat', () => {
    const watch = new HangUpWatch();
    const result = watch.assess(state({ inCombat: true }), T0);
    expect(result.clean).toBe(false);
    expect(result.reasons.join(' ')).toContain('combat');
  });

  it('refuses while something in the room is still swinging', () => {
    const watch = new HangUpWatch();
    watch.observe(block('mob-hits', { attacker: 'orc' }), []);
    expect(watch.assess(state(), T0 + 1000).clean).toBe(false);
  });

  it('and stops refusing once the mob has stopped', () => {
    const watch = new HangUpWatch();
    watch.observe(block('mob-hits', { attacker: 'orc' }), []);
    expect(watch.assess(state(), T0 + MOB_ENGAGED_MS + 1).clean).toBe(true);
  });

  /*
   * The five-minute window is the part nothing on screen shows: combat has
   * ended, the room is empty, and a hangup is still penalised.
   */
  it('refuses for five minutes after a player hits you', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), [who('Grimjaw')]);
    expect(watch.assess(state(), T0 + 60_000).clean).toBe(false);
    expect(watch.assess(state(), T0 + PVP_WINDOW_MS - 1).clean).toBe(false);
    expect(watch.assess(state(), T0 + PVP_WINDOW_MS + 1).clean).toBe(true);
  });

  /* The server penalises the aggressor exactly as it penalises the victim. */
  it('refuses for five minutes after you hit a player', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'You', target: 'Grimjaw' }), [who('Grimjaw')]);
    expect(watch.assess(state(), T0 + 60_000).clean).toBe(false);
  });

  it('names who it was, because five minutes of refusing needs a reason', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), [who('Grimjaw')]);
    expect(watch.assess(state(), T0 + 1000).reasons.join(' ')).toContain('Grimjaw');
  });

  it('says how long is left, so waiting is a choice rather than a mystery', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), [who('Grimjaw')]);
    const result = watch.assess(state(), T0 + 60_000);
    expect(result.clearInMs).toBeGreaterThan(0);
    expect(result.clearInMs).toBeLessThanOrEqual(PVP_WINDOW_MS - 60_000);
  });

  /*
   * A name not in the roster is treated as a monster. Treating every unknown
   * name as a player would keep the window permanently open and make a clean
   * hangup unreachable — the roster is what makes the distinction real.
   */
  it('does not open the PvP window for a name nobody has listed', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), []);
    // Still a reason — something hit us — but it lapses in seconds, not minutes.
    expect(watch.assess(state(), T0 + 1000).clean).toBe(false);
    expect(watch.assess(state(), T0 + MOB_ENGAGED_MS + 1).clean).toBe(true);
  });

  it('matches a roster name whatever its case', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'GRIMJAW', target: 'you' }), [who('Grimjaw')]);
    expect(watch.assess(state(), T0 + 60_000).clean).toBe(false);
  });

  it('reports every reason at once rather than only the first', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), [who('Grimjaw')]);
    watch.observe(block('mob-hits', { attacker: 'orc' }, T0 + 500), []);
    const result = watch.assess(state({ inCombat: true }), T0 + 1000);
    expect(result.reasons).toHaveLength(3);
  });

  /* A new connection is a new character in the realm. */
  /*
   * `ShouldMobAttackTarget` is set the moment a monster decides to attack, a
   * full round before its first swing — so a reading built only from blows
   * misses exactly the window in which a hangup looks safe and is not. The
   * realm data names which monsters decide that on sight.
   */
  it('refuses while something the realm says attacks on sight is in the room', () => {
    const watch = new HangUpWatch();
    const result = watch.assess(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: mobs_([['giant rat', 'hostile']]) } }),
      T0
    );
    expect(result.clean).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/giant rat/);
  });

  it('does not refuse for a monster the realm says never starts a fight', () => {
    const watch = new HangUpWatch();
    const result = watch.assess(
      state({
        room: { ...EMPTY_CHARACTER.room, occupants: mobs_([['practice dummy', 'passive']]) }
      }),
      T0
    );
    expect(result.clean).toBe(true);
  });

  /* Unknown is never the reassuring answer, and the wording says it is a doubt. */
  it('refuses, as a doubt, for a monster the realm data cannot place', () => {
    const watch = new HangUpWatch();
    const result = watch.assess(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: here_(['kobold']) } }),
      T0
    );
    expect(result.clean).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/kobold/);
    expect(result.reasons.join(' ')).toMatch(/may attack/);
  });

  it('does not count a player standing in the room as a monster reason', () => {
    const watch = new HangUpWatch();
    const result = watch.assess(
      state({
        room: { ...EMPTY_CHARACTER.room, occupants: here_(['Grimjaw'], ['Grimjaw']) },
        online: [who('Grimjaw', 'Outlaw')]
      }),
      T0
    );
    expect(result.clean).toBe(true);
  });

  it('forgets everything on reset', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), [who('Grimjaw')]);
    watch.reset();
    expect(watch.assess(state(), T0 + 1000).clean).toBe(true);
  });
});

/*
 * Known, not guessed. The room line does not say what anybody is, so this
 * cross-references the roster — and under-reports rather than crying wolf.
 */
describe('who in the room is a player', () => {
  it('counts an occupant the realm has listed', () => {
    const here = playersHere(
      state({
        room: { ...EMPTY_CHARACTER.room, occupants: here_(['Grimjaw', 'orc rogue'], ['Grimjaw']) },
        online: [who('Grimjaw', 'Outlaw')]
      })
    );
    expect(here).toEqual(['Grimjaw']);
  });

  it('does not count a monster whose name happens to be capitalised', () => {
    const here = playersHere(
      state({
        room: { ...EMPTY_CHARACTER.room, occupants: here_(['Sheriff Lionheart']) },
        online: []
      })
    );
    expect(here).toEqual([]);
  });

  it('says nobody when the roster is empty, rather than guessing', () => {
    const here = playersHere(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: here_(['Grimjaw']) }, online: [] })
    );
    expect(here).toEqual([]);
  });

  /*
   * The server's own punctuation, which outranks the roster's silence.
   *
   * `*` is printed only for a player — `Player.cs` appends it when attacking
   * them would cost no experience — so somebody wearing one is a player whether
   * or not a listing has arrived. This is the case the roster cross-reference
   * used to miss, and it is the one that matters: a name marked free to attack
   * is a name a hangup decision turns on.
   */
  it('counts somebody the listing itself marked as a player', () => {
    const here = playersHere(
      state({ room: { ...EMPTY_CHARACTER.room, occupants: here_(['Grimjaw*']) }, online: [] })
    );
    expect(here).toEqual(['Grimjaw']);
  });
});

/**
 * `Also here:` entries, classified the way the tracker classifies them.
 *
 * Through the real classifier rather than by writing the shape out, so a test
 * cannot assert against a room the client could never actually produce. No
 * realm data: these are all names it would not carry anyway.
 */
function here_(names: string[], players: string[] = []): RoomOccupant[] {
  const roster = new Set(players.map((name) => name.toLowerCase()));
  return names.map((name) => classifyOccupant(name, { players: roster, mob: () => undefined }));
}

/** The same, for monsters the realm data has placed with a disposition. */
function mobs_(entries: Array<[string, MobDisposition]>): RoomOccupant[] {
  const facts = new Map(entries);
  return entries.map(([name]) =>
    classifyOccupant(name, {
      players: new Set(),
      mob: (asked) => {
        const disposition = facts.get(asked);
        return disposition === undefined
          ? undefined
          : { disposition, uncertain: false, costly: 'never' };
      }
    })
  );
}
