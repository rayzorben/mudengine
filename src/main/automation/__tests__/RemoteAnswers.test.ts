import { describe, expect, it } from 'vitest';

import { RemoteAnswers } from '../RemoteAnswers';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { parseRemoteReply, type RemoteReply } from '../../../shared/remotes';

const ok = parseRemoteReply('{ok}') as RemoteReply;

describe('RemoteAnswers', () => {
  // The session log of 2026-11-02 03:18: `/brak @auto-sneak on`, answered by Brakkle.
  it('reads the answer from the player an abbreviated telepath reached', () => {
    const answers = new RemoteAnswers();
    expect(answers.noteTyped('/brak @auto-sneak on', 0)).toBeNull();
    expect(answers.heard('Brakkle', ok, 1000)).toBe(
      t('automation.remotes.heardOk', { who: 'Brakkle', raw: 'auto-sneak' })
    );
    expect(answers.sweep(tuning().remotes.replyMs + 1)).toEqual([]);
  });

  it('says a switch remote the other client refused, and does not sweep it', () => {
    const answers = new RemoteAnswers();
    answers.noteTyped('/brak @attack-last on', 0);
    const refused = parseRemoteReply('{command invalid or not allowed}') as RemoteReply;
    expect(answers.heard('Brakkle', refused, 1000)).toBe(
      t('automation.remotes.heardRefused', { who: 'Brakkle', raw: 'attack-last on' })
    );
    expect(answers.sweep(tuning().remotes.replyMs)).toEqual([]);
  });

  it('says a switch remote nobody answered, once', () => {
    const answers = new RemoteAnswers();
    answers.noteTyped('/brak @attack-last on', 0);
    expect(answers.sweep(tuning().remotes.replyMs - 1)).toEqual([]);
    const lapsed = answers.sweep(tuning().remotes.replyMs);
    expect(lapsed).toEqual([
      t('automation.remotes.heardNothing', { who: 'brak', raw: 'attack-last on' })
    ]);
    expect(answers.sweep(tuning().remotes.replyMs * 2)).toEqual([]);
  });

  it('says at once that a bare switch remote changes nothing on a mudengine client', () => {
    const answers = new RemoteAnswers();
    expect(answers.noteTyped('/brak @attack-last', 0)).toBe(
      t('automation.remotes.askedSwitchBare', { who: 'brak', raw: 'attack-last' })
    );
    expect(answers.sweep(tuning().remotes.replyMs)).toEqual([]);
  });

  it('reads neither of two typed names that both start the answering name', () => {
    const answers = new RemoteAnswers();
    answers.noteTyped('/bra @auto-sneak on', 0);
    answers.noteTyped('/brak @attack-last on', 0);
    expect(answers.heard('Brakkle', ok, 1000)).toBeNull();
  });

  // The positive control is the refused switch remote above, with no other question to Brakkle.
  it('reads no refusal once another question went to the same player', () => {
    const answers = new RemoteAnswers();
    answers.noteTyped('/brak @attack-last on', 0);
    answers.noteAsked('Brakkle', 'health', 500);
    const refused = parseRemoteReply('{command invalid or not allowed}') as RemoteReply;
    expect(answers.heard('Brakkle', refused, 1000)).toBeNull();
    expect(answers.heard('Brakkle', ok, 1500)).toBe(
      t('automation.remotes.heardOk', { who: 'Brakkle', raw: 'attack-last' })
    );
  });

  // The word the player first remembered (todo 20261102-2217-01), sent to a client that knows no such remote.
  it('says the refusal of a typed word no client here knows, and its silence', () => {
    const answers = new RemoteAnswers();
    answers.noteTyped('/brak @auto-attack on', 0);
    const refused = parseRemoteReply('{command invalid or not allowed}') as RemoteReply;
    expect(answers.heard('Brakkle', refused, 1000)).toBe(
      t('automation.remotes.heardRefused', { who: 'Brakkle', raw: 'auto-attack on' })
    );
    answers.noteTyped('/brak @auto-attack on', 0);
    expect(answers.sweep(tuning().remotes.replyMs)).toEqual([
      t('automation.remotes.heardNothing', { who: 'brak', raw: 'auto-attack on' })
    ]);
  });

  it('says a typed @do answered and one that was not', () => {
    const answers = new RemoteAnswers();
    answers.noteTyped('/brak @do bas s', 0);
    expect(answers.heard('Brakkle', ok, 1000)).toBe(
      t('automation.remotes.heardOk', { who: 'Brakkle', raw: 'do' })
    );
    answers.noteTyped('/brak @do bas s', 0);
    expect(answers.sweep(tuning().remotes.replyMs)).toEqual([
      t('automation.remotes.heardNothing', { who: 'brak', raw: 'do bas s' })
    ]);
  });

  // The positive control is the typed `@do` above, kept and swept.
  it('keeps no @do the client sends itself', () => {
    const answers = new RemoteAnswers();
    answers.noteAsked('Brakkle', 'do', 0);
    expect(answers.heard('Brakkle', ok, 1000)).toBeNull();
    expect(answers.sweep(tuning().remotes.replyMs)).toEqual([]);
  });

  it('says when the question a player answers was asked', () => {
    const answers = new RemoteAnswers();
    expect(answers.askedBefore('Brakkle', 10)).toBe(false);
    answers.noteTyped('/brak @do bas s', 5);
    expect(answers.askedBefore('Brakkle', 10)).toBe(true);
    expect(answers.askedBefore('Brakkle', 5)).toBe(false);
  });

  it('keeps nothing it does not read', () => {
    const answers = new RemoteAnswers();
    answers.noteTyped('/brak @health', 0);
    expect(answers.sweep(tuning().remotes.replyMs)).toEqual([]);
  });
});
