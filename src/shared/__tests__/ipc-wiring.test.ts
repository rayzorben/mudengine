import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Invoke, Push, Send } from '../ipc';

/**
 * Channel names and payload types are declared together so a mismatch is a
 * compile error. What the type system cannot see is whether the *other end*
 * exists: `IpcApi` forces the preload to expose every method, but nothing
 * forces main to handle it. A channel with no handler is an `invoke` that
 * rejects at runtime, on a path somebody only reaches by pressing the thing.
 *
 * Read as source text, deliberately. Importing `src/main/index.ts` would
 * start the app.
 */
const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8');
const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');

/** Whether a file mentions `Invoke.name`, `Send.name` or `Push.name`. */
const mentions = (source: string, group: string, key: string): boolean =>
  new RegExp(`\\b${group}\\.${key}\\b`).test(source);

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

  it('listens for every one-way channel', () => {
    const missing = Object.keys(Send).filter((key) => !mentions(main, 'Send', key));
    expect(missing, `nothing in main listens for: ${missing.join(', ')}`).toEqual([]);
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

  it('subscribes to every push in the preload', () => {
    const missing = Object.keys(Push).filter((key) => !mentions(preload, 'Push', key));
    expect(missing, `the renderer cannot hear: ${missing.join(', ')}`).toEqual([]);
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
