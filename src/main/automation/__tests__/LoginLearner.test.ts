import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { LoginAutomator } from '../LoginAutomator';
import { LoginLearner } from '../LoginLearner';
import { DEFAULT_CONFIG, type LoginConfig, type LoginStep } from '../../../shared/config';
import type { Block, BlockType } from '../../../shared/blocks';
import type { LineTerminator } from '../../../shared/types';
import {
  NOTHING_LEARNED,
  type LearnedLogin,
  type LearnedLoginRecord
} from '../../../shared/loginLearning';
import { t } from '../../app/i18n';

/** MajorBBS's way in, verbatim from `logs/2026-11-01_04-10-22_soul.mudcap.jsonl` (OCI). */
const USER_ID = 'Please enter your User-ID or type "new" to register: ';
const PASSWORD = 'Enter your password: ';
const TOP = 'Make your selection (G,T,C,F,E,L,A,P,D,R,Q,I,? for help, or X to exit):';
const MAIL = 'Do you want to see it now (Y/N)? ';
const PAGER = '(N)onstop, (Q)uit, or (C)ontinue?';
const REALM_MENU = '[MAJORMUD]: ';

const SCRIPT: LoginStep[] = [
  { when: 'Please enter your User-ID', send: '{user}' },
  { when: 'Enter your password:', send: '{password}' },
  { when: '[MAJORMUD]', send: 'E' }
];

const account: LoginConfig = {
  ...DEFAULT_CONFIG.connection.login,
  enabled: true,
  learn: true,
  username: 'soul',
  password: 'hunter2',
  steps: SCRIPT
};

function block(type: BlockType, text: string, terminator: LineTerminator = 'flush'): Block {
  return {
    seq: 1,
    at: Date.now(),
    type,
    domain: 'session',
    groups: {},
    text,
    terminator,
    confidence: 0.8
  };
}

/** A record held in memory, written as the file would be. */
class HeldRecord implements LearnedLoginRecord {
  held: LearnedLogin = NOTHING_LEARNED;
  writes = 0;
  read(): LearnedLogin {
    return this.held;
  }
  write(next: LearnedLogin): void {
    this.held = next;
    this.writes += 1;
  }
}

let sent: string[];
let notices: string[];
let queue: CommandQueue;
let record: HeldRecord;
let learner: LoginLearner;
let login: LoginAutomator;

function connect(config: LoginConfig = account): void {
  learner = new LoginLearner(config, record, (message) => notices.push(message));
  login = new LoginAutomator(config, queue, {}, true, learner);
  login.reset();
  learner.reset();
}

/** One line, in the session's order: the automator answers, then the learner reads the same block. */
function line(type: BlockType, text: string, terminator: LineTerminator = 'flush'): void {
  const read = block(type, text, terminator);
  login.onBlock(read);
  learner.onBlock(read);
  vi.advanceTimersByTime(50);
}

const typed = (command: string): void => learner.noteTyped(command);

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  record = new HeldRecord();
  queue = new CommandQueue(
    { ...DEFAULT_CONFIG.automation, pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 } },
    { send: (command) => sent.push(command) }
  );
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

/** The account, then the TOP menu answered by hand with `G`, then the realm's menu. */
function wayInByHand(top = 'G'): void {
  line('unknown', USER_ID);
  line('unknown', PASSWORD);
  line('unknown', TOP);
  if (!sent.includes(top)) typed(top);
  line('prompt-menu', REALM_MENU);
}

describe('learning the way in', () => {
  it('answers from the next connection what the player typed on this one', () => {
    connect();
    wayInByHand();
    expect(sent).toEqual(['soul', 'hunter2', 'E']);
    expect(record.held.rows).toMatchObject([{ when: TOP.trim(), send: 'G', missed: 0 }]);
    expect(notices).toContain(
      t('automation.login.learn.learned', { promptText: TOP.trim(), answer: '"G"' })
    );

    sent = [];
    connect();
    wayInByHand();
    expect(sent).toEqual(['soul', 'hunter2', 'G', 'E']);
  });

  it('does not answer a row on the connection it was learned on', () => {
    connect();
    line('unknown', TOP);
    typed('G');
    line('unknown', TOP);
    expect(sent).toEqual([]);
  });

  it('keeps the account as its placeholders and never a password', () => {
    connect({ ...account, steps: [{ when: '[MAJORMUD]', send: 'E' }] });
    line('unknown', USER_ID);
    typed('soul');
    line('unknown', 'Secret word please: ', 'flush');
    typed('hunter2');
    line('unknown', PASSWORD);
    typed('not-the-password');
    line('prompt-menu', REALM_MENU);

    expect(record.held.rows.map(({ when, send }) => ({ when, send }))).toEqual([
      { when: USER_ID.trim(), send: '{user}' },
      { when: 'Secret word please:', send: '{password}' }
    ]);
    const written = JSON.stringify(record.held) + notices.join('\n');
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('not-the-password');
    expect(notices).toContain(t('automation.login.learn.secret', { promptText: PASSWORD.trim() }));
  });

  it('keeps only menu keys on the connection where an account is made', () => {
    connect({ ...account, enabled: false, username: '', password: '' });
    line('unknown', USER_ID);
    typed('new');
    line('unknown', 'Choose a User-ID: ');
    typed('soul');
    line('unknown', 'Enter your real name: ');
    typed('Ray Bennett');
    line('unknown', 'Enter your date of birth (MM/DD/YY): ');
    typed('01/02/80');
    line('unknown', 'Do you want ANSI color (Y/N)? ');
    typed('Y');
    line('unknown', TOP);
    typed('G');
    line('prompt-menu', REALM_MENU);

    expect(record.held.rows.map(({ when, send }) => ({ when, send }))).toEqual([
      { when: TOP.trim(), send: 'G' }
    ]);
    expect(notices).toContain(t('automation.login.learn.newAccount'));
  });

  it('forgets an answer whose prompt has not come up on three logins in a row', () => {
    connect();
    line('unknown', MAIL);
    typed('N');
    wayInByHand();
    expect(record.held.rows).toHaveLength(2);

    for (let round = 1; round <= 2; round += 1) {
      connect();
      wayInByHand();
      expect(record.held.rows.find((row) => row.when === MAIL.trim())?.missed).toBe(round);
    }
    connect();
    wayInByHand();
    expect(record.held.rows.map((row) => row.when)).toEqual([TOP.trim()]);
    expect(notices).toContain(
      t('automation.login.learn.forgot', { promptText: MAIL.trim(), answer: '"N"', count: 3 })
    );
  });

  it('counts a prompt seen again afresh', () => {
    connect();
    line('unknown', MAIL);
    typed('N');
    wayInByHand();
    connect();
    wayInByHand();
    expect(record.held.rows.find((row) => row.when === MAIL.trim())?.missed).toBe(1);

    connect();
    line('unknown', MAIL);
    wayInByHand();
    expect(sent.filter((command) => command === 'N')).toHaveLength(1);
    expect(record.held.rows.find((row) => row.when === MAIL.trim())?.missed).toBe(0);
  });

  it('counts nothing for a connection that never reached the realm menu', () => {
    connect();
    line('unknown', MAIL);
    typed('N');
    wayInByHand();
    connect();
    line('unknown', USER_ID);
    expect(record.held.rows.find((row) => row.when === MAIL.trim())?.missed).toBe(0);
  });

  it('stops using a script row the player answered otherwise when its screen came back', () => {
    const showcase: LoginConfig = {
      ...account,
      steps: [...SCRIPT, { when: '(SHOWCASE)', send: '3' }]
    };
    const showcaseScreen = (): void => {
      line('unknown', 'Current Page: Game Showcase (SHOWCASE)', 'newline');
      line('unknown', 'Make your choice (1-6 or X to exit): ');
    };
    connect(showcase);
    // `3` goes out at the header and reaches the wrong game; the player backs out and picks 5.
    showcaseScreen();
    typed('5');
    line('unknown', 'Welcome to Tradewars! Choose (X to exit): ');
    typed('X');
    showcaseScreen();
    typed('5');
    line('prompt-menu', REALM_MENU);
    expect(sent).toEqual(['3', 'E']);
    expect(record.held.retired).toEqual(['(SHOWCASE)']);
    expect(notices).toContain(
      t('automation.login.learn.answeredFirst', {
        promptText: 'Make your choice (1-6 or X to exit):'
      })
    );

    sent = [];
    connect(showcase);
    showcaseScreen();
    expect(sent).toEqual(['5']);
  });

  it('does not file a line typed after the automator answered as that prompt’s answer', () => {
    connect({ ...account, steps: [...SCRIPT, { when: PAGER, send: 'Q', repeat: true }] });
    line('unknown', PAGER);
    typed('');
    line('prompt-menu', REALM_MENU);
    expect(sent).toEqual(['Q', 'E']);
    expect(record.held).toEqual(NOTHING_LEARNED);
  });

  it('keeps nothing from a login that closed before the realm menu, and says so', () => {
    connect({ ...account, steps: [...SCRIPT, { when: 'Make your selection', send: 'G' }] });
    line('unknown', USER_ID);
    line('unknown', PASSWORD);
    line('unknown', TOP);
    // The `G` went out; the BBS hangs up on the `X` typed behind it, or on one typed instead.
    line('unknown', TOP);
    typed('X');
    expect(record.writes).toBe(0);

    // The same session dials again, as the client's one learner per character does.
    login.reset();
    learner.reset();
    expect(record.held).toEqual(NOTHING_LEARNED);
    expect(notices).toContain(t('automation.login.learn.dropped'));
  });

  it('makes an account from `new` typed ahead of any prompt', () => {
    connect({ ...account, enabled: false, username: '', password: '' });
    typed('new');
    line('unknown', 'Enter your real name: ');
    typed('Ray Bennett');
    line('prompt-menu', REALM_MENU);
    expect(record.held.rows).toEqual([]);
    expect(notices).toContain(t('automation.login.learn.newAccount'));
  });

  it('learns nothing at a prompt too short to tell from others', () => {
    connect();
    line('unknown', '> ');
    typed('G');
    line('prompt-menu', REALM_MENU);
    expect(record.held.rows).toEqual([]);
  });

  it('learns a pager the player answered twice alike as one asked every time', () => {
    connect();
    line('unknown', PAGER);
    typed('');
    line('unknown', PAGER);
    typed('');
    line('prompt-menu', REALM_MENU);
    expect(record.held.rows).toMatchObject([{ when: PAGER, send: '', repeat: true }]);
    expect(notices).toContain(
      t('automation.login.learn.pager', {
        promptText: PAGER,
        answer: t('automation.login.learn.enter')
      })
    );
  });

  it('keeps nothing and answers nothing learned with learning off', () => {
    record.held = { rows: [{ when: TOP.trim(), send: 'G', missed: 0, learned: '' }], retired: [] };
    connect({ ...account, learn: false });
    line('unknown', TOP);
    typed('T');
    line('prompt-menu', REALM_MENU);
    expect(sent).toEqual(['E']);
    expect(record.writes).toBe(0);
  });
});
