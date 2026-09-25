import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { classifyOccupant } from '../../../shared/mobs';
import { blockOf } from '../../../shared/__tests__/blocks';
import { DeathSentence } from '../deathSentence';

/*
 * The order a death sentence is kept, let go and learned in (todo 700: *order
 * is a decision*). The tracker's tests play a kill and read the lore, which a
 * lesson written before the naming test, a blank line that lets go of the
 * sentence, or a reset that keeps it would all pass. So these drive
 * `DeathSentence` with a lore that writes down each lesson it is told.
 */

const T = 1_700_000_000_000;
const SENTENCE = 'The kobold falls to the ground with a shriek!';

/** A learner that knows `kobold` (and not `thin kobold`), and the lessons it gave. */
function rig(): { lessons: string[]; learner: DeathSentence } {
  const lessons: string[] = [];
  const learner = new DeathSentence({
    known: (name) => name === 'kobold',
    lore: { observeDeath: (name, text, at) => lessons.push(`${name} | ${text} | ${at}`) }
  });
  return { lessons, learner };
}

/** Fighting `target`. */
function fighting(target: string | null): CharacterState {
  const s = structuredClone(EMPTY_CHARACTER);
  return { ...s, phase: 'in-game', combat: { ...s.combat, target } };
}

const unread = (text: string, at = T): ReturnType<typeof blockOf> =>
  blockOf('unknown', text, {}, at);

describe('the order a death sentence is learned in', () => {
  it('learns the unread line before the experience line when it names the target', () => {
    const { lessons, learner } = rig();
    learner.heard(unread(SENTENCE));
    expect(learner.before(fighting('kobold'), T + 1)).toBe('sentence');
    expect(lessons).toEqual([`kobold | ${SENTENCE} | ${T + 1}`]);
  });

  it('keeps it across the prompt and a blank line, and nothing else', () => {
    const kept = rig();
    kept.learner.heard(unread(SENTENCE));
    kept.learner.heard(blockOf('status-line', '[HP=10/20]:', {}, T));
    kept.learner.heard(unread('   '));
    expect(kept.learner.before(fighting('kobold'), T + 1)).toBe('sentence');

    const broken = rig();
    broken.learner.heard(unread(SENTENCE));
    broken.learner.heard(blockOf('user-hits', 'You hit the orc for 3 damage!', {}, T));
    expect(broken.learner.before(fighting('kobold'), T + 1)).toBe('experience');
    expect(broken.lessons).toEqual([]);
  });

  it('writes no lesson before the line has been found to name the target', () => {
    const { lessons, learner } = rig();
    learner.heard(unread('The orc falls to the ground with a shriek!'));
    expect(learner.before(fighting('kobold'), T + 1)).toBe('experience');
    learner.heard(unread('The koboldling falls to the ground!'));
    expect(learner.before(fighting('kobold'), T + 1)).toBe('experience');
    learner.heard(unread('The kobold has 3 lives left.'));
    expect(learner.before(fighting('kobold'), T + 1)).toBe('experience');
    learner.heard(unread(SENTENCE));
    expect(learner.before(fighting(null), T + 1)).toBe('experience');
    expect(lessons).toEqual([]);
  });

  it('drops the room’s modifier only where the realm knows the shorter name', () => {
    const { lessons, learner } = rig();
    learner.heard(unread(SENTENCE));
    expect(learner.before(fighting('thin kobold'), T + 1)).toBe('sentence');
    expect(lessons).toEqual([`thin kobold | ${SENTENCE} | ${T + 1}`]);
  });

  /*
   * The realm's author may name the monster by a shorter noun than its row
   * (todo 751; orohost wire, `logs/2026-09-10_12-54-31_festus:476-483`): a
   * `thin gnoll axeman` dies with `The gnoll drops his weapon…`. Beside a
   * `big gnoll scout` the same words may be the scout's, since an area caster
   * is paid for every kill (`Mob.cs:2313-2344`), so that room refuses.
   */
  it('learns a sentence naming the target by part of its row, where no other monster answers to it', () => {
    const GNOLL = 'The gnoll drops his weapon, throws up blood, and collapses!';
    const lessons: string[] = [];
    const learner = new DeathSentence({
      known: (name) => name === 'gnoll axeman' || name === 'gnoll scout',
      lore: { observeDeath: (name, text) => lessons.push(`${name} | ${text}`) }
    });
    const room = (target: string, ...names: string[]): CharacterState => {
      const s = fighting(target);
      const occupants = names.map((name) =>
        classifyOccupant(name, {
          players: new Set<string>(),
          mob: () => ({ disposition: 'hostile', uncertain: false, costly: 'never' })
        })
      );
      return { ...s, room: { ...s.room, occupants } };
    };

    learner.heard(unread(GNOLL));
    expect(
      learner.before(room('thin gnoll axeman', 'thin gnoll axeman', 'big gnoll scout'), T + 1)
    ).toBe('experience');
    learner.heard(unread(GNOLL));
    expect(learner.before(room('thin gnoll axeman', 'thin gnoll axeman'), T + 2)).toBe('sentence');
    learner.heard(unread('The fungus tree collapses in a heap!'));
    expect(learner.before(fighting('black fungus tree'), T + 3)).toBe('sentence');
    // Said anywhere but as the subject, a word of the name is no naming.
    learner.heard(unread('The scorpion bleeds black fluid and dies!'));
    expect(learner.before(fighting('black pudding'), T + 4)).toBe('experience');
    expect(lessons).toEqual([
      `thin gnoll axeman | ${GNOLL}`,
      'black fungus tree | The fungus tree collapses in a heap!'
    ]);
  });

  it('keeps a shared sentence’s candidates for the experience line to name', () => {
    const { lessons, learner } = rig();
    const shared = blockOf('mob-dies', SENTENCE, { mobs: 'kobold|orc' }, T);
    learner.heard(shared);
    expect(learner.before(fighting('rat'), T + 1)).toBe('experience');
    expect(learner.before(fighting('orc'), T + 2)).toBe('sentence');
    expect(lessons).toEqual([`orc | ${SENTENCE} | ${T + 2}`]);
  });

  it('lets go of the line at a death the room settled, and when forgotten', () => {
    const settled = rig();
    settled.learner.heard(unread(SENTENCE));
    settled.learner.heard(blockOf('mob-dies', SENTENCE, { mob: 'kobold' }, T));
    expect(settled.learner.before(fighting('kobold'), T + 1)).toBe('experience');

    const forgotten = rig();
    forgotten.learner.heard(unread(SENTENCE));
    forgotten.learner.forget();
    expect(forgotten.learner.before(fighting('kobold'), T + 1)).toBe('experience');
    expect([...settled.lessons, ...forgotten.lessons]).toEqual([]);
  });
});
