/**
 * Named card layouts: where every card is, saved under a name to put back
 * with one click from the rail head's Layouts menu, and written to a file and
 * read back from one. Pure; `hooks/useNamedLayouts.ts` keeps the list and
 * reads a stored or loaded layout through `layoutOf`. See `mudengine-ui` ›
 * `parts/cards.md`, *Named card layouts*.
 */
import { layoutFileValue, LAYOUT_FILE_KIND } from '@shared/cardLayoutFile';
import { isRecord } from '@shared/values';

import type { AutoLayoutApi, CardArrangement, CardLayout } from './cards';

/** One saved layout. The name is what the player typed, trimmed; it is the layout's identity. */
export interface NamedLayout {
  name: string;
  layout: CardArrangement;
}

/** The longest name kept; a longer one is cut there. */
export const LAYOUT_NAME_MAX = 40;

/** A name as kept: trimmed, inner runs of space made one, cut to `LAYOUT_NAME_MAX`; null when nothing is left. */
export function layoutName(typed: string): string | null {
  const name = typed.trim().replace(/\s+/g, ' ').slice(0, LAYOUT_NAME_MAX).trim();
  return name.length > 0 ? name : null;
}

/** Where every card is in `layout`, without what is set on each. */
export function arrangementOf(layout: CardLayout | CardArrangement): CardArrangement {
  const { rail, above, below, floats, away, sizes, spots, columns, rolled } = layout;
  return { rail, above, below, floats, away, sizes, spots, columns, rolled };
}

/** A value as JSON with every object's keys sorted, so two equal layouts compare equal whatever order they were written in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, field]) => [key, canonical(field)]));
}

/** A key that is the same for two arrangements exactly when every card is in the same place. */
export function arrangementKey(layout: CardLayout | CardArrangement): string {
  return JSON.stringify(canonical(arrangementOf(layout)));
}

/** The saved layout the cards stand in now, if one matches; the first by list order. */
export function shownLayout(
  layouts: readonly NamedLayout[],
  current: CardLayout | CardArrangement
): string | null {
  const key = arrangementKey(current);
  return layouts.find((entry) => arrangementKey(entry.layout) === key)?.name ?? null;
}

/** The list with `entry` saved: in the place of one with its name, else at the end. */
export function withLayout(layouts: readonly NamedLayout[], entry: NamedLayout): NamedLayout[] {
  const at = layouts.findIndex((saved) => saved.name === entry.name);
  return at < 0
    ? [...layouts, entry]
    : layouts.map((saved, index) => (index === at ? entry : saved));
}

/** The list without the layout called `name`. */
export function withoutLayout(layouts: readonly NamedLayout[], name: string): NamedLayout[] {
  return layouts.filter((saved) => saved.name !== name);
}

/** The text of a card layout file. */
export function layoutFileText(entry: NamedLayout): string {
  return `${JSON.stringify({ kind: LAYOUT_FILE_KIND, name: entry.name, layout: entry.layout }, null, 2)}\n`;
}

/** A saved layout before its arrangement is read: the name, and the layout as written. */
export interface WrittenLayout {
  name: string;
  layout: Readonly<Record<string, unknown>>;
}

/** One entry as stored or written to a file: a name and an object; null for anything else. */
export function writtenLayout(value: unknown): WrittenLayout | null {
  if (!isRecord(value) || typeof value['name'] !== 'string' || !isRecord(value['layout'])) {
    return null;
  }
  const name = layoutName(value['name']);
  return name === null ? null : { name, layout: value['layout'] };
}

/** A card layout file's text, read as far as its name and layout; null for anything that is not one. */
export function writtenLayoutFile(text: string): WrittenLayout | null {
  const value = layoutFileValue(text);
  return value === null ? null : writtenLayout(value);
}

/** The saved layouts, and the shown character's cards put where one has them. */
export interface NamedLayoutsApi {
  layouts: readonly NamedLayout[];
  /** The saved layout the shown character's cards stand in now; null when none matches. */
  shown: string | null;
  /** Save where the cards are now under `name`; the same name replaces it. */
  save(name: string): void;
  /** Put the cards where the layout called `name` has them. */
  apply(name: string): void;
  /** Keep `entry` in the list and put the cards where it has them: a layout loaded from a file. */
  adopt(entry: NamedLayout): void;
  remove(name: string): void;
}

/** What a file action did; null when the picker was dismissed. */
export type LayoutFileOutcome =
  | { kind: 'saved'; file: string }
  | { kind: 'loaded'; name: string }
  | { kind: 'refused'; error: string };

/** Card layouts to and from a file. */
export interface LayoutFilesApi {
  /** Write a saved layout to a file the player picks. */
  save(entry: NamedLayout): Promise<LayoutFileOutcome | null>;
  /** Write where the cards are now, under `name`. */
  saveShown(name: string): Promise<LayoutFileOutcome | null>;
  /** Read a file the player picks, keep it and put the cards where it has them. */
  load(): Promise<LayoutFileOutcome | null>;
}

/** Everything the rail head and the palette do to the whole rail: auto layout, the saved layouts, and their files. */
export interface RailLayoutsApi {
  auto: AutoLayoutApi;
  named: NamedLayoutsApi;
  files: LayoutFilesApi;
}
