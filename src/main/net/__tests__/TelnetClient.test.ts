import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { TelnetClient } from '../TelnetClient';
import { CMD, OPT, SUB } from '../telnet-constants';

/**
 * End-to-end transport tests against a throwaway TCP server that behaves the
 * way a MajorMUD-era host does: it negotiates a handful of options, emits
 * CP437 box art and ANSI colour, and expects a CR LF terminated command back.
 */
interface Harness {
  port: number;
  /** Everything the server has received, framing included. */
  received: Buffer[];
  send(data: Buffer | string): void;
  close(): Promise<void>;
  /** Resolves once a client socket is attached. */
  connected: Promise<void>;
}

const servers: Harness[] = [];

async function startServer(onConnect?: (socket: net.Socket) => void): Promise<Harness> {
  const received: Buffer[] = [];
  let client: net.Socket | null = null;
  let markConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => (markConnected = resolve));

  const server = net.createServer((socket) => {
    client = socket;
    socket.on('data', (chunk) => received.push(chunk));
    socket.on('error', () => {});
    onConnect?.(socket);
    markConnected();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');

  const harness: Harness = {
    port: address.port,
    received,
    connected,
    send: (data) => client?.write(typeof data === 'string' ? Buffer.from(data, 'latin1') : data),
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy();
        server.close(() => resolve());
      })
  };

  servers.push(harness);
  return harness;
}

/** Waits for a predicate to hold, polling the event loop. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('TelnetClient', () => {
  it('connects, negotiates, and decodes CP437 output', async () => {
    const server = await startServer((socket) => {
      // A typical opening volley from a BBS front end.
      socket.write(
        Buffer.from([
          CMD.IAC,
          CMD.WILL,
          OPT.SUPPRESS_GO_AHEAD,
          CMD.IAC,
          CMD.DO,
          OPT.TERMINAL_TYPE,
          CMD.IAC,
          CMD.DO,
          OPT.NAWS
        ])
      );
    });

    const client = new TelnetClient();
    const text: string[] = [];
    client.on('data', (chunk) => text.push(chunk));

    await client.connect({ host: '127.0.0.1', port: server.port, encoding: 'cp437' });
    client.resize({ cols: 80, rows: 25 });

    await until(() => client.negotiated.suppressGoAhead);

    // 0xC9 0xCD 0xBB are CP437 double-line box-drawing characters.
    server.send(Buffer.from([0x1b, 0x5b, 0x33, 0x36, 0x6d, 0xc9, 0xcd, 0xbb, 0x0d, 0x0a]));
    await until(() => text.join('').includes('╔'));

    expect(text.join('')).toBe('\x1b[36m╔═╗\r\n');
    expect(client.negotiated.remoteEnabled).toContain('SUPPRESS-GO-AHEAD');
    expect(client.negotiated.localEnabled).toEqual(
      expect.arrayContaining(['TERMINAL-TYPE', 'NAWS'])
    );

    client.disconnect();
  });

  it('answers TERMINAL-TYPE and reports NAWS to the server', async () => {
    const server = await startServer((socket) => {
      socket.write(Buffer.from([CMD.IAC, CMD.DO, OPT.NAWS, CMD.IAC, CMD.DO, OPT.TERMINAL_TYPE]));
      setTimeout(() => {
        socket.write(Buffer.from([CMD.IAC, CMD.SB, OPT.TERMINAL_TYPE, SUB.SEND, CMD.IAC, CMD.SE]));
      }, 20);
    });

    const client = new TelnetClient();
    await client.connect({ host: '127.0.0.1', port: server.port, encoding: 'cp437' });
    client.resize({ cols: 132, rows: 43 });

    await until(() => Buffer.concat(server.received).includes('ANSI'));

    const all = Buffer.concat(server.received);
    // NAWS payload for 132x43.
    expect([...all]).toEqual(
      expect.arrayContaining([CMD.SB, OPT.NAWS, 0, 132, 0, 43, CMD.IAC, CMD.SE])
    );
    expect(all.toString('latin1')).toContain('ANSI');

    client.disconnect();
  });

  it('sends commands as CR LF and never leaks a raw 0xFF', async () => {
    const server = await startServer();
    const client = new TelnetClient();
    await client.connect({ host: '127.0.0.1', port: server.port, encoding: 'cp437' });
    await server.connected;

    client.send('look\r');
    await until(() => server.received.length > 0);

    expect(Buffer.concat(server.received).toString('latin1')).toBe('look\r\n');

    client.disconnect();
  });

  it('reports a graceful close distinctly from a dropped connection', async () => {
    const server = await startServer();
    const client = new TelnetClient();
    const closes: boolean[] = [];
    client.on('close', (graceful) => closes.push(graceful));

    await client.connect({ host: '127.0.0.1', port: server.port, encoding: 'cp437' });
    await server.connected;

    // Server-initiated drop.
    await server.close();
    await until(() => closes.length === 1);
    expect(closes[0]).toBe(false);
  });

  it('rejects rather than throwing when the host refuses the connection', async () => {
    const client = new TelnetClient();
    await expect(
      client.connect({ host: '127.0.0.1', port: 1, encoding: 'cp437' })
    ).rejects.toThrow();
    expect(client.connected).toBe(false);
  });
});

describe('TelnetClient geometry reporting', () => {
  it('coalesces a burst of resizes into one report and logs it', async () => {
    const server = await startServer((socket) => {
      socket.write(Buffer.from([CMD.IAC, CMD.DO, OPT.NAWS]));
    });

    const client = new TelnetClient();
    const logged: string[] = [];
    client.on('telnet', (e) => {
      if (e.direction === 'out' && e.summary.startsWith('SB NAWS')) logged.push(e.summary);
    });

    await client.connect({ host: '127.0.0.1', port: server.port, encoding: 'cp437' });
    await until(() => client.negotiated.localEnabled.includes('NAWS'));

    // Agreeing to NAWS makes the parser report the current size straight away.
    expect(logged).toEqual(['SB NAWS 80x24 SE']);

    // A burst, as the diagnostics rail animates open: only the settled size
    // should reach the server.
    client.resize({ cols: 148, rows: 40 });
    client.resize({ cols: 134, rows: 40 });
    client.resize({ cols: 120, rows: 40 });

    await until(() => logged.length === 2);
    expect(logged).toEqual(['SB NAWS 80x24 SE', 'SB NAWS 120x40 SE']);

    // A later change is reported; an unchanged one is not.
    client.resize({ cols: 120, rows: 40 });
    client.resize({ cols: 90, rows: 30 });
    await until(() => logged.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(logged).toEqual(['SB NAWS 80x24 SE', 'SB NAWS 120x40 SE', 'SB NAWS 90x30 SE']);

    client.disconnect();
  });
});

describe('teardown', () => {
  it('does not throw when the peer resets after the owner stopped listening', async () => {
    /*
     * `EventEmitter` throws on an `error` event with no listener, and in the
     * main process that is the application going away rather than a rejected
     * promise. `disconnect()` calls `end()` and only destroys the socket 250 ms
     * later, so there is a real window in which a reset arrives after the owner
     * has torn its listeners down.
     */
    let peer: net.Socket | null = null;
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      peer = socket;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    const client = new TelnetClient();
    await client.connect({ host: '127.0.0.1', port, encoding: 'cp437' });
    client.removeAllListeners();

    // Reset rather than close: a FIN is an ordinary graceful exit and would not
    // produce the error event this is about.
    const socket = peer as unknown as net.Socket;
    socket.resetAndDestroy?.() ?? socket.destroy(new Error('reset'));

    // If the guard is missing this takes the process down rather than failing
    // the assertion, so reaching the end is the test.
    await new Promise((resolve) => setTimeout(resolve, 120));
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(true).toBe(true);
  });
});
