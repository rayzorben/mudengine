import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';

import { TelnetClient } from '../TelnetClient';

/**
 * A socket that opens and then does nothing, which is what a dropped SYN looks
 * like from here.
 *
 * The real case — a firewall that swallows the handshake — cannot be produced on
 * demand against the one realm this project dials. So the connector is stubbed
 * rather than the network coerced: the behaviour under test is the client's
 * deadline, not the kernel's.
 */
class DeadSocket extends EventEmitter {
  destroyed = false;
  setNoDelay(): this {
    return this;
  }
  write(): boolean {
    return true;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  override removeListener(event: string, listener: (...args: never[]) => void): this {
    super.removeListener(event, listener as (...args: unknown[]) => void);
    return this;
  }
}

const target = { host: '127.0.0.1', port: 9, encoding: 'cp437' as const };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the dial has a deadline', () => {
  it('gives up rather than leaving the session wedged', async () => {
    const dead = new DeadSocket();
    const spy = vi
      .spyOn(net, 'createConnection')
      .mockImplementation(() => dead as unknown as net.Socket);

    const client = new TelnetClient(undefined, 40);
    /*
     * Without the deadline this promise never settles: the phase stays
     * `connecting`, `BUSY_PHASES` refuses every further attempt, and the only
     * way back is restarting the application. The operating system does not
     * help — it waits roughly two minutes on an unanswered SYN.
     */
    await expect(client.connect(target)).rejects.toThrow(/No answer from 127\.0\.0\.1:9/);
    expect(spy).toHaveBeenCalledOnce();
    // And the socket it gave up on is not left open.
    expect(dead.destroyed).toBe(true);
    client.disconnect();
  });

  it('does not fire once the socket is up', async () => {
    const live = new DeadSocket();
    vi.spyOn(net, 'createConnection').mockImplementation(() => {
      queueMicrotask(() => live.emit('connect'));
      return live as unknown as net.Socket;
    });

    const client = new TelnetClient(undefined, 40);
    await client.connect(target);

    // Long past the deadline: a connected socket must never be torn down by
    // the timer that was watching the dial.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(live.destroyed).toBe(false);
    client.disconnect();
  });

  it('reports the refusal rather than the deadline when the host says no', async () => {
    const refused = new DeadSocket();
    vi.spyOn(net, 'createConnection').mockImplementation(() => {
      queueMicrotask(() => refused.emit('error', new Error('ECONNREFUSED')));
      return refused as unknown as net.Socket;
    });

    const client = new TelnetClient(undefined, 40);
    // The immediate, informative error wins; the deadline is for silence.
    await expect(client.connect(target)).rejects.toThrow(/ECONNREFUSED/);
    client.disconnect();
  });
});
