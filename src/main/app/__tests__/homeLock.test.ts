import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { claimHome, LOCK_FILE } from '../homeLock';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-lock-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const everybodyAlive = (): boolean => true;
const nobodyAlive = (): boolean => false;

describe('claimHome', () => {
  it('takes a home nobody holds, and writes who has it', () => {
    const claim = claimHome(root, 100, everybodyAlive);
    expect(claim.held).toBe(true);
    expect(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')).toBe('100\n');
  });

  it('refuses a home a running client holds, and says which', () => {
    claimHome(root, 100, everybodyAlive);
    const second = claimHome(root, 200, everybodyAlive);
    expect(second).toMatchObject({ held: false, by: 100 });
  });

  it('takes over a lock whose holder is gone, and says whose it was', () => {
    claimHome(root, 100, everybodyAlive);
    const second = claimHome(root, 200, nobodyAlive);
    expect(second).toMatchObject({ held: true, recovered: 100 });
    expect(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')).toBe('200\n');
  });

  it('takes over a lock that names nobody', () => {
    fs.writeFileSync(path.join(root, LOCK_FILE), 'not a pid');
    const claim = claimHome(root, 200, everybodyAlive);
    expect(claim).toMatchObject({ held: true, recovered: null });
  });

  it('releases only its own lock', () => {
    const first = claimHome(root, 100, everybodyAlive);
    if (!first.held) throw new Error('expected to hold the home');
    first.lock.release();
    expect(fs.existsSync(path.join(root, LOCK_FILE))).toBe(false);

    const second = claimHome(root, 200, everybodyAlive);
    expect(second.held).toBe(true);
    // The first holder's release is a no-op against a lock that is not its own.
    first.lock.release();
    expect(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')).toBe('200\n');
    first.lock.release();
  });

  it('creates the home if it does not exist yet', () => {
    const fresh = path.join(root, 'nested', 'home');
    expect(claimHome(fresh, 100, everybodyAlive).held).toBe(true);
    expect(fs.existsSync(path.join(fresh, LOCK_FILE))).toBe(true);
  });
});
