import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PlayerBook, realmAddress } from '../PlayerBook';
import type { PlayerFacts } from '../../../shared/players';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-players-'));
  file = path.join(dir, 'players.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes eagerly, which is what a test wants and a look does not. */
const store = (notify?: (message: string) => void): PlayerBook =>
  new PlayerBook({ file, saveDelayMs: 0, ...(notify ? { notify } : {}) });

const facts = (over: Partial<PlayerFacts> = {}): PlayerFacts => ({
  name: 'Soul',
  alignment: null,
  title: null,
  gang: null,
  level: null,
  race: null,
  className: null,
  gangRank: null,
  equipment: null,
  equipmentAt: null,
  lastRoom: null,
  lastRoomName: null,
  lastRoomAt: null,
  lastSeen: 1_000,
  vitals: null,
  vitalsAt: null,
  ...over
});

const GLOVES = [{ name: 'silk gloves', slot: 'Hands' }];

/** The turn the book notifies on. */
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('what a realm knows about its players', () => {
  it('knows nobody until told', () => {
    expect(store().forRealm('orohost:2427').recall()).toEqual([]);
  });

  it('recalls what it was told, and reads it back after a restart', () => {
    const first = store();
    first.forRealm('orohost:2427').remember(facts({ equipment: GLOVES, equipmentAt: 500 }));
    first.flush();

    const again = store().forRealm('orohost:2427').recall();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ name: 'Soul', equipment: GLOVES, equipmentAt: 500 });
  });

  /*
   * Soul on GreaterMUD is not Soul on a MajorMUD board, whatever map data
   * either ships — and two entries that dial one address are one realm.
   */
  it('keeps one realm’s players out of another’s, by the address dialled', () => {
    const book = store();
    book.forRealm(realmAddress({ host: 'Orohost', port: 2427 })).remember(facts());
    expect(book.forRealm(realmAddress({ host: 'orohost ', port: 2427 })).recall()).toHaveLength(1);
    expect(book.forRealm(realmAddress({ host: 'bbs.bearfather.net', port: 23 })).recall()).toEqual(
      []
    );
  });

  it('merges a later sighting into the record rather than keeping two', () => {
    const realm = store().forRealm('test');
    realm.remember(facts({ gang: 'Valor', lastSeen: 1_000 }));
    realm.remember(facts({ name: 'soul', equipment: GLOVES, equipmentAt: 2_000, lastSeen: 2_000 }));
    const [soul, ...rest] = realm.recall();
    expect(rest).toEqual([]);
    expect(soul).toMatchObject({ name: 'soul', gang: 'Valor', equipment: GLOVES, lastSeen: 2_000 });
  });

  /*
   * The sighting clock moves on every fold. A party listing that moved thirty
   * of them must not rewrite the file and push every other character's state,
   * so the later time is kept and written with the next real change, or on
   * quit — and told to nobody.
   */
  it('keeps a later sighting time without waking the disk or the other sessions', async () => {
    const book = store();
    const realm = book.forRealm('test');
    realm.remember(facts({ gang: 'Valor', lastSeen: 1_000 }));
    book.flush();
    // The first remember's own notification goes out this turn; let it.
    await turn();
    const heard: PlayerFacts[][] = [];
    realm.subscribe((batch) => heard.push([...batch]));

    realm.remember(facts({ gang: 'Valor', lastSeen: 2_000 }));
    await turn();
    expect(heard).toEqual([]);
    const read = () =>
      (
        JSON.parse(fs.readFileSync(file, 'utf8')) as {
          realms: Record<string, Record<string, { lastSeen: number }>>;
        }
      ).realms['test']?.['soul']?.lastSeen;
    expect(read()).toBe(1_000);
    expect(realm.recall()[0]?.lastSeen).toBe(2_000);

    book.flush();
    expect(read()).toBe(2_000);
  });

  it('does not touch the disk when nothing was news', () => {
    const book = store();
    const realm = book.forRealm('test');
    realm.remember(facts({ gang: 'Valor' }));
    book.flush();
    const stamp = fs.statSync(file).mtimeMs;

    realm.remember(facts({ gang: 'Valor' }));
    book.flush();
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
  });

  /*
   * It is the only copy of what every character on the realm has seen, and it
   * could have been edited. Sharing goes on; the disk is refused and that is
   * said out loud.
   */
  it('refuses to overwrite a file it cannot parse, says so once, and keeps sharing', () => {
    fs.writeFileSync(file, '{ this is not json');
    const said: string[] = [];
    const book = store((message) => said.push(message));
    const realm = book.forRealm('test');

    realm.remember(facts({ gang: 'Valor' }));
    realm.remember(facts({ name: 'Yang' }));
    book.flush();

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('will not parse');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ this is not json');
    expect(realm.recall()).toHaveLength(2);
  });

  /*
   * A file that cannot be *read* is as much the only copy as one that cannot
   * be parsed, and a book that wrote a fresh file over a transient `EACCES`
   * would lose the realm's whole record to five minutes of play.
   */
  it('refuses to write over a file it cannot read, and says so once', () => {
    fs.mkdirSync(file);
    const said: string[] = [];
    const book = store((message) => said.push(message));
    const realm = book.forRealm('test');

    realm.remember(facts({ gang: 'Valor' }));
    realm.remember(facts({ name: 'Yang' }));
    book.flush();

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('could not read');
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(realm.recall()).toHaveLength(2);
  });

  it('ignores an entry that names nobody, and files by the name inside the record', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        realms: { test: { ghost: {}, wrongkey: { name: 'Soul', gang: 'Valor', lastSeen: 5 } } }
      })
    );
    const realm = store().forRealm('test');
    expect(realm.recall()).toEqual([expect.objectContaining({ name: 'Soul', gang: 'Valor' })]);
    // Told about Soul again, it is one Soul.
    realm.remember(facts({ level: 6, lastSeen: 6 }));
    expect(realm.recall()).toHaveLength(1);
  });
});

describe('telling the other sessions on a realm', () => {
  it('hands every view the change, once per turn, whoever remembered it', async () => {
    const book = store();
    const vaelor = book.forRealm('test');
    const rand = book.forRealm('test');
    const heard: PlayerFacts[][] = [];
    const echoed: PlayerFacts[][] = [];
    rand.subscribe((batch) => heard.push([...batch]));
    vaelor.subscribe((batch) => echoed.push([...batch]));

    vaelor.remember(facts({ equipment: GLOVES, equipmentAt: 500 }));
    vaelor.remember(facts({ name: 'Yang', gang: 'Valor' }));
    vaelor.remember(facts({ name: 'Yang', gang: 'Valor', level: 3 }));
    expect(heard).toEqual([]);

    await turn();
    // Three remembers, two players, one call — Yang once, as they now stand.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toHaveLength(2);
    expect(heard[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Soul', equipment: GLOVES }),
        expect.objectContaining({ name: 'Yang', level: 3 })
      ])
    );
    // The origin hears it too: the book may have had something newer to add.
    expect(echoed).toHaveLength(1);
  });

  it('says nothing when nothing was news, and nothing to another realm', async () => {
    const book = store();
    const heard: PlayerFacts[][] = [];
    book.forRealm('test').remember(facts({ gang: 'Valor' }));
    await turn();
    book.forRealm('test').subscribe((batch) => heard.push([...batch]));
    book.forRealm('elsewhere').subscribe(() => {
      throw new Error('another realm was told');
    });

    book.forRealm('test').remember(facts({ gang: 'Valor' }));
    await turn();
    expect(heard).toEqual([]);
  });

  /*
   * Confirmed by probe before the fix: an unsubscribe closure that had already
   * emptied and deleted its realm's set, called again after a newer listener
   * had remade the set, deleted the new set — and the newer listener was told
   * nothing, silently. Sharing stopping with nothing said is the failure this
   * project singles out as worst.
   */
  it('does not let a stale unsubscribe silence a newer listener', async () => {
    const book = store();
    const stale = book.forRealm('test').subscribe(() => {});
    stale();
    const heard: PlayerFacts[][] = [];
    book.forRealm('test').subscribe((batch) => heard.push([...batch]));
    stale();

    book.forRealm('test').remember(facts());
    await turn();
    expect(heard).toHaveLength(1);
  });

  it('stops telling a view that has unsubscribed', async () => {
    const book = store();
    const heard: PlayerFacts[][] = [];
    const stop = book.forRealm('test').subscribe((batch) => heard.push([...batch]));
    stop();
    book.forRealm('test').remember(facts());
    await turn();
    expect(heard).toEqual([]);
  });
});
