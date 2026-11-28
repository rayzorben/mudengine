/**
 * The rows of one worn piece's card beside the Reference panel (`WornBeside`):
 * every stat the piece or the item looked up states, the realm's columns and
 * every effect, each with both figures and the change where it is a number.
 * A stat neither states is left out. Pure: `ReferenceBeside` draws these
 * rows as they are.
 */
import { damageRangeText, perRoundText } from './figures';
import { t } from './i18n';
import { usesText } from './reference';
import {
  abilityIsMagnitude,
  abilityShape,
  MAGICAL_ABILITY,
  MIN_LEVEL_ABILITY,
  readEffects,
  type ReadEffect,
  type ReferredNames
} from '@shared/abilities';
import type { RealmFamily } from '@shared/character';
import { sameItem } from '@shared/items';
import { abilitySum } from '@shared/light';
import { meanBlow, type SlotFigures, type SlotRanking } from '@shared/slotGear';
import type { BesideVerdict, ComparedItem, WornBeside, WornPiece } from '@shared/wornBeside';

/** One side of a comparison: the item looked up, or the worn piece. */
export interface CompareSide {
  item: ComparedItem;
  figures: SlotFigures;
}

/** What the effects need to be named. */
export interface CompareNames {
  family: RealmFamily | null;
  classNames: Record<number, string>;
  referred: ReferredNames;
}

/** One stat: as drawn for each side, and the change where both are numbers. */
export interface CompareRow {
  key: string;
  label: string;
  /** As drawn; null where that side does not state it. */
  worn: string | null;
  item: string | null;
  /** The item's figure less the worn piece's, and whether that is better. */
  change: { by: number; tone: BesideVerdict | null } | null;
}

/** Which way a figure is better: up, down, or neither (a price). */
type Better = 'higher' | 'lower' | 'neither';

interface Figure {
  value: number | null;
  text?: string;
}

function toneOf(by: number, better: Better): BesideVerdict | null {
  if (better === 'neither') return null;
  const gain = better === 'lower' ? -by : by;
  return gain > 0 ? 'better' : gain < 0 ? 'worse' : 'same';
}

function figureRow(
  key: string,
  label: string,
  worn: Figure,
  item: Figure,
  better: Better
): CompareRow | null {
  if (worn.value === null && item.value === null) return null;
  const drawn = (side: Figure) => (side.value === null ? null : (side.text ?? String(side.value)));
  const by = worn.value === null || item.value === null ? null : item.value - worn.value;
  return {
    key,
    label,
    worn: drawn(worn),
    item: drawn(item),
    change: by === null ? null : { by, tone: toneOf(by, better) }
  };
}

function wordRow(
  key: string,
  label: string,
  worn: string | undefined,
  item: string | undefined
): CompareRow | null {
  if (worn === undefined && item === undefined) return null;
  return { key, label, worn: worn ?? null, item: item ?? null, change: null };
}

/** Armour's class and resistance: a zero the realm omits is a zero on armour, unknown on anything else. */
function armourFigure(item: ComparedItem, read: 'ac' | 'dr'): Figure {
  return { value: item.armour === undefined ? null : (item.armour[read] ?? 0) };
}

/** A weapon's speed, strength or accuracy: the realm omits a zero on a weapon, so it is a zero there. */
function weaponFigure(item: ComparedItem, read: 'speed' | 'strength' | 'accuracy'): Figure {
  return { value: item.weapon === undefined ? null : (item.weapon[read] ?? 0) };
}

/** The realm's own columns: what it stops, swings, weighs and costs. */
function columnRows(worn: CompareSide, item: CompareSide, ranking: SlotRanking): CompareRow[] {
  const range = (side: CompareSide): Figure => {
    const damage = side.figures.damage;
    return {
      value: meanBlow(damage),
      ...(damage === null ? {} : { text: damageRangeText(damage) })
    };
  };
  const round = (side: CompareSide): Figure => {
    const value = side.figures.perRound?.value ?? null;
    return { value, ...(value === null ? {} : { text: perRoundText(value) }) };
  };
  const worth = (side: CompareSide): Figure => {
    const value = side.figures.worth;
    return { value, ...(value === null ? {} : { text: perRoundText(value) }) };
  };
  const weapon = (side: CompareSide) => side.item.weapon;
  const rows = [
    ranking.by === 'armour'
      ? figureRow(
          'worth',
          t('cards.reference.item.beside.worth'),
          worth(worn),
          worth(item),
          'higher'
        )
      : figureRow('round', t('cards.slotPeek.columnPerRound'), round(worn), round(item), 'higher'),
    figureRow(
      'ac',
      t('cards.slotPeek.columnAc'),
      armourFigure(worn.item, 'ac'),
      armourFigure(item.item, 'ac'),
      'higher'
    ),
    figureRow(
      'dr',
      t('cards.slotPeek.columnDr'),
      armourFigure(worn.item, 'dr'),
      armourFigure(item.item, 'dr'),
      'higher'
    ),
    figureRow('damage', t('cards.slotPeek.columnDamage'), range(worn), range(item), 'higher'),
    figureRow(
      'speed',
      t('cards.slotPeek.columnSpeed'),
      weaponFigure(worn.item, 'speed'),
      weaponFigure(item.item, 'speed'),
      'lower'
    ),
    figureRow(
      'accuracy',
      t('cards.reference.item.beside.accuracy'),
      weaponFigure(worn.item, 'accuracy'),
      weaponFigure(item.item, 'accuracy'),
      'higher'
    ),
    figureRow(
      'strength',
      t('cards.reference.item.weapon.needsLabel'),
      weaponFigure(worn.item, 'strength'),
      weaponFigure(item.item, 'strength'),
      'lower'
    ),
    figureRow(
      'hands',
      t('cards.reference.item.beside.hands'),
      { value: weapon(worn)?.hands ?? null },
      { value: weapon(item)?.hands ?? null },
      'neither'
    ),
    wordRow(
      'skill',
      t('cards.reference.item.weapon.skillLabel'),
      weapon(worn)?.type,
      weapon(item)?.type
    ),
    wordRow(
      'material',
      t('cards.reference.item.armour.madeOfLabel'),
      worn.item.armour?.material,
      item.item.armour?.material
    )
  ];
  return rows.filter((row): row is CompareRow => row !== null);
}

/** A level gate is better lower; being magical is neither, as it only says who may use it. */
function betterOf(id: number): Better {
  if (id === MIN_LEVEL_ABILITY) return 'lower';
  if (id === MAGICAL_ABILITY) return 'neither';
  return 'higher';
}

/** Every effect either states, in the item's order and then the worn piece's. */
function effectRows(worn: CompareSide, item: CompareSide, names: CompareNames): CompareRow[] {
  const read = (side: CompareSide) =>
    readEffects(
      side.item.abilities ?? [],
      {
        table: 'item',
        family: names.family === 'greatermud' ? 'greatermud' : 'other',
        classNames: names.classNames,
        referred: names.referred
      },
      t
    );
  const theirs = read(worn);
  const ours = read(item);
  const byId = (effects: readonly ReadEffect[]) => new Map(effects.map((each) => [each.id, each]));
  const wornEffects = byId(theirs.shown);
  const itemEffects = byId(ours.shown);
  const ids = [...new Set([...itemEffects.keys(), ...wornEffects.keys()])];
  // A flag's presence is the fact, so a flag on one side is a word against nothing.
  const present = t('cards.reference.item.beside.present');
  const drawn = (effect: ReadEffect | undefined) =>
    effect === undefined ? undefined : effect.value.length > 0 ? effect.value : present;
  const rows = ids.map((id): CompareRow | null => {
    const label = (itemEffects.get(id) ?? wornEffects.get(id))?.label ?? String(id);
    if (!abilityIsMagnitude(abilityShape(id, 'item'))) {
      return wordRow(`effect-${id}`, label, drawn(wornEffects.get(id)), drawn(itemEffects.get(id)));
    }
    // A magnitude one side lacks is that side's zero: the realm states what an item has.
    const figure = (side: CompareSide, effect: ReadEffect | undefined): Figure => ({
      value: abilitySum(side.item.abilities ?? [], id),
      ...(effect === undefined ? {} : { text: effect.value })
    });
    return figureRow(
      `effect-${id}`,
      label,
      figure(worn, wornEffects.get(id)),
      figure(item, itemEffects.get(id)),
      betterOf(id)
    );
  });
  const unread = figureRow(
    'unread',
    t('cards.reference.item.beside.unread'),
    { value: theirs.quiet },
    { value: ours.quiet },
    'neither'
  );
  return [...rows, ...(theirs.quiet + ours.quiet > 0 ? [unread] : [])].filter(
    (row): row is CompareRow => row !== null
  );
}

/** What carrying it costs: weight, the realm's price and its uses. */
function burdenRows(worn: CompareSide, item: CompareSide): CompareRow[] {
  const uses = (side: CompareSide) => side.item.uses ?? null;
  const rows = [
    figureRow(
      'weight',
      t('cards.slotPeek.columnWeight'),
      { value: worn.item.encumbrance ?? null },
      { value: item.item.encumbrance ?? null },
      'lower'
    ),
    figureRow(
      'price',
      t('cards.room.shop.columnPrice'),
      { value: worn.item.price ?? null },
      { value: item.item.price ?? null },
      'neither'
    ),
    // `-1` is the realm saying for ever: a word, never a number to subtract.
    uses(worn) === -1 || uses(item) === -1
      ? wordRow('uses', t('cards.reference.item.usesLabel'), usesOf(uses(worn)), usesOf(uses(item)))
      : figureRow(
          'uses',
          t('cards.reference.item.usesLabel'),
          usesFigure(uses(worn)),
          usesFigure(uses(item)),
          'higher'
        )
  ];
  return rows.filter((row): row is CompareRow => row !== null);
}

function usesOf(uses: number | null): string | undefined {
  return uses === null ? undefined : usesText(uses);
}

function usesFigure(uses: number | null): Figure {
  return uses === null ? { value: null } : { value: uses, text: usesText(uses) };
}

/** Every stat of the worn piece against the item looked up. */
export function compareRows(
  worn: CompareSide,
  item: CompareSide,
  ranking: SlotRanking,
  names: CompareNames
): CompareRow[] {
  return [
    ...columnRows(worn, item, ranking),
    ...effectRows(worn, item, names),
    ...burdenRows(worn, item)
  ];
}

/** The worn piece wearing the item replaces, by its place in `beside.worn`; -1 where none. */
export function replacedIndex(beside: WornBeside): number {
  const replaces = beside.replaces;
  if (replaces === null || beside.worn === null) return -1;
  return beside.worn.findIndex((piece: WornPiece) => sameItem(piece.name, replaces));
}
