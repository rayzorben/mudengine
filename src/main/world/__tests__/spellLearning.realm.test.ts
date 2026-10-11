import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { LEARN_SPELL_ABILITY } from '../../../shared/abilities';
import { indexSpells } from '../buildRealm';
import { blocksInReach, spellsTaughtInReach } from '../indexQuests';
import { openRealm } from '../RealmSource';
import { abilityPairs, number, text } from '../values';

/**
 * Where a spell is learned (todo 71), against the export's own
 * `Spells."Learned From"` (`Item #N`, `NPC #N`, `Textblock #N`), which the
 * client does not read: the scrolls are `LearnSp` and the trainers are the
 * reached `learnspell` steps. Each archive's agreement is pinned, so a change
 * to either reading shows. Skips where an archive is absent.
 */
interface Agreement {
  claims: number;
  scrollsFound: number;
  teachersFound: number;
  missed: string[];
  beyond: number[];
}

function agreement(archive: string): Agreement {
  const source = openRealm(archive);
  try {
    const taught = spellsTaughtInReach(blocksInReach(source, indexSpells(source)));
    const mobNames = new Map<number, string>();
    for (const row of source.table('Monsters')?.rows ?? []) {
      const id = number(row['Number']);
      if (id !== null) mobNames.set(id, text(row['Name']).trim());
    }
    const scrolls = new Map<number, Set<number>>();
    for (const row of source.table('Items')?.rows ?? []) {
      const id = number(row['Number']);
      if (id === null) continue;
      for (const [ability, value] of abilityPairs(row)) {
        if (ability !== LEARN_SPELL_ABILITY) continue;
        scrolls.set(value, (scrolls.get(value) ?? new Set()).add(id));
      }
    }
    const result: Agreement = {
      claims: 0,
      scrollsFound: 0,
      teachersFound: 0,
      missed: [],
      beyond: []
    };
    const claimed = new Set<number>();
    for (const row of source.table('Spells')?.rows ?? []) {
      const spell = number(row['Number']);
      if (spell === null) continue;
      for (const [, kind, raw] of text(row['Learned From']).matchAll(
        /(Item|NPC|Textblock) #(\d+)/g
      )) {
        const id = Number(raw);
        result.claims++;
        claimed.add(spell);
        const from = taught.get(spell) ?? [];
        const found =
          kind === 'Item'
            ? (scrolls.get(spell)?.has(id) ?? false)
            : kind === 'NPC'
              ? from.some((place) => place.w === mobNames.get(id))
              : from.some((place) => place.k === 'room');
        if (!found) result.missed.push(`${spell} ${kind} #${id}`);
        else if (kind === 'Item') result.scrollsFound++;
        else result.teachersFound++;
      }
    }
    for (const spell of new Set([...taught.keys(), ...scrolls.keys()]))
      if (!claimed.has(spell)) result.beyond.push(spell);
    return result;
  } finally {
    source.close();
  }
}

/*
 * Every claim found, and the client's only extra sources are scrolls the
 * export leaves out because the item is not `In Game`: `scroll of protective
 * aura` (24) and `songsheet of destruction` (279).
 */
describe.each([
  ['gmud.zip', 292, [24, 279]],
  ['pmud.zip', 294, [24, 279]],
  ['majormud-v1.11p.zip', 239, [279]]
] as const)('where a spell is learned, %s', (name, claims, beyond) => {
  const archive = path.resolve('mdb', name);
  it.skipIf(!fs.existsSync(archive))('finds every source the export’s Learned From names', () => {
    const found = agreement(archive);
    expect(found.missed).toEqual([]);
    expect(found.claims).toBe(claims);
    expect(found.beyond).toEqual(beyond);
  });
});
