import { describe, expect, it } from 'vitest';

import {
  isFullStatline,
  readStatline,
  SET_STATLINE,
  STATLINE_MAX_CELLS,
  STATLINE_TEMPLATE,
  statlineMatcher,
  withReading,
  type StatlineFigures
} from '../statline';

/*
 * The prompts below are what the two families printed for the client's own
 * template on 2026-09-09 (GreaterMUD on orohost, MajorMUD in Newhaven). The
 * matcher is generated from the template, so these are the check that the
 * generator reproduces the realm's rendering rather than an idea of it.
 */
describe('the matcher built from the template', () => {
  const matcher = statlineMatcher(STATLINE_TEMPLATE)!;

  it('exists for the template the client sends', () => {
    expect(matcher).not.toBeNull();
    expect(SET_STATLINE).toBe(`set statline full custom ${STATLINE_TEMPLATE}`);
  });

  it('reads every figure off GreaterMUD, idle, where %r is one space', () => {
    expect(
      readStatline(matcher, '[HP=156/156,MA=11/28,Exp=1386670,Need=14402,Wealth=0 ]:')
    ).toEqual({
      hp: 156,
      hpMax: 156,
      mana: 11,
      manaMax: 28,
      exp: 1386670,
      need: 14402,
      wealth: 0,
      state: null
    });
  });

  it('reads MajorMUD, idle, where %r is nothing', () => {
    const read = readStatline(matcher, '[HP=40/40,MA=7/8,Exp=0,Need=2500,Wealth=0]:');
    expect(read?.hp).toBe(40);
    expect(read?.need).toBe(2500);
    expect(read?.state).toBeNull();
  });

  it('reads resting and meditating, and the echo after the prompt is left alone', () => {
    expect(
      readStatline(matcher, '[HP=40/40,MA=7/8,Exp=0,Need=2500,Wealth=0 (Resting) ]:med')?.state
    ).toBe('resting');
    expect(
      readStatline(matcher, '[HP=40/40,MA=7/8,Exp=0,Need=2500,Wealth=0 (Meditating) ]:')?.state
    ).toBe('meditating');
  });

  it('takes a sign on health and on the experience owed, and nowhere else', () => {
    const read = readStatline(matcher, '[HP=-25/156,MA=11/28,Exp=1386670,Need=-14402,Wealth=0 ]:');
    expect(read?.hp).toBe(-25);
    expect(read?.need).toBe(-14402);
    expect(readStatline(matcher, '[HP=25/156,MA=-11/28,Exp=1,Need=1,Wealth=0 ]:')).toBeNull();
  });

  it('refuses the class-default line, which the tolerant pattern reads', () => {
    expect(readStatline(matcher, '[HP=156/MA=11]:')).toBeNull();
  });

  it('admits the suffix the server splices in for an invisible character', () => {
    expect(
      readStatline(matcher, '[HP=156/156,MA=11/28,Exp=1,Need=2,Wealth=0  (Invisible) ]:')?.hp
    ).toBe(156);
    expect(
      readStatline(matcher, '[HP=156/156,MA=11/28,Exp=1,Need=2,Wealth=0 (Resting)  (Invisible) ]:')
        ?.state
    ).toBe('resting');
  });
});

describe('what a template can and cannot be built from', () => {
  it('is null for full, in any case', () => {
    expect(statlineMatcher('full')).toBeNull();
    expect(statlineMatcher('  Full ')).toBeNull();
    expect(isFullStatline('FULL')).toBe(true);
  });

  it('reads a template somebody else composed, in their labels', () => {
    // captures/: `[H=100|M=50|E=200]` is a MajorMUD player's own line.
    const matcher = statlineMatcher('[H=%h|M=%m|E=%x]')!;
    expect(matcher).not.toBeNull();
    expect(readStatline(matcher, '[H=100|M=50|E=200]:')).toMatchObject({
      hp: 100,
      mana: 50,
      exp: 200,
      hpMax: null
    });
  });

  it('treats a colour wildcard as taking no cells', () => {
    const matcher = statlineMatcher('%f4[HP=%f7%h/%H%f4]:')!;
    expect(matcher).not.toBeNull();
    expect(readStatline(matcher, '[HP=12/34]:')).toMatchObject({ hp: 12, hpMax: 34 });
  });

  it('accepts %w, which nothing reads, and does not report it', () => {
    const matcher = statlineMatcher('[HP=%h,Warn=%w]:')!;
    expect(readStatline(matcher, '[HP=12,Warn=On]:')?.hp).toBe(12);
    expect(readStatline(matcher, '[HP=12,Warn=Maybe]:')).toBeNull();
  });

  it('is null for %n, an unseen wildcard, a figure asked for twice, or no figure at all', () => {
    expect(statlineMatcher('[HP=%h]%n:')).toBeNull();
    expect(statlineMatcher('[HP=%h,%q]:')).toBeNull();
    expect(statlineMatcher('[HP=%h/%h]:')).toBeNull();
    expect(statlineMatcher('[Hello]:')).toBeNull();
    expect(statlineMatcher('')).toBeNull();
    expect(statlineMatcher('[HP=%')).toBeNull();
  });

  it('escapes the template as literal text', () => {
    const matcher = statlineMatcher('(HP: %h) $%c.')!;
    expect(readStatline(matcher, '(HP: 5) $12.')).toMatchObject({ hp: 5, wealth: 12 });
    expect(readStatline(matcher, 'xHP: 5) $12.')).toBeNull();
  });
});

/*
 * The figures a designed line draws from: what the client tracks, with the
 * prompt's own reading laid over it. The drawing is `rewrites.test.ts`.
 */
describe('the figures a design draws from', () => {
  const figures: StatlineFigures = {
    hp: 120,
    hpMax: 156,
    mana: 5,
    manaMax: 28,
    exp: 10,
    need: 90,
    wealth: 7,
    state: 'resting',
    name: 'Vaelor',
    fullName: 'Vaelor Stone',
    race: 'Human',
    className: 'Mystic',
    manaType: 'KAI',
    level: 3,
    room: 'Town Square',
    lives: 9,
    expSession: 12,
    encumbrance: 100,
    encumbranceMax: 400,
    encumbranceWord: 'None'
  };

  it("lays a prompt's reading over the state, and the prompt's idle over a remembered rest", () => {
    const known: StatlineFigures = { ...figures, hp: 1, state: 'resting' };
    const read = {
      hp: 50,
      hpMax: null,
      mana: null,
      manaMax: null,
      exp: null,
      need: null,
      wealth: null,
      state: null
    };
    expect(withReading(known, read)).toMatchObject({ hp: 50, hpMax: 156, state: null, level: 3 });
  });

  it('states the ceiling the prompt row holds, which is the server’s own repaint width', () => {
    expect(STATLINE_MAX_CELLS).toBe(79);
  });
});
