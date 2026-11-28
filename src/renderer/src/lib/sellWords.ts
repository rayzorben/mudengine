/**
 * The Sell face's rows and words, pure: the pack's unworn items and the
 * room's floor as rows joined to main's answer for each name, the picks a set
 * of rows comes to, and why a row cannot be picked.
 */
import { t } from './i18n';
import type { CharacterState } from '@shared/character';
import type { ItemEntity } from '@shared/entities';
import { sameItem } from '@shared/items';
import {
  sellKey,
  type SellChoice,
  type SellFrom,
  type SellKept,
  type SellPick
} from '@shared/sellRun';
import { roomAddress } from '@shared/world';
import type { IpcApi } from '@shared/ipc';

/** What the Sell face asks of main, addressed at its character. */
export interface SellDesk {
  load(): ReturnType<IpcApi['sellChoices']>;
  plan(picks: SellPick[]): ReturnType<IpcApi['sellPlan']>;
  go(picks: SellPick[]): ReturnType<IpcApi['sellRun']>;
  stop(): void;
  /** A bare `search` of the room, for what lies hidden in it. */
  search(): void;
}

/** One tile of the face: a name carried unworn, or a name lying in the room. */
export interface SellRow {
  /** `from` and the name, so a pick stays with its row however the pack is ordered. */
  key: string;
  from: SellFrom;
  thing: ItemEntity;
  /** How many there are: the unworn copies carried, or the piles' counts together. */
  count: number;
  /** Only a search shows it: the room does not list it in the open. */
  hidden: boolean;
  /** Main's answer for the name; null until it has answered. */
  choice: SellChoice | null;
}

/** How many of each row are picked, by the row's key. */
export type SellPicked = ReadonlyMap<string, number>;

/** The rows, a name once: what lies in the room, open then searched, then what is carried unworn. */
export function sellRows(character: CharacterState, choices: readonly SellChoice[]): SellRow[] {
  const rows: SellRow[] = [];
  const add = (thing: ItemEntity, from: SellFrom, count: number, hidden: boolean): void => {
    const row = rows.find((each) => each.from === from && sameItem(each.thing.name, thing.name));
    if (row !== undefined) {
      row.count += count;
      row.hidden = row.hidden && hidden;
      return;
    }
    const choice =
      choices.find((each) => each.from === from && sameItem(each.name, thing.name)) ?? null;
    rows.push({ key: sellKey({ name: thing.name, from }), from, thing, count, hidden, choice });
  };
  for (const item of character.room.items) add(item, 'floor', item.count ?? 1, false);
  for (const item of character.room.hidden) add(item, 'floor', item.count ?? 1, true);
  for (const item of character.inventory.items) if (!item.equipped) add(item, 'pack', 1, false);
  return rows;
}

/** Whether a row can be picked: main has answered for it and nothing keeps it. */
export function sells(row: SellRow): row is SellRow & { choice: SellChoice } {
  return row.choice !== null && row.choice.kept === null;
}

/** How many of a row are picked: never more than there are, none of a row that cannot go. */
export function pickedOf(row: SellRow, picked: SellPicked): number {
  return sells(row) ? Math.min(picked.get(row.key) ?? 0, row.count) : 0;
}

/** The picks with `row` set to `count` of it; none takes the row out. */
export function withPicked(picked: SellPicked, row: SellRow, count: number): SellPicked {
  const next = new Map(picked);
  const most = Math.max(0, Math.min(count, row.count));
  if (most === 0) next.delete(row.key);
  else next.set(row.key, most);
  return next;
}

/** Every row of `rows` that can go, picked whole; or none of them, where all already are. */
export function withAll(picked: SellPicked, rows: readonly SellRow[]): SellPicked {
  const sellable = rows.filter(sells);
  const every = sellable.length > 0 && sellable.every((row) => pickedOf(row, picked) === row.count);
  return sellable.reduce((next, row) => withPicked(next, row, every ? 0 : row.count), picked);
}

/** What the picks of one place weigh together; null where any picked row is unweighed. */
export function weightOf(
  rows: readonly SellRow[],
  picked: SellPicked,
  from: SellFrom
): number | null {
  let weight = 0;
  for (const row of rows) {
    const count = row.from === from ? pickedOf(row, picked) : 0;
    if (count === 0) continue;
    if (row.thing.encumbrance === undefined) return null;
    weight += count * row.thing.encumbrance;
  }
  return weight;
}

/** What changes main's answer: the unworn pack, the floor and the room. */
export function sellAskKey(character: CharacterState): string {
  const { room, inventory } = character;
  return [
    roomAddress(room) ?? '',
    ...inventory.items.map((item) => `${item.equipped ? '+' : ''}${item.name}`),
    '|',
    ...[...room.items, ...room.hidden].map((item) => `${item.count ?? 1} ${item.name}`)
  ].join('\u0001');
}

/** The picked rows as main is asked for them: a name, where it is and how many of it. */
export function picksOf(rows: readonly SellRow[], picked: SellPicked): SellPick[] {
  return rows.flatMap((row) => {
    const count = pickedOf(row, picked);
    return count === 0 || row.choice === null
      ? []
      : [{ name: row.choice.name, from: row.from, count }];
  });
}

/** What the picked rows pay together, in copper. */
export function paysOf(rows: readonly SellRow[], picked: SellPicked): number {
  return rows.reduce((sum, row) => sum + (row.choice?.copper ?? 0) * pickedOf(row, picked), 0);
}

/** Why a row cannot be picked. */
export function keptWords(kept: SellKept, quest: string | undefined): string {
  switch (kept) {
    case 'unknown-row':
      return t('cards.sell.kept.unknownRow');
    case 'several-rows':
      return t('cards.sell.kept.severalRows');
    case 'unpriced':
      return t('cards.sell.kept.unpriced');
    case 'no-counter':
      return t('cards.sell.kept.noCounter');
    case 'quest':
      return quest === undefined
        ? t('cards.sell.kept.questUnnamed')
        : t('cards.sell.kept.quest', { quest });
    case 'fixed':
      return t('cards.sell.kept.fixed');
    default: {
      const never: never = kept;
      return never;
    }
  }
}
