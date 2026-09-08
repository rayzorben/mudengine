import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  asShippedWorld,
  DEFAULT_SHIPPED_WORLD,
  readArchiveIdentity,
  SHIPPED_WORLD_LABEL,
  SHIPPED_WORLDS,
  shippedWorldFile,
  worldOfRealm
} from '../worlds';

/**
 * A shipped world is a closed union with three halves — the type, the list a
 * file's word is parsed against, and the label a person reads — and the type
 * is erased at runtime, so it is read out of its own source rather than
 * restated here. The same shape `realm.test.ts` keeps for the formula family.
 */
function unionMembers(): string[] {
  const source = fs.readFileSync(path.resolve('src/shared/worlds.ts'), 'utf8');
  const start = source.indexOf('export type ShippedWorld =');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([\w-]+)'/g)].map((match) => match[1]!);
}

describe('the worlds the client ships', () => {
  const declared = unionMembers();

  it('declares, accepts and labels exactly the same set', () => {
    expect(declared).toEqual(['majormud', 'paradigm']);
    expect([...SHIPPED_WORLDS].sort()).toEqual([...declared].sort());
    expect(Object.keys(SHIPPED_WORLD_LABEL).sort()).toEqual([...declared].sort());
    expect(SHIPPED_WORLDS).toContain(DEFAULT_SHIPPED_WORLD);
  });

  it('parses a world rather than casting one', () => {
    expect(asShippedWorld('paradigm')).toBe('paradigm');
    // A realm file is typed by hand; the case and the spaces are not the word.
    expect(asShippedWorld(' MajorMUD ')).toBe('majormud');
    expect(asShippedWorld('greatermud')).toBeNull();
    expect(asShippedWorld('/home/somebody/pmud.zip')).toBeNull();
    expect(asShippedWorld(undefined)).toBeNull();
  });

  it('keeps each world in a file named after it', () => {
    for (const world of SHIPPED_WORLDS) {
      expect(shippedWorldFile(world)).toBe(`${world}.jsonl.gz`);
    }
  });
});

describe("the world a realm's own word names", () => {
  it('reads the two menu prompts as the two worlds', () => {
    expect(worldOfRealm('majormud')).toBe('majormud');
    expect(worldOfRealm('paradigm')).toBe('paradigm');
  });

  it("reads a GreaterMUD server as Paradigm's data, which is what the one seen runs", () => {
    expect(worldOfRealm('greatermud')).toBe('paradigm');
  });

  it('names nothing until the realm has said anything', () => {
    expect(worldOfRealm(null)).toBeNull();
  });
});

describe('the archive a bundled world was built from', () => {
  const identity = { name: 'pmud.zip', size: 2_727_772, sha1: 'a'.repeat(40) };

  it('round-trips what the build wrote', () => {
    expect(readArchiveIdentity(identity)).toEqual(identity);
  });

  it('refuses a record with any field of the wrong shape', () => {
    expect(readArchiveIdentity({ ...identity, sha1: 'A'.repeat(40) })).toBeNull();
    expect(readArchiveIdentity({ ...identity, size: 0 })).toBeNull();
    expect(readArchiveIdentity({ ...identity, name: '' })).toBeNull();
    expect(readArchiveIdentity(null)).toBeNull();
    expect(readArchiveIdentity('pmud.zip')).toBeNull();
  });
});
