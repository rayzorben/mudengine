import { describe, expect, it } from 'vitest';

import { DeathsRemote } from '../DeathsRemote';
import { Classifier } from '../../parse/Classifier';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { Block, BlockType } from '../../../shared/blocks';
import type { Intent, Offered } from '../CommandQueue';

const block = (type: BlockType, groups: Record<string, string> = {}, at = 0): Block =>
  ({ type, domain: 'status', groups, text: '', at, seq: 1, terminator: 'newline' }) as Block;

const ROW = {
  month: '10',
  day: '30',
  year: '2026',
  hour: '1',
  minute: '49',
  half: 'AM',
  killer: 'cave bear',
  map: '7',
  room: '773'
};

/** A queue that answers each command as `answers` says and keeps what it took. */
function harness(answers: Record<string, Offered> = {}) {
  const offered: Intent[] = [];
  const replies: string[] = [];
  const notices: string[] = [];
  const deaths = new DeathsRemote(
    {
      offer: (intent) => {
        offered.push(intent);
        return answers[intent.command] ?? 'queued';
      }
    },
    {
      notice: (message) => notices.push(message),
      reply: (to, body, prefix) => replies.push(`${prefix}${to} ${body}`)
    },
    () => 0
  );
  return { deaths, offered, replies, notices };
}

describe('@death', () => {
  it('asks death, and answers everybody waiting at the prompt behind the rows', () => {
    const { deaths, offered, replies } = harness();
    deaths.ask('Rand', '/');
    deaths.ask('Soul', '/');
    expect(offered.map((intent) => intent.command)).toEqual(['death']);
    // A row before the ask went out answers something else.
    deaths.onBlock(block('user-recent-death', ROW));
    offered[0]!.onSent?.();
    deaths.onBlock(block('status-line'));
    deaths.onBlock(block('user-recent-death', ROW));
    deaths.onBlock(block('user-recent-death', { ...ROW, day: '28', map: '1', room: '297' }));
    deaths.onBlock(block('status-line'));
    expect(replies).toEqual([
      '/Rand {2026-10-30 1:49AM - 7/773, 2026-10-28 1:49AM - 1/297}',
      '/Soul {2026-10-30 1:49AM - 7/773, 2026-10-28 1:49AM - 1/297}'
    ]);
  });

  it('answers {none} for None! :)', () => {
    const { deaths, offered, replies } = harness();
    deaths.ask('Rand', '/');
    offered[0]!.onSent?.();
    deaths.onBlock(block('user-recent-death'));
    deaths.onBlock(block('status-line'));
    expect(replies).toEqual(['/Rand {none}']);
  });

  it('asks pro where the realm lacks death, and says so where it lacks both', () => {
    const one = harness({ death: 'unavailable' });
    one.deaths.ask('Rand', '/');
    expect(one.offered.map((intent) => intent.command)).toEqual(['death', 'pro']);

    const both = harness({ death: 'unavailable', pro: 'unavailable' });
    both.deaths.ask('Rand', '/');
    expect(both.notices).toEqual([t('automation.remotes.deathsNoWord', { from: 'Rand' })]);
    both.deaths.ask('Rand', '/');
    expect(both.offered).toHaveLength(4);
  });

  it('names the word and the reason when the queue refuses the ask', () => {
    const { deaths, notices } = harness({ death: 'switched-off' });
    deaths.ask('Rand', '/');
    expect(notices).toEqual([
      t('automation.remotes.deathsNotAsked', {
        from: 'Rand',
        command: 'death',
        why: 'switched-off'
      })
    ]);
  });

  it('carries the deadline, and a late send of a lapsed ask arms nothing', () => {
    const { deaths, offered, replies, notices } = harness();
    const { replyMs } = tuning().remotes;
    deaths.ask('Rand', '/');
    expect(offered[0]!.expiresAt).toBe(replyMs);
    deaths.onBlock(block('status-line', {}, replyMs));
    expect(notices).toEqual([
      t('automation.remotes.deathsNeverSent', { from: 'Rand', seconds: replyMs / 1000 })
    ]);
    deaths.ask('Soul', '/');
    offered[0]!.onSent?.();
    // The player's own listing before the second ask goes is not its answer.
    deaths.onBlock(block('user-recent-death', ROW));
    deaths.onBlock(block('status-line'));
    expect(replies).toEqual([]);
    offered[1]!.onSent?.();
    deaths.onBlock(block('user-recent-death', ROW));
    deaths.onBlock(block('status-line'));
    expect(replies).toEqual(['/Soul {2026-10-30 1:49AM - 7/773}']);
  });

  // The `pro` listing as Paradigm printed it (2026-09-12), whole, through the classifier.
  it('answers from the rows at the end of a pro listing', () => {
    const { deaths, offered, replies } = harness({ death: 'unavailable' });
    deaths.ask('Rand', '/');
    offered[1]!.onSent?.();
    const classifier = new Classifier();
    let seq = 0;
    for (const text of [
      'Player ID:           187',
      'Location:            9,719',
      'Recover Password:    Off',
      'You do not have a suicide password set.',
      'Recent Deaths:',
      '9/9/2026 9:55 PM - Festus - 1/2372',
      '[HP=98/MA=50]:'
    ]) {
      seq += 1;
      deaths.onBlock(
        classifier.classify({ seq, at: seq, text, plain: text, terminator: 'newline' }).block
      );
    }
    expect(replies).toEqual(['/Rand {2026-09-09 9:55PM - 1/2372}']);
  });

  it('says so when no listing comes, and asks again on the next @death', () => {
    const { deaths, offered, replies, notices } = harness();
    deaths.ask('Rand', '/');
    offered[0]!.onSent?.();
    const { replyMs } = tuning().remotes;
    deaths.onBlock(block('status-line', {}, replyMs - 1));
    expect(notices).toEqual([]);
    deaths.onBlock(block('status-line', {}, replyMs));
    expect(notices).toEqual([
      t('automation.remotes.deathsUnanswered', { from: 'Rand', seconds: replyMs / 1000 })
    ]);
    expect(replies).toEqual([]);
    deaths.ask('Rand', '/');
    expect(offered).toHaveLength(2);
  });
});
