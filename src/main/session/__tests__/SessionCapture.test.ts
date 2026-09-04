import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionCapture } from '../SessionCapture';
import type { ConnectionTarget, StreamLine } from '../../../shared/types';

let dir = '';
let problems: string[] = [];

const target: ConnectionTarget = { host: 'gmud-tgs', port: 2427, encoding: 'cp437' };

const open = (maxBytes = 64 * 1024): SessionCapture => {
  const capture = new SessionCapture({
    directory: dir,
    maxBytes,
    onProblem: (message) => problems.push(message)
  });
  capture.open(target, new Date('2026-08-25T12:00:00Z'), 'vaelor');
  return capture;
};

const line = (plain: string): StreamLine => ({
  seq: 1,
  at: 1_700_000_000_000,
  text: `[1;32m${plain}[0m`,
  plain,
  terminator: 'newline'
});

/**
 * Every recorded entry, once the stream has flushed.
 *
 * *Awaited*, not slept on. This used to wait 60 ms and hope, which passes on a
 * quiet machine and fails on a busy one — it failed once in a full-suite run
 * and passed on its own twice straight afterwards, which is the signature of a
 * race rather than a bug. `close()` resolves when the last line is on disk.
 */
const entries = async (capture: SessionCapture): Promise<Record<string, unknown>[]> => {
  const file = capture.path;
  await capture.close();
  if (file === '' || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((row) => JSON.parse(row) as Record<string, unknown>);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-capture-'));
  problems = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/*
 * A capture exists so a pattern can be written against what the server actually
 * sent rather than against what another client's source suggests it might. That
 * only works if it keeps the escape sequences: the ANSI is a *confidence
 * signal* for the classifier, and a capture that stripped it would be a capture
 * you cannot develop the colour half of a rule against.
 */
describe('what a capture keeps', () => {
  it('keeps decoded text with its escape sequences intact', async () => {
    const capture = open();
    capture.text('[1;32mNewhaven[0m\r\n');
    const [, entry] = await entries(capture);
    expect(entry?.['k']).toBe('text');
    expect(String(entry?.['s'])).toContain('[1;32m');
  });

  /*
   * The bytes are the record everything else is checked against.
   *
   * `text` is already decoded and quirk-adjusted, so an argument about what the
   * server sent that is settled from it is settled from this client's own
   * interpretation. This is the one entry that survives being wrong about the
   * encoding — and it went unwritten for four phases because `bytes()` existed,
   * was documented in the file header, and was wired to nothing.
   */
  it('keeps the raw bytes off the socket, before decoding', async () => {
    const capture = open();
    // `b0 db` is the shade-and-block pair this server opens with: invalid UTF-8
    // and wrong in Latin-1, which is exactly why the undecoded form is kept.
    capture.bytes(Buffer.from([0xb0, 0xdb, 0xdb, 0xb1]));
    const [entry] = (await entries(capture)).filter((row) => row['k'] === 'in');
    expect(entry).toBeDefined();
    expect(Buffer.from(String(entry?.['raw']), 'base64')).toEqual(
      Buffer.from([0xb0, 0xdb, 0xdb, 0xb1])
    );
  });

  it('keeps a framed line both ways: what it says and what it looked like', async () => {
    const capture = open();
    capture.line(line('Newhaven Village Entrance'));
    const found = (await entries(capture)).find((entry) => entry['k'] === 'line');
    expect(found?.['s']).toBe('Newhaven Village Entrance');
    expect(String(found?.['raw'])).toContain('[1;32m');
    expect(found?.['term']).toBe('newline');
  });

  /* "Why did the bot do that" needs to know whether a person or a rule sent it. */
  it('records who sent a command, not only that one was sent', async () => {
    const capture = open();
    capture.out('n', 'user');
    capture.out('n', 'automation');
    const sent = (await entries(capture)).filter((entry) => entry['k'] === 'out');
    expect(sent.map((entry) => [entry['s'], entry['src']])).toEqual([
      ['n', 'user'],
      ['n', 'automation']
    ]);
  });

  it('stamps every entry with when it happened, relative to the start', async () => {
    const capture = open();
    capture.text('one');
    for (const entry of await entries(capture)) expect(typeof entry['t']).toBe('number');
  });
});

/*
 * The same property the session log has, and the more important one here: a
 * capture records *every outbound command verbatim*, so it grows faster and is
 * usually left on for a whole evening on purpose.
 */
describe('the size cap', () => {
  it('stops recording once the cap is reached', async () => {
    const capture = open(200);
    for (let i = 0; i < 50; i += 1) capture.text('x'.repeat(50));
    const written = await entries(capture);
    expect(written.length).toBeLessThan(10);
  });

  it('says so rather than going quiet', () => {
    const capture = open(200);
    for (let i = 0; i < 50; i += 1) capture.text('x'.repeat(50));
    expect(problems.join(' ')).toMatch(/size limit|no longer recording/i);
    void capture.close();
  });

  it('says it once, however much more arrives', () => {
    const capture = open(200);
    for (let i = 0; i < 200; i += 1) capture.text('x'.repeat(50));
    expect(problems).toHaveLength(1);
    void capture.close();
  });

  it('stays stopped for the rest of the session', async () => {
    const capture = open(200);
    for (let i = 0; i < 50; i += 1) capture.text('x'.repeat(50));
    capture.out('a-short-command');
    const written = await entries(capture);
    expect(written.some((entry) => entry['s'] === 'a-short-command')).toBe(false);
  });
});

/*
 * Capturing can never take the session down, for the same reason logging
 * cannot: a client that drops a character because a disk filled is worse than
 * one that stops recording.
 */
describe('when the filesystem will not cooperate', () => {
  /* A dial that never connected leaves no capture either. See `SessionLog`. */
  it('creates nothing until something is recorded', async () => {
    const capture = new SessionCapture({ directory: dir, maxBytes: 1024, onProblem: () => {} });
    capture.open(target, new Date(), 'vaelor');
    expect(fs.readdirSync(dir)).toEqual([]);
    await capture.close();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports a directory it cannot create, and does not throw', () => {
    const here: string[] = [];
    const capture = new SessionCapture({
      directory: path.join(dir, '\0nope'),
      maxBytes: 1024,
      onProblem: (message) => here.push(message)
    });
    // The file is created on the first record, so that is where a directory
    // that cannot be made is reported. See `SessionLog`'s twin of this.
    expect(() => capture.open(target, new Date(), 'vaelor')).not.toThrow();
    expect(here).toHaveLength(0);
    expect(() => capture.text('anything')).not.toThrow();
    expect(here.length).toBeGreaterThan(0);
    expect(() => capture.text('more')).not.toThrow();
    expect(here).toHaveLength(1);
  });

  it('ignores everything with nothing open', () => {
    const capture = new SessionCapture({ directory: dir, maxBytes: 1024 });
    expect(() => capture.text('x')).not.toThrow();
    expect(() => capture.out('n')).not.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
