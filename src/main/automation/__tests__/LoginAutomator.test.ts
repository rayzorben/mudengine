import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { LoginAutomator } from '../LoginAutomator';
import { DEFAULT_CONFIG, normalizeConfig } from '../../../shared/config';
import type { LoginConfig } from '../../../shared/config';
import type { Block, BlockType } from '../../../shared/blocks';
import type { LineTerminator } from '../../../shared/types';

/**
 * The two prompts the local server actually prints, verbatim.
 *
 * Named rather than inlined because they are now matched as *text* like every
 * other prompt: the account used to be answered off the block type, which is
 * one wording of each question and the reason a BBS that asks anything else
 * could not be described at all.
 */
const USERNAME = 'Please enter your username or "new": ';
const PASSWORD = 'Please enter your password: ';

const credentials: LoginConfig = {
  ...DEFAULT_CONFIG.connection.login,
  enabled: true,
  username: 'vaelor',
  password: 'secret'
};

/**
 * One classified line.
 *
 * `terminator` defaults to `flush` because everything this module answers is a
 * prompt, and `flush` is what makes a line one — it ended because the server
 * stopped talking. A test that wants an ordinary sentence says `newline`, and
 * that is the distinction a credential row is gated on.
 */
function block(type: BlockType, text = '', terminator: LineTerminator = 'flush'): Block {
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
 * The text is the whole of it: every prompt is answered by matching what the
 * realm printed rather than by its block type, the account's two included,
 * which is what lets one client speak to MajorMUD, GreaterMUD, Paradigm and a
 * WorldGroup front end without four vocabularies.
 */
const PROMPTS: Array<[BlockType, string]> = [
  ['prompt-username', USERNAME],
  ['prompt-password', PASSWORD],
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

  it('answers a pager every screenful, not once per connection', () => {
    /*
     * Measured on bearfather: the script's answer stops the first pageful, the
     * BBS prints the text that follows — registry notice, credits, banners —
     * pages that too and asks again. Answered once, the login sat at the
     * second prompt for the rest of the connection.
     *
     * So the prompt coming back is the answer *working*, which is the opposite
     * of what it means for a menu, and the row says which it is.
     */
    const pager = '(N)onstop, (Q)uit, or (C)ontinue?';
    const paged = new LoginAutomator(
      { ...credentials, steps: [{ when: pager, send: 'Q', repeat: true }] },
      queue,
      { notice: (m) => notices.push(m) }
    );

    for (let screenful = 0; screenful < 3; screenful += 1) {
      paged.onBlock(block('unknown', pager));
      vi.advanceTimersByTime(50);
    }

    expect(sent).toEqual(['Q', 'Q', 'Q']);
    // And never reported as a prompt that came back: coming back is the point.
    expect(notices.join(' ')).not.toMatch(/came back/i);
  });

  it('still answers a menu once, even next to a pager', () => {
    // The flag is per row, so the default stays *once* and nothing that works
    // today changes.
    const menu = new LoginAutomator(
      {
        ...credentials,
        steps: [
          { when: 'Make Your Selection', send: 'M' },
          { when: 'or (C)ontinue', send: 'Q', repeat: true }
        ]
      },
      queue,
      { notice: (m) => notices.push(m) }
    );

    menu.onBlock(block('unknown', 'Make Your Selection: '));
    vi.advanceTimersByTime(50);
    menu.onBlock(block('unknown', '(N)onstop, (Q)uit, or (C)ontinue?'));
    vi.advanceTimersByTime(50);
    menu.onBlock(block('unknown', 'Make Your Selection: '));
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['M', 'Q']);
  });
});

describe('safety', () => {
  it('never retries a rejected password', () => {
    // Retrying is how an automated client walks into a lockout, and a wrong
    // password does not become right on the second attempt.
    login.onBlock(block('prompt-username', USERNAME));
    login.onBlock(block('prompt-password', PASSWORD));
    vi.advanceTimersByTime(50);
    login.onBlock(block('login-failed', 'Invalid username/password!'));
    login.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(100);

    expect(sent).toEqual(['vaelor', 'secret']);
    expect(notices.join(' ')).toMatch(/rejected/i);
  });

  it('stops rather than answering a prompt that came back', () => {
    // A repeated prompt means the answer was refused; answering again loops.
    login.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(50);
    login.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['vaelor']);
    expect(notices.join(' ')).toMatch(/came back/i);
  });

  it('never repeats a credential, whatever the row says', () => {
    /*
     * `repeat` describes a pager, and a password prompt is never one. Honoured
     * here it would retry the account at a realm that just refused it, which
     * is the lockout this module exists to avoid — so the credential's own
     * once-per-connection is checked first and this flag cannot reach it.
     */
    const reckless = new LoginAutomator(
      { ...credentials, steps: [{ when: 'password', send: '{password}', repeat: true }] },
      queue,
      { notice: (m) => notices.push(m) }
    );

    reckless.onBlock(block('prompt-password', PASSWORD));
    vi.advanceTimersByTime(50);
    reckless.onBlock(block('prompt-password', PASSWORD));
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['secret']);
    expect(notices.join(' ')).toMatch(/came back/i);
  });

  it('leaves the prompt alone when nothing is configured for it', () => {
    const partial = new LoginAutomator({ ...credentials, password: '' }, queue, {
      notice: (m) => notices.push(m)
    });
    partial.onBlock(block('prompt-password', PASSWORD));
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

  /*
   * A placeholder the client cannot fill in is a typo in the script, and the
   * script is typed into a form. Sending `{slot}` verbatim at a live service is
   * the one outcome worse than sending nothing, so `{` is reserved: an answer
   * naming anything but the account stops the sequence and says which row.
   */
  it('refuses a placeholder it does not know rather than typing it', () => {
    const typo = new LoginAutomator(
      { ...credentials, steps: [{ when: 'Please select a character', send: '{slot}' }] },
      queue,
      { notice: (m) => notices.push(m) }
    );
    typo.onBlock(block('prompt-character', 'Please select a character: '));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toMatch(/\{slot\}/);
  });

  /*
   * A credential answers a *prompt* — a line that ended because the server
   * stopped talking — and nothing else.
   *
   * Matched on text alone the password would go out at any line containing the
   * row's wording, and a BBS prints plenty pre-login: `(C)hange Password`,
   * `Forgot your password? mail sysop`. That is the password in the clear at a
   * live service one line before the prompt that asks for it. A menu answer is
   * `P` or `1` and is not worth the same gate.
   */
  it('never sends the account at an ordinary line that merely mentions it', () => {
    const loose = new LoginAutomator(
      { ...credentials, steps: [{ when: 'Password', send: '{password}' }] },
      queue,
      { notice: (m) => notices.push(m) }
    );
    loose.onBlock(block('unknown', '  (C)hange Password    (L)ogoff', 'newline'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);

    // And the prompt itself, one line later, is still answered.
    loose.onBlock(block('unknown', 'Password: ', 'flush'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['secret']);
  });

  /*
   * The same line, arriving newline-terminated on a realm whose prompts are in
   * `patterns.ts`. The type carries what the framing did not, so allowing it
   * costs nothing and refusing it would be a regression on the realms that
   * already work.
   */
  it('still answers a typed prompt that did not arrive on a flush', () => {
    login.onBlock(block('prompt-username', USERNAME, 'newline'));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['vaelor']);
  });

  /*
   * "A rejected credential is never retried" survives a second matching row.
   *
   * Recording the repeat was not enough on its own: the loop returns from
   * inside the match, so a leftover row matching the same prompt sent the
   * password again and the recording was never read. One attempt closer to a
   * lockout, which is the whole reason the sequence stops rather than retries.
   */
  it('does not answer a returning credential prompt from a second row', () => {
    const twice = new LoginAutomator(
      {
        ...credentials,
        steps: [
          { when: 'Please enter your password', send: '{password}' },
          { when: 'password', send: '{password}' }
        ]
      },
      queue,
      { notice: (m) => notices.push(m) }
    );
    twice.onBlock(block('prompt-password', PASSWORD));
    vi.advanceTimersByTime(50);
    twice.onBlock(block('prompt-password', PASSWORD));
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['secret']);
    expect(notices.join(' ')).toMatch(/came back/i);
  });

  /*
   * The same rule with the rows the other way up.
   *
   * `repeated` used to be worked out as the selection loop went, so it held
   * only what the rows *before* the match said — and a duplicate sitting above
   * the used one saw `false` and sent the password again. Decided over the
   * whole script now, so row order cannot change the answer.
   */
  it('does not answer a returning credential prompt from an earlier row either', () => {
    const twice = new LoginAutomator(
      {
        ...credentials,
        steps: [
          { when: 'Password:', send: '{password}' },
          { when: 'enter your password', send: '{password}' }
        ]
      },
      queue,
      { notice: (m) => notices.push(m) }
    );
    // The first wording matches only the second row.
    twice.onBlock(block('unknown', 'Please enter your password '));
    vi.advanceTimersByTime(50);
    // The realm refuses and re-prompts in wording the *first* row matches.
    twice.onBlock(block('unknown', 'Password: '));
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['secret']);
    expect(notices.join(' ')).toMatch(/came back/i);
  });

  /*
   * The script is hot-reloaded, and `noAccountRow` sends the player to edit it
   * while they are sitting at the prompt it names. `used` is keyed by index, so
   * a reindexed row would otherwise read as already answered and the sequence
   * would stall with nothing said.
   */
  it('forgets which menus it has used when the script itself changes', () => {
    const edited = new LoginAutomator(
      { ...credentials, steps: [{ when: 'Continue', send: 'y' }] },
      queue,
      { notice: (m) => notices.push(m) }
    );
    edited.onBlock(block('unknown', 'Continue: '));
    vi.advanceTimersByTime(50);
    // Reindexed by an edit, so what index 0 meant is no longer what it means.
    edited.configure({
      ...credentials,
      steps: [
        { when: 'Accept the rules', send: '1' },
        { when: 'Continue', send: 'y' }
      ]
    });
    edited.onBlock(block('unknown', 'Continue: '));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['y', 'y']);
  });

  /*
   * The account's own used-once does *not* reset with the script, because it
   * is keyed on the credential rather than on the row: editing the file does
   * not un-send what the realm already has. Which is what makes `noAccountRow`
   * safe advice — a player who had no credential row has sent nothing, so the
   * row they add fires.
   */
  it('does not re-send a credential the realm already has after an edit', () => {
    login.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(50);
    login.configure({ ...credentials, steps: [{ when: 'Login ID', send: '{user}' }] });
    login.onBlock(block('unknown', 'Login ID: '));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['vaelor']);
  });

  /*
   * `Please enter the password you would like to use:` — the account-creation
   * path, which the classifier types apart from the login's own prompt for
   * exactly this reason. A row reading `when: password` is a reasonable thing
   * to write and matches it, and answering would make an account.
   */
  it('never answers the prompt that chooses a new password', () => {
    login.onBlock(
      block('prompt-new-password', 'Please enter the password you would like to use: ')
    );
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
  });

  /*
   * The record, not the wire. `SessionManager.reportable` arms on a
   * `prompt-password` block and falls back to an exact match against the
   * configured password — neither of which covers a realm this client does not
   * recognise answered with `{user} {password}`. The module doing the filling
   * in is the one that knows for certain.
   */
  it('marks the command it sends as carrying the password', () => {
    const marked: boolean[] = [];
    const queue = new CommandQueue(
      { ...DEFAULT_CONFIG.automation, pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 } },
      {
        send: (command, intent) => {
          sent.push(command);
          marked.push(intent.secret === true);
        }
      }
    );
    const embedded = new LoginAutomator(
      {
        ...credentials,
        steps: [
          { when: 'Account', send: 'login {user} {password}' },
          { when: 'Continue', send: '' }
        ]
      },
      queue,
      {}
    );
    embedded.onBlock(block('unknown', 'Account: '));
    vi.advanceTimersByTime(50);
    embedded.onBlock(block('unknown', 'Continue: '));
    vi.advanceTimersByTime(50);
    queue.dispose();

    expect(sent).toEqual(['login vaelor secret', '']);
    // The flag is on the command it is about, so the queue holding the two
    // apart cannot spend it on somebody else's line. See `Intent.secret`.
    expect(marked).toEqual([true, false]);
  });

  /*
   * A character that states its own `login.steps` **replaces** the realm's, so
   * a player who adds one row to change their character slot loses the account
   * rows with it — and every other refusal here is silent, so nothing would
   * say why the client is sitting at the username prompt doing nothing.
   * Reported, not stopped: the menus may still be worth answering.
   */
  it('says so when the account is configured and no row sends it', () => {
    const slotOnly = new LoginAutomator(
      { ...credentials, steps: [{ when: 'Please select a character', send: '2' }] },
      queue,
      { notice: (m) => notices.push(m) }
    );
    slotOnly.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(50);
    slotOnly.onBlock(block('prompt-character', 'Please select a character: '));
    vi.advanceTimersByTime(50);

    expect(sent).toEqual(['2']);
    expect(notices.filter((m) => /no row that sends them/i.test(m))).toHaveLength(1);
  });

  it('does nothing at all when disabled', () => {
    const off = new LoginAutomator({ ...credentials, enabled: false }, queue);
    off.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
  });

  it('starts fresh on a reconnect', () => {
    login.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(50);
    login.reset();
    login.onBlock(block('prompt-username', USERNAME));
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
  /**
   * And whose *account* prompts are nothing like Paradigm's either.
   *
   * `Login ID:` and `Password:` are typed `unknown` by the classifier — its two
   * credential patterns are this realm family's own wording — so before the
   * account joined the script there was no answer to them and no row anybody
   * could write to supply one. They are ordinary rows now.
   */
  const shift: LoginConfig = {
    enabled: true,
    username: 'vaelor',
    password: 'secret',
    steps: [
      { when: 'Login ID', send: '{user}' },
      { when: 'Password', send: '{password}' },
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
      ['unknown', 'Login ID: '],
      ['unknown', 'Password: '],
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

/*
 * Bearfather, 2026-09-17: the player's own keystroke dismissed the pager and
 * held the queue; the script's `Q` waited behind it, then behind two attacks,
 * and reached the realm — where `q` is quit — half a second after the status
 * line. The realm began the exit.
 */
describe('an answer the queue held', () => {
  const pager = '(N)onstop, (Q)uit, or (C)ontinue?';
  let paged: LoginAutomator;

  beforeEach(() => {
    paged = new LoginAutomator(
      { ...credentials, steps: [{ when: pager, send: 'Q', repeat: true }] },
      queue,
      {}
    );
  });

  it('still goes out when the hold ends at the same screen', () => {
    queue.noteTyping(true);
    paged.onBlock(block('unknown', pager));
    queue.noteTyping(false);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['Q']);
  });

  it('is dropped once the realm has been entered', () => {
    queue.noteTyping(true);
    paged.onBlock(block('unknown', pager));
    paged.onBlock(block('status-line', '[HP=44/KAI=2]:'));
    queue.noteTyping(false);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
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
    login.onBlock(block('prompt-username', USERNAME));
    vi.advanceTimersByTime(50);
    expect(login.standDown).toBeNull();
  });

  /*
   * The request is not the leaving: the realm refuses one and interrupts
   * another (Festus, 2026-09-18, a bugbear). Only a completed exit counts.
   */
  const REQUEST = 'You will exit after a period of silent meditation.';
  const SAVED = 'Your character has been saved. If you have any comments or suggestions, please';

  it('does not name an exit that was only asked for', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', REQUEST, 'newline'));
    expect(login.standDown).toBeNull();
  });

  it('names it once the menu has confirmed it', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', REQUEST, 'newline'));
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    expect(login.standDown).toBe('left-realm');
  });

  // Bearfather's wire, 2026-09-17: MajorMUD says so before its menu.
  it("names it on MajorMUD's own sentence for a completed exit", () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-left-realm', SAVED, 'newline'));
    expect(login.standDown).toBe('left-realm');
  });

  it('forgets it when the player breaks the exit', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', REQUEST, 'newline'));
    login.observeCommand('break');
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    expect(login.standDown).toBeNull();
  });

  /*
   * 2026-09-18: interrupted four seconds in, the exit's latch stood for three
   * hours, and the link that dropped then was not dialled back.
   */
  it('forgets it when the realm interrupts the exit', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', REQUEST, 'newline'));
    login.onBlock(
      block(
        'user-exit-interrupted',
        'Your meditation has been interrupted - you may not exit now!',
        'newline'
      )
    );
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    expect(login.standDown).toBeNull();
  });

  it('lifts it when the character comes back in on the same connection', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', REQUEST, 'newline'));
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    expect(login.standDown).toBe('left-realm');
    login.onBlock(block('status-line', '[HP=34]:'));
    expect(login.standDown).toBeNull();
    // And a second exit is a second stand-down, said again.
    login.onBlock(block('user-exits-realm', REQUEST, 'newline'));
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    expect(login.standDown).toBe('left-realm');
    expect(notices.filter((m) => m.includes('stands down'))).toHaveLength(2);
  });

  it('names a refused login, because the way back in from one is a lockout', () => {
    login.onBlock(block('prompt-username', USERNAME));
    login.onBlock(block('prompt-password', PASSWORD));
    vi.advanceTimersByTime(50);
    login.onBlock(block('login-failed', 'Invalid username/password!'));
    expect(login.standDown).toBe('login-refused');
  });

  it('is clear again on the next connection', () => {
    login.onBlock(block('status-line', '[HP=34]:'));
    login.onBlock(block('user-exits-realm', REQUEST, 'newline'));
    login.onBlock(block('prompt-menu', '[PARADIGM]:'));
    login.reset();
    expect(login.standDown).toBeNull();
  });
});
