import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { NO_FIGHTS } from '../../../shared/fights';
import { NO_TALK } from '../TalkLog';
import { NO_REALM_PLAYERS } from '../../../shared/players';
import { NO_BELONGINGS } from '../../../shared/belongings';
import { NO_LORE } from '../../../shared/lore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';

import { SessionHost } from '../SessionHost';
import { Push, type Addressed, type Notice, type SessionId } from '../../../shared/ipc';
import { DEFAULT_CONFIG, type AppConfig } from '../../../shared/config';
import type { ConnectionTarget, StreamChunk } from '../../../shared/types';

/**
 * Real sockets, two of them, because the bug this file exists to catch is
 * cross-talk: one character's bytes, state or keystrokes reaching another's
 * surface. That is the defining failure of the multi-session refactor and the
 * one least likely to be noticed by playing — it looks like a glitch until the
 * day it looks like the wrong character casting.
 */
let server: net.Server;
let port: number;
let host: SessionHost | null = null;
let accepted: net.Socket[] = [];
/** What each accepted socket received, in the order they were accepted. */
let received: string[] = [];

const config: AppConfig = {
  ...DEFAULT_CONFIG,
  // No files: this is about routing, and a test that writes logs is a test that
  // fails on a full disk.
  logging: { ...DEFAULT_CONFIG.logging, enabled: false, capture: false }
};

interface Sent {
  channel: string;
  message: Addressed<unknown>;
}

let attachedSends: Sent[] = [];
let allSends: Sent[] = [];
/**
 * How many times the roster was republished.
 *
 * Counted separately from `allSends`, which only records *addressed* pushes:
 * the roster is the one thing a window is told that is not about one character,
 * and it is now per window, so it does not travel as an `Addressed<T>` at all.
 */
let rosterPublishes = 0;
let notices: Notice[] = [];
/** The addresses sessions were keyed on for their realm's players, per dial. */
let dialledRealms: ConnectionTarget[] = [];
/** Whether these sessions want a lost connection dialled back. See `Reconnect`. */
let autoReconnect = false;

beforeEach(async () => {
  accepted = [];
  received = [];
  attachedSends = [];
  allSends = [];
  rosterPublishes = 0;
  notices = [];
  dialledRealms = [];
  autoReconnect = false;

  server = net.createServer((socket) => {
    const index = accepted.length;
    accepted.push(socket);
    received.push('');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      received[index] += chunk.toString('latin1');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;

  host = new SessionHost({
    worldFor: () => undefined,
    loreFor: () => NO_LORE,
    // Nothing to learn against without a realm, which is what these run with.
    memoryFor: () => undefined,
    fightsFor: () => NO_FIGHTS,
    talkFor: () => NO_TALK,
    playersFor: () => NO_REALM_PLAYERS,
    destinationsFor: () => ({ remember: () => {}, matching: () => [] }),
    playersAt: (target) => {
      dialledRealms.push(target);
      return NO_REALM_PLAYERS;
    },
    // Nowhere to write, like every other record in these runs.
    belongingsAt: () => NO_BELONGINGS,
    internal: () => DEFAULT_INTERNAL,
    publishRoster: () => {
      rosterPublishes += 1;
    },
    configFor: () => config,
    autoReconnect: () => autoReconnect,
    label: (id) => ({ name: id, server: 'test', accent: 'cyan' }),
    logDirectory: () => '',
    toAttached: (channel, message) => attachedSends.push({ channel, message }),
    // The tests observe the feed as if every window had asked for it.
    toDiagnostics: (channel, message) => attachedSends.push({ channel, message }),
    toAll: (channel, payload) => {
      if (payload && typeof payload === 'object' && 'session' in payload) {
        allSends.push({ channel, message: payload as Addressed<unknown> });
      }
    },
    notice: (notice) => notices.push(notice)
  });
});

afterEach(async () => {
  host?.disposeAll();
  host = null;
  for (const socket of accepted) socket.destroy();
  accepted = [];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function target() {
  return { host: '127.0.0.1', port, encoding: 'cp437' as const };
}

async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The decoded text this channel delivered for one session. */
function textFor(session: SessionId): string {
  return attachedSends
    .filter((sent) => sent.channel === Push.data && sent.message.session === session)
    .map((sent) => (sent.message.payload as StreamChunk).text)
    .join('');
}

describe('SessionHost', () => {
  it('gives each session its own output, and never the other one', async () => {
    await host!.connect('thorn', target());
    await host!.connect('mara', target());
    await until(() => accepted.length === 2);

    accepted[0]!.write('thorn sees this\r\n');
    accepted[1]!.write('mara sees that\r\n');
    await until(() => textFor('thorn').includes('this') && textFor('mara').includes('that'));

    expect(textFor('thorn')).toContain('thorn sees this');
    expect(textFor('thorn')).not.toContain('mara');
    expect(textFor('mara')).toContain('mara sees that');
    expect(textFor('mara')).not.toContain('thorn');
  });

  /*
   * A character can be dialled at a saved realm other than its own, and what
   * it learns about the players there is *that* realm's — keyed on where the
   * socket goes, not on where the character's file says it lives.
   */
  it('keys what a session learns about players on the address it dialled', async () => {
    const where = { ...target(), port };
    await host!.connect('thorn', where);
    await until(() => accepted.length === 1);
    expect(dialledRealms).toEqual([where]);
  });

  it('sends a keystroke to one socket only', async () => {
    await host!.connect('thorn', target());
    await host!.connect('mara', target());
    await until(() => accepted.length === 2);

    host!.get('thorn')!.manager.send('north\r');
    await until(() => received[0]!.includes('north'));

    expect(received[0]).toContain('north');
    // A keystroke arriving at the wrong character is the failure the addressed
    // contract exists to make impossible; this is the runtime half of it.
    expect(received[1]).not.toContain('north');
  });

  it('leaves one session connected when the other disconnects', async () => {
    await host!.connect('thorn', target());
    await host!.connect('mara', target());
    await until(() => accepted.length === 2);

    host!.get('thorn')!.manager.disconnect();
    await until(() => host!.get('thorn')!.manager.state.phase !== 'connected');

    expect(host!.connectedIds).toEqual(['mara']);
  });

  it('retains each session backscroll separately, for replay on attach', async () => {
    await host!.connect('thorn', target());
    await host!.connect('mara', target());
    await until(() => accepted.length === 2);

    accepted[0]!.write('thorn output\r\n');
    accepted[1]!.write('mara output\r\n');
    await until(
      () =>
        host!.get('thorn')!.backscroll.text.includes('thorn') &&
        host!.get('mara')!.backscroll.text.includes('mara')
    );

    expect(host!.get('thorn')!.backscroll.text).not.toContain('mara');
    expect(host!.get('mara')!.backscroll.text).not.toContain('thorn');
  });

  it('returns the same slot rather than opening a character twice', () => {
    const first = host!.ensure('thorn');
    const second = host!.ensure('thorn');
    // The same character logged in twice is never useful, and the server drops
    // one of them.
    expect(second).toBe(first);
    expect(host!.ids).toEqual(['thorn']);
  });

  it('addresses every coalesced fact it publishes', async () => {
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);
    accepted[0]!.write('[HP=30]:\r\n');
    await until(() => allSends.some((sent) => sent.channel === Push.state));

    // Nothing reaches a window without saying which character it came from.
    expect(allSends.every((sent) => typeof sent.message.session === 'string')).toBe(true);
    expect(allSends.every((sent) => sent.message.session === 'thorn')).toBe(true);
  });

  /* A window has to be told when the roster changes, or a character that just
     connected has no tab until something else happens to republish it. */
  it('republishes the roster when a character connects', async () => {
    const before = rosterPublishes;
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);
    expect(rosterPublishes).toBeGreaterThan(before);
  });

  it('reports which characters are still connected, for the quit confirmation', async () => {
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);
    expect(host!.connectedIds).toEqual(['thorn']);

    host!.disposeAll();
    expect(host!.ids).toEqual([]);
  });

  it('addresses its notices to the session that caused them', async () => {
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((notice) => notice.session === 'thorn')).toBe(true);
  });

  /*
   * Auto-reconnect, end to end through a real socket that the far end kills.
   *
   * The unit tests over `Reconnect` prove the ladder; what only this can prove
   * is that a socket dying reaches it at all — that the manager reports the
   * loss, the host redials through the same path a dial somebody asked for
   * takes, and the character comes back on a *new* connection rather than a
   * revived one.
   */
  it('dials a character back when the far end drops the socket', async () => {
    autoReconnect = true;
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);

    accepted[0]!.destroy();
    // The first attempt is immediate, so no wait beyond the socket's own close.
    await until(() => accepted.length === 2);
    expect(host!.get('thorn')?.manager.state.phase).toBe('connected');
  });

  it('leaves a character alone when the disconnect was asked for', async () => {
    autoReconnect = true;
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);

    host!.disconnect('thorn');
    await until(() => host!.get('thorn')?.manager.state.phase === 'closed');
    // Long enough that the immediate rung would have fired several times over.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(accepted).toHaveLength(1);
  });

  /*
   * The one way somebody can say *stop trying*. A character sitting at a closed
   * socket with a retry pending has nothing for the manager to close, so
   * without the host calling the timer off the button would look inert and the
   * client would dial straight back in.
   */
  it('calls a pending retry off when Disconnect is pressed', async () => {
    autoReconnect = true;
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);

    accepted[0]!.destroy();
    await until(() => accepted.length === 2);
    accepted[1]!.destroy();
    await until(() => host!.get('thorn')?.manager.state.phase === 'closed');

    host!.disconnect('thorn');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(accepted).toHaveLength(2);
    expect(host!.get('thorn')?.reconnect.pending).toBe(false);
  });

  it('does not dial back a character that never asked for it', async () => {
    await host!.connect('thorn', target());
    await until(() => accepted.length === 1);

    accepted[0]!.destroy();
    await until(() => host!.get('thorn')?.manager.state.phase === 'closed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(accepted).toHaveLength(1);
  });
});
