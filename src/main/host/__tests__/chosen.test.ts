import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileUnderHome, PickedFiles } from '../chosen';

describe('a file the desktop dialog picked', () => {
  it('is the path the dialog last gave that window, and no other', () => {
    const picks = new PickedFiles();
    expect(picks.remember(1, '/home/me/hunting.json')).toBe('/home/me/hunting.json');
    expect(picks.chosen(1, '/home/me/hunting.json')).toBe('/home/me/hunting.json');
    expect(picks.chosen(1, '/etc/passwd')).toBeNull();
    expect(picks.chosen(2, '/home/me/hunting.json')).toBeNull();
  });

  it('is nothing once the dialog is dismissed or the window closes', () => {
    const picks = new PickedFiles();
    picks.remember(1, '/home/me/a.json');
    expect(picks.remember(1, null)).toBeNull();
    expect(picks.chosen(1, '/home/me/a.json')).toBeNull();
    picks.remember(1, '/home/me/b.json');
    picks.forget(1);
    expect(picks.chosen(1, '/home/me/b.json')).toBeNull();
  });
});

describe('a file a browser tab picked from the home', () => {
  let home = '';
  let elsewhere = '';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-chosen-home-'));
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-chosen-elsewhere-'));
    fs.mkdirSync(path.join(home, 'exports'));
    fs.writeFileSync(path.join(home, 'exports', 'soul.tar.gz'), 'x');
    fs.writeFileSync(path.join(elsewhere, 'secret.json'), '{}');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('is read from its real path when it is under the home', async () => {
    const file = path.join(home, 'exports', 'soul.tar.gz');
    expect(await fileUnderHome(home, file)).toBe(fs.realpathSync(file));
  });

  it('is refused outside the home before anything says whether it exists', async () => {
    expect(await fileUnderHome(home, path.join(elsewhere, 'secret.json'))).toBeNull();
    expect(await fileUnderHome(home, path.join(elsewhere, 'missing.json'))).toBeNull();
    expect(await fileUnderHome(home, path.join(home, '..', 'x.json'))).toBeNull();
  });

  it('is refused through a symlink that leads out of the home', async () => {
    const link = path.join(home, 'exports', 'out.json');
    fs.symlinkSync(path.join(elsewhere, 'secret.json'), link);
    expect(await fileUnderHome(home, link)).toBeNull();
  });

  it('says why when a file under the home cannot be found', async () => {
    await expect(fileUnderHome(home, path.join(home, 'gone.json'))).rejects.toThrow(/gone\.json/);
  });
});
