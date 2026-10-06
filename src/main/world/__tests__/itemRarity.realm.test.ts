import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildRealm } from '../buildRealm';
import { rarityBook } from '../itemRarity';
import { openRealm } from '../RealmSource';
import { number, text } from '../values';
import { WorldGraph } from '../WorldGraph';

/**
 * Item rarity on orohost's world database (todo 13), converted the way a
 * player's realm is. The bands the todo measured with its prototype, the
 * summoner the katana's dropper is found by, and the chest odds against
 * MegaMUD's own `Items."Obtained From"`. Skips where the archive is absent.
 */
const archive = path.resolve('mdb/gmud.zip');
const available = fs.existsSync(archive);
let dir = '';
let world: WorldGraph | null = null;

beforeAll(() => {
  if (!available) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-rarity-'));
  const source = openRealm(archive);
  try {
    const built = buildRealm(source, '2026-10-05');
    const file = path.join(dir, 'gmud.jsonl.gz');
    const lines = [JSON.stringify(built.header), ...built.lines];
    fs.writeFileSync(file, zlib.gzipSync(lines.join('\n') + '\n'));
    world = WorldGraph.load(file);
  } finally {
    source.close();
  }
}, 120_000);

afterAll(() => {
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

const rarityOf = (name: string) => {
  const id = world!.itemIdNamed(name);
  expect(id, `${name} should be indexed`).not.toBeNull();
  return rarityBook(world!).of(id!);
};

describe.skipIf(!available)('item rarity on gmud.mdb', () => {
  it('rates the quarterstaff common, the katana very rare and the Manablade extremely rare', () => {
    expect(rarityOf('quarterstaff')).toMatchObject({ rarity: 'common' });
    expect(rarityOf('adamantite katana')).toMatchObject({ rarity: 'veryRare' });
    expect(rarityOf('adamantite katana').hours).toBeCloseTo(170);
    expect(rarityOf('Manablade')).toMatchObject({ rarity: 'extremelyRare' });
  });

  it('finds the weaponsmaster where the queen is, since her arrival summons him', () => {
    const smith = world!.mob('dark-elf weaponsmaster');
    expect(world!.summonersOf(smith!).map((mob) => mob.name)).toContain('dark-elf queen');
  });

  /*
   * MegaMUD states the chance of at least one copy a use; this is the copies a
   * use makes on average, so they agree where one roll gives it (913) and the
   * average is the higher wherever several rolls do. The 252 under MegaMUD's
   * figure are nested tables, where its model does not follow the server's
   * roll (`TextBlockPart.cs:911`). Pinned, so a change to either reading shows.
   */
  it('reads the chests as MegaMUD does wherever one roll gives the item', () => {
    const uses = new Map<number, ReadonlyMap<number, number>>();
    for (const { by, items } of world!.supply().runs)
      if (by.kind === 'use') uses.set(by.item, items);
    const source = openRealm(archive);
    let agree = 0;
    let below = 0;
    try {
      for (const row of source.table('Items')?.rows ?? []) {
        const item = number(row['Number']);
        for (const entry of text(row['Obtained From']).matchAll(/Item #(\d+)\(([\d.]+)%\)/g)) {
          const made = uses.get(Number(entry[1]));
          if (made === undefined || item === null) continue;
          const copies = (made.get(item) ?? 0) * 100;
          const stated = Number(entry[2]);
          if (Math.abs(copies - stated) <= 0.1) agree += 1;
          if (copies < stated - 0.1) below += 1;
        }
      }
    } finally {
      source.close();
    }
    expect({ agree, below }).toEqual({ agree: 913, below: 252 });
  });
});
