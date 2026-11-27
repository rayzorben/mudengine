/**
 * The rows of the Reference panel's comparison (`WornBeside`): each figure
 * the item or anything worn in its slot gives, and which way is better. A
 * figure neither side gives is left out. Pure, so `ReferenceWorn` draws what
 * this says and decides nothing.
 */
import { damageRangeText, perRoundText } from './figures';
import { t } from './i18n';
import { abilityName } from '@shared/abilities';
import type { RealmFamily } from '@shared/character';
import { GEAR_WEIGHT_ABILITY, GEAR_WEIGHT_FIELDS } from '@shared/gearWeighing';
import { sameItem } from '@shared/items';
import { meanBlow, type SlotFigures } from '@shared/slotGear';
import type { BesideVerdict, WornBeside, WornPiece } from '@shared/wornBeside';

/** One side of the comparison: the item looked up or a worn piece. */
interface Side {
  figures: SlotFigures;
  weight: number | null;
  speed: number | null;
}

export interface BesideRow {
  key: string;
  label: string;
  /** The item's figure, then each worn piece's, in `beside.worn`'s order. */
  item: number | null;
  worn: Array<number | null>;
  /** How a side's figure is drawn (0 the item, then the worn pieces): a weapon's damage as its range. */
  text: (at: number) => string;
  /** Lower is better: weight, and a weapon's speed. */
  lower: boolean;
}

const plain = (value: number): string => String(value);

function sides(beside: WornBeside): Side[] {
  const item: Side = {
    figures: beside.item,
    weight: beside.item.weight,
    speed: beside.item.speed
  };
  return [item, ...(beside.worn ?? [])];
}

function row(
  key: string,
  label: string,
  all: readonly Side[],
  read: (side: Side) => number | null,
  options: { lower?: boolean; text?: (side: Side) => string } = {}
): BesideRow | null {
  const values = all.map(read);
  if (values.every((value) => value === null || value === 0)) return null;
  const [item = null, ...worn] = values;
  const text = options.text;
  return {
    key,
    label,
    item,
    worn,
    text: (at) => {
      const side = all[at];
      const value = values[at];
      if (side === undefined || value === undefined || value === null) return '';
      return text === undefined ? plain(value) : text(side);
    },
    lower: options.lower === true
  };
}

/** Every row the comparison draws, armour's figures or a weapon's first. */
export function besideRows(beside: WornBeside, family: RealmFamily | null): BesideRow[] {
  const all = sides(beside);
  const named = family === 'greatermud' ? 'greatermud' : 'other';
  const damage = (side: Side) => side.figures.damage;
  const weapon = [
    row('damage', t('cards.slotPeek.columnDamage'), all, (side) => meanBlow(damage(side)), {
      text: (side) => {
        const range = damage(side);
        return range === null ? '' : damageRangeText(range);
      }
    }),
    row('speed', t('cards.slotPeek.columnSpeed'), all, (side) => side.speed, { lower: true }),
    row(
      'round',
      t('cards.slotPeek.columnPerRound'),
      all,
      (side) => side.figures.perRound?.value ?? null,
      {
        text: (side) => {
          const value = side.figures.perRound?.value;
          return value === undefined ? '' : perRoundText(value);
        }
      }
    )
  ];
  const armour = [
    row('ac', t('cards.slotPeek.columnAc'), all, (side) => side.figures.figures.armourClass),
    ...GEAR_WEIGHT_FIELDS.map((field) =>
      row(
        field,
        field === 'damageResist'
          ? t('cards.slotPeek.columnDr')
          : (abilityName(GEAR_WEIGHT_ABILITY[field], named) ?? field),
        all,
        (side) => side.figures.figures.abilities[field]
      )
    )
  ];
  const worth =
    beside.ranking.by === 'armour'
      ? row('worth', t('cards.reference.item.beside.worth'), all, (side) => side.figures.worth, {
          text: (side) => (side.figures.worth === null ? '' : perRoundText(side.figures.worth))
        })
      : null;
  const weight = row('weight', t('cards.slotPeek.columnWeight'), all, (side) => side.weight, {
    lower: true
  });
  const rows =
    beside.ranking.by === 'weapon'
      ? [...weapon, ...armour, weight]
      : [worth, ...armour, ...weapon, weight];
  return rows.filter((each): each is BesideRow => each !== null);
}

/** The worn piece wearing the item replaces, by its place in `beside.worn`; -1 where none. */
export function replacedIndex(beside: WornBeside): number {
  const replaces = beside.replaces;
  if (replaces === null || beside.worn === null) return -1;
  return beside.worn.findIndex((piece: WornPiece) => sameItem(piece.name, replaces));
}

/** The item's figure less a worn piece's, and whether that is better; null where either is unknown. */
export function changeOf(
  entry: BesideRow,
  against: number
): { by: number; tone: BesideVerdict } | null {
  const theirs = entry.worn[against];
  if (entry.item === null || theirs === undefined || theirs === null) return null;
  const by = entry.item - theirs;
  const gain = entry.lower ? -by : by;
  return { by, tone: gain > 0 ? 'better' : gain < 0 ? 'worse' : 'same' };
}
