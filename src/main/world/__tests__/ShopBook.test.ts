import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ShopBook } from '../ShopBook';
import type { Shelf } from '../../../shared/shops';
import { t } from '../../app/i18n';

let dir = '';
let file = '';
let said: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-shops-'));
  file = path.join(dir, 'memory', 'shops-greatermud.json');
  said = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const book = (realm = 'greatermud'): ShopBook => new ShopBook(file, realm, (m) => said.push(m));

const shelf = (over: Partial<Shelf> = {}): Shelf => ({
  room: '1/12',
  shopName: "Jael's Missile Weapons",
  shop: 7,
  by: 'Vaelor',
  at: 1_757_000_000_000,
  items: [
    { name: 'shortbow', quantity: 25, price: '20 gold crowns', note: "You can't use" },
    { name: 'runed longbow', quantity: 1, price: '20 platinum pieces', note: null }
  ],
  ...over
});

describe('keeping a shop list', () => {
  it('replaces a room’s shelf whole, so a line no longer printed is gone', () => {
    const store = book();
    store.stock(shelf());
    store.stock(
      shelf({
        at: 2,
        items: [{ name: 'shortbow', quantity: 24, price: '20 gold crowns', note: null }]
      })
    );
    expect(store.all).toHaveLength(1);
    expect(store.all[0]!.items.map((item) => item.name)).toEqual(['shortbow']);
  });

  it('keeps a shop the realm records no id for, such as a gang house', () => {
    const store = book();
    store.stock(shelf({ room: '3/40', shop: null, shopName: 'Gang House Storeroom' }));
    store.stock(shelf());
    expect(store.all.map((kept) => kept.room)).toEqual(['3/40', '1/12']);
  });

  it('survives a restart', () => {
    const first = book();
    first.stock(shelf());
    first.close();
    expect(book().all).toEqual([shelf()]);
    expect(said).toEqual([]);
  });

  it('ignores a file kept for another realm', () => {
    const first = book('paradigm');
    first.stock(shelf());
    first.close();
    expect(book().all).toEqual([]);
    expect(said).toEqual([]);
  });

  it('says so, and keeps the file aside, when a row cannot be read', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, realm: 'greatermud', shelves: [{ room: 3 }] })
    );
    expect(book().all).toEqual([]);
    expect(said).toEqual([t('notices.world.shops.invalidFile', { fileName: path.basename(file) })]);
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
  });
});
