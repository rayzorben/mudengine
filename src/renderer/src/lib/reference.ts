/**
 * The realm's answer to a lookup, as the rows every surface lists: what each
 * one is, the word in its chip, its key and its realm number. One reading for
 * the Reference card, its popover and the palette's *In the realm* rows.
 *
 * Out of `ReferenceDetail` (todo 733), so `lib/paletteFind.ts` reads it
 * without importing a component. See `mudengine-ui` › `parts/tables.md`.
 */
import { t } from './i18n';
import type { Numbered } from '@shared/entities';
import type { FightSummary } from '@shared/fights';
import { ITEM_KIND_WORD } from '@shared/items';
import type { MobLoreEntry } from '@shared/lore';
import type { RowPeace } from '@shared/mobRules';
import type { Verdict } from '@shared/verdict';
import type {
  MobPlaces,
  WorldClass,
  WorldItem,
  WorldLookup,
  WorldMob,
  WorldRace,
  WorldSpell
} from '@shared/world';

/** One thing the realm answered with, whatever kind of thing it is. */
export type ReferenceEntry =
  | {
      kind: 'mob';
      name: string;
      mob: WorldMob;
      learned: MobLoreEntry | null;
      fights: FightSummary | null;
      /** *Can I fight this?* — against the character as it stands; null when the realm cannot weigh it. */
      verdict: Verdict | null;
      /** Where the realm puts it; null where it puts it nowhere. See `MobPlaces`. */
      places: MobPlaces | null;
      /** The character's row saying it does not attack first; null where none does. */
      peace: RowPeace | null;
    }
  | { kind: 'item'; name: string; item: WorldItem }
  | { kind: 'spell'; name: string; spell: WorldSpell }
  | { kind: 'race'; name: string; race: WorldRace }
  | { kind: 'class'; name: string; className: WorldClass };

export function flattenLookup(found: WorldLookup): ReferenceEntry[] {
  return [
    ...found.mobs.map((mob): ReferenceEntry => ({
      kind: 'mob',
      name: mob.name,
      mob,
      learned: found.learned?.[mob.name] ?? null,
      fights: found.fights?.[mob.name] ?? null,
      verdict: found.verdicts?.[mob.name] ?? null,
      places: found.mobPlaces?.[mob.name] ?? null,
      peace: found.rowPeace?.[mob.name] ?? null
    })),
    ...found.items.map((item): ReferenceEntry => ({ kind: 'item', name: item.name, item })),
    ...found.spells.map((spell): ReferenceEntry => ({ kind: 'spell', name: spell.name, spell })),
    ...found.races.map((race): ReferenceEntry => ({ kind: 'race', name: race.name, race })),
    ...found.classes.map((entry): ReferenceEntry => ({
      kind: 'class',
      name: entry.name,
      className: entry
    }))
  ];
}

/**
 * The word in the chip beside a name: what kind of thing this is.
 *
 * An item says which *kind* of item when the realm knows — armour, weapon,
 * scroll — because "item" beside a broadsword is a label that says nothing.
 */
export function entryWord(entry: ReferenceEntry): string {
  if (entry.kind === 'mob') return t('cards.reference.kind.monster');
  if (entry.kind === 'spell') return t('cards.reference.kind.spell');
  if (entry.kind === 'race') return t('cards.reference.kind.race');
  if (entry.kind === 'class') return t('cards.reference.kind.class');
  return entry.item.kind === undefined
    ? t('cards.reference.kind.item')
    : ITEM_KIND_WORD[entry.item.kind];
}

/**
 * What identifies one row of the matches list.
 *
 * The realm names two spells `maelstrom` and two `magic armour` — its own rows
 * disagree about the level and one lookup returns both — so kind and name is
 * not a unique key. React handed a duplicate key loses the ability to delete
 * the older of the pair: the row stays in the document after the answer that
 * held it has gone. Typing `ma` and then narrowing to `magic miss` left those
 * two dead rows sitting above the two-row answer, with the highlight correctly
 * on a live row and the pointer over a corpse — which reads as the selection
 * being off by two.
 *
 * The position in the answer is what this list is addressed by everywhere else
 * — the highlight is an index, and hovering points at one — so it is what a row
 * is keyed by too, and a realm that repeats a name cannot break it.
 */
export function entryKey(entry: ReferenceEntry, index: number): string {
  return `${index}:${entry.kind}:${entry.name}`;
}

/**
 * The realm row a match is, whichever kind of thing it is.
 *
 * Four of the five kinds are looked up *as rows* and answer with their own
 * number: two spells named `maelstrom` come back as two entries, and four
 * `void sphere` rows as four. A monster is the exception — the fold is by
 * name, so it answers with `ids` and with the `row` a room settled it to.
 */
export function entryNumber(entry: ReferenceEntry): Numbered {
  switch (entry.kind) {
    case 'mob':
      return entry.mob;
    case 'item':
      return entry.item;
    case 'spell':
      return entry.spell;
    case 'race':
      return entry.race;
    case 'class':
      return entry.className;
  }
}
