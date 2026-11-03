import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { HAZARD_ABILITY, abilityWound, spellWounds } from '../../../shared/abilities';
import { indexSpells } from '../buildRealm';
import { openRealm } from '../RealmSource';

/**
 * The spells whose heal column is 0 on a roll that can go below 0, in the two
 * world databases in `mdb/` and the shipped Paradigm (2026-11-03). A 0 column
 * takes the roll (`Spell.cs:1406`) and a heal below 0 wounds, so each is a
 * wound to `spellWounds`; they read as harmless before. Most are players'
 * heals whose roll climbs above 0 with the caster's level; none is cast by a
 * room, an exit or a room command. Skips where an archive is absent.
 */
const NEGATIVE_HEALS = [
  'merciful grace -25..25',
  'close wounds -20..-50',
  'sabre -10..-1',
  'dead heal -999..-999',
  'curing wind -40..30',
  'greater healing -30..0',
  'greater mend -20..0',
  'invigorate -4..3'
];

interface SpellRow {
  n: string;
  ab?: Array<[number, number]>;
  pw?: [number, number];
}

const census = (spells: readonly SpellRow[]): string[] =>
  spells
    .filter((spell) =>
      (spell.ab ?? []).some(
        ([ability, value]) =>
          ability === HAZARD_ABILITY.heal &&
          value === 0 &&
          abilityWound(ability, value, spell.pw) !== null
      )
    )
    .map((spell) => {
      expect(spellWounds({ abilities: spell.ab, power: spell.pw })).toBe(true);
      return `${spell.n} ${spell.pw?.[0]}..${spell.pw?.[1]}`;
    });

const archives = ['gmud', 'pmud'].filter((name) => fs.existsSync(`mdb/${name}.zip`));
const shipped = path.resolve('resources/world/paradigm.jsonl.gz');

describe('a heal column of 0 on a roll below 0', () => {
  it.each(archives)('wounds on %s, and these are all of them', (name) => {
    const source = openRealm(path.resolve(`mdb/${name}.zip`));
    try {
      expect(census(indexSpells(source))).toEqual(NEGATIVE_HEALS);
    } finally {
      source.close();
    }
  });

  it.runIf(fs.existsSync(shipped))('wounds on the shipped Paradigm', () => {
    const header = zlib.gunzipSync(fs.readFileSync(shipped)).toString().split('\n', 1)[0]!;
    const spells = (JSON.parse(header) as { spells?: SpellRow[] }).spells ?? [];
    expect(census(spells)).toEqual(NEGATIVE_HEALS);
  });
});
