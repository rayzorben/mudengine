/**
 * Every tag a rewrite template may name, for the editor's completion, and the
 * addressing rules the editor's sidebar draws its rows by. Read off the
 * catalogue (`ENTITY_SPECS`) so what completes, what the sidebar lists and
 * what the console resolves cannot drift apart. `mudengine-ui` › *The
 * console*.
 */
import {
  CHARACTER_FIELDS,
  ENTITY_SPECS,
  ROW_FIELDS,
  type FieldSpec,
  type RewriteEntity
} from '@shared/rewrites';
import { ANSI_COLOURS, STYLE_CLOSERS, STYLE_TAGS } from '@shared/template';

/** A field's tag: `{weight}`, or `{me.hp}` under a record. */
export const tagOf = (prefix: string, key: string): string => `{${prefix}${key}}`;

/** What a list's row is addressed by: the name its `{for}` binds, `item.`. */
export const rowPrefix = (list: FieldSpec): string => `${list.row ?? ''}.`;

/** What a record's own fields are addressed by: the record under its prefix, `item.action.`. */
export const recordPrefix = (prefix: string, record: FieldSpec): string =>
  `${prefix}${record.key}.`;

/** The `{for}` that opens a list, with the row named. */
export const repeatTag = (list: FieldSpec, prefix = ''): string =>
  `{for ${list.row ?? ''} in ${prefix}${list.key}}`;

/** Where the character's own figures sit: at the top, or under `me.`. */
export const selfPrefix = (entity: RewriteEntity): string =>
  ENTITY_SPECS[entity].self === 'top' ? '' : 'me.';

/** A colour's tag, for the text or, with `ground`, behind it. */
export const colourTag = (colour: string, ground: boolean): string =>
  `{${ground ? 'bg:' : ''}${colour}}`;

/** A style's tag, `{bold}`, and the tag that ends it, `{/bold}`. */
export const styleTag = (style: string): string => `{${style}}`;
export const closerTag = (style: string): string => `{/${style}}`;

/**
 * The control tags as typed, each spelled once for the sidebar's buttons and
 * the completion; open where what follows is the player's: a test after
 * `{if `, a pattern after `{group `.
 */
export const CONTROL = {
  if: '{if ',
  elseIf: '{else if ',
  else: '{else}',
  endIf: '{/if}',
  for: '{for ',
  endFor: '{/for}',
  group: '{group ',
  table: '{table}',
  tableHeader: '{table header}',
  endTable: '{/table}'
} as const;

/** A field's tags: itself, or a record's own fields in its place, since a record draws nothing alone. */
function fieldTags(field: FieldSpec, prefix: string): string[] {
  if (field.kind !== 'record') return [tagOf(prefix, field.key)];
  return (field.fields ?? []).flatMap((inner) => fieldTags(inner, recordPrefix(prefix, field)));
}

/** Every tag a template for `entity` may name, each once, in the sidebar's order. */
export function templateTags(entity: RewriteEntity): string[] {
  const spec = ENTITY_SPECS[entity];
  const self = selfPrefix(entity);
  const lists = spec.fields.filter((field) => field.kind === 'list' && field.row !== undefined);
  const tags = [
    ...spec.fields.flatMap((field) => fieldTags(field, '')),
    ...lists.flatMap((list) => [
      repeatTag(list),
      ...(list.fields ?? []).flatMap((inner) => fieldTags(inner, rowPrefix(list)))
    ]),
    ...CHARACTER_FIELDS.flatMap((field) => fieldTags(field, self)),
    ...(lists.length > 0 ? ROW_FIELDS.flatMap((field) => fieldTags(field, '')) : []),
    ...ANSI_COLOURS.flatMap((colour) => [colourTag(colour, false), colourTag(colour, true)]),
    ...STYLE_TAGS.map(styleTag),
    ...STYLE_CLOSERS.map(closerTag),
    ...Object.values(CONTROL)
  ];
  return [...new Set(tags)];
}

/**
 * The tag being typed at `caret`: the open brace before it on the same line,
 * and what follows the brace, or null where the caret is not inside one.
 */
export function tagAt(text: string, caret: number): { from: number; typed: string } | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const from = text.lastIndexOf('{', caret - 1);
  if (from < lineStart) return null;
  const typed = text.slice(from, caret);
  return typed.includes('}') ? null : { from, typed };
}
