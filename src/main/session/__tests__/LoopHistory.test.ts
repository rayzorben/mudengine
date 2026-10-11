import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LoopHistory } from '../LoopHistory';
import { tuning } from '../../app/tuning';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-recent-loops-'));
  file = path.join(dir, 'recent-loops', 'vaelor.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const every = (): boolean => true;

describe('the loops a character started by name', () => {
  it('lists the newest first, one row per loop', () => {
    const history = new LoopHistory(file, () => {});
    history.remember('Darkwood', 100);
    history.remember('Sewers', 200);
    history.remember('Darkwood', 300);
    expect(history.latest(every, 5)).toEqual(['Darkwood', 'Sewers']);
  });

  it('leaves out a loop the character no longer has, and keeps it in the file', () => {
    const history = new LoopHistory(file, () => {});
    history.remember('Darkwood', 100);
    history.remember('Gone', 200);
    expect(history.latest((name) => name !== 'Gone', 5)).toEqual(['Darkwood']);
    history.close();
    const again = new LoopHistory(file, () => {});
    expect(again.latest(every, 5)).toEqual(['Gone', 'Darkwood']);
  });

  it('keeps at most records.recentLoopsKept', () => {
    const history = new LoopHistory(file, () => {});
    const kept = tuning().records.recentLoopsKept;
    for (let at = 0; at <= kept; at += 1) history.remember(`loop ${at}`, at);
    expect(history.latest(every, kept + 1)).toHaveLength(kept);
  });

  it('says an unreadable file once and never writes over it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const said: string[] = [];
    const history = new LoopHistory(file, (message) => said.push(message));
    history.remember('Darkwood', 100);
    history.close();
    expect(said).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    // Positive control: the run itself still remembers.
    expect(history.latest(every, 5)).toEqual(['Darkwood']);
  });
});
