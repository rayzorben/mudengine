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
}

/** One line of the face: a carried item, or a pile on the floor. */
export interface SellRow {
  key: string;
  from: SellFrom;
  thing: ItemEntity;
  /** How many the row is: one carried item, or the pile's count. */
  count: number;
  /** Main's answer for the name; null until it has answered. */
  choice: SellChoice | null;
}

/** The rows: what is carried unworn, then what lies in the room, open and searched. */
export function sellRows(character: CharacterState, choices: readonly SellChoice[]): SellRow[] {
  const choiceOf = (from: SellFrom, name: string): SellChoice | null =>
    choices.find((choice) => choice.from === from && sameItem(choice.name, name)) ?? null;
  const carried = character.inventory.items.filter((item) => !item.equipped);
  const floor = [...character.room.items, ...character.room.hidden];
  return [
    ...carried.map((thing, at) => ({
      key: `pack:${thing.name}:${at}`,
      from: 'pack' as const,
      thing,
      count: 1,
      choice: choiceOf('pack', thing.name)
    })),
    ...floor.map((thing, at) => ({
      key: `floor:${thing.name}:${at}`,
      from: 'floor' as const,
      thing,
      count: thing.count ?? 1,
      choice: choiceOf('floor', thing.name)
    }))
  ];
}

/** Whether a row can be picked: main has answered for it and nothing keeps it. */
export function sells(row: SellRow): row is SellRow & { choice: SellChoice } {
  return row.choice !== null && row.choice.kept === null;
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

/** The picked rows as main is asked for them: a name once, with how many of it. */
export function picksOf(rows: readonly SellRow[], picked: ReadonlySet<string>): SellPick[] {
  const picks = new Map<string, SellPick>();
  for (const row of rows) {
    if (!picked.has(row.key) || !sells(row)) continue;
    const key = sellKey(row.choice);
    const pick = picks.get(key);
    if (pick === undefined) {
      picks.set(key, { name: row.choice.name, from: row.from, count: row.count });
    } else pick.count += row.count;
  }
  return [...picks.values()];
}

/** What the picked rows pay together, in copper. */
export function paysOf(rows: readonly SellRow[], picked: ReadonlySet<string>): number {
  return rows.reduce(
    (sum, row) =>
      picked.has(row.key) && sells(row) ? sum + (row.choice.copper ?? 0) * row.count : sum,
    0
  );
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
