import { describe, expect, it } from 'vitest';

import { AbilitiesRemote } from '../AbilitiesRemote';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { Block, BlockType } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type AbilitySums, type CharacterState } from '../../../shared/character';
import type { Quest, QuestStep } from '../../../shared/quests';
import type { Intent, Offered } from '../CommandQueue';

const block = (type: BlockType, at = 0): Block =>
  ({ type, domain: 'status', groups: {}, text: '', at, seq: 1, terminator: 'newline' }) as Block;

const listed = (sums: Record<number, number>, at: number, complete = true): CharacterState => ({
  ...EMPTY_CHARACTER,
  abilities: { sums, complete, at } satisfies AbilitySums
});

const step = (block: number, to: number, who: string, say: string): QuestStep => ({
  block,
  who,
  say: [say],
  to,
  needs: [],
  takes: [],
  gives: []
});

const GOOD: Quest = {
  id: 126,
  name: 'GoodQuest',
  steps: [
    step(1, 4, 'Chancellor Annora', 'messenger'),
    step(2, 5, 'Commander Markus', 'letter'),
    step(3, 6, 'Chancellor Annora', 'return')
  ]
};

/** A queue that answers as `answer` says, a clock the test moves, and what went back. */
function harness(answer: Offered = 'queued', quests: readonly Quest[] | null = [GOOD]) {
  const offered: Intent[] = [];
  const replies: string[] = [];
  const notices: string[] = [];
  let clock = 1000;
  const remote = new AbilitiesRemote(
    {
      offer: (intent) => {
        offered.push(intent);
        return answer;
      }
    },
    {
      notice: (message) => notices.push(message),
      reply: (to, body, prefix) => replies.push(`${prefix}${to} ${body}`),
      quests: () => quests
    },
    () => clock
  );
  const tick = (at: number): void => {
    clock = at;
  };
  return { remote, offered, replies, notices, tick };
}

const ask = t('cards.quests.step.ask', { who: 'Commander Markus', word: 'letter' });

describe('@abil', () => {
  it('asks abil once, and answers everybody waiting with the step that set the rank', () => {
    const { remote, offered, replies, tick } = harness();
    remote.ask('Rand', '/', [126]);
    remote.ask('Soul', '/', [126, 2]);
    expect(offered.map((intent) => intent.command)).toEqual(['abil']);
    // A listing read before the send answers something else.
    remote.onBlock(block('user-abilities', 1000), listed({ 126: 4 }, 1000));
    expect(replies).toEqual([]);
    tick(2000);
    offered[0]!.onSent?.();
    remote.onBlock(block('user-abilities', 2100), listed({ 126: 5, 2: 50 }, 2100));
    expect(replies).toEqual([
      `/Rand {GoodQuest(126) - 5 (${ask})}`,
      `/Soul {GoodQuest(126) - 5 (${ask}), AC(2) - 50}`
    ]);
  });

  it('tells every listed quest counter for a bare @abil, and {none} without one', () => {
    const one = harness();
    one.remote.ask('Rand', '/', []);
    one.offered[0]!.onSent?.();
    one.remote.onBlock(block('user-abilities', 1000), listed({ 2: 50, 126: 5 }, 1000));
    expect(one.replies).toEqual([`/Rand {GoodQuest(126) - 5 (${ask})}`]);

    const none = harness();
    none.remote.ask('Rand', '/', []);
    none.offered[0]!.onSent?.();
    none.remote.onBlock(block('user-abilities', 1000), listed({ 2: 50 }, 1000));
    expect(none.replies).toEqual(['/Rand {none}']);
  });

  it('reads an id a complete listing leaves out as 0, and an incomplete one as unknown', () => {
    const complete = harness();
    complete.remote.ask('Rand', '/', [126]);
    complete.offered[0]!.onSent?.();
    complete.remote.onBlock(block('user-abilities', 1000), listed({ 2: 50 }, 1000));
    expect(complete.replies).toEqual(['/Rand {GoodQuest(126) - 0}']);

    const cut = harness();
    cut.remote.ask('Rand', '/', [126]);
    cut.offered[0]!.onSent?.();
    cut.remote.onBlock(block('user-abilities', 1000), listed({ 2: 50 }, 1000, false));
    expect(cut.replies).toEqual(['/Rand {GoodQuest(126) - unknown}']);
  });

  it('names every step the realm writes to the same rank', () => {
    const forked: Quest = { ...GOOD, steps: [...GOOD.steps, step(4, 5, 'Sister Lyra', 'vow')] };
    const { remote, offered, replies } = harness('queued', [forked]);
    remote.ask('Rand', '/', [126]);
    offered[0]!.onSent?.();
    remote.onBlock(block('user-abilities', 1000), listed({ 126: 5 }, 1000));
    const lyra = t('cards.quests.step.ask', { who: 'Sister Lyra', word: 'vow' });
    expect(replies).toEqual([`/Rand {GoodQuest(126) - 5 (${ask} or ${lyra})}`]);
  });

  it('asks nothing for a bare @abil with no world loaded, and says why', () => {
    const { remote, offered, notices } = harness('queued', null);
    remote.ask('Rand', '/', []);
    expect(offered).toEqual([]);
    expect(notices).toEqual([t('automation.remotes.abilNoQuests', { from: 'Rand' })]);
  });

  it('says so where the realm has no abil, and sends nothing back', () => {
    const { remote, replies, notices } = harness('unavailable');
    remote.ask('Rand', '/', [126]);
    expect(notices).toEqual([
      t('automation.remotes.listingNoWord', { from: 'Rand', remote: '@abil', words: 'abil' })
    ]);
    expect(replies).toEqual([]);
  });

  it('gives up at the reply deadline, and says whether abil ever went', () => {
    const seconds = Math.round(tuning().remotes.replyMs / 1000);
    const late = tuning().remotes.replyMs + 1000;

    const unsent = harness();
    unsent.remote.ask('Rand', '/', [126]);
    unsent.remote.onBlock(block('status-line', 999), EMPTY_CHARACTER);
    expect(unsent.notices).toEqual([]);
    unsent.remote.onBlock(block('status-line', late), EMPTY_CHARACTER);
    expect(unsent.notices).toEqual([
      t('automation.remotes.listingNeverSent', { from: 'Rand', remote: '@abil', seconds })
    ]);

    const silent = harness();
    silent.remote.ask('Rand', '/', [126]);
    silent.offered[0]!.onSent?.();
    silent.remote.onBlock(block('status-line', late), EMPTY_CHARACTER);
    expect(silent.notices).toEqual([
      t('automation.remotes.listingUnanswered', {
        from: 'Rand',
        remote: '@abil',
        listing: t('automation.remotes.listingAbil'),
        seconds
      })
    ]);
    // Over: a listing after the deadline answers nobody.
    silent.remote.onBlock(block('user-abilities', late), listed({ 126: 5 }, late));
    expect(silent.replies).toEqual([]);
  });

  it('arms nothing from the send of an ask that has already lapsed', () => {
    const { remote, offered, replies } = harness();
    remote.ask('Rand', '/', [126]);
    remote.reset();
    offered[0]!.onSent?.();
    remote.onBlock(block('user-abilities', 1000), listed({ 126: 5 }, 1000));
    expect(replies).toEqual([]);
  });
});
