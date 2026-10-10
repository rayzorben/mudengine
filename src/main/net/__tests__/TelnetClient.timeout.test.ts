import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';

import { DeadSocket } from './deadSocket';
import { TelnetClient } from '../TelnetClient';

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
     * `connecting`, a second Connect was refused (until todo 22), and the only
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

/*
 * Todo 22: a key pressed on Festus mid-dial was taken as sent, and the dead-link
 * watch hung up 6.7 s after a dial that had already failed.
 */
describe('a socket still dialling is not connected', () => {
  it('refuses a write until the socket opens, and takes one after', async () => {
    const dialling = new DeadSocket();
    vi.spyOn(net, 'createConnection').mockImplementation(() => dialling as unknown as net.Socket);

    const client = new TelnetClient(undefined, 5_000);
    const dial = client.connect(target);
    expect(client.connected).toBe(false);
    expect(client.dialling).toBe(true);
    expect(client.send('\r')).toBe(false);
    expect(dialling.written).toEqual([]);

    dialling.emit('connect');
    await dial;
    expect(client.connected).toBe(true);
    expect(client.dialling).toBe(false);
    expect(client.send('\r')).toBe(true);
    expect(dialling.written).toHaveLength(1);
    client.disconnect();
    expect(client.connected).toBe(false);
  });

  it('drops a socket at once when hung up mid-dial, rather than waiting on a FIN', async () => {
    const dialling = new DeadSocket();
    vi.spyOn(net, 'createConnection').mockImplementation(() => dialling as unknown as net.Socket);

    const client = new TelnetClient(undefined, 5_000);
    const dial = client.connect(target);
    client.disconnect();
    await expect(dial).rejects.toThrow();
    expect(dialling.destroyed).toBe(true);
    expect(client.dialling).toBe(false);
  });

  it('says which address the name resolved to', async () => {
    const dialling = new DeadSocket();
    vi.spyOn(net, 'createConnection').mockImplementation(() => dialling as unknown as net.Socket);

    const client = new TelnetClient(undefined, 5_000);
    const resolved: string[] = [];
    client.on('resolved', (host, address) => resolved.push(`${host} ${address}`));
    const dial = client.connect(target);
    dialling.emit('lookup', null, '192.0.2.7', 4, 'paramud.mudinfo.net');
    expect(resolved).toEqual(['127.0.0.1 192.0.2.7']);
    client.disconnect();
    await expect(dial).rejects.toThrow();
  });
});
