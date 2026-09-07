import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Invoke, Push, Send } from '../ipc';

/**
 * Channel names and payload types are declared together so a mismatch is a
 * compile error. What the type system cannot see is whether the *other end*
 * exists: `IpcApi` forces a bridge to expose every method, but nothing
 * forces main to handle it. A channel with no handler is an `invoke` that
 * rejects at runtime, on a path somebody only reaches by pressing the thing.
 *
 * Two bridges since 2026-09-07 — the preload for the desktop and the web
 * bridge for a browser tab — and **both** are held to the one list, for the
 * closed-union reason: a channel added to one carrier and not the other
 * type-checks and then fails on whichever host nobody happened to test.
 *
 * Read as source text, deliberately. Importing `src/main/client.ts` would
 * start the client.
 */
const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8');
const main = read('src/main/client.ts');
const preload = read('src/preload/index.ts');
const web = read('src/renderer/src/lib/webBridge.ts');

/**
 * What the web bridge answers in the window rather than over the socket,
 * each for a stated reason (`webBridge.ts` header): the clipboard is the
 * tab's, and the picker browses the client's disk through `browseHome`. Each
 * still has to be a method on the bridge; it is only the channel constant it
 * does not name.
 */
const ANSWERED_IN_THE_WINDOW = ['copyText', 'pasteText', 'chooseRealm'] as const;

/** Whether a file mentions `Invoke.name`, `Send.name` or `Push.name`. */
const mentions = (source: string, group: string, key: string): boolean =>
  new RegExp(`\\b${group}\\.${key}\\b`).test(source);

/** Whether a bridge defines the method at all, by whichever route. */
const defines = (source: string, key: string): boolean =>
  new RegExp(`^\\s+${key}:`, 'm').test(source);

describe('the IPC contract is wired at both ends', () => {
  it('has channels to check', () => {
    expect(Object.keys(Invoke).length).toBeGreaterThan(20);
  });

  it('handles every invocable channel in main', () => {
    const missing = Object.keys(Invoke).filter((key) => !mentions(main, 'Invoke', key));
    expect(missing, `no handler in main for: ${missing.join(', ')}`).toEqual([]);
  });

  it('exposes every invocable channel through the preload', () => {
    const missing = Object.keys(Invoke).filter((key) => !mentions(preload, 'Invoke', key));
    expect(missing, `not exposed to the renderer: ${missing.join(', ')}`).toEqual([]);
  });

  it('exposes every invocable channel through the web bridge', () => {
    const local = new Set<string>(ANSWERED_IN_THE_WINDOW);
    const missing = Object.keys(Invoke).filter(
      (key) => !local.has(key) && !mentions(web, 'Invoke', key)
    );
    expect(missing, `the web bridge does not carry: ${missing.join(', ')}`).toEqual([]);
    const undefinedLocally = ANSWERED_IN_THE_WINDOW.filter((key) => !defines(web, key));
    expect(
      undefinedLocally,
      `the web bridge does not answer: ${undefinedLocally.join(', ')}`
    ).toEqual([]);
  });

  it('listens for every one-way channel', () => {
    const missing = Object.keys(Send).filter((key) => !mentions(main, 'Send', key));
    expect(missing, `nothing in main listens for: ${missing.join(', ')}`).toEqual([]);
  });

  it('sends every one-way channel from both bridges', () => {
    for (const [name, source] of [
      ['preload', preload],
      ['web bridge', web]
    ] as const) {
      const missing = Object.keys(Send).filter((key) => !mentions(source, 'Send', key));
      expect(missing, `the ${name} never sends: ${missing.join(', ')}`).toEqual([]);
    }
  });

  /*
   * A push nothing ever sends is a subscription the renderer holds open for a
   * message that cannot arrive — which looks exactly like a feature that is
   * merely quiet.
   */
  it('sends every push from somewhere in main', () => {
    const sources = [main, ...sessionSources()].join('\n');
    const missing = Object.keys(Push).filter((key) => !mentions(sources, 'Push', key));
    expect(missing, `nothing ever pushes: ${missing.join(', ')}`).toEqual([]);
  });

  it('subscribes to every push in both bridges', () => {
    for (const [name, source] of [
      ['preload', preload],
      ['web bridge', web]
    ] as const) {
      const missing = Object.keys(Push).filter((key) => !mentions(source, 'Push', key));
      expect(missing, `the ${name} cannot hear: ${missing.join(', ')}`).toEqual([]);
    }
  });

  /*
   * The bridge says which host it is, and only the value that is true of it.
   * A preload claiming `web` would hide every desktop control on the desktop.
   */
  it('each bridge states its own host kind', () => {
    expect(/^\s+host: 'electron',/m.test(preload)).toBe(true);
    expect(/^\s+host: 'web',/m.test(web)).toBe(true);
  });
});

/** Main is not the only thing that pushes; the session layer does most of it. */
function sessionSources(): string[] {
  const dir = path.resolve('src/main');
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return files;
}
