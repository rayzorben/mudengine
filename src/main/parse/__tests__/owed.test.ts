import { describe, expect, it } from 'vitest';

import { blockOf } from '../../../shared/__tests__/blocks';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { OwedAttacks } from '../owed';

/*
 * The attacks owed an engagement, and the three things that settle one without
 * it (todo 763): its echo passed by a prompt and then a later echo, a guard
 * stepping in, and age. The tracker's tests play the wire; these drive the
 * queue's own edge, where the order a line settles an entry in is the rule.
 */
const T = 1_700_000_000_000;
const prompt = (): ReturnType<typeof blockOf> => blockOf('status-line', '[HP=34]:', {}, T);
const echo = (command: string): ReturnType<typeof blockOf> =>
  blockOf('command-echo', command, {}, T);

describe('an engagement', () => {
  it('answers the oldest attack still owed, one each', () => {
    const owed = new OwedAttacks();
    owed.sent('pu small filthbug', 'small filthbug', T);
    owed.sent('pu large giant rat', 'large giant rat', T + 11);
    expect(owed.answer(T + 117)).toBe('small filthbug');
    expect(owed.answer(T + 133)).toBe('large giant rat');
    expect(owed.answer(T + 140)).toBeNull();
  });

  it('binds nothing while a bare verb is owed, since a refused name ahead of it would take its answer', () => {
    const owed = new OwedAttacks();
    owed.sent('pu orc rogue', 'orc rogue', T);
    owed.sent('a', null, T + 1);
    expect(owed.answer(T + 2)).toBeNull();
    // Positive control: the named attack alone binds.
    owed.forget();
    owed.sent('pu orc rogue', 'orc rogue', T);
    expect(owed.answer(T + 2)).toBe('orc rogue');
  });

  it('lets an attack nothing answered in time go, and keeps one exactly at the edge', () => {
    const owed = new OwedAttacks();
    const bind = DEFAULT_INTERNAL.tuning.parse.engageBindMs;
    owed.sent('pu giant rat', 'giant rat', T);
    expect(owed.answer(T + bind + 1)).toBeNull();
    owed.sent('pu kobold thief', 'kobold thief', T + 10_000);
    expect(owed.answer(T + 10_000 + bind)).toBe('kobold thief');
  });
});

/*
 * The server echoes a command when it reads it, and a prompt printed after the
 * echo is the server having had its turn at it. So an attack echoed, passed by
 * a prompt, and then passed by the echo of a later command was answered by
 * something other than an engagement — refused — and is owed nothing more.
 */
describe('an echo', () => {
  /*
   * orohost, `2026-08-26_10-57-20_main.mudcap.jsonl` t=34850–35052: the rat
   * was already dead, `Your command had no effect.` answered its attack, and
   * the queue bound the lashworm's engagement to the rat.
   */
  it('retires an attack its prompt and a later echo passed unanswered', () => {
    const owed = new OwedAttacks();
    owed.sent('pu nasty giant rat', 'nasty giant rat', T);
    owed.heard(echo('pu nasty giant rat'));
    owed.sent('pu small lashworm', 'small lashworm', T + 94);
    owed.heard(prompt());
    owed.heard(echo('pu small lashworm'));
    expect(owed.answer(T + 202)).toBe('small lashworm');
  });

  /*
   * Paradigm, `2026-08-31_18-54-18_festus.mudcap.jsonl` t=1888–2787: a login
   * burst comes back as a run of bare echoes, the server reading ahead of its
   * answers, and the attack's engagement arrives after all of them. A bare echo
   * passes nothing (`Classifier.pendingEchoes`); retiring on it lost 76 such
   * bindings over the recorded sessions.
   */
  it('keeps an attack through a run of bare echoes', () => {
    const owed = new OwedAttacks();
    owed.sent('pu small acid slime', 'small acid slime', T);
    owed.heard(echo('pu small acid slime'));
    owed.heard(echo('st'));
    owed.heard(echo('i'));
    owed.heard(prompt());
    expect(owed.answer(T + 899)).toBe('small acid slime');
  });

  it('settles only an attack echoed before it, never one whose echo has not come', () => {
    const owed = new OwedAttacks();
    owed.sent('pu orc rogue', 'orc rogue', T);
    owed.heard(prompt());
    owed.heard(echo('l'));
    expect(owed.answer(T + 5)).toBe('orc rogue');
  });

  it('pairs a repeated command with its oldest owed attack', () => {
    const owed = new OwedAttacks();
    owed.sent('aa rat', 'rat', T);
    owed.sent('aa rat', 'rat', T + 1);
    owed.heard(echo('aa rat'));
    owed.heard(prompt());
    owed.heard(echo('aa rat'));
    // The first was passed and retired; the second, echoed last, still binds.
    expect(owed.answer(T + 5)).toBe('rat');
    expect(owed.answer(T + 6)).toBeNull();
  });
});

/*
 * `X moves to protect Y`: the server turns the guard on the attacker and makes
 * it the attack's target (`AttackCommand.cs:342-347`, `Player.cs:6136-6141`),
 * so the engagement that follows is the guard's.
 */
describe('a guard stepping in', () => {
  it('takes the attack owed on its ward', () => {
    const owed = new OwedAttacks();
    owed.sent('aa nasty wild dog', 'nasty wild dog', T);
    expect(owed.redirect('thin wild dog', 'nasty wild dog')).toBe(true);
    expect(owed.answer(T + 80)).toBe('thin wild dog');
  });

  it("takes a bare verb's attack, which was the ward's", () => {
    const owed = new OwedAttacks();
    owed.sent('a', null, T);
    expect(owed.redirect('thin wild dog', 'nasty wild dog')).toBe(true);
    expect(owed.answer(T + 80)).toBe('thin wild dog');
  });

  it('is replaced by a second guard of the same ward, the one the server leaves as target', () => {
    const owed = new OwedAttacks();
    owed.sent('aa nasty wild dog', 'nasty wild dog', T);
    owed.redirect('thin wild dog', 'nasty wild dog');
    expect(owed.redirect('small wild dog', 'nasty wild dog')).toBe(true);
    expect(owed.answer(T + 80)).toBe('small wild dog');
  });

  it('owes nothing new when no attack names the ward, until told to step in', () => {
    const owed = new OwedAttacks();
    owed.sent('aa kobold', 'kobold', T);
    expect(owed.redirect('thin wild dog', 'nasty wild dog')).toBe(false);
    owed.stepIn('thin wild dog', 'nasty wild dog', T + 5);
    // A spell's guard: the engagement right behind it is the guard's, ahead of the kobold.
    expect(owed.answer(T + 6)).toBe('thin wild dog');
    expect(owed.answer(T + 7)).toBe('kobold');
  });

  /*
   * A guard the spell cannot touch gets no engagement (`Player.cs:6138-6155`):
   * the step is retired by the next echo past its prompt, as a refused attack
   * is, so a later attack's engagement binds the later attack (763, review).
   */
  it('lets a step no engagement answered go at the next echo past its prompt', () => {
    const owed = new OwedAttacks();
    owed.stepIn('thin wild dog', 'nasty wild dog', T);
    owed.heard({ type: 'status-line', text: '[HP=40]:' });
    owed.sent('aa kobold', 'kobold', T + 100);
    owed.heard({ type: 'command-echo', text: 'aa kobold' });
    expect(owed.answer(T + 180)).toBe('kobold');
  });
});
