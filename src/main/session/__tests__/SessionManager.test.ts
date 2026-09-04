import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  BUSY_PHASES,
  editorInput,
  IDLE_FLUSH_MS,
  SessionManager,
  type SessionSink
} from '../SessionManager';
import { DEFAULT_CONFIG, type AutomationConfig, type RetreatConfig } from '../../../shared/config';
import { WorldGraph } from '../../world/WorldGraph';
import { t } from '../../app/i18n';
import { PlayerBook } from '../../world/PlayerBook';
import { PROMPT_REPAINT } from '../../net/stream-quirks';
import { ABANDON_MS } from '../TerminalFeed';
import type { StreamLine } from '../../../shared/types';
import type { AutomationSnapshot } from '../../../shared/automation';
import type { CharacterState } from '../../../shared/character';
import type { StandDown } from '../../automation/LoginAutomator';
import { NO_REALM_PLAYERS } from '../../../shared/players';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';

/**
 * These drive a real socket rather than a mocked client: framing sits directly
 * on top of the transport, and a chunk boundary landing inside a terminator is
 * exactly the case a mock would paper over.
 */
let server: net.Server;
let port: number;
let manager: SessionManager | null = null;

/**
 * Every socket the server has accepted, in order. A test that reconnects needs
 * the *second* one, so this is a list rather than a single latch.
 */
let accepted: net.Socket[] = [];

beforeEach(async () => {
  accepted = [];
  server = net.createServer((socket) => {
    socket.on('error', () => {});
    accepted.push(socket);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  manager?.dispose();
  manager = null;
  for (const socket of accepted) socket.destroy();
  accepted = [];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The nth accepted socket, once it exists. */
async function client(index = 0): Promise<net.Socket> {
  await until(() => accepted.length > index);
  return accepted[index]!;
}

function collect(): {
  sink: SessionSink;
  lines: StreamLine[];
  notices: string[];
  traces: AutomationSnapshot[];
  raw: Buffer[];
  drops: Array<StandDown | null>;
} {
  const lines: StreamLine[] = [];
  const notices: string[] = [];
  const traces: AutomationSnapshot[] = [];
  const raw: Buffer[] = [];
  /** One entry per socket that went *unasked*. See `SessionSink.dropped`. */
  const drops: Array<StandDown | null> = [];
  return {
    lines,
    notices,
    traces,
    raw,
    drops,
    sink: {
      bytes: (payload) => raw.push(payload),
      data: () => {},
      line: (line) => lines.push(line),
      block: () => {},
      character: () => {},
      command: () => {},
      state: () => {},
      dropped: (why) => drops.push(why),
      telnet: () => {},
      notice: (message) => notices.push(message),
      automation: (snapshot) => traces.push(snapshot)
    }
  };
}

/** Waits until `predicate` holds or the timeout elapses. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The trigger line has been read, and the client has had its chance to act.
 *
 * A negative assertion needs both halves, and a fixed sleep is only the second
 * of them: a status line the client never saw — a framing regression, a pattern
 * that stopped matching — passed as though the feature had correctly declined.
 * Waiting for the health figure to reach `character` proves the line landed.
 *
 * `publishLine` classifies, feeds and only then calls `act`, all in one
 * synchronous call, so observing the figure from a poll means the decision has
 * already been made or declined. The short settle after it covers anything
 * deferred a turn, and is a twelfth of the sleep it replaces.
 */
async function settled(hp: number): Promise<void> {
  await until(() => manager!.character.vitals.hp === hp);
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('the raw byte record', () => {
  /*
   * The tap the capture is built on, and it went unwired for four phases: the
   * `bytes` event existed on `TelnetClient`, `SessionCapture.bytes()` existed
   * and was documented in that file's header, and nothing connected them. The
   * cost was not theoretical — the first disagreement about what the server
   * actually sent, and in what order, had no file to settle it from.
   */
  it('publishes payload bytes undecoded, so an encoding fault survives them', async () => {
    const { sink, raw } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    // Shade and block glyphs: invalid UTF-8, wrong in Latin-1, and exactly what
    // this server opens with. Decoded text could not prove they arrived.
    socket.write(Buffer.from([0xb0, 0xdb, 0xdb, 0xb1]));
    await until(() => raw.length > 0);
    expect(Buffer.concat(raw)).toEqual(Buffer.from([0xb0, 0xdb, 0xdb, 0xb1]));
  });

  it('strips Telnet framing from what it publishes, keeping the payload', async () => {
    const { sink, raw } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    // IAC WILL ECHO around a payload: negotiation is not payload, and a record
    // that mixed the two could not be replayed through the parser.
    socket.write(Buffer.from([0xff, 0xfb, 0x01, 0x41, 0x42]));
    await until(() => Buffer.concat(raw).length >= 2);
    expect(Buffer.concat(raw)).toEqual(Buffer.from([0x41, 0x42]));
  });
});

describe('SessionManager line framing', () => {
  it('frames server output into lines', async () => {
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('one\r\ntwo\r\n');

    await until(() => lines.length >= 2);
    expect(lines.map((line) => line.plain)).toEqual(['one', 'two']);
    expect(lines.every((line) => line.terminator === 'newline')).toBe(true);
  });

  it('frames the in-place status-line repaint as its own line', async () => {
    // The case that makes this game family different: the server rewrites its
    // status line with ESC[79D ESC[K instead of sending a newline.
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write(`[HP=100/MA=50]:${PROMPT_REPAINT}You are in a room.\r\n`);

    await until(() => lines.length >= 2);
    expect(lines[0]?.plain).toBe('[HP=100/MA=50]:');
    expect(lines[0]?.terminator).toBe('repaint');
    expect(lines[1]?.plain).toBe('You are in a room.');
  });

  it('reassembles a line split across two writes', async () => {
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Obvious exits: ');
    await new Promise((resolve) => setTimeout(resolve, 40));
    socket.write('north, south\r\n');

    await until(() => lines.some((line) => line.terminator === 'newline'));
    expect(lines.at(-1)?.plain).toBe('Obvious exits: north, south');
  });

  it('releases a trailing prompt once the server goes quiet', async () => {
    // The login prompt never gets a terminator: the server sends it and waits.
    // Without the idle flush the line the player is staring at is invisible to
    // every consumer until the socket closes.
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Please enter your username or "new":');

    await until(() => lines.length >= 1);
    expect(lines[0]?.plain).toBe('Please enter your username or "new":');
    expect(lines[0]?.terminator).toBe('flush');
  });

  it('does not re-emit a prompt it has already released', async () => {
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Password:');
    await until(() => lines.length >= 1);

    manager.disconnect();
    // One whole flush period after the disconnect: if it had armed another
    // timer, that is when the second copy would arrive.
    await new Promise((resolve) => setTimeout(resolve, IDLE_FLUSH_MS * 2));
    expect(lines.filter((line) => line.plain === 'Password:')).toHaveLength(1);
  });

  it('strips ANSI into `plain` while keeping it in `text`', async () => {
    // Grammar first, colour second: rules match plain text, and the attributes
    // stay available alongside as a confidence signal.
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('\x1b[0;32mObvious exits: \x1b[1;33mnorth\x1b[0m\r\n');

    await until(() => lines.length >= 1);
    expect(lines[0]?.plain).toBe('Obvious exits: north');
    expect(lines[0]?.text).toContain('\x1b[1;33m');
  });

  it('numbers lines monotonically and restarts them per connection', async () => {
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('a\r\nb\r\n');
    await until(() => lines.length >= 2);
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);

    expect(manager.lines).toHaveLength(2);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    expect(manager.lines).toHaveLength(0);
  });

  it('does not let a partial line leak between connections', async () => {
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('half a line');
    await until(() => lines.length >= 1);
    lines.length = 0;

    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const second = await client(1);
    second.write(' rest\r\n');

    await until(() => lines.length >= 1);
    expect(lines[0]?.plain).toBe(' rest');
  });

  it('keeps the retained line log bounded', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write(Array.from({ length: 700 }, (_, i) => `line ${i}\r\n`).join(''));

    await until(() => manager!.lines.length === 500);
    expect(manager.lines).toHaveLength(500);
    // Oldest dropped, newest kept.
    expect(manager.lines.at(-1)?.plain).toBe('line 699');
  });
});

describe('SessionManager lifecycle', () => {
  it('publishes nothing after dispose', async () => {
    // A pending prompt must not be flushed into a sink whose owner has gone
    // away — that is how a torn-down window gets written to.
    const { sink, lines } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('a prompt with no newline');

    manager.dispose();
    const seen = lines.length;
    // The pending prompt would be released by the idle flush, so the wait is
    // one whole flush period rather than a number chosen to feel safe.
    await new Promise((resolve) => setTimeout(resolve, IDLE_FLUSH_MS * 2));
    expect(lines).toHaveLength(seen);

    manager = null;
  });
});

/*
 * Which closes are a *loss*, which is the whole safety property auto-reconnect
 * rests on. Every deliberate close arrives at the same `close` event, and this
 * is the only place that can tell them apart — so a mistake here is a client
 * that either abandons a character mid-dungeon or dials somebody back into a
 * realm they walked out of, with their password.
 */
describe('telling a lost socket from one that was closed', () => {
  it('reports the far end hanging up, with no reason to stand down', async () => {
    const { sink, drops } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.destroy();
    await until(() => drops.length > 0);
    expect(drops).toEqual([null]);
  });

  it('reports nothing at all when this client asked for the disconnect', async () => {
    const { sink, drops } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    await client();

    manager.disconnect();
    await until(() => manager!.state.phase === 'closed');
    expect(drops).toEqual([]);
  });

  /*
   * The player typed their way out and the BBS then hung up on them. At the
   * socket layer that is identical to a dead link; one line above it, it is
   * the one close that must never be dialled back — automatic login would put
   * them straight back in the realm they just left.
   */
  it('carries the reason when the player had left the realm on purpose', async () => {
    const { sink, drops } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('You will exit after a period of silent meditation.\r\n');
    // The block has to be classified before the socket goes, or the latch this
    // reads has not been set — which is the ordering the real stream has too.
    await until(() => manager!.lines.some((line) => /silent meditation/.test(line.plain)));
    socket.destroy();

    await until(() => drops.length > 0);
    expect(drops).toEqual(['left-realm']);
  });

  it('carries the reason when the realm refused the login', async () => {
    const { sink, drops } = collect();
    manager = new SessionManager(sink, undefined, DEFAULT_CONFIG.automation, {
      enabled: true,
      username: 'vaelor',
      password: 'wrong',
      steps: []
    });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Invalid username/password!\r\n');
    await until(() => manager!.lines.some((line) => /Invalid username/.test(line.plain)));
    socket.destroy();

    await until(() => drops.length > 0);
    expect(drops).toEqual(['login-refused']);
  });
});

describe('answering the login', () => {
  /**
   * The sequence, and what the server says next once each answer arrives.
   * Every prompt is sent *unterminated*: the server says its piece and waits,
   * which is why the idle flush has to release it before anything can answer.
   */
  const EXCHANGE: Array<{ prompt: string; expect: string }> = [
    { prompt: 'Please enter your username or "new": ', expect: 'vaelor' },
    { prompt: 'Please enter your password: ', expect: 'secret' },
    { prompt: 'Please enter your selection: ', expect: 'P' },
    { prompt: 'Please select a realm: ', expect: '1' },
    { prompt: '[PARADIGM]: ', expect: 'E' }
  ];

  it('answers every prompt without waiting out the acknowledgement timeout', async () => {
    /*
     * The regression this exists for: a login produces no status line, so when
     * only the status line released queue credit, the third answer sat until
     * `ackTimeoutMs` expired and logging in took four and a half seconds. A
     * prompt *is* the acknowledgement — the server has finished with the last
     * command and is waiting — so the window must reopen on one.
     *
     * A window of 2 against a 5s timeout makes the difference unmissable: with
     * prompts acking, the whole exchange finishes in well under a second; with
     * only status lines acking, it could not finish inside this test's budget.
     */
    const { sink } = collect();
    manager = new SessionManager(
      sink,
      undefined,
      {
        ...DEFAULT_CONFIG.automation,
        pacing: { window: 2, minGapMs: 50, ackTimeoutMs: 5000 }
      },
      {
        enabled: true,
        username: 'vaelor',
        password: 'secret',
        steps: [
          { when: 'Please enter your selection', send: 'P' },
          { when: 'Please select a realm', send: '1' },
          { when: 'Please select a character', send: '1' },
          { when: '[PARADIGM]', send: 'E' }
        ]
      }
    );
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    const received: string[] = [];
    socket.on('data', (chunk) => {
      for (const answer of chunk.toString('latin1').split('\r\n')) {
        if (answer.length > 0) received.push(answer);
      }
    });

    const started = Date.now();
    for (const [index, step] of EXCHANGE.entries()) {
      socket.write(step.prompt);
      await until(() => received.length > index, 4000);
    }

    expect(received).toEqual(EXCHANGE.map((step) => step.expect));
    // Generous, but far below even one ackTimeoutMs: the point is that nothing
    // in the sequence blocked on the timeout.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("the shadow of the server's input line", () => {
  /*
   * The buffer that decides whether automation may send has to hold what the
   * *server* holds, and a control byte is not text. Measured in
   * `logs/2026-08-30_20-57-36_main.mudcap.jsonl`: twenty Escapes and an Enter
   * were answered with a bare room reprint, exactly as an empty line is.
   */
  it('keeps what the server would keep', () => {
    expect(editorInput('north')).toBe('north');
    expect(editorInput('n\r')).toBe('n\r');
    // The erases are modelled by the caller, so they survive this.
    expect(editorInput('no\x7f')).toBe('no\x7f');
  });

  it('keeps nothing of the keys the server keeps nothing of', () => {
    // Escape, on its own and twenty times over.
    expect(editorInput('\x1b')).toBe('');
    expect(editorInput('\x1b'.repeat(20) + '\r')).toBe('\r');
    // An arrow key, which is where dropping only the introducer would leave
    // `[A` behind and hold automation just as thoroughly.
    expect(editorInput('\x1b[A')).toBe('');
    expect(editorInput('\x1b[1;5C')).toBe('');
    // A function key (SS3), Tab, and a Ctrl chord.
    expect(editorInput('\x1bOP')).toBe('');
    expect(editorInput('\t')).toBe('');
    expect(editorInput('\x01')).toBe('');
  });

  /* A sequence the chunk ends inside is consumed whole rather than leaving
     half of something the server is not holding at all. */
  it('consumes a sequence the chunk ends inside', () => {
    expect(editorInput('n\x1b[')).toBe('n');
    expect(editorInput('n\x1b')).toBe('n');
  });
});

describe('a person at the keyboard', () => {
  /*
   * Typing is a state, not an event, and it begins at the first keystroke.
   *
   * The grace used to be started only where a *committed* command is handled —
   * inside the newline loop — so automation stood down for the moment after
   * somebody finished typing and competed with them for every moment before
   * it. `pu small lashworm` is a second and a half of keystrokes, and a
   * command the client interleaves into that is what turns it into
   * `lpu small lashworm`, which this server answers by saying out loud in the
   * room.
   */
  it('stands automation down from the first keystroke, not from the Enter', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();

    // One keystroke, no terminator: nothing is committed and nothing can be.
    manager.send('p');

    // The entry probe fires on reaching the realm, so there is something real
    // wanting to send. It must not, while a half-typed word is on the line.
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    /*
     * Both halves of the situation, rather than a sleep long enough that one
     * would surely have happened: the probe really did queue something, and
     * the queue really is standing down. A sleep asserted neither, so a probe
     * that had stopped firing at all passed this as though the hold worked.
     */
    await until(() => manager!.automation.queue.depth > 0 && manager!.automation.queue.suppressed);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The keystroke itself reaches the socket -- it is the player's -- so what
    // is asserted is that no *command* was committed behind it.
    expect(Buffer.concat(chunks).toString('latin1')).toBe('p');
  });

  /*
   * The other half of the hold, and it is about *byte order on the wire*.
   *
   * `noteTyping(false)` releases held commands synchronously, and when it ran
   * before the Enter keystroke had been written to the socket, the released
   * command overtook the very terminator that released it: the server read
   * `dance` + `pu thin carrion beast` as one line and said
   * `dancepu thin carrion beast` out loud in the room. Captured live,
   * 2026-08-26, 14:22 session.
   */
  it('puts the Enter on the wire before the command it releases', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();

    // In the realm, so the entry probe queues real commands...
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    // ...while a half-typed word holds them.
    for (const key of 'dance') manager.send(key);
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.automation.queue.depth > 0 && manager!.automation.queue.suppressed);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(Buffer.concat(chunks).toString('latin1')).toBe('dance');

    // Enter. Everything held may now go — behind the terminator, never past it.
    manager.send('\r');
    await until(() => Buffer.concat(chunks).toString('latin1').includes('\r\n'));
    const wire = Buffer.concat(chunks).toString('latin1');
    expect(wire.startsWith('dance\r')).toBe(true);
    // The released command begins only after the player's terminator.
    const released = wire.slice('dance\r'.length);
    expect(released.length).toBeGreaterThan(0);
    expect(released.startsWith('\r')).toBe(false);
  });

  /*
   * And the failure that made `editorInput` necessary, end to end.
   *
   * Escape leaves no character in the server's line, so it is not a half-typed
   * command and must not stand automation down. It did: every keystroke went
   * into the shadow buffer, `outbound` never emptied, and the hold ran to its
   * twenty-second ceiling — re-armed by each further key. A hostile walked
   * into a room, the attack was decided in the same millisecond and sat in the
   * queue for twenty-two seconds while the monster hit the character sixteen
   * times (`logs/2026-08-30_20-57-36_main.mudcap.jsonl`, t=43603 to t=66056).
   *
   * The positive control is the assertion itself: what is checked is that a
   * real command *arrived*, not that a sleep passed without one.
   */
  it('is not held down by keys the server keeps no text of', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();

    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    // Escape, then an arrow key: two keystrokes and no line.
    manager.send('\x1b');
    manager.send('\x1b[A');
    // In the realm, so the entry probe has something real it wants to send.
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);

    await until(() => Buffer.concat(chunks).toString('latin1').includes('rm\r\n'));
    expect(manager.automation.queue.suppressed).toBe(false);
  });
});

describe('the decision trace', () => {
  /** Drives the fixture to the realm, which is what makes the probe fire. */
  async function reachTheRealm(socket: net.Socket): Promise<void> {
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
  }

  it('records what the arbiter sent, and why', async () => {
    // A rule firing is not a command sent -- an intent can be coalesced away,
    // expire, or be cancelled in between -- so the send is recorded separately.
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    await reachTheRealm(socket);

    await until(() => manager!.automation.sent.length > 0);
    const trace = manager!.automation;
    expect(trace.enabled).toBe(true);
    expect(trace.sent[0]?.reason).toBe('entering the realm');
    expect(DEFAULT_CONFIG.automation.onEnterRealm).toContain(trace.sent[0]?.command);
  });

  it('reads newest first, because a trace is read backwards', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    await reachTheRealm(socket);

    await until(() => manager!.automation.sent.length >= 2);
    const sent = manager!.automation.sent;
    expect(sent[0]!.at).toBeGreaterThanOrEqual(sent[1]!.at);
  });

  it('publishes the first change immediately rather than after the interval', async () => {
    // A trace you have to wait a beat for is a worse trace.
    const { sink, traces } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    await reachTheRealm(socket);

    await until(() => traces.length > 0);
    expect(traces.length).toBeGreaterThan(0);
  });

  it('forgets the trace on a new connection', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    await reachTheRealm(socket);
    await until(() => manager!.automation.sent.length > 0);

    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    expect(manager.automation.sent).toEqual([]);
  });
});

describe('credentials in the record', () => {
  /**
   * The session capture records every outbound command verbatim, which is what
   * makes it useful for pattern work and exactly why the answer to a password
   * prompt must be filtered before it gets there.
   */
  function withCommands(): { sink: SessionSink; commands: string[] } {
    const commands: string[] = [];
    const { sink } = collect();
    return { commands, sink: { ...sink, command: (command) => commands.push(command) } };
  }

  it('never writes down the answer to a password prompt', async () => {
    const { sink, commands } = withCommands();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Please enter your password:\r\n');
    await until(() => manager!.character.phase !== 'unknown' || true);
    // Whoever answers -- automator or a person typing -- it is the prompt that
    // makes the next command a secret, not who sent it.
    await new Promise((r) => setTimeout(r, 50));
    manager.send('hunter2\r');

    await until(() => commands.length > 0);
    expect(commands).not.toContain('hunter2');
    expect(commands[0]).toMatch(/^•+$/);
  });

  it('redacts one command, not every command after it', async () => {
    const { sink, commands } = withCommands();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Please enter your password:\r\n');
    await new Promise((r) => setTimeout(r, 50));
    manager.send('hunter2\r');
    manager.send('look\r');

    await until(() => commands.length >= 2);
    expect(commands[1]).toBe('look');
  });

  it('redacts the password the automator sends, not the command after it', async () => {
    /*
     * The bug this exists for, found by reading a real capture: the flag was
     * armed *after* the login automator saw the block, and the automator
     * answers synchronously from inside that call. So the password went into
     * the file verbatim and the menu selection after it was starred out --
     * which looks entirely correct until you read the file.
     */
    const commands: string[] = [];
    const { sink } = collect();
    manager = new SessionManager(
      { ...sink, command: (command) => commands.push(command) },
      undefined,
      {
        ...DEFAULT_CONFIG.automation,
        pacing: { window: 2, minGapMs: 10, ackTimeoutMs: 5000 }
      },
      {
        enabled: true,
        username: 'vaelor',
        password: 'secret',
        steps: [
          { when: 'Please enter your selection', send: 'P' },
          { when: 'Please select a realm', send: '1' },
          { when: 'Please select a character', send: '1' },
          { when: '[PARADIGM]', send: 'E' }
        ]
      }
    );
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Please enter your username or "new": ');
    await until(() => commands.length >= 1, 4000);
    socket.write('Please enter your password: ');
    await until(() => commands.length >= 2, 4000);
    socket.write('Please enter your selection: ');
    await until(() => commands.length >= 3, 4000);

    expect(commands[0]).toBe('vaelor');
    expect(commands[1]).toMatch(/^•+$/);
    expect(commands[2]).toBe('P');
    expect(commands.join(' ')).not.toContain('secret');
  });

  it('redacts the configured password at a prompt the classifier did not read', async () => {
    /*
     * The prompt is the primary key, and it is also the weak point: a BBS
     * front-end the classifier has never met produces no `prompt-password`
     * block, so a manual login there would have written the password down
     * verbatim. The configured credential is the one thing known without
     * reading the prompt -- and only an exact match counts, so the command
     * after it is recorded as itself.
     */
    const commands: string[] = [];
    const { sink } = collect();
    manager = new SessionManager(
      { ...sink, command: (command) => commands.push(command) },
      undefined,
      DEFAULT_CONFIG.automation,
      { ...DEFAULT_CONFIG.connection.login, username: 'vaelor', password: 'hunter2' }
    );
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    // Not a shape the classifier knows, so nothing arms the prompt-keyed redaction.
    socket.write('Secret word? ');
    await new Promise((r) => setTimeout(r, 50));
    manager.send('hunter2\r');
    manager.send('look\r');

    await until(() => commands.length >= 2);
    expect(commands[0]).toMatch(/^•+$/);
    expect(commands[1]).toBe('look');
    expect(commands.join(' ')).not.toContain('hunter2');
  });

  it('redacts the answers to the account-creation password prompts too', async () => {
    /*
     * Found by the corrected `check:secrets`: a 2026-08-26 capture held a
     * password twice, typed at `Please enter the password you would like to
     * use:` and again at `Please confirm your new password:`, two days after
     * the login prompt was keyed on. The answer here is deliberately *not* a
     * configured password, so this proves the prompt path and not the match.
     */
    const { sink, commands } = withCommands();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('Please enter the password you would like to use:\r\n');
    await new Promise((r) => setTimeout(r, 50));
    manager.send('brandnew1\r');
    socket.write('Please confirm your new password:\r\n');
    await new Promise((r) => setTimeout(r, 50));
    manager.send('brandnew1\r');
    manager.send('look\r');

    await until(() => commands.length >= 3);
    expect(commands[0]).toMatch(/^•+$/);
    expect(commands[1]).toMatch(/^•+$/);
    expect(commands[2]).toBe('look');
    expect(commands.join(' ')).not.toContain('brandnew1');
  });

  it('leaves ordinary commands alone', async () => {
    const { sink, commands } = withCommands();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    await client();
    manager.send('who\r');
    await until(() => commands.length > 0);
    expect(commands[0]).toBe('who');
  });
});

describe('losing the connection', () => {
  it('stops a walk rather than reporting progress nothing is making', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });

    const socket = await client();
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');

    // A route that has already started; the room it expects never arrives
    // because the socket goes away underneath it.
    const started = manager.walker.start(
      {
        cost: 1,
        blocked: false,
        steps: [
          {
            from: '1/1',
            to: '1/2',
            direction: 'e',
            command: 'e',
            name: 'Next',
            requirement: null,
            dark: false
          }
        ]
      },
      { ...manager.character, room: { ...manager.character.room, map: 1, number: 1 } }
    );
    expect(started).toBeNull();
    expect(manager.walker.progress.status).toBe('walking');

    socket.destroy();
    await until(() => manager!.walker.progress.status === 'stopped');
    expect(manager.walker.progress.reason).toMatch(/connection closed/i);
  });
});

describe('connecting twice', () => {
  it('refuses a second attempt while the first is still in flight', async () => {
    // `connect` tears down whatever is open before it dials, so a second call
    // arriving mid-handshake kills a connection that was about to succeed.
    // React's StrictMode made that the *normal* case in development: it mounts
    // the renderer twice, and both mounts said "ready".
    expect(BUSY_PHASES.has('connecting')).toBe(true);
    expect(BUSY_PHASES.has('resolving')).toBe(true);
  });

  it('does not treat being connected as a reason to refuse', async () => {
    // Dialling while connected is how you switch servers, and the palette
    // offers it.
    expect(BUSY_PHASES.has('connected')).toBe(false);
  });
});

/*
 * The panic button, and why it mostly refuses.
 *
 * "Disconnect when health is low" is what every MegaMUD-era client offers, and
 * on this server family an unclean disconnect costs a percentage of *maximum*
 * HP — fatal at exactly the health that makes somebody want it. So the feature
 * exists and the interesting behaviour is the refusal.
 */
describe('hanging up to escape', () => {
  const safety = (
    over: Partial<(typeof DEFAULT_CONFIG)['automation']['safety']['hangUp']> = {}
  ) => ({
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: [],
    safety: {
      ...DEFAULT_CONFIG.automation.safety,
      hangUp: {
        enabled: true,
        belowHealth: 0.3,
        onlyWhenClean: true,
        onPlayerInRoom: false,
        ...over
      }
    }
  });

  /*
   * A maximum, then a status line low enough to trip it.
   *
   * `health` is the one command that reports current and maximum together, so
   * it is the cheapest way to give the tracker a maximum — and without one the
   * fraction is unknown and nothing may fire, which is itself a case below.
   */
  const knowMaximum = (socket: net.Socket): void => {
    socket.write('Health: 100/100 [100%]\r\n');
  };
  const hurt = async (socket: net.Socket): Promise<void> => {
    knowMaximum(socket);
    socket.write('[HP=100]:\r\n');
    // The fall has to arrive as a *change*, so the healthy line lands first.
    await until(() => manager!.character.vitals.hp === 100);
    socket.write('[HP=10]:\r\n');
  };

  it('hangs up when health falls and nothing says it would be penalised', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, safety());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    await hurt(await client());

    await until(() => notices.some((notice) => /Hanging up/.test(notice)));
    await until(() => manager?.state.phase === 'closing' || manager?.state.phase === 'closed');
  });

  /* Unknown is not zero: a maximum that has not arrived must never trip this. */
  it('does not hang up on a health figure with no maximum behind it', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, safety());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('[HP=10]:\r\n');

    await settled(10);
    expect(notices.some((notice) => /Hanging up/.test(notice))).toBe(false);
    expect(manager?.state.phase).toBe('connected');
  });

  /*
   * The whole point. A hangup in combat is penalised, and refusing is said out
   * loud — somebody who turned this on is relying on it, and a safety feature
   * that silently declines is worse than one that was never offered.
   */
  it('refuses in combat, and says why', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, safety());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    knowMaximum(socket);
    socket.write('The orc rogue slashes you for 5 damage!\r\n');
    await until(() => manager!.character.combat.blows > 0);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => /Not hanging up/.test(notice)));
    const refusal = notices.find((notice) => /Not hanging up/.test(notice)) ?? '';
    expect(refusal).toMatch(/attacking you|combat/);
    // And it stays connected, which is the part that matters.
    expect(manager?.state.phase).toBe('connected');
  });

  /*
   * "Why did the bot run?" has to be answerable from a trace, and hanging up
   * is the one decision with a consequence nothing can undo. A refusal has to
   * be there too: somebody who turned a safety feature on and saw nothing
   * happen needs to see that it *decided* not to.
   */
  it('records the refusal where somebody can read it', async () => {
    const { sink, traces } = collect();
    manager = new SessionManager(sink, undefined, safety());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    knowMaximum(socket);
    socket.write('The orc rogue slashes you for 5 damage!\r\n');
    /*
     * The blow is what makes the hangup unclean, so it has to land before the
     * status line that would otherwise trip it. `blows` and not `attackers`:
     * a monster's attack text is realm data, so nothing in the line says where
     * the name stops, and with no room block to name the occupants the roster
     * of attackers stays empty. The blow was still counted.
     */
    await until(() => manager!.character.combat.blows > 0);
    socket.write('[HP=10]:\r\n');

    await until(() => traces.some((trace) => trace.safety.length > 0));
    const decision = traces.at(-1)?.safety[0];
    expect(decision?.action).toBe('hang up');
    expect(decision?.acted).toBe(false);
    expect(decision?.refused).toMatch(/attacking you|combat/);
    expect(decision?.because).toMatch(/health/);
  });

  it('records the hangup itself, which produces no command to record', async () => {
    const { sink, traces } = collect();
    manager = new SessionManager(sink, undefined, safety());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    await hurt(await client());

    await until(() => traces.some((trace) => trace.safety.some((entry) => entry.acted)));
    const decision = traces.at(-1)?.safety.find((entry) => entry.acted);
    expect(decision?.action).toBe('hang up');
  });

  it('says it once rather than on every status line', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, safety());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    knowMaximum(socket);
    socket.write('The orc rogue slashes you for 5 damage!\r\n');
    await until(() => manager!.character.combat.blows > 0);
    for (const hp of [12, 11, 10, 9, 8]) {
      socket.write(`[HP=${hp}]:\r\n`);
      await until(() => manager!.character.vitals.hp === hp);
    }
    await until(() => notices.some((notice) => /Not hanging up/.test(notice)));
    expect(notices.filter((notice) => /Not hanging up/.test(notice))).toHaveLength(1);
  });

  /*
   * Off is for a realm where PvP is disabled or the penalty is not configured —
   * which the client cannot detect and the player can know.
   */
  it('hangs up anyway when told to, and says the penalty is likely', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, safety({ onlyWhenClean: false }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    knowMaximum(socket);
    socket.write('The orc rogue slashes you for 5 damage!\r\n');
    /*
     * The blow is what makes the hangup unclean, so it has to land before the
     * status line that would otherwise trip it. `blows` and not `attackers`:
     * a monster's attack text is realm data, so nothing in the line says where
     * the name stops, and with no room block to name the occupants the roster
     * of attackers stays empty. The blow was still counted.
     */
    await until(() => manager!.character.combat.blows > 0);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => /Hanging up/.test(notice)));
    expect(notices.find((notice) => /Hanging up/.test(notice))).toMatch(/Penalty likely/);
  });

  /*
   * The condition nothing on screen shows. Combat is over, nothing in the room
   * is swinging, the status line looks like any other — and a hangup is still
   * penalised for five minutes after a player's blow either way. The roster is
   * what makes Vaelor a player rather than a monster's realm-data name.
   */
  it('refuses inside the five-minute PvP window after combat has ended', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, safety());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    knowMaximum(socket);
    socket.write('Vaelor just entered the Realm.\r\n');
    await until(() => manager!.character.online.some((who) => who.name === 'Vaelor'));
    socket.write('Vaelor moves to attack you!\r\n');
    await until(() => manager!.character.combat.attackers.length > 0);
    socket.write('*Combat Off*\r\n');
    await until(() => !manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => /Not hanging up/.test(notice)));
    const refusal = notices.find((notice) => /Not hanging up/.test(notice)) ?? '';
    expect(refusal).toMatch(/PvP with Vaelor/);
    expect(refusal).toMatch(/walk out instead/);
    expect(manager?.state.phase).toBe('connected');
  });

  it('does nothing at all while it is switched off', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, safety({ enabled: false }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    await hurt(await client());

    await settled(10);
    expect(notices.some((notice) => /anging up/.test(notice))).toBe(false);
    expect(manager?.state.phase).toBe('connected');
  });

  /* The master switch outranks it: with automation off, nothing automated acts. */
  it('does nothing while automation as a whole is off', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, { ...safety(), enabled: false });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    await hurt(await client());

    await settled(10);
    expect(notices.some((notice) => /anging up/.test(notice))).toBe(false);
  });
});

/*
 * Running away is the escape that works: walking out breaks combat and carries
 * none of the penalty an unclean disconnect does, which is exactly why the
 * hangup refusal tells you to do this instead.
 *
 * **What it sends is a direction, and these tests assert the direction.** They
 * used to assert the word `flee`, and passed for four phases while the server
 * answered every one of them `Your command had no effect.` — a test that
 * watches for a token rather than for an effect grades the client on its
 * intentions. Each of these now gives the character a room with exits in it,
 * because a room is where a way out comes from.
 */
describe('running away', () => {
  const escaping = (
    over: Partial<(typeof DEFAULT_CONFIG)['automation']['safety']['retreat']> = {}
  ) => ({
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: [],
    safety: {
      ...DEFAULT_CONFIG.automation.safety,
      retreat: {
        ...DEFAULT_CONFIG.automation.safety.retreat,
        enabled: true,
        belowHealth: 0.3,
        whenOutnumbered: 0,
        cooldownMs: 3000,
        ...over
      } as RetreatConfig
    }
  });

  /**
   * Any sentence the escape says when it acts, and the one it says when it
   * cannot. One matcher, so a test asserting *nothing happened* cannot pass
   * because the wording moved to a different rung.
   */
  const RAN = /Running \w+:|Retreating \w+,|Not running:/;

  /** A room with two ways out of it, which is what an escape needs. */
  const ROOM = 'Rat Cellar\r\nObvious exits: north, south\r\n';

  /**
   * Everything the client committed to the wire, polled for the command under
   * test rather than read after a fixed sleep. The queue paces a send behind
   * `minGapMs` and the escape is proposed in the `emergency` band, so a wait
   * sized for the nominal case is a test being impatient rather than the
   * feature being slow — and one sized to never be impatient is 600ms every
   * run.
   */
  const sent = (socket: net.Socket, pattern: RegExp): Promise<string> => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const wire = (): string => Buffer.concat(chunks).toString('latin1');
    return until(() => pattern.test(wire())).then(wire);
  };

  it('runs when health falls, in a fight — and it is a move that goes out', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = sent(socket, /\bn\r\n/);
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write(ROOM);
    socket.write('*Combat Engaged*\r\n');
    // The drop has to arrive as a *change*, so the lines that set the maximum
    // and open the fight have to land first. Waiting for the fight itself
    // proves both did — it is the later of the two.
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => RAN.test(notice)));
    // North, because it is the first exit the room printed and nothing here is
    // placed — the bottom rung of the ladder, which is still an exit.
    expect(await seen).toMatch(/\bn\r\n/);
    expect(notices.find((notice) => RAN.test(notice))).toMatch(/Running n:/);
  });

  /*
   * The room said nothing, and there is nothing behind us on the trail. So
   * nothing is sent — and the point is that it *says so*: a refusal reported
   * as an action is how a word that did nothing survived four phases.
   */
  it('refuses out loud rather than inventing a way out', async () => {
    const { sink, notices, traces } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => /Not running:/.test(notice)));
    /*
     * No move reached the wire — not a direction, and certainly not a word
     * invented for the purpose.
     *
     * Not *nothing*, which is what this asserted first and is a stronger claim
     * than the feature makes: a refused escape leaves nothing in flight, so
     * everything else that keeps a character alive is free to act, and here
     * `Recovery` sits it down. That is the point of the refusal being a
     * refusal — it used to arm the in-flight window and switch resting,
     * healing and fighting all off while printing *standing and fighting*.
     */
    expect(Buffer.concat(chunks).toString('latin1')).not.toMatch(/\b[nsewud]\r\n/);
    // The trace is published on its own throttle, so it is waited for rather
    // than read off whatever had been pushed when the notice landed.
    await until(() => traces.some((trace) => trace.safety.length > 0));
    const decision = traces.at(-1)?.safety[0];
    expect(decision).toMatchObject({ action: 'retreat', acted: false });
    expect(decision?.refused).toMatch(/no exit known/);
  });

  /* An escape out of combat is a wasted move that puts the character in a room
     it did not choose. */
  it('does not run when nothing is fighting it', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write(ROOM);
    socket.write('[HP=10]:\r\n');

    await settled(10);
    expect(notices.some((notice) => RAN.test(notice))).toBe(false);
  });

  it('does not run above the threshold', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write(ROOM);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=90]:\r\n');

    await settled(90);
    expect(notices.some((notice) => RAN.test(notice))).toBe(false);
  });

  /*
   * Being swarmed at full health. A health threshold notices too late — by the
   * time the bar is low the next round has already been rolled.
   */
  it('runs when outnumbered, whatever the health says', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping({ whenOutnumbered: 2 }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    /*
     * The room, which is two facts at once here. It is where the way out comes
     * from — and it is also the only thing that can say a monster's name ends
     * at `rogue`, because there is nothing in `The orc rogue slashes you for 1
     * damage!` that says where the name stops. Either the room or the realm's
     * monster table has to; this session has no realm, so the room does. That
     * is exactly what the client does on a realm it has no data for.
     */
    socket.write('Rat Cellar\r\n');
    socket.write('Also here: orc rogue, cave rat.\r\n');
    socket.write('Obvious exits: north\r\n');
    socket.write('*Combat Engaged*\r\n');
    socket.write('The orc rogue slashes you for 1 damage!\r\n');
    socket.write('The cave rat bites you for 1 damage!\r\n');
    // Both blows, not just the first: the count is what is under test.
    await until(() => manager!.character.combat.attackers.length >= 2);
    socket.write('[HP=98]:\r\n');

    await until(() => notices.some((notice) => RAN.test(notice)));
    expect(notices.find((notice) => RAN.test(notice))).toMatch(/attackers/);
  });

  it('does not count one attacker as being outnumbered', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping({ whenOutnumbered: 2 }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write(ROOM);
    socket.write('*Combat Engaged*\r\n');
    socket.write('The orc rogue slashes you for 1 damage!\r\n');
    await until(() => manager!.character.combat.blows > 0);
    socket.write('[HP=98]:\r\n');

    await settled(98);
    expect(notices.some((notice) => RAN.test(notice))).toBe(false);
  });

  /*
   * A status line arrives every few hundred milliseconds under pressure. One
   * queued move, not a queue full of them — coalesced by *intent*, which is the
   * rule the queue exists for. Never by command text: a second `n` is a
   * different move, and a second escape is the same intent.
   */
  it('queues one escape however many status lines arrive', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write(ROOM);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    for (const hp of [12, 11, 10, 9, 8]) {
      socket.write(`[HP=${hp}]:\r\n`);
      await until(() => manager!.character.vitals.hp === hp);
    }
    await until(() => notices.some((notice) => RAN.test(notice)));
    expect(notices.filter((notice) => RAN.test(notice))).toHaveLength(1);
  });

  /* And an escape, which does produce a command, is still recorded as a
     decision: the command says what was sent, and this says why — and, since
     there are four ways to know an exit, which of them answered. */
  it('records why it ran, which way, and how it knew that way', async () => {
    const { sink, traces } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write(ROOM);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() => traces.some((trace) => trace.safety.length > 0));
    const decision = traces.at(-1)?.safety[0];
    expect(decision).toMatchObject({ action: 'retreat', acted: true });
    expect(decision?.because).toMatch(/health at \d+%/);
    expect(decision?.because).toMatch(/— n \(printed\)$/);
  });

  it('does nothing while it is switched off', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping({ enabled: false }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write(ROOM);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await settled(10);
    expect(notices.some((notice) => RAN.test(notice))).toBe(false);
  });
});

/*
 * The realm roster is maintained for free from what the server volunteers --
 * `player-enters` and `player-arrives-room` -- but neither carries an
 * alignment, so a name that arrives this way is unconfirmed until a `who`
 * says otherwise. That `who` is queued rather than sent on the spot: firing
 * one per arrival would be one per adventurer in a busy room, and the idle
 * tick that already exists coalesces a whole burst into the single `who` that
 * answers all of it.
 */
describe('the roster catch-up', () => {
  /*
   * Three tests, and they are here for the *wiring* — that a line on the wire
   * reaches `Routines`, and that the `who` it decides on reaches the socket.
   *
   * What the routine decides is settled in `Routines.test.ts`, on fake timers:
   * asks on the arrival itself, coalesces a whole room of arrivals into one
   * `who`, holds off for a minute afterwards, asks nothing when nobody
   * unlisted has arrived, forgets on a new connection. Those ran here too,
   * through a real socket and a real clock, at two and a half seconds each for
   * an assertion the unit test makes in under a millisecond. The one that only
   * restated the unit test — asking nothing when nobody has arrived — is gone;
   * these three each prove a hookup no unit test can see.
   */
  const catchingUp = () => ({
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    /*
     * A quarter-second quiet period. Shorter than any options file may hold —
     * `normalizeConfig` clamps this to 5 — because what is under test is the
     * hookup either side of the tick, not the length of the wait, and the real
     * value would make each of these cost six seconds.
     */
    idle: { enabled: true, afterSeconds: 0.25, command: 'l' },
    onEnterRealm: [],
    onPartyChange: '',
    rules: []
  });

  /**
   * Everything the client has committed to the wire, polled rather than read
   * after one fixed sleep.
   *
   * `who` is not the first thing this tick sends -- the keep-alive goes out
   * first, and `who` follows once `CommandQueue`'s own `minGapMs` pacing gap
   * has passed. A tick's *own* firing time drifts against real timers besides,
   * so a wait sized for the nominal schedule can end a few hundred
   * milliseconds before the pacing gap actually clears it -- which is a test
   * being impatient, not the feature being slow. Polling for the pattern (or
   * giving up at the deadline) is what `until()` already does for a notice;
   * this is the same idea against the raw bytes, because nothing here emits
   * one.
   */
  const untilSent = async (
    socket: net.Socket,
    pattern: RegExp,
    timeoutMs = 4000
  ): Promise<string> => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = Buffer.concat(chunks).toString('latin1');
      if (pattern.test(text) || Date.now() > deadline) return text;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** In the realm, which is what arms the idle clock, and quiet since. */
  const inTheRealm = async (socket: net.Socket): Promise<void> => {
    socket.write('[HP=10]:\r\n');
    await until(() => manager!.character.phase === 'in-game');
  };

  it('queues `who` for the next idle tick once somebody unlisted is noticed', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, catchingUp());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    await inTheRealm(socket);

    const seen = untilSent(socket, /\bwho\b/);
    socket.write('Vaelor just entered the Realm.\r\n');
    expect(await seen).toMatch(/\bwho\b/);
  });

  it('does the same for somebody unlisted walking into the room', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, catchingUp());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    await inTheRealm(socket);

    const seen = untilSent(socket, /\bwho\b/);
    socket.write('Vaelor walks into the room from the north.\r\n');
    expect(await seen).toMatch(/\bwho\b/);
  });

  it('does not ask a second time inside the debounce window', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, catchingUp());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    await inTheRealm(socket);

    /*
     * One collector for the whole exchange, unlike the two tests above:
     * `untilSent` attaches its own listener and sees only what arrives after
     * it, so counting across two waits needs a single running record.
     */
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const wire = (): string => Buffer.concat(chunks).toString('latin1');
    const settle = async (pattern: RegExp, timeoutMs = 4000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (pattern.test(wire()) || Date.now() > deadline) return wire();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    socket.write('Vaelor just entered the Realm.\r\n');
    expect(await settle(/\bwho\b/)).toMatch(/\bwho\b/);

    /*
     * The listing that answers it. A batch completes on the status line that
     * follows it, same as a real `who` reply, so the row alone would never
     * close the batch and `onWhoListing` would never fire.
     */
    socket.write('             Current Adventurers\r\n');
    socket.write('             ===================\r\n');
    socket.write('             Vaelor                -  Apprentice\r\n');
    socket.write('[HP=10]:\r\n');
    await until(() => manager!.character.online.some((entry) => entry.name === 'Vaelor'));

    // A second arrival, seconds later. Real news, and still not worth a second
    // command: the debounce is a minute and the listing just stamped it.
    socket.write('Soul just entered the Realm.\r\n');

    /*
     * Two keep-alives, which is the proof the idle tick fired at all — the
     * catch-up drains on that tick too, so a run where no tick happened would
     * satisfy "no second `who`" without testing anything.
     */
    const seen = await settle(/(^|\n)l\r\n[\s\S]*\nl\r\n/);
    expect(seen).toMatch(/l\r\n/);
    expect(seen.match(/\bwho\b/g) ?? []).toHaveLength(1);
  });
});

describe('a quiet command asked from a card', () => {
  /*
   * The smoke run's sequence, at the process boundary the harness reads: the
   * entry probes go out and only `rm` is answered; the player pastes half a
   * line and then types a `look` the host never answers; seconds pass; the
   * Room card asks `rm`. The answer must reach the line record — that is the
   * positive control — and never the console. Written while the harness's
   * version of this check was failing on a clean tree and this replica was
   * not, so that whichever half moves next is caught by name.
   */
  it('reaches the record and never the console, even behind an unanswered look', async () => {
    const painted: string[] = [];
    const { sink, lines } = collect();
    manager = new SessionManager({ ...sink, data: (chunk) => painted.push(chunk.text) });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const received: Buffer[] = [];
    socket.on('data', (chunk) => {
      received.push(chunk);
      // The one command this host answers, the way the realm answers it.
      if (/(^|\n)rm\r?\n/.test(chunk.toString('latin1'))) {
        socket.write(
          Buffer.from(
            'rm\r\nLocation: 1,2140\r\n\r\n\x1b[1;32m[HP=98/MA=50]:\x1b[0m' + PROMPT_REPAINT,
            'latin1'
          )
        );
      }
    });
    socket.write(
      '\x1b[1;36mNewhaven, Village Entrance\x1b[0m\r\n' +
        '\x1b[0;32mObvious exits: \x1b[1;33mnorth\x1b[0m\r\n' +
        '\x1b[1;32m[HP=100/MA=50]:\x1b[0m' +
        PROMPT_REPAINT
    );
    await until(() => manager!.character.phase === 'in-game');
    const sentRm = (): number =>
      (
        Buffer.concat(received)
          .toString('latin1')
          .match(/rm\r\n/g) ?? []
      ).length;
    await until(() => sentRm() === 1);
    // Acknowledge the other probes, then end on an unterminated prompt and GA.
    socket.write(
      ('\x1b[1;32m[HP=98/MA=50]:\x1b[0m\r\n'.repeat(5) +
        '\x1b[1;32m[HP=98/MA=50]:\x1b[0m ') as string
    );
    socket.write(Buffer.from([0xff, 0xf9]));
    await until(() => lines.some((line) => line.plain === 'Location: 1,2140'));
    expect(painted.join('')).not.toContain('Location: 1,2140');

    manager.send('smoke-paste-123');
    manager.send('look\r');
    await until(() => Buffer.concat(received).toString('latin1').includes('look\r\n'));
    // Longer than the feed writes an unacknowledged command off after.
    await new Promise((resolve) => setTimeout(resolve, ABANDON_MS + 200));

    expect(manager.ask('rm')).toBe(true);
    await until(() => sentRm() === 2, 6000);
    await until(() => lines.filter((line) => line.plain === 'Location: 1,2140').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const fed = painted.join('');
    expect(fed).not.toContain('Location: 1,2140');
    expect(fed).not.toMatch(/(?:\n|\[K)rm\r\n/);
    expect(fed).toContain('Obvious exits: ');
  }, 15000);
});

describe('asking another player from the palette', () => {
  it('telepaths the question at them, once in the realm, and refuses at a menu', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));

    // Not in the realm yet: a telepath typed at a menu is a menu answer.
    expect(manager.askRemote('Soul', 'health')).toBe(false);

    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    expect(manager.askRemote('Soul', 'health')).toBe(true);
    await until(() => Buffer.concat(received).toString('latin1').includes('/Soul @health\r\n'));
  });

  /* The arbiter's answer, not the session's: a repeat of a question still
     waiting is coalesced into it, and the palette is told nothing went out. */
  it('reports a repeat of a question still waiting as not sent', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    // Hold the queue the way a half-typed line does, so the first ask waits.
    manager.send('l');
    expect(manager.askRemote('Soul', 'health')).toBe(true);
    expect(manager.askRemote('Soul', 'health')).toBe(false);
  });
});

/**
 * The three-room world the retreat and death tests place a character in: the
 * lair at 1/3, the road at 1/2 and the haven at 1/1, in a line.
 */
function haven(): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-haven-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const rooms = [
    { m: 1, r: 1, n: 'Haven Hall', x: { n: { m: 1, r: 2 } } },
    { m: 1, r: 2, n: 'Middle Road', x: { s: { m: 1, r: 1 }, n: { m: 1, r: 3 } } },
    { m: 1, r: 3, n: 'Rat Lair', x: { s: { m: 1, r: 2 } } }
  ];
  fs.writeFileSync(
    file,
    zlib.gzipSync(
      [
        JSON.stringify({ v: 1, source: 'test', rooms: 3, generatedAt: 'x' }),
        ...rooms.map((r) => JSON.stringify(r))
      ].join('\n') + '\n'
    )
  );
  const world = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return world;
}

/*
 * Which way out, and how the client knew it.
 *
 * Four rungs, and each is strictly better than the one under it, which is why
 * none of them is a setting: retrace the trail, then an exit that doubles back
 * onto it, then an exit the realm can place, then an exit the room printed.
 * `SessionManager.wayOut` has the argument; these are the rungs.
 *
 * The suite exists because the thing it replaced could not be tested: the old
 * `flee` strategy sent a word, and a word reaching the socket looks identical
 * whether the server has that command or not.
 */
describe('which way out', () => {
  const escaping = (over: Partial<RetreatConfig> = {}): AutomationConfig => ({
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: [],
    safety: {
      ...DEFAULT_CONFIG.automation.safety,
      retreat: {
        ...DEFAULT_CONFIG.automation.safety.retreat,
        enabled: true,
        belowHealth: 0.3,
        cooldownMs: 3000,
        ...over
      } as RetreatConfig
    }
  });
  const wire = (socket: net.Socket): (() => string) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    return () => Buffer.concat(chunks).toString('latin1');
  };

  /**
   * The strongest rung, and the one the whole change is for.
   *
   * The character walks north into the lair and is then attacked. The escape
   * has to send `s` — the reverse of the move it is *known* to have made,
   * which is the only exit here that names a room this character was standing
   * in, alive, a moment ago.
   *
   * Measured against the failure it fixes
   * (`logs/2026-09-02_21-04-28_festus.mudcap.jsonl` t=418517): a loop sent `n`,
   * combat re-opened 2ms later and stopped the walk, and the room arrived
   * 1,244ms after that. The walker never confirmed that step, so the history it
   * kept still pointed at the room behind — and the escape said *no confirmed
   * step to retrace* while standing in a room it had walked into itself. The
   * trail is the tracker's now and records the move whoever sent it, so this
   * case is answered whether a walker was involved or not: nothing here starts
   * a walk.
   */
  it('retraces the move the character is known to have made', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, haven(), escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = wire(socket);
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('Location:            1,2\r\nMiddle Road\r\nObvious exits: north, south\r\n');
    await until(() => manager!.character.room.number === 2);

    // The player types it. Nothing about the trail is the walker's.
    manager.send('n\r\n');
    socket.write('Rat Lair\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);

    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => /Retreating s, the way we came/.test(notice)));
    await until(() => /\bs\r\n/.test(seen()));
  });

  /*
   * The rung under it, and the reason it exists: a retreat that has already run
   * once is standing where the *escape* put it, not where the last recorded
   * move ended, so the newest step no longer answers. The room before it still
   * does, through the realm data.
   */
  it('doubles back onto the trail when the newest step no longer ends here', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, haven(), escaping({ cooldownMs: 1000 }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Health: 100/100 [100%]\r\n');
    // Walked home to lair: 1/1 → 1/2 → 1/3, both moves confirmed.
    socket.write('Location:            1,1\r\nHaven Hall\r\nObvious exits: north\r\n');
    await until(() => manager!.character.room.number === 1);
    manager.send('n\r\n');
    socket.write('Middle Road\r\nObvious exits: north, south\r\n');
    await until(() => manager!.character.room.number === 2);
    manager.send('n\r\n');
    socket.write('Rat Lair\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);

    /*
     * And now the character is somewhere the trail never recorded arriving at
     * — dragged, teleported, or moved by a step the client did not see land.
     * `wayBackFrom` goes quiet; the middle road is still behind us, and `s`
     * still reaches it.
     */
    socket.write('Location:            1,2\r\nMiddle Road\r\nObvious exits: north, south\r\n');
    await until(() => manager!.character.room.number === 2);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() =>
      notices.some((notice) => /It doubles back onto the way we came/.test(notice))
    );
  });

  /* Nothing behind us at all, but the realm knows where the room's exit goes. */
  it('takes an exit the realm can place when there is no trail', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, haven(), escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = wire(socket);
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('Location:            1,3\r\nRat Lair\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() =>
      notices.some((notice) => /The realm knows where that exit goes/.test(notice))
    );
    await until(() => /\bs\r\n/.test(seen()));
  });

  /*
   * The bottom rung, and it is still an exit: the server printed it. This is
   * the case the old `flee` strategy claimed to cover by asking the realm to
   * choose — except the realm was never asked, because the word was not a
   * command.
   */
  it('takes an exit the room printed when nothing is placed', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = wire(socket);
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('Rat Cellar\r\nObvious exits: east\r\n');
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => /It is the exit the room listed/.test(notice)));
    await until(() => /\be\r\n/.test(seen()));
  });

  /*
   * A three-room world the character can be placed in: the lair at 1/3, the
   * road at 1/2 and the haven at 1/1, in a line. The escape steps south onto
   * the road; the haven walk then plans the one step home.
   */
  it('safe-haven steps out, then walks home once the fight is over', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(
      sink,
      haven(),
      escaping({ strategy: 'safe-haven', safeHavenRoom: 'Haven Hall 1/1' })
    );
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = wire(socket);
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('Location:            1,3\r\nRat Lair\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');
    await until(() => /\bs\r\n/.test(seen()));

    /*
     * The fight ends before the new room prints, which is the order the server
     * has: a walk home planned at `*Combat Off*` would be a route from the lair
     * the character has just left. It waits for the room to change, then plans
     * the one step home from the road.
     */
    socket.write('*Combat Off*\r\n');
    await until(() => !manager!.character.inCombat);
    expect(notices.some((notice) => /Retreating to Haven Hall/.test(notice))).toBe(false);
    /*
     * The room that answers the step out, resolved the way the client resolves
     * one: by dead reckoning from the lair through the move it just made. No
     * `Location:` line in front of it — the server prints those in a `pro`
     * listing, not ahead of every room, and one here would place the character
     * before the block and leave the reckoning starting from where it landed.
     */
    socket.write('Middle Road\r\nObvious exits: north, south\r\n');
    await until(() => notices.some((notice) => /Retreating to Haven Hall/.test(notice)));
    // Two souths: the one that got out, and the one that walks home.
    await until(() => /\bs\r\n[\s\S]*\bs\r\n/.test(seen()));
    expect(notices.find((notice) => /Retreating to Haven Hall/.test(notice))).toMatch(/: 1 step/);
  });

  /**
   * The escape must not retrace its own escape.
   *
   * `CharacterTracker.trail` records every confirmed move whoever sent it —
   * which is the whole point of it, and includes the escape's own. So one
   * cooldown after running `s` out of a lair, the newest step on the trail *is*
   * that escape, its reverse is `n`, and the client walks back through the door
   * it just came out of. Out, in, out, in, at cooldown speed, with no
   * `escapeSettleMs` hold to stop it and a 100%-follower monster to guarantee
   * the fight is still there.
   *
   * Two escapes, which is what no other test here runs.
   */
  it('never runs back into a room it has just run out of', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, haven(), escaping({ cooldownMs: 1 }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = wire(socket);
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('Location:            1,3\r\nRat Lair\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    // Out of the lair, southward, and the room that answers it.
    await until(() => /\bs\r\n/.test(seen()));
    socket.write('Middle Road\r\nObvious exits: north, south\r\n');
    await until(() => manager!.character.room.number === 2);

    /*
     * Still in the fight — the server's own flag outlives an escape by a
     * measured median of 3,493ms — and still hurt, so the escape fires again.
     * `n` is the reverse of the move that got out and it is the one direction
     * that must not be sent; `s` to the haven is the answer.
     */
    socket.write('[HP=9]:\r\n');
    await until(() => /\bs\r\n[\s\S]*\bs\r\n/.test(seen()));
    expect(seen()).not.toMatch(/\bn\r\n/);
    expect(notices.filter((notice) => /Running |Retreating \w+,/.test(notice))).toHaveLength(2);
  });

  /**
   * A refused escape is a refusal, not an escape in flight.
   *
   * Everything that could keep a character alive is gated on *is an escape
   * running* — auto-combat, retaliation, the heal, the potion, the cures, the
   * blessings and `mayRest`. Arming that window when nothing was sent would
   * switch all of them off and print *Standing and fighting* while doing it,
   * which is the notice saying the opposite of what the code does.
   */
  it('lets the character rest when it decided it could not run', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, {
      ...escaping(),
      health: { ...DEFAULT_CONFIG.automation.health, restBelow: 0.5, restTo: 0.9 }
    });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = wire(socket);
    // A room that named no exit at all, so there is nothing to send.
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');

    await until(() => notices.some((notice) => /Not running:/.test(notice)));
    await until(() => /\brest\r\n/.test(seen()));
  });

  /* A haven the realm cannot place is refused out loud, and nothing is walked. */
  it('safe-haven refuses a room it cannot place, and says so', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(
      sink,
      haven(),
      escaping({ strategy: 'safe-haven', safeHavenRoom: 'Nowhere Hall 9/9' })
    );
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const seen = wire(socket);
    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('Location:            1,3\r\nRat Lair\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');
    await until(() => /\bs\r\n/.test(seen()));
    socket.write('*Combat Off*\r\n');
    socket.write('Middle Road\r\nObvious exits: north, south\r\n');
    await until(() => notices.some((notice) => /Could not retreat to Nowhere Hall/.test(notice)));
    // The one step out went; no second step followed it.
    expect(seen().replace(/s\r\n/, '')).not.toMatch(/\b[nsew]\r\n/);
  });
});

/*
 * An escape *holds* the lap, and then the character is finally allowed to sit
 * down.
 *
 * Diagnosed from the user's own capture
 * (`logs/2026-09-02_09-58-25_festus.mudcap.jsonl`). The escape sent `e` out of
 * a room with a cave worm in it; two seconds after `*Combat Off*` the loop
 * planned its next leg and sent `w` — straight back in. Three round trips, 51
 * HP down to 15, and what ended it was the player typing a direction by hand.
 *
 * And the resting is the other half of the same fault. `mayRest` refuses while
 * a loop is *marching*, so the two seconds between the fight ending and the
 * loop walking off again were the whole window the character had to sit down
 * in — and it spent every one of them under the resting floor, marching.
 *
 * That was first answered by *stopping* the loop, which fixed the corridor and
 * broke the lap: observed on festus the same day, the escape and the rest were
 * both right and then the character simply stood in the corridor for good. A
 * lap ends when the player stops it, when the character dies, or when its
 * stops fail wholesale — never because automation worked. So it is a hold, and
 * a hold that lets go when the reason for it is over.
 */
describe('the lap after an escape', () => {
  const escaping = (): AutomationConfig => ({
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: [],
    health: {
      ...DEFAULT_CONFIG.automation.health,
      // The floor the character is under for the whole of this test, and the
      // ceiling that keeps it sitting until it is well again.
      restBelow: 0.7,
      restTo: 0.75
    },
    safety: {
      ...DEFAULT_CONFIG.automation.safety,
      retreat: {
        ...DEFAULT_CONFIG.automation.safety.retreat,
        enabled: true,
        belowHealth: 0.5,
        // The window an escape has to work in. Short, because what is being
        // asserted after it is the *rest*, which waits for the escape to be
        // over.
        cooldownMs: 1,
        strategy: 'step-back'
      }
    }
  });

  /** Into the realm, placed, with a maximum known and a one-stop loop running. */
  async function looping(socket: net.Socket): Promise<void> {
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    // The maximum, so a fraction exists at all — an unknown one runs from
    // nothing and rests nothing.
    socket.write('Health: 100/100 [100%]\r\n');
    await until(() => manager!.character.vitals.hpMax === 100);
    /*
     * And a room with exits in it, because the escape sends a **direction** and
     * a direction has to come from somewhere. The room block first and the
     * coordinates after: `user-profile` merges into the room on record, so the
     * exits survive it, where a room block arriving second on a session with no
     * realm would take the placement away again.
     */
    socket.write('Home\r\nObvious exits: north, south\r\n');
    socket.write('Location: 1,2140\r\n[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.room.number === 2140);
    expect(
      manager!.loops.start({ name: 'lap', stops: [{ room: 'Home 1/2140' }] }, manager!.character)
    ).toBeNull();
    expect(manager!.loops.progress.status).toBe('running');
  }

  it('holds the loop, whichever way out was taken, and never ends it', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    await looping(socket);

    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=40/MA=50]:' + PROMPT_REPAINT);
    // The move goes out mid-fight, so `fight` is the hold the card shows
    // first; `retreated` is what is left of it once the fight is over.
    await until(() => manager!.loops.progress.hold === 'fight');
    socket.write('*Combat Off*\r\n[HP=40/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.loops.progress.hold === 'retreated');
    // Still the same lap, on the same stop: running away is not one of the
    // three things that end one.
    expect(manager.loops.progress).toMatchObject({ status: 'running', name: 'lap', stop: 1 });
  });

  /*
   * And the point of holding it: `mayRest` refuses while a loop is running
   * without a hold, so until the loop holds the character cannot sit down
   * however far under `restBelow` it is.
   */
  it('and then rests, which a marching loop had been forbidding', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, escaping());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const seen = (): string => Buffer.concat(chunks).toString('latin1');
    await looping(socket);

    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=40/MA=50]:' + PROMPT_REPAINT);
    await until(() => /\bn\r\n/.test(seen()));

    // The fight ends, and 40 of 100 is under the resting floor.
    socket.write('*Combat Off*\r\n[HP=40/MA=50]:' + PROMPT_REPAINT);
    await until(() => /\brest\b/.test(seen()));
  });
});

/*
 * A death is a teleport, and the realm chooses the destination.
 *
 * Everything that was on its way somewhere was planned from a room the
 * character is no longer in, several maps away — so carrying on with any of it
 * walks a one-life-lighter character back towards whatever killed it. Nothing
 * here is a setting: the loop is stopped, not unconfigured.
 */
describe('a death stops everything that was going somewhere', () => {
  /*
   * Without this the loop does not merely continue — it books the walk the
   * death ended as a *failed leg*, skips the stop it could not reach, and
   * plans the next one out of the temple, with nothing on screen saying a
   * death was what happened.
   */
  it('stops a running loop, and says the death was why', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, {
      ...DEFAULT_CONFIG.automation,
      enabled: true
    });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    // The one exact statement of position this server makes, so a stop can be
    // held without realm data.
    socket.write('Location: 1,2140\r\n[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.room.number === 2140);
    expect(
      manager.loops.start({ name: 'lap', stops: [{ room: 'Home 1/2140' }] }, manager.character)
    ).toBeNull();
    expect(manager.loops.progress.status).toBe('running');

    socket.write('You have been killed!\r\n');
    await until(() => manager!.loops.progress.status === 'stopped');
    expect(manager.loops.progress.reason).toMatch(/killed/i);
  });

  /*
   * A pause keeps the loop's place and `resume` plans afresh from wherever the
   * character is — which after this is a temple nobody chose. So a paused loop
   * is stopped too, rather than left as something a follower's `@ok` or a
   * click could walk away from the temple.
   */
  it('stops a paused loop as well as a running one', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, {
      ...DEFAULT_CONFIG.automation,
      enabled: true
    });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    socket.write('Location: 1,2140\r\n[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.room.number === 2140);
    manager.loops.start({ name: 'lap', stops: [{ room: 'Home 1/2140' }] }, manager.character);
    manager.loops.pause();
    expect(manager.loops.progress.status).toBe('paused');

    socket.write('You have been killed!\r\n');
    await until(() => manager!.loops.progress.status === 'stopped');
  });

  /*
   * A `safe-haven` retreat is armed by the escape and spent when the fight ends
   * — and a death *is* the fight ending. Without this the first status line
   * after the temple plans a route to a haven chosen for a fight that is over,
   * which is the client walking a dead character's replacement out of the one
   * room it is safe in.
   */
  it('drops an armed safe-haven retreat, out loud', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, haven(), {
      ...DEFAULT_CONFIG.automation,
      enabled: true,
      idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
      onEnterRealm: [],
      rules: [],
      safety: {
        ...DEFAULT_CONFIG.automation.safety,
        retreat: {
          ...DEFAULT_CONFIG.automation.safety.retreat,
          enabled: true,
          belowHealth: 0.3,
          cooldownMs: 3000,
          strategy: 'safe-haven',
          safeHavenRoom: 'Haven Hall 1/1'
        }
      }
    });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const seen = (): string => Buffer.concat(chunks).toString('latin1');

    socket.write('Health: 100/100 [100%]\r\n');
    socket.write('Location:            1,3\r\nRat Lair\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.character.inCombat);
    socket.write('[HP=10]:\r\n');
    // The step out goes, which is what arms the retreat: the assertion below is
    // about a retreat that genuinely existed to be dropped.
    await until(() => /\bs\r\n/.test(seen()));

    socket.write('You have been killed!\r\n');
    await until(() => notices.some((notice) => /Not retreating to Haven Hall/.test(notice)));

    /*
     * And the room the realm moved the character into resolves without the
     * retreat waking up. Asserted after the refusal has been *observed*, so
     * this is the absence of a decision rather than the absence of a chance to
     * make one.
     */
    socket.write('Location:            1,2\r\nMiddle Road\r\nObvious exits: north, south\r\n');
    await until(() => manager!.character.room.number === 2);
    expect(notices.some((notice) => /Retreating to Haven Hall/.test(notice))).toBe(false);
    // The one step out went; nothing followed it.
    expect(seen().replace(/s\r\n/, '')).not.toMatch(/\b[nsew]\r\n/);
  });
});

/*
 * Two characters on one realm, in one client. What one sees somebody wearing
 * is what the other's flyout shows — live, with no restart and no second look.
 */
/*
 * The walk's own nudge, end to end through the real arbiter.
 *
 * `Walker` answers a step that has gone unanswered for a second with a bare
 * Enter, and the server then answers the step and the nudge together — two
 * identical room blocks in one packet. The client read the second as the
 * arrival of the step it had just sent off the first, so it ran a room ahead
 * of the character for the rest of the lap (`2026-09-02_18-07-07_festus`,
 * t=4862445: `e` twice inside three milliseconds, then a fight opened out of a
 * room the character was already leaving).
 *
 * **This test exists because the unit tests could not see it.** An empty line
 * is deliberately not a command, so `SessionManager` skips all three observers
 * for one — which meant the expectation the fix adds was never filed by
 * anything the client actually does, and a harness of its own that called the
 * tracker directly passed anyway. That is `CLAUDE.md`'s "do not let a test
 * harness do something the client should be doing", and the only cure is
 * driving the real session.
 */
describe('the walk’s own nudge, in a corridor of namesakes', () => {
  /* Four rooms of one name, each printing exits the next also has — the sewer,
     where nothing in a room block can say whether it is a reprint. */
  const corridor = (): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-nudge-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const rooms = [
      { m: 1, r: 1, n: 'Sewer Tunnel', x: { n: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'Sewer Tunnel', x: { n: { m: 1, r: 3 }, s: { m: 1, r: 1 } } },
      { m: 1, r: 3, n: 'Sewer Tunnel', x: { n: { m: 1, r: 4 }, s: { m: 1, r: 2 } } },
      { m: 1, r: 4, n: 'Sewer Tunnel', x: { s: { m: 1, r: 3 } } }
    ];
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        [
          JSON.stringify({ v: 1, source: 'test', rooms: 4, generatedAt: 'x' }),
          ...rooms.map((room) => JSON.stringify(room))
        ].join('\n') + '\n'
      )
    );
    const world = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return world;
  };

  /*
   * The three silences are **load-bearing, not tidiness**: the control below
   * asserts the exact bytes that followed the step, and the idle keep-alive,
   * the entry probe and the rules all send through the same arbiter. Turning
   * one on to test something adjacent will read as a nudge regression.
   */
  const quiet: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: []
  };

  const MIDDLE = 'Sewer Tunnel\r\nObvious exits: north, south\r\n';

  it('does not let the reprint it asked for answer the step behind it', async () => {
    const world = corridor();
    const { sink } = collect();
    manager = new SessionManager(sink, world, quiet);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const wire = (): string => Buffer.concat(chunks).toString('latin1');

    socket.write('[HP=34]:' + PROMPT_REPAINT);
    socket.write('Location:            1,4\r\nSewer Tunnel\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 4);

    const route = world.route('1/4', '1/1');
    expect(route.steps).toHaveLength(3);
    expect(manager!.walker.start(route, manager!.character)).toBeNull();

    // The first step goes out and the server says nothing, so the walk nudges.
    await until(() => wire().includes('s\r\n'));
    const afterStep = wire().length;
    await until(() => wire().length > afterStep, 4000);
    // The positive control: the bare Enter really did reach the wire, so what
    // follows is a test of how its answer is read rather than of a nudge that
    // never fired.
    expect(wire().slice(afterStep)).toBe('\r\n');

    // And the server answers both at once: the arrival, then the reprint.
    socket.write(MIDDLE);
    await until(() => manager!.character.room.number === 3);
    // Which confirms the step, so the walk sends the next one.
    await until(() => wire().split('s\r\n').length === 3);

    /*
     * The nudge's reprint, identical to the block before it — and a changed
     * status line behind it, because the whole claim here is that the reprint
     * changes *nothing*. The server writes in order, so waiting for the health
     * to move is what proves the reprint was read before the assertion; a
     * fixed sleep would pass just as well against a client that never framed
     * either.
     */
    socket.write(MIDDLE);
    socket.write('[HP=33]:' + PROMPT_REPAINT);
    await until(() => manager!.character.vitals.hp === 33);

    /*
     * Standing where the arrival put it. Before this, the reprint answered the
     * step and the client moved itself to 1/2 with nothing on the wire having
     * said so — and every command it sent from then on was aimed a room ahead
     * of the character.
     */
    expect(manager!.character.room.number).toBe(3);
    expect(manager!.walker.progress.status).toBe('walking');
    /*
     * And the half the room number alone does not cover: the walk did not
     * *confirm* a second arrival, so it did not send a third step. That is the
     * reported symptom in its own terms — `e` twice inside three milliseconds
     * — and asserting it here also rules out the client having reached 1/3 by
     * some route other than the one under test.
     */
    expect(wire().split('s\r\n')).toHaveLength(3);
  });

  /*
   * The same interleaving, with the player's own Enter instead of the walker's
   * nudge — and it is the *likelier* one, because somebody watching a walk
   * stall for a second is exactly the person who presses Return. Two call
   * sites file the re-read (`SessionManager`'s arbiter and its committed-line
   * path) and deleting either must fail something; before this test, deleting
   * the player's half broke nothing in 1,520 tests.
   */
  it('files the player’s own bare Enter the same way', async () => {
    const world = corridor();
    const { sink } = collect();
    manager = new SessionManager(sink, world, quiet);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const wire = (): string => Buffer.concat(chunks).toString('latin1');

    socket.write('[HP=34]:' + PROMPT_REPAINT);
    socket.write('Location:            1,4\r\nSewer Tunnel\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 4);

    const route = world.route('1/4', '1/1');
    expect(manager!.walker.start(route, manager!.character)).toBeNull();
    await until(() => wire().includes('s\r\n'));

    // The player presses Return while the step is still out.
    manager!.send('\r');
    await until(() => wire().includes('s\r\n\r\n'));

    // The step's arrival, which confirms it and releases the next step — waited
    // for, because a reprint that lands before the walk has sent that step
    // finds an empty queue and cannot answer anything, which is a test that
    // passes whatever the client does.
    socket.write(MIDDLE);
    await until(() => manager!.character.room.number === 3);
    await until(() => wire().split('s\r\n').length === 3);

    // And then the answer to the Enter.
    socket.write(MIDDLE);
    socket.write('[HP=33]:' + PROMPT_REPAINT);
    await until(() => manager!.character.vitals.hp === 33);

    expect(manager!.character.room.number).toBe(3);
  });
});

/*
 * Typing is not taking the wheel.
 *
 * A walk and a loop stand down when the *player* moves the character — two
 * drivers with one wheel — and for as long as that fired on any committed
 * command, checking a stat sheet mid-lap ended the lap. Captured from the
 * user's own console, 2026-08-31: `st` during a fight, and
 * `Loop stopped: Manually stopped`.
 */
describe('typing while a route is being walked', () => {
  /** Three rooms in a line: 1/3 north end, 1/2 middle, 1/1 south end. */
  const line = (): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-typing-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const rooms = [
      { m: 1, r: 1, n: 'South End', x: { n: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'Middle Road', x: { s: { m: 1, r: 1 }, n: { m: 1, r: 3 } } },
      { m: 1, r: 3, n: 'North End', x: { s: { m: 1, r: 2 } } }
    ];
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        [
          JSON.stringify({ v: 1, source: 'test', rooms: 3, generatedAt: 'x' }),
          ...rooms.map((room) => JSON.stringify(room))
        ].join('\n') + '\n'
      )
    );
    const world = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return world;
  };

  const quiet: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: []
  };

  /** In the realm at the north end, with a reader for what reached the wire. */
  async function atTheNorthEnd(): Promise<{
    socket: net.Socket;
    world: WorldGraph;
    wire: () => string;
  }> {
    const world = line();
    const { sink } = collect();
    manager = new SessionManager(sink, world, quiet);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.write('[HP=34]:' + PROMPT_REPAINT);
    socket.write('Location:            1,3\r\nNorth End\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 3);
    return { socket, world, wire: () => Buffer.concat(chunks).toString('latin1') };
  }

  /** ...and walking the two steps south from it. */
  function walkSouth(world: WorldGraph): void {
    const route = world.route('1/3', '1/1');
    expect(route.steps).toHaveLength(2);
    expect(manager!.walker.start(route, manager!.character)).toBeNull();
    expect(manager!.walker.progress.status).toBe('walking');
  }

  it('keeps walking when the player types something that is not a move', async () => {
    const { world, wire } = await atTheNorthEnd();
    walkSouth(world);
    manager!.send('st\r');
    /*
     * The command really was committed and really did reach the wire — the
     * positive control, without which a walk that is still walking could be
     * one this test never reached.
     */
    await until(() => wire().includes('st\r\n'));
    expect(manager!.walker.progress.status).toBe('walking');
  });

  /* The one case that does stand it down: the move landed. */
  it('stops when the player’s own direction lands them somewhere else', async () => {
    const { socket, world } = await atTheNorthEnd();
    walkSouth(world);
    manager!.send('s\r');
    socket.write('Location:            1,2\r\nMiddle Road\r\nObvious exits: south, north\r\n');
    await until(() => manager!.walker.progress.status !== 'walking');
    expect(manager!.walker.progress.reason).toBe(t('automation.walk.reasonPlayerTookOver'));
  });

  /*
   * The end-to-end of `Walker.holdForFight` and the `replan` this session
   * answers it with. The unit tests prove the walker holds and asks; this is
   * the one that proves somebody is listening — a route that asks for a plan
   * nothing answers stops as off-path, which is the old behaviour wearing a
   * new reason.
   *
   * The reported shape exactly (`logs/2026-09-02_16-54-23_festus.mudcap.jsonl`
   * scaled to three rooms): walking, a monster, a fight, and then a client
   * that sent nothing at all until a person pressed Enter.
   */
  it('waits a fight out and then walks on, from wherever the fight left it', async () => {
    const { socket, world } = await atTheNorthEnd();
    walkSouth(world);
    await until(() => manager!.walker.progress.status === 'walking');

    // Something wandered in and opened on the character mid-step.
    socket.write('*Combat Engaged*\r\n');
    await until(() => manager!.walker.progress.hold === 'fight');
    // Held, not ended: the destination and the journey both survive it.
    expect(manager!.walker.progress.status).toBe('walking');
    expect(manager!.walker.progress.destination).toBe('South End');

    /*
     * The step the fight interrupted landed after all, so the fight is being
     * fought a room further on than the route was drawn from. Written as the
     * server writes an arrival — no `Location:` line, which is the `rm` answer
     * and not what a move produces — because the arriving room is also what
     * answers the move this walk has outstanding, and the resume deliberately
     * refuses to plan while one is.
     */
    socket.write('Middle Road\r\nObvious exits: south, north\r\n');
    await until(() => manager!.character.room.number === 2);
    expect(manager!.walker.progress.hold).toBe('fight');

    socket.write('*Combat Off*\r\n');
    socket.write('[HP=34]:' + PROMPT_REPAINT);

    // Planned again from 1/2 rather than resumed from 1/3, and walking.
    await until(() => manager!.walker.progress.hold === null);
    expect(manager!.walker.progress.status).toBe('walking');
    expect(manager!.walker.progress.total).toBe(1);
    expect(manager!.walker.progress.destination).toBe('South End');
  });

  /*
   * A direction the realm refuses moves nobody, so it must not be left armed
   * to be answered by somebody else's arrival. Without the disarm the walk
   * below — started afterwards, and confirming its own first step — stopped
   * blaming a player who had walked into a wall a moment earlier.
   */
  it('does not blame the player for a walk step after their direction hit a wall', async () => {
    const { socket, world } = await atTheNorthEnd();
    manager!.send('e\r');
    socket.write('There is no exit in that direction!\r\n');
    socket.write('[HP=33]:' + PROMPT_REPAINT);
    await settled(33);

    walkSouth(world);
    socket.write('Location:            1,2\r\nMiddle Road\r\nObvious exits: south, north\r\n');
    // The first of two steps confirmed, and the walk carries on to the second.
    await until(() => manager!.walker.progress.done === 1);
    expect(manager!.walker.progress.status).toBe('walking');
  });
});

/*
 * Walking out to the character menu is a character *leaving*, and what comes
 * back through that menu may be somebody else — a reroll, or another
 * character on the same account. Found the expensive way (2026-08-31): a
 * character was rerolled and renamed, walked back in, and every card went on
 * naming the one before it, because nothing was forgotten and the realm-entry
 * probe had already fired for the connection and would not fire again.
 */
describe('leaving the realm for the menu', () => {
  const probing: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: ['st'],
    rules: []
  };

  async function inAndOut(): Promise<{ socket: net.Socket; wire: () => string }> {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, probing);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const wire = (): string => Buffer.concat(chunks).toString('latin1');

    socket.write('Welcome back, Claude!\r\n');
    socket.write('[HP=34]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    await until(() => wire().includes('st\r\n'));
    expect(manager!.character.name).toBe('Claude');
    return { socket, wire };
  }

  it('forgets the character and asks again on the way back in', async () => {
    const { socket, wire } = await inAndOut();
    const before = wire().split('st\r\n').length - 1;

    // Out to the menu, the way the server actually reports it.
    socket.write('You will exit after a period of silent meditation.\r\n');
    socket.write('[PARADIGM]:');
    await until(() => manager!.character.phase !== 'in-game');
    expect(manager!.character.name).toBeNull();

    // And back in as somebody else. The entry probe fires a second time,
    // which is what puts the new name on the card.
    socket.write('[HP=40]:' + PROMPT_REPAINT);
    await until(() => wire().split('st\r\n').length - 1 > before);
  });

  it('says so, once', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, probing);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('[HP=34]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    socket.write('You will exit after a period of silent meditation.\r\n');
    socket.write('[PARADIGM]:');
    await until(() => notices.some((notice) => notice === t('session.realm.left')));
    expect(notices.filter((notice) => notice === t('session.realm.left'))).toHaveLength(1);
  });
});

describe('what the realm knows about a player, between characters', () => {
  it('shows one character what another saw somebody wearing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-players-'));
    const book = new PlayerBook({ file: path.join(dir, 'players.json'), saveDelayMs: 0 });
    const vaelor = collect();
    const rand = collect();
    const pushed: CharacterState[] = [];
    rand.sink.character = (state) => pushed.push(state);

    manager = new SessionManager(
      vaelor.sink,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      book.forRealm('test:1')
    );
    const other = new SessionManager(
      rand.sink,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      book.forRealm('test:1')
    );
    try {
      await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
      await other.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
      const socket = await client(0);
      socket.write(
        [
          '[ Soul Guardian ](Valor)',
          'He is equipped with:',
          '',
          'silk gloves                    (Hands)',
          '[HP=334/KAI=27]:',
          ''
        ].join('\r\n')
      );

      await until(() => other.character.players['soul']?.equipment != null);
      expect(other.character.players['soul']).toMatchObject({
        equipment: [{ name: 'silk gloves', slot: 'Hands' }],
        gang: 'Valor',
        // The book says what Soul wears, not whether Rand has seen them.
        online: false
      });
      // And the window with Rand's tab was told.
      expect(pushed.at(-1)?.players['soul']?.equipment).toEqual([
        { name: 'silk gloves', slot: 'Hands' }
      ]);

      // Written down, so a restart starts from it.
      book.flush();
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'players.json'), 'utf8')) as {
        realms: Record<string, Record<string, { equipment: unknown }>>;
      };
      expect(written.realms['test-1']?.['soul']?.equipment).toEqual([
        { name: 'silk gloves', slot: 'Hands' }
      ]);
    } finally {
      other.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a follower pacing the loop', () => {
  /** A manager whose remotes answer Soul and Yang the pacing pair. */
  function pacedManager(sink: SessionSink): SessionManager {
    return new SessionManager(sink, undefined, {
      ...DEFAULT_CONFIG.automation,
      enabled: true,
      remotes: {
        enabled: true,
        gangpath: false,
        gang: [],
        // Named rather than left to the shipped party list: this case is about
        // the pacing pair reaching the loop, not about who was granted it.
        party: [],
        players: {
          soul: { allow: ['wait', 'ok'], deny: [] },
          yang: { allow: ['wait', 'ok'], deny: [] }
        }
      }
    });
  }

  /** Into the realm, placed, and running a one-stop loop held where it stands. */
  async function looping(socket: net.Socket): Promise<void> {
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    // The one exact statement of position this server makes, so the loop can
    // hold a stop the character is already standing in without realm data.
    socket.write('Location: 1,2140\r\n[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.room.number === 2140);
    expect(
      manager!.loops.start({ name: 'pace', stops: [{ room: 'Home 1/2140' }] }, manager!.character)
    ).toBeNull();
    expect(manager!.loops.progress.status).toBe('running');
  }

  /*
   * `@wait` used to *stop* the loop — the `@ok` callback read `if (ready)
   * return;` — so one fallen-behind follower ended the lap for good and the
   * leader stood at a stop until somebody noticed. The pair is a pause and a
   * resume now, and the resume waits for the last of several waiting
   * followers, because the loop walks away from whoever is still behind.
   */
  it('pauses on @wait and resumes when the last waiting follower says @ok', async () => {
    const { sink } = collect();
    manager = pacedManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    await looping(socket);

    socket.write('Soul telepaths: @wait\r\n');
    await until(() => manager!.loops.progress.status === 'paused');
    socket.write('Yang telepaths: @wait\r\n');

    // The first @ok is not enough: Yang is still catching up. The pause has
    // been observed, so the absence a moment later is a real decision.
    socket.write('Soul telepaths: @ok\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.loops.progress.status).toBe('paused');

    socket.write('Yang telepaths: @ok\r\n');
    await until(() => manager!.loops.progress.status === 'running');
  });

  /*
   * `@ok` may only resume what `@wait` paused. A pause the player chose from
   * the Loop card is theirs to end, and a follower's `@ok` walking a
   * hand-paused loop away would be somebody else's typing moving this
   * character.
   */
  it('leaves a pause the player chose alone', async () => {
    const { sink, notices } = collect();
    manager = pacedManager(sink);
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    await looping(socket);

    // The player pauses from the card (the IPC handler's own call)...
    manager.loops.pause();
    expect(manager.loops.progress.status).toBe('paused');

    // ...and a follower's @ok is read, reported, and resumes nothing. The
    // follower-ready notice is the positive control: the line demonstrably
    // reached the remotes, and the pause still stood.
    const said = notices.length;
    socket.write('Soul telepaths: @ok\r\n');
    await until(() => notices.length > said);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(manager.loops.progress.status).toBe('paused');
  });
});

/*
 * The reaction to a player opening on this character — MegaMUD's NotifyGang,
 * from the evidence the client already reads: `<Name> moves to attack you!`
 * puts the attacker in `attackers` and starts the five-minute clock, and the
 * pvp block is what acts on the same moment. The roster is what makes Vaelor
 * a player rather than a monster's realm-data name.
 */
describe('a player opening on this character', () => {
  const pvpConfig = (over: Partial<(typeof DEFAULT_CONFIG)['automation']['safety']['pvp']> = {}) =>
    ({
      ...DEFAULT_CONFIG.automation,
      enabled: true,
      idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
      onEnterRealm: [],
      rules: [],
      safety: {
        ...DEFAULT_CONFIG.automation.safety,
        pvp: { notifyGang: false, action: 'none' as const, ...over }
      }
    }) as AutomationConfig;

  async function attacked(socket: net.Socket): Promise<void> {
    socket.write('[HP=62]:\r\n');
    await until(() => manager!.character.phase === 'in-game');
    // A room with a way out of it: the pvp reaction runs the same escape the
    // health floor does, and that escape sends a direction or nothing.
    socket.write('Town Square\r\nObvious exits: west\r\n');
    await until(() => manager!.character.room.exits.length > 0);
    socket.write('Vaelor just entered the Realm.\r\n');
    await until(() => manager!.character.online.some((who) => who.name === 'Vaelor'));
    socket.write('Vaelor moves to attack you!\r\n');
    await until(() => manager!.character.combat.attackers.length > 0);
  }

  it('tells the gang once per attacker, with the health riding along', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, pvpConfig({ notifyGang: true }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));

    await attacked(socket);
    await until(() => Buffer.concat(received).toString('latin1').includes('bg attacked by Vaelor'));
    const wire = Buffer.concat(received).toString('latin1');
    expect(wire).toContain('[HP=62]');
    expect(notices.some((notice) => /Telling the gang/.test(notice))).toBe(true);

    // A blow line per round is one broadcast per window, not one per line.
    socket.write('Vaelor moves to attack you!\r\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sends = Buffer.concat(received)
      .toString('latin1')
      .match(/bg attacked by Vaelor/g);
    expect(sends?.length).toBe(1);
  });

  it('runs when told to, whatever the retreat threshold says', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, pvpConfig({ action: 'retreat' }));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));

    await attacked(socket);
    await until(() => Buffer.concat(received).toString('latin1').includes('w\r\n'));
    expect(notices.some((notice) => /Running w:/.test(notice))).toBe(true);
  });

  it('does nothing at all while both halves are off', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, pvpConfig());
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));

    await attacked(socket);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const wire = Buffer.concat(received).toString('latin1');
    expect(wire).not.toContain('bg ');
    expect(wire).not.toMatch(/\bw\r\n/);
    expect(notices.some((notice) => /Telling the gang|Running \w+:/.test(notice))).toBe(false);
  });
});

/**
 * The clock behind the modules that decide on a number and own none of their
 * own.
 *
 * Everything automated here hangs off a state change, and a state change needs
 * a status line — which a standing, idle character gets only when the server's
 * own regeneration moves a vital, once every thirty seconds. So a decision that
 * became right while the wire said nothing was not taken until the wire spoke,
 * or until the player pressed Enter. Measured 2026-09-02
 * (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`): a heal came off its
 * six-second cooldown at 97.6s and went out at 120.5s, on the player's own
 * keystroke — twenty-three seconds of *should have cast, did not*.
 *
 * A settings change is the same shape and the fastest way to state it: the
 * threshold that arrives is new, the character it applies to has not moved, and
 * nothing is coming from the server to notice it on.
 */
describe('re-deciding with nothing new from the wire', () => {
  const health = (restBelow: number): AutomationConfig => ({
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: [],
    health: { ...DEFAULT_CONFIG.automation.health, restBelow }
  });

  /** In the realm, hurt, with the rest threshold off and a reader for the wire. */
  async function hurtAndStanding(): Promise<{ wire: () => string }> {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, health(0));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.write('Health: 80/80 [100%]\r\n');
    await until(() => manager!.character.vitals.hpMax === 80);
    socket.write('[HP=30]:' + PROMPT_REPAINT);
    // The trigger really was read: the figure and its maximum both reached the
    // tracker, so what follows is a decision rather than a line nobody saw.
    await until(
      () => manager!.character.vitals.hp === 30 && manager!.character.vitals.hpMax === 80
    );
    return { wire: () => Buffer.concat(chunks).toString('latin1') };
  }

  it('acts on a threshold that arrives while the server is silent', async () => {
    const { wire } = await hurtAndStanding();
    expect(wire()).not.toContain('rest\r\n');
    // No further server output from here: the only thing that changed is the
    // setting, and the tick is the only thing that can notice it.
    manager!.configure(health(0.5), DEFAULT_CONFIG.connection.login);
    await until(() => wire().includes('rest\r\n'));
  });

  /*
   * And not before the character is in the realm, where there is nothing to
   * decide about.
   *
   * The positive control is the phase reaching `authenticating`: `unknown` is
   * what a freshly connected session already is, so waiting for "not in-game"
   * would have passed just as well on a menu prompt the client never framed —
   * and the assertion below is an absence, which is exactly the shape that
   * needs the trigger to have been *observed*.
   *
   * Nothing feeds it a health figure first, deliberately: walking out to a menu
   * is a character *leaving*, so `noteRealmPhase` clears the vitals on the way
   * past and there is no number left for a threshold to act on either way. What
   * this states is that the tick does not run at a menu at all.
   */
  it('decides nothing at a login menu', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, health(0.5));
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.write('Please select a character: ');
    await until(() => manager!.character.phase === 'authenticating');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(Buffer.concat(chunks).toString('latin1')).not.toContain('rest\r\n');
  });

  /*
   * One clock for the life of the session, whatever the host does.
   *
   * `useRealm` is called from the constructor *and* again on every dial, so a
   * timer armed there left one live interval per connection with only the last
   * handle kept — and `dispose` then cleared one of them. An unref'd timer
   * still fires, into a queue whose own `enqueue` re-arms its timer, so a
   * closed tab went on deciding once a second and held its whole object graph
   * open.
   */
  it('arms one clock however many realms it is handed, and drops it on dispose', () => {
    vi.useFakeTimers();
    try {
      const { sink } = collect();
      const session = new SessionManager(sink);
      const armed = vi.getTimerCount();
      expect(armed).toBeGreaterThan(0);
      session.useRealm(NO_REALM_PLAYERS);
      session.useRealm(NO_REALM_PLAYERS);
      expect(vi.getTimerCount()).toBe(armed);
      session.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Giving up on a step nothing answered, and everything that was waiting on it.
 *
 * Reported 2026-09-03 as a console reading *"A step went unanswered"* in the
 * middle of a walk whose rooms were arriving normally. The message was true —
 * a step really had been lost, somewhere back up the log — and the defect was
 * what happened next: `pendingMoves` falls only when a room or a refusal
 * answers the step, six things gate on it, and exactly one of them
 * (auto-combat) had a clock. So the client said one sentence, hit back again,
 * and left the character unable to run away, walk a route or run a loop for
 * the rest of the session with nothing further said.
 *
 * Driven end to end because that is where it lives: the claim is made on the
 * command path, the bound is in `Expectations`, and the recovery is read by
 * `Walker.start` — three files, none of which can see the failure alone.
 */
describe('a step the server never answers', () => {
  const life = 300;

  beforeEach(() => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      parse: { ...DEFAULT_INTERNAL.tuning.parse, staleMoveMs: life }
    });
  });
  afterEach(() => setTuning(DEFAULT_INTERNAL.tuning));

  /** In the realm, with one move sent and nothing coming back for it. */
  async function lostAStep(): Promise<{ socket: net.Socket; notices: string[] }> {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, {
      ...DEFAULT_CONFIG.automation,
      enabled: false
    });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    socket.write('Guild Street\r\nObvious exits: north, south\r\n[HP=56/MA=12]:' + PROMPT_REPAINT);
    await until(() => manager!.character.room.name === 'Guild Street');

    manager.send('n\r');
    // The claim really was made, so what follows is a bound lapsing rather
    // than a command the tracker never saw.
    await until(() => manager!.character.room.name === 'Guild Street');
    return { socket, notices };
  }

  it('gives up on it, and says which step, once', async () => {
    const { socket, notices } = await lostAStep();

    // Nothing answers the move. The bound lapses on the next line off the wire,
    // because what the server owes this client is a fact about the wire.
    await new Promise((resolve) => setTimeout(resolve, life + 50));
    socket.write('[HP=56/MA=12]:' + PROMPT_REPAINT);
    await until(() => notices.some((notice) => notice.includes('“n”')));

    const said = notices.filter((notice) => notice.includes('“n”'));
    expect(said).toHaveLength(1);
    // Said in whole seconds off the tuning key rather than as a bare number.
    expect(said[0]).toMatch(/0s/);
  });

  /*
   * The half the report was about: everything that was waiting on the claim
   * starts working again.
   *
   * Auto-combat is the one of the six that sends a command, so it is what can
   * be *seen* from here — and its refusal while a step is outstanding is right
   * (a fight opened now lands in the room being left). What was wrong is that
   * the refusal was permanent. The two assertions are each other's control:
   * silence before the bound and a swing after it, from one unchanged stream
   * of blows.
   */
  it('lets what was waiting on it work again', async () => {
    const { sink } = collect();
    manager = new SessionManager(sink, undefined, {
      ...DEFAULT_CONFIG.automation,
      enabled: true,
      idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
      onEnterRealm: [],
      rules: [],
      combat: { ...DEFAULT_CONFIG.automation.combat, enabled: true, retaliate: true }
    });
    await manager.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    const socket = await client();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    const wire = (): string => Buffer.concat(chunks).toString('latin1');

    socket.write(
      'Guild Street\r\nAlso here: slime beast.\r\nObvious exits: north, south\r\n[HP=56/MA=12]:' +
        PROMPT_REPAINT
    );
    await until(() => manager!.character.room.occupants.length === 1);

    manager.send('n\r');
    await until(() => wire().includes('n\r\n'));

    // It opens on the character while the step is still outstanding. Nothing
    // is swung back: a fight opened now would land in the room being left.
    socket.write('The slime beast slashes you for 3 damage!\r\n');
    socket.write('[HP=53/MA=12]:' + PROMPT_REPAINT);
    await until(() => manager!.character.combat.attackers.includes('slime beast'));
    expect(wire()).not.toContain('slime beast');

    // Nothing ever answers the step. Past the bound, the same blow is hit back.
    await new Promise((resolve) => setTimeout(resolve, life + 50));
    socket.write('The slime beast slashes you for 3 damage!\r\n');
    socket.write('[HP=50/MA=12]:' + PROMPT_REPAINT);
    await until(() => wire().includes('slime beast'));
  });

  /* And a step that *is* answered costs nothing: the claim goes when the room
     comes, and no notice is raised. */
  it('says nothing at all when the room arrives', async () => {
    const { socket, notices } = await lostAStep();
    socket.write(
      'Guild Street\r\nObvious exits: north, south, east\r\n[HP=56/MA=12]:' + PROMPT_REPAINT
    );
    await until(() => manager!.character.room.exits.length === 3);
    await new Promise((resolve) => setTimeout(resolve, life + 50));
    socket.write('[HP=56/MA=12]:' + PROMPT_REPAINT);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(notices.filter((notice) => notice.includes('given up waiting'))).toEqual([]);
  });
});

/*
 * A lost socket is not the character leaving: it stands wherever the link
 * went, with whatever was in the room, and `Reconnect` dials it back. What it
 * was doing has to still be there when it is — before this, the loop was left
 * nominally running on the closed socket with the leg booked as a failed stop,
 * and the next dial reset it to nothing.
 */
describe('picking up after a lost connection', () => {
  const dial = () => ({ host: '127.0.0.1', port, encoding: 'cp437' as const });
  const automation = (): AutomationConfig => ({
    ...DEFAULT_CONFIG.automation,
    enabled: true,
    idle: { ...DEFAULT_CONFIG.automation.idle, enabled: false },
    onEnterRealm: [],
    rules: []
  });

  /** Into the realm and placed at Home, on this socket. */
  async function placed(socket: net.Socket): Promise<void> {
    socket.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    socket.write('Location: 1,2140\r\n[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.room.number === 2140);
  }

  it('holds a running loop through the loss, and walks it on once the character is back and placed', async () => {
    const { sink, notices, drops } = collect();
    manager = new SessionManager(sink, undefined, automation());
    await manager.connect(dial());
    const first = await client();
    await placed(first);
    expect(
      manager.loops.start({ name: 'lap', stops: [{ room: 'Home 1/2140' }] }, manager.character)
    ).toBeNull();

    first.destroy();
    await until(() => manager!.loops.progress.hold === 'offline');
    expect(manager.loops.progress).toMatchObject({ status: 'running', name: 'lap', stop: 1 });
    // And it is still reported as a loss, so `Reconnect` dials it back.
    expect(drops).toEqual([null]);

    // Dialled back to the same address: the loop is carried, still held.
    await manager.connect(dial());
    const second = await client(1);
    expect(manager.loops.progress).toMatchObject({ status: 'running', hold: 'offline' });
    second.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    // In the realm is not enough: nothing is planned from an unknown room.
    expect(manager.loops.progress.hold).toBe('offline');
    await until(() => notices.includes(t('session.reconnect.waitingToBePlaced')));

    second.write('Location: 1,2140\r\n[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.loops.progress.hold === null);
    expect(manager.loops.progress).toMatchObject({ status: 'running', name: 'lap', stop: 1 });
    expect(notices).toContain(t('automation.loops.walkingOnAfterReconnect'));
  });

  it('ends the loop when this client asked for the disconnect, and says why', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, automation());
    await manager.connect(dial());
    await placed(await client());
    manager.loops.start({ name: 'lap', stops: [{ room: 'Home 1/2140' }] }, manager.character);

    manager.disconnect();
    await until(() => manager!.state.phase === 'closed');
    expect(manager.loops.progress).toMatchObject({
      status: 'stopped',
      reason: t('session.loop.stoppedDisconnected')
    });
    expect(manager.loops.carried).toBe(false);
    expect(notices).toContain(
      t('automation.loops.stopped', { reason: t('session.loop.stoppedDisconnected') })
    );
  });

  /* A loop is a list of rooms in one realm. */
  it('puts the loop down when the next dial is to a different realm, and says so', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, automation());
    await manager.connect(dial());
    const first = await client();
    await placed(first);
    manager.loops.start({ name: 'lap', stops: [{ room: 'Home 1/2140' }] }, manager.character);
    first.destroy();
    await until(() => manager!.loops.progress.hold === 'offline');

    const other = net.createServer((socket) => socket.on('error', () => {}));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as net.AddressInfo).port;
    try {
      await manager.connect({ host: '127.0.0.1', port: otherPort, encoding: 'cp437' });
      expect(manager.loops.progress.status).toBe('idle');
      expect(notices).toContain(
        t('automation.loops.stopped', { reason: t('session.loop.stoppedRealmChanged') })
      );
    } finally {
      manager.disconnect();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  /* Four rooms in a line, each with its own name so nothing is ambiguous. */
  const line = (): WorldGraph => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-pickup-'));
    const file = path.join(dir, 'rooms.jsonl.gz');
    const rooms = [
      { m: 1, r: 1, n: 'Gate', x: { n: { m: 1, r: 2 } } },
      { m: 1, r: 2, n: 'Road', x: { n: { m: 1, r: 3 }, s: { m: 1, r: 1 } } },
      { m: 1, r: 3, n: 'Bridge', x: { n: { m: 1, r: 4 }, s: { m: 1, r: 2 } } },
      { m: 1, r: 4, n: 'Square', x: { s: { m: 1, r: 3 } } }
    ];
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        [
          JSON.stringify({ v: 1, source: 'test', rooms: 4, generatedAt: 'x' }),
          ...rooms.map((room) => JSON.stringify(room))
        ].join('\n') + '\n'
      )
    );
    const world = WorldGraph.load(file);
    fs.rmSync(dir, { recursive: true, force: true });
    return world;
  };

  it('plans the route the player was walking again, from wherever the character is now', async () => {
    const world = line();
    const { sink, notices } = collect();
    manager = new SessionManager(sink, world, automation());
    await manager.connect(dial());
    const first = await client();
    const before: Buffer[] = [];
    first.on('data', (chunk) => before.push(chunk));
    first.write('[HP=34]:' + PROMPT_REPAINT);
    first.write('Location:            1,4\r\nSquare\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 4);
    const route = world.route('1/4', '1/1');
    expect(route.steps).toHaveLength(3);
    expect(manager.walker.start(route, manager.character)).toBeNull();
    await until(() => Buffer.concat(before).toString('latin1').includes('s\r\n'));

    first.destroy();
    await until(() => manager!.walker.progress.status === 'stopped');

    await manager.connect(dial());
    const second = await client(1);
    const after: Buffer[] = [];
    second.on('data', (chunk) => after.push(chunk));
    // The step had landed before the link went, so the character is a room on.
    second.write('[HP=34]:' + PROMPT_REPAINT);
    second.write('Location:            1,3\r\nBridge\r\nObvious exits: north, south\r\n');
    await until(() => manager!.walker.progress.status === 'walking');
    // Two steps left, not three: planned from Bridge, not from the old route.
    expect(manager.walker.progress).toMatchObject({ total: 2, destination: 'Gate' });
    await until(() => Buffer.concat(after).toString('latin1').includes('s\r\n'));
    expect(notices).toContain(t('session.walk.resumed', { destination: 'Gate' }));
  });

  /* Dialled back into the lair it was standing in and killed before the entry
     probe placed it: the temple is where it is now, and the route it was
     walking would lead back out. */
  it('drops the route when the character dies before it is placed', async () => {
    const world = line();
    const { sink, notices } = collect();
    manager = new SessionManager(sink, world, automation());
    await manager.connect(dial());
    const first = await client();
    first.write('[HP=34]:' + PROMPT_REPAINT);
    first.write('Location:            1,4\r\nSquare\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 4);
    expect(manager.walker.start(world.route('1/4', '1/1'), manager.character)).toBeNull();
    first.destroy();
    await until(() => manager!.walker.progress.status === 'stopped');

    await manager.connect(dial());
    const second = await client(1);
    second.write('[HP=34]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    second.write('You have been killed!\r\n');
    await until(() =>
      notices.includes(
        t('session.walk.notResumed', {
          destination: 'Gate',
          reason: t('session.loop.stoppedDied')
        })
      )
    );
    // The temple places the character; nothing is picked up from it.
    second.write('Location:            1,3\r\nBridge\r\nObvious exits: north, south\r\n');
    await until(() => manager!.character.room.number === 3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(manager.walker.progress.status).not.toBe('walking');
  });

  /* A paused lap is carried paused, so nothing walks on when the room arrives
     and the client must not say that something will. The placement letting
     the carry go is the positive control. */
  it('carries a paused lap paused, without promising that it walks on', async () => {
    const { sink, notices } = collect();
    manager = new SessionManager(sink, undefined, automation());
    await manager.connect(dial());
    const first = await client();
    await placed(first);
    manager.loops.start({ name: 'lap', stops: [{ room: 'Home 1/2140' }] }, manager.character);
    manager.loops.pause();
    first.destroy();
    await until(() => manager!.loops.carried);

    await manager.connect(dial());
    const second = await client(1);
    second.write('[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => manager!.character.phase === 'in-game');
    second.write('Location: 1,2140\r\n[HP=100/MA=50]:' + PROMPT_REPAINT);
    await until(() => !manager!.loops.carried);
    expect(manager.loops.progress).toMatchObject({ status: 'paused', name: 'lap' });
    expect(notices).not.toContain(t('session.reconnect.waitingToBePlaced'));
    expect(notices).not.toContain(t('automation.loops.walkingOnAfterReconnect'));
  });

  it('forgets the route when this client asked for the disconnect', async () => {
    const world = line();
    const { sink } = collect();
    manager = new SessionManager(sink, world, automation());
    await manager.connect(dial());
    const first = await client();
    first.write('[HP=34]:' + PROMPT_REPAINT);
    first.write('Location:            1,4\r\nSquare\r\nObvious exits: south\r\n');
    await until(() => manager!.character.room.number === 4);
    expect(manager.walker.start(world.route('1/4', '1/1'), manager.character)).toBeNull();

    manager.disconnect();
    await until(() => manager!.state.phase === 'closed');
    await manager.connect(dial());
    const second = await client(1);
    second.write('[HP=34]:' + PROMPT_REPAINT);
    second.write('Location:            1,3\r\nBridge\r\nObvious exits: north, south\r\n');
    await until(() => manager!.character.room.number === 3);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(manager.walker.progress.status).not.toBe('walking');
  });
});
