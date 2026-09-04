import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { LoginAutomator } from '../LoginAutomator';
import { DEFAULT_CONFIG, normalizeConfig } from '../../../shared/config';
import type { LoginConfig } from '../../../shared/config';
import type { Block, BlockType } from '../../../shared/blocks';

const credentials: LoginConfig = {
  ...DEFAULT_CONFIG.connection.login,
  enabled: true,
  username: 'vaelor',
  password: 'secret'
};

function block(type: BlockType, text = ''): Block {
  return { seq: 1, at: Date.now(), type, domain: 'session', groups: {}, text, confidence: 0.8 };
}

let sent: string[];
let notices: string[];
let queue: CommandQueue;
let login: LoginAutomator;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  queue = new CommandQueue(
    {
      ...DEFAULT_CONFIG.automation,
      pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
    },
    { send: (command) => sent.push(command) }
  );
  login = new LoginAutomator(credentials, queue, { notice: (m) => notices.push(m) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

/**
 * Walks the whole sequence the local server actually asks for, with the prompt
 * *text* each block carries.
 *
 * The text matters now: menus are answered by matching the prompt rather than
 * by its block type, which is what lets one client speak to MajorMUD,
 * GreaterMUD, Paradigm and a WorldGroup front end without four vocabularies.
 * Only the username and password are answered from the schema.
 */
const PROMPTS: Array<[BlockType, string]> = [
  ['prompt-username', 'Please enter your username or "new": '],
  ['prompt-password', 'Please enter your password: '],
  ['prompt-selection', 'Please enter your selection: '],
  ['prompt-realm', 'Please select a realm: '],
  ['prompt-menu', '[PARADIGM]: ']
];

function fullSequence(): void {
  for (const [type, text] of PROMPTS) {
    login.onBlock(block(type, text));
    vi.advanceTimersByTime(50);
  }
}

describe('answering the sequence', () => {
  it('answers every prompt it is configured for', () => {
    fullSequence();
    expect(sent).toEqual(['vaelor', 'secret', 'P', '1', 'E']);
  });

  it('stops once the status line says we are in the realm', () => {
    fullSequence();
    login.onBlock(block('status-line', '[HP=33]:'));
    expect(login.complete).toBe(true);

    // A conversation in game can quote something that looks like a menu;
    // answering it would send `P` at the room.
    login.onBlock(block('prompt-selection', 'Please enter your selection: '));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['vaelor', 'secret', 'P', '1', 'E']);
  });

  it('answers a realm-specific prompt from the extra list', () => {
    login.onBlock(block('unknown', '(N)onstop, (Q)uit, or (C)ontinue?'));
    vi.advanceTimersByTime(50);
    // A bare Enter, which is what that menu wants.
    expect(sent).toEqual(['']);
  });
});

describe('safety', () => {
  it('never retries a rejected password', () => {
    // Retrying is how an automated client walks into a lockout, and a wrong
    // password does not become right on the second attempt.
    login.onBlock(block('prompt-username'));
    login.onBlock(block('prompt-password'));
    vi.advanceTimersByTime(50);
    login.onBlock(block('login-failed', 'Invalid username/password!'));
    login.onBlock(block('prompt-username'));
    vi.advanceTimersByTime(100);

    expect(sent).toEqual(['vaelor', 'secret']);
    expect(notices.join(' ')).toMatch(/rejected/i);
  });

  it('stops rather than answering a prompt that came back', () => {
    // A repeated prompt means the answer was refused; answering again loops.
    login.onBlock(block('prompt-username', 'Please enter your username or "new": '));
    vi.advanceTimersByTime(50);
    login.onBlock(block('prompt-username', 'Please enter your username or "new": '));
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['vaelor']);
    expect(notices.join(' ')).toMatch(/came back/i);
  });

  it('leaves the prompt alone when nothing is configured for it', () => {
    const partial = new LoginAutomator({ ...credentials, password: '' }, queue, {
      notice: (m) => notices.push(m)
    });
    partial.onBlock(block('prompt-password'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toMatch(/finish logging in yourself/i);
  });

  /*
   * A menu nobody wrote a step for is left for the player, silently — unlike a
   * missing credential, which stops the sequence and says so. The difference is
   * that a BBS asks menus this client has never seen, and stopping on every one
   * would make the feature unusable on anything but the realm it was written
   * against; a missing password is always a mistake.
   */
  it('leaves a menu it has no step for alone', () => {
    const partial = new LoginAutomator({ ...credentials, steps: [] }, queue, {
      notice: (m) => notices.push(m)
    });
    partial.onBlock(block('prompt-menu', '[WORLDGROUP]: '));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
  });

  it('does nothing at all when disabled', () => {
    const off = new LoginAutomator({ ...credentials, enabled: false }, queue);
    off.onBlock(block('prompt-username'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
  });

  it('starts fresh on a reconnect', () => {
    login.onBlock(block('prompt-username'));
    vi.advanceTimersByTime(50);
    login.reset();
    login.onBlock(block('prompt-username'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['vaelor', 'vaelor']);
  });
});

describe('config', () => {
  it('refuses to enable itself without credentials', () => {
    // Enabling with a blank username would send empty answers at a live
    // service on every connection.
    const config = normalizeConfig({ connection: { login: { enabled: true } } });
    expect(config.connection.login.enabled).toBe(false);
  });

  it('enables when both credentials are present', () => {
    const config = normalizeConfig({
      connection: { login: { enabled: true, username: 'a', password: 'b' } }
    });
    expect(config.connection.login.enabled).toBe(true);
  });

  it('keeps an empty `send`, which several menus want', () => {
    const config = normalizeConfig({
      connection: { login: { steps: [{ when: 'Continue?', send: '' }] } }
    });
    expect(config.connection.login.steps).toEqual([{ when: 'Continue?', send: '' }]);
  });
});

/*
 * The reason the four named menus had to go.
 *
 * MajorMUD, GreaterMUD, Paradigm and Shift all have different menu systems, and
 * MajorMUD behind WorldGroup can put any amount of custom ANSI and any number
 * of menus in between. A client with four slots called `selection`, `realm`,
 * `character` and `enterRealm` cannot describe that at all — those are
 * *Paradigm's* menus, and naming them in the schema made one BBS's layout part
 * of the client's vocabulary.
 */
describe('a BBS whose menus are nothing like Paradigm’s', () => {
  const shift: LoginConfig = {
    enabled: true,
    username: 'vaelor',
    password: 'secret',
    steps: [
      { when: 'S : Shift', send: 's' },
      { when: 'Please select a realm', send: '1' },
      // A bare Enter, which is what several BBS menus want. Enter is always
      // sent, so an empty answer is a real one.
      { when: 'Press ENTER to continue', send: '' }
    ]
  };

  it('walks a script the client has never seen before', () => {
    const login = new LoginAutomator(shift, queue, { notice: (m) => notices.push(m) });
    for (const [type, text] of [
      ['prompt-username', 'Please enter your username or "new": '],
      ['prompt-password', 'Please enter your password: '],
      ['unknown', '   S : Shift'],
      ['prompt-realm', 'Please select a realm: '],
      ['unknown', 'Press ENTER to continue']
    ] as Array<[BlockType, string]>) {
      login.onBlock(block(type, text));
      vi.advanceTimersByTime(50);
    }
    expect(sent).toEqual(['vaelor', 'secret', 's', '1', '']);
  });

  /* A sentence somebody typed into a BBS config, so case is not a promise. */
  it('matches a prompt however it is capitalised', () => {
    const login = new LoginAutomator(shift, queue, {});
    login.onBlock(block('unknown', 'PLEASE SELECT A REALM:'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['1']);
  });

  /*
   * A realm with one character skips the character menu. A script that
   * insisted on its own order would stall on the first prompt that never came;
   * first unused match wins, which handles a skipped menu for free.
   */
  it('does not stall when a menu never arrives', () => {
    const login = new LoginAutomator(shift, queue, {});
    login.onBlock(block('prompt-realm', 'Please select a realm: '));
    vi.advanceTimersByTime(50);
    login.onBlock(block('unknown', 'Press ENTER to continue'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['1', '']);
  });

  it('answers each menu once, however often it is printed', () => {
    const login = new LoginAutomator(shift, queue, {});
    for (let i = 0; i < 3; i += 1) {
      login.onBlock(block('unknown', '   S : Shift'));
      vi.advanceTimersByTime(50);
    }
    expect(sent).toEqual(['s']);
  });
});

describe('leaving on purpose', () => {
  it('stands down at the menu that follows an exit, and says so once', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', 'You will exit after a period of silent meditation.'));
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
    expect(notices.filter((m) => m.includes('stands down'))).toHaveLength(1);
  });

  it('does not stand down for an exit the player broke', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', 'You will exit after a period of silent meditation.'));
    login.observeCommand('break');
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    expect(notices.filter((m) => m.includes('stands down'))).toHaveLength(0);
  });
});

/*
 * The same latch, read by auto-reconnect. It is read rather than copied
 * because a second copy is how the two answers drift, and the one that would
 * drift here dials somebody back into the realm they just walked out of.
 */
describe('why a lost socket must not be dialled again', () => {
  it('says nothing while the login is going normally', () => {
    login.onBlock(block('prompt-username'));
    vi.advanceTimersByTime(50);
    expect(login.standDown).toBeNull();
  });

  /*
   * Read from `leaving` alone, before any menu has arrived. The exit takes a
   * few seconds and the BBS can hang up inside them, so waiting for the menu
   * would miss the ordinary way somebody leaves.
   */
  it('names the exit as soon as one is asked for', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', 'You will exit after a period of silent meditation.'));
    expect(login.standDown).toBe('left-realm');
  });

  it('keeps naming it once the menu has confirmed it', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', 'You will exit after a period of silent meditation.'));
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    expect(login.standDown).toBe('left-realm');
  });

  it('forgets it when the player breaks the exit', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', 'You will exit after a period of silent meditation.'));
    login.observeCommand('break');
    expect(login.standDown).toBeNull();
  });

  it('names a refused login, because the way back in from one is a lockout', () => {
    login.onBlock(block('prompt-username'));
    login.onBlock(block('prompt-password'));
    vi.advanceTimersByTime(50);
    login.onBlock(block('login-failed', 'Invalid username/password!'));
    expect(login.standDown).toBe('login-refused');
  });

  it('is clear again on the next connection', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', 'You will exit after a period of silent meditation.'));
    login.reset();
    expect(login.standDown).toBeNull();
  });
});
