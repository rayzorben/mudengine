import { describe, expect, it } from 'vitest';

import { HangUpWatch, MOB_ENGAGED_MS, PVP_WINDOW_MS, playersHere } from '../HangUp';
import { t } from '../../app/i18n';
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
  return {
    seq: 1,
    at,
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

function who(name: string, alignment: Adventurer['alignment'] = null): Adventurer {
  return { name, alignment, title: null, flags: null, gang: null, provisional: false };
}

function state(over: Partial<CharacterState> = {}): CharacterState {
  return { ...EMPTY_CHARACTER, phase: 'in-game', ...over };
}

/*
 * A charged disconnect costs a percentage of *maximum* HP, and only PvP
 * charges one (`ClearToHangWithoutPenalty`, todo 131). See
 * docs/greatermud/combat.md.
 */
describe('whether hanging up would be penalised', () => {
  it('finds no reason when nothing has happened', () => {
    const watch = new HangUpWatch();
    expect(watch.assess(state(), T0)).toMatchObject({ clean: true, reasons: [] });
  });

  /* `PenalizeHangInMobCombat` is false and assigned nowhere (`GMUDServer.cs:120`). */
  it('charges nothing for a fight with a monster, which still threatens', () => {
    const watch = new HangUpWatch();
    watch.observe(block('mob-hits', { attacker: 'orc' }), state());
    const fighting = state({
      inCombat: true,
      room: { ...EMPTY_CHARACTER.room, occupants: mobs_([['giant rat', 'hostile']]) }
    });
    // Positive control: the same room is one a naked character would not stay in.
    expect(watch.threatened(fighting, T0 + 1000)).toBe(true);
    expect(watch.clean(fighting, T0 + 1000)).toBe(true);
    expect(watch.assess(fighting, T0 + 1000)).toMatchObject({ clean: true, reasons: [] });
  });

  it('threatens while something is still swinging, and stops once it has stopped', () => {
    const watch = new HangUpWatch();
    watch.observe(block('mob-hits', { attacker: 'orc' }), state());
    expect(watch.threatened(state(), T0 + 1000)).toBe(true);
    expect(watch.threatened(state(), T0 + MOB_ENGAGED_MS + 1)).toBe(false);
  });

  /* 2026-10-19: Soul hung up naked in the temple seconds after the killing blow. */
  it('forgets the killing blow at the death', () => {
    const watch = new HangUpWatch();
    watch.observe(block('mob-hits', { attacker: 'orc' }), state());
    expect(watch.threatened(state(), T0 + 1000)).toBe(true);
    watch.observe(block('user-dies', {}, T0 + 1500), state());
    expect(watch.threatened(state(), T0 + 2000)).toBe(false);
    expect(watch.monsterNear(state(), T0 + 2000)).toBe(false);
  });

  it('charges for a player it is fighting, or one fighting it, right now', () => {
    const watch = new HangUpWatch();
    const room = {
      ...EMPTY_CHARACTER.room,
      occupants: here_(['Grimjaw', 'orc rogue'], ['Grimjaw'])
    };
    const players = { online: [who('Grimjaw', 'Outlaw')], room };
    const target = state({ ...players, combat: { ...EMPTY_CHARACTER.combat, target: 'Grimjaw' } });
    expect(watch.assess(target, T0).reasons).toEqual([
      t('automation.hangUp.reasonPvpNow', { name: 'Grimjaw' })
    ]);
    const attacked = state({
      ...players,
      combat: { ...EMPTY_CHARACTER.combat, attackers: ['Grimjaw'] }
    });
    expect(watch.clean(attacked, T0)).toBe(false);
    // A monster as the target is no PvP.
    const monster = state({
      ...players,
      combat: { ...EMPTY_CHARACTER.combat, target: 'orc rogue' }
    });
    expect(watch.clean(monster, T0)).toBe(true);
    // Not in a protected room (`Room.IsProtected`).
    expect(watch.clean({ ...target, room: { ...room, safe: true } }, T0)).toBe(true);
  });

  /* Unknown is never the reassuring answer: a name the room does not list as a monster may be a player. */
  it('charges, as a doubt, for a fighter the client cannot place', () => {
    const watch = new HangUpWatch();
    const room = { ...EMPTY_CHARACTER.room, occupants: here_(['Gorgo']) };
    const unplaced = state({ room, combat: { ...EMPTY_CHARACTER.combat, attackers: ['Gorgo'] } });
    expect(watch.assess(unplaced, T0).reasons).toEqual([
      t('automation.hangUp.reasonPvpUnplaced', { name: 'Gorgo' })
    ]);
    const unlisted = state({ combat: { ...EMPTY_CHARACTER.combat, attackers: ['Gorgo'] } });
    expect(watch.clean(unlisted, T0)).toBe(false);
  });

  it('charges four minutes after a player hit you, and not six', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'Grimjaw', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
    expect(watch.clean(state(), T0 + 4 * 60_000)).toBe(false);
    expect(watch.clean(state(), T0 + 6 * 60_000)).toBe(true);
  });

  /*
   * The five-minute window is the part nothing on screen shows: combat has
   * ended, the room is empty, and a hangup is still penalised.
   */
  it('refuses for five minutes after a player hits you', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'Grimjaw', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
    expect(watch.assess(state(), T0 + 60_000).clean).toBe(false);
    expect(watch.assess(state(), T0 + PVP_WINDOW_MS - 1).clean).toBe(false);
    expect(watch.assess(state(), T0 + PVP_WINDOW_MS + 1).clean).toBe(true);
  });

  /* The server penalises the aggressor exactly as it penalises the victim. */
  it('refuses for five minutes after you hit a player', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'You', target: 'Grimjaw' }),
      state({ online: [who('Grimjaw')] })
    );
    expect(watch.assess(state(), T0 + 60_000).clean).toBe(false);
  });

  /*
   * Rayzor, 2026-11-12: `The tall salamander skewers Brakkle for 6 damage!`
   * read through the catch-all frame names Brakkle as the target and the
   * salamander as the attacker. A monster hitting a party member is no PvP.
   * The control above is the same block with `You` as the attacker.
   */
  it('does not count a monster hitting a player as this character hitting one', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'tall salamander', target: 'Brakkle' }),
      state({ online: [who('Brakkle')] })
    );
    watch.observe(block('user-hits', { target: 'Brakkle' }), state({ online: [who('Brakkle')] }));
    expect(watch.assess(state(), T0 + 1000).clean).toBe(true);
  });

  it('names who it was, because five minutes of refusing needs a reason', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'Grimjaw', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
    expect(watch.assess(state(), T0 + 1000).reasons.join(' ')).toContain('Grimjaw');
  });

  it('says how long is left, so waiting is a choice rather than a mystery', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'Grimjaw', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
    const result = watch.assess(state(), T0 + 60_000);
    expect(result.clearInMs).toBeGreaterThan(0);
    expect(result.clearInMs).toBeLessThanOrEqual(PVP_WINDOW_MS - 60_000);
  });

  /*
   * Todo 20261103-0930-01: a player missing from the who list is the case that
   * matters, and unknown is the unsafe answer, so only a known monster is one.
   */
  it('opens the PvP window for a name nothing has placed, and says it is unlisted', () => {
    const blows: string[] = [];
    const watch = new HangUpWatch({
      pvpBlow: (name, _at, listed) => blows.push(`${name}:${listed}`)
    });
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), state());
    expect(watch.clean(state(), T0 + 60_000)).toBe(false);
    expect(blows).toEqual(['Grimjaw:false']);
    // It may be a monster too, so it threatens as one.
    expect(watch.monsterSwung(T0 + 1000)).toBe(true);
  });

  it('opens it for a player the room listing marked, though the who list has not', () => {
    const blows: string[] = [];
    const watch = new HangUpWatch({
      pvpBlow: (name, _at, listed) => blows.push(`${name}:${listed}`)
    });
    const room = { ...EMPTY_CHARACTER.room, occupants: here_(['Grimjaw*']) };
    watch.observe(block('user-hits', { attacker: 'Grimjaw', target: 'you' }), state({ room }));
    expect(blows).toEqual(['Grimjaw:true']);
    expect(watch.monsterSwung(T0 + 1000)).toBe(false);
  });

  it('does not open it for a monster the room lists, which still threatens', () => {
    const blows: string[] = [];
    const watch = new HangUpWatch({ pvpBlow: (name) => blows.push(name) });
    const room = { ...EMPTY_CHARACTER.room, occupants: mobs_([['Champion Gudruk', 'hostile']]) };
    watch.observe(
      block('user-hits', { attacker: 'Champion Gudruk', target: 'you' }),
      state({ room })
    );
    expect(watch.threatened(state(), T0 + 1000)).toBe(true);
    expect(watch.clean(state(), T0 + 1000)).toBe(true);
    expect(blows).toEqual([]);
    // Positive control: the same blow from a name nothing placed opens it.
    watch.observe(block('user-hits', { attacker: 'Gorgo', target: 'you' }, T0 + 2000), state());
    expect(blows).toEqual(['Gorgo']);
  });

  it('does not open it for a blow that names nobody', () => {
    const watch = new HangUpWatch();
    watch.observe(block('user-hits', { target: 'you' }), state());
    expect(watch.clean(state(), T0 + 1000)).toBe(true);
    expect(watch.monsterSwung(T0 + 1000)).toBe(true);
  });

  /* The user, 2026-11-04: a monster's damage line stops the room damage count; the river's own line reads as a miss. */
  it('marks a damage line from anything not a player, and never a miss or a player', () => {
    const missed = new HangUpWatch();
    missed.observe(block('mob-misses', {}), state());
    expect(missed.monsterSwung(T0 + 1000)).toBe(true);
    expect(missed.monsterHit(T0 + 1000)).toBe(false);
    const player = new HangUpWatch();
    player.observe(
      block('user-hits', { attacker: 'Grimjaw', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
    expect(player.monsterHit(T0 + 1000)).toBe(false);
    // A room spell's damage line with nothing here: the room's, not a monster's.
    const spell = new HangUpWatch();
    spell.observe(block('user-hits', { attacker: 'Fire', target: 'you' }), state());
    spell.observe(block('mob-hits', {}), state());
    expect(spell.monsterHit(T0 + 1000)).toBe(false);
    // The positive controls: a monster's blow, and its weapon's extra damage, with it here.
    const room = { ...EMPTY_CHARACTER.room, occupants: mobs_([['bola spider', 'hostile']]) };
    const hit = new HangUpWatch();
    hit.observe(block('mob-hits', {}), state({ room }));
    expect(hit.monsterHit(T0 + 1000)).toBe(true);
    expect(hit.monsterHit(T0 + MOB_ENGAGED_MS)).toBe(false);
    const acid = new HangUpWatch();
    acid.observe(block('user-hits', { attacker: 'Acid', target: 'you' }), state({ room }));
    expect(acid.monsterHit(T0 + 1000)).toBe(true);
    // In a fight the state shows, the monster need not be listed.
    const fight = new HangUpWatch();
    fight.observe(block('mob-hits', {}), state({ inCombat: true }));
    expect(fight.monsterHit(T0 + 1000)).toBe(true);
  });

  it('matches a roster name whatever its case', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'GRIMJAW', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
    expect(watch.assess(state(), T0 + 60_000).clean).toBe(false);
  });

  it('reports every reason at once rather than only the first', () => {
    const watch = new HangUpWatch();
    watch.observe(
      block('user-hits', { attacker: 'Grimjaw', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
    const result = watch.assess(
      state({
        online: [who('Grimjaw', 'Outlaw')],
        room: { ...EMPTY_CHARACTER.room, occupants: here_(['Grimjaw'], ['Grimjaw']) },
        combat: { ...EMPTY_CHARACTER.combat, attackers: ['Grimjaw'] }
      }),
      T0 + 1000
    );
    expect(result.reasons).toHaveLength(2);
  });

  /* A new connection is a new character in the realm. */
  /*
   * `ShouldMobAttackTarget` is set the moment a monster decides to attack, a
   * full round before its first swing — so a reading built only from blows
   * misses exactly the window in which a hangup looks safe and is not. The
   * realm data names which monsters decide that on sight.
   */
  it('threatens, uncharged, where the realm says a monster attacks on sight', () => {
    const watch = new HangUpWatch();
    const here = state({
      room: { ...EMPTY_CHARACTER.room, occupants: mobs_([['giant rat', 'hostile']]) }
    });
    expect(watch.threatened(here, T0)).toBe(true);
    expect(watch.clean(here, T0)).toBe(true);
  });

  it('does not threaten for a monster the realm says never starts a fight', () => {
    const watch = new HangUpWatch();
    const here = state({
      room: { ...EMPTY_CHARACTER.room, occupants: mobs_([['practice dummy', 'passive']]) }
    });
    expect(watch.threatened(here, T0)).toBe(false);
  });

  /* Unknown is never the reassuring answer. */
  it('threatens for a monster the realm data cannot place', () => {
    const watch = new HangUpWatch();
    const here = state({ room: { ...EMPTY_CHARACTER.room, occupants: here_(['kobold']) } });
    expect(watch.threatened(here, T0)).toBe(true);
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
    watch.observe(
      block('user-hits', { attacker: 'Grimjaw', target: 'you' }),
      state({ online: [who('Grimjaw')] })
    );
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

/* Todo 01: what low health may hang up beside. */
describe('whether a monster is near', () => {
  it('counts a monster that swung lately, with the room empty and no fight flagged', () => {
    const watch = new HangUpWatch();
    expect(watch.monsterNear(state(), T0)).toBe(false);
    watch.observe(block('mob-misses', { attacker: 'orc' }), state());
    expect(watch.monsterNear(state(), T0 + 1)).toBe(true);
    expect(watch.monsterNear(state(), T0 + MOB_ENGAGED_MS)).toBe(false);
  });
});
