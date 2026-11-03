import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateHome } from '../Migration';
import { homeAt, type Home } from '../../app/home';
import { notesOf } from '../../app/copyMatch';

/** `theWalksBecameEachCharacters`: the shared recent walks became one list per character. */
describe('the recent walks became each character’s own', () => {
  const SHARED = {
    v: 1,
    realms: {
      paradigm: [
        { id: '1/1', name: 'Town Square', at: 5, visits: 2 },
        { id: '1/2', name: 'Bank', at: 4, visits: 1 }
      ],
      majormud: [{ id: '2/7', name: 'Silvermere Bank', at: 3, visits: 1 }],
      'gmud.zip': [{ id: '3/3', name: 'Arena', at: 2, visits: 1 }]
    }
  };

  let dir = '';
  let home: Home;
  let said: string[] = [];

  const migrate = (): void => {
    said = [];
    migrateHome({ home, legacyOptions: [], note: (message) => said.push(message) });
  };
  const write = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  // JSON.parse's own answer, read back by the assertions below.
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const profile = (id: string, server: string): void =>
    write(home.profile(id).file, `server: ${server}\n`);
  const shared = (): string => home.state('destinations.json');
  const backup = (): string => `${shared()}.before-characters`;
  const own = (id: string): string => home.record('destinations', id);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-walks-'));
    home = homeAt(path.join(dir, 'home'));
    write(home.server('paradigm').file, 'name: Paradigm\nhost: paramud.mudinfo.net\nport: 2323\n');
    write(
      home.server('majorbbs').file,
      'name: MajorBBS\nhost: majorbbs.example\nport: 23\ndatabase: majormud\n'
    );
    // Paradigm states no database, so its world is the one its address said.
    write(home.state('worlds.json'), {
      v: 1,
      realms: { 'paramud.mudinfo.net:2323': { world: 'paradigm', realm: 'paradigm', at: 1 } }
    });
    profile('rayzor', 'Paradigm');
    profile('soul', 'MajorBBS');
    write(shared(), SHARED);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives each character its own world's list, keeps the shared file as a backup, and runs once", () => {
    migrate();
    expect(read(own('rayzor')).realms).toEqual({ paradigm: SHARED.realms.paradigm });
    expect(read(own('soul')).realms).toEqual({ majormud: SHARED.realms.majormud });
    expect(fs.existsSync(shared())).toBe(false);
    // Every row, the Arena no character's world claims included, is still on disk.
    expect(read(backup())).toEqual(SHARED);
    expect(notesOf(said, 'notices.migration.walksBecameEachCharacters')).toHaveLength(1);

    const rayzor = fs.readFileSync(own('rayzor'), 'utf8');
    migrate();
    expect(notesOf(said, 'notices.migration.walksBecameEachCharacters')).toEqual([]);
    expect(fs.readFileSync(own('rayzor'), 'utf8')).toBe(rayzor);
    expect(read(backup())).toEqual(SHARED);
  });

  it('gives a character whose realm it cannot place every world, so it starts no emptier', () => {
    profile('drifter', 'Nowhere');
    migrate();
    expect(read(own('drifter')).realms).toEqual(SHARED.realms);
  });

  it('never writes over a list a character has, and seeds no directory without a character', () => {
    const kept = { v: 1, realms: { paradigm: [{ id: '9/9', name: 'Mine', at: 9, visits: 1 }] } };
    write(own('rayzor'), kept);
    fs.mkdirSync(home.profile('empty').dir, { recursive: true });
    migrate();
    expect(read(own('rayzor'))).toEqual(kept);
    expect(fs.existsSync(own('empty'))).toBe(false);
    expect(read(own('soul')).realms).toEqual({ majormud: SHARED.realms.majormud });
  });

  it('starts a character made after the move with no list of its own', () => {
    migrate();
    profile('newbie', 'Paradigm');
    migrate();
    expect(fs.existsSync(own('newbie'))).toBe(false);
  });

  it('leaves a shared file it cannot read where it is, and says so', () => {
    write(shared(), '{ not json');
    migrate();
    expect(fs.readFileSync(shared(), 'utf8')).toBe('{ not json');
    expect(fs.existsSync(backup())).toBe(false);
    expect(fs.existsSync(own('rayzor'))).toBe(false);
    expect(notesOf(said, 'notices.migration.walksUnread')).toHaveLength(1);
  });

  it('never writes over an earlier backup', () => {
    write(backup(), 'earlier');
    migrate();
    expect(fs.readFileSync(backup(), 'utf8')).toBe('earlier');
    expect(read(`${backup()}.2`)).toEqual(SHARED);
  });
});
