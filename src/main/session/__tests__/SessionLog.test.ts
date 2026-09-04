import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionLog } from '../SessionLog';
import type { ConnectionTarget } from '../../../shared/types';

let dir = '';
let problems: string[] = [];

const target: ConnectionTarget = { host: 'gmud-tgs', port: 2427, encoding: 'cp437' };

const open = (maxBytes = 1024): SessionLog => {
  const log = new SessionLog({ directory: dir, maxBytes, onProblem: (m) => problems.push(m) });
  log.open(target, new Date('2026-08-25T12:00:00Z'), 'vaelor');
  return log;
};

/**
 * What ended up on disk, once the stream has flushed.
 *
 * Awaited, not slept on: `close()` resolves when the last line is really there.
 * Waiting a fixed 60 ms passes on a quiet machine and fails on a busy one,
 * which is the flake `SessionCapture`'s equivalent produced before this shape
 * was applied to both.
 */
const contents = async (log: SessionLog): Promise<string> => {
  await log.close();
  const files = fs.readdirSync(dir);
  return files.length === 0 ? '' : fs.readFileSync(path.join(dir, files[0]!), 'utf8');
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-log-'));
  problems = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('what a session log keeps', () => {
  it('writes what the server said', async () => {
    const log = open();
    log.write('Newhaven Village Entrance\r\n');
    expect(await contents(log)).toContain('Newhaven Village Entrance');
  });

  /*
   * The raw stream is reproducible from the wire and unreadable in an editor.
   * What makes a log worth keeping is being able to grep it.
   */
  it('strips the ANSI, so it greps', async () => {
    const log = open();
    log.write('[1;32mNewhaven[0m\r\n');
    const text = await contents(log);
    expect(text).toContain('Newhaven');
    expect(text).not.toContain('');
  });

  /* The file opens with a header naming the session, so this checks the tail. */
  it('normalises CR away, so a line is a line', async () => {
    const log = open();
    log.write('one\r\ntwo\r\n');
    expect(await contents(log)).toMatch(/one\ntwo\n$/);
  });

  /*
   * Keyed by *session*, not by host and port: two characters on one BBS
   * connecting in the same second produced names that differed by nothing, and
   * the question anyone asks of a log is "what happened to Vaelor".
   *
   * Read off the log rather than off the directory — `createWriteStream` opens
   * the file lazily, so the directory is empty for a moment after `open()`.
   */
  it('names the character it recorded', () => {
    const log = open();
    expect(path.basename(log.path)).toContain('vaelor');
    void log.close();
  });
});

/*
 * A client left connected overnight must not be able to consume a partition
 * unattended. This is the property that makes leaving one running safe, and
 * nothing was checking it.
 */
describe('the size cap', () => {
  it('stops appending once the cap is reached', async () => {
    const log = open(64);
    log.write('x'.repeat(40));
    log.write('y'.repeat(40));
    const text = await contents(log);
    expect(text.length).toBeLessThanOrEqual(64);
    expect(text).not.toContain('y');
  });

  it('says so rather than going quiet', () => {
    const log = open(64);
    log.write('x'.repeat(100));
    expect(problems.join(' ')).toMatch(/limit|no longer recording/i);
    void log.close();
  });

  /* A message per write would be a warning nobody reads. */
  it('says it once, however much more arrives', () => {
    const log = open(64);
    for (let i = 0; i < 10; i += 1) log.write('x'.repeat(100));
    expect(problems).toHaveLength(1);
    void log.close();
  });

  it('stays stopped for the rest of the session', async () => {
    const log = open(64);
    log.write('x'.repeat(100));
    log.write('short');
    expect(await contents(log)).not.toContain('short');
  });
});

/*
 * Logging can never take the session down. Every filesystem failure disables
 * the log for the rest of the session rather than propagating into the socket
 * path — a client that drops a character because a disk filled is worse than
 * one that stops logging.
 */
describe('when the filesystem will not cooperate', () => {
  it('reports a directory it cannot create, and does not throw', () => {
    const problemsHere: string[] = [];
    const log = new SessionLog({
      // A path with a NUL in it cannot be created on any platform.
      directory: path.join(dir, '\0nope'),
      maxBytes: 1024,
      onProblem: (m) => problemsHere.push(m)
    });
    /*
     * `open` names the file and touches nothing, so the failure surfaces on the
     * first thing written — the file is created lazily now, so that a dial that
     * never connected leaves no file at all. What must not move is the rest of
     * the promise: reported once, and nothing throws.
     */
    expect(() => log.open(target, new Date(), 'vaelor')).not.toThrow();
    expect(problemsHere).toHaveLength(0);
    expect(() => log.write('anything')).not.toThrow();
    expect(problemsHere.length).toBeGreaterThan(0);
    // And writing again is inert rather than a second failure.
    expect(() => log.write('more')).not.toThrow();
    expect(problemsHere).toHaveLength(1);
  });

  /*
   * **A dial that never connected leaves no file.**
   *
   * `SessionHost` rotates the log before *every* dial, so an eager open made a
   * file per attempt rather than per connection — and behind auto-reconnect
   * that is one every fifteen seconds. A router down overnight is roughly 1,920
   * empty `.log` files by morning, with `npm run check:secrets` walking the
   * whole directory afterwards.
   */
  it('creates nothing until something is written to it', async () => {
    const log = open();
    expect(fs.readdirSync(dir)).toEqual([]);
    await log.close();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  /* And the header is still the first thing in a log that does get used. */
  it('writes the header ahead of the first line, once', async () => {
    const log = open();
    log.write('one\r\n');
    log.write('two\r\n');
    const text = await contents(log);
    expect(text.startsWith('--- session gmud-tgs:2427')).toBe(true);
    expect(text.match(/--- session/g)).toHaveLength(1);
  });

  it('ignores a write with nothing open', () => {
    const log = new SessionLog({ directory: dir, maxBytes: 1024 });
    expect(() => log.write('anything')).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('closes cleanly twice', () => {
    const log = open();
    void log.close();
    expect(() => log.close()).not.toThrow();
  });
});
