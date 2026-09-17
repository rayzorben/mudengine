/**
 * The editor one design opens in: its name, what it draws, the template,
 * and beside it every figure the template may name, each a press that puts
 * its tag at the caret. The listing is drawn under the template by the same
 * renderer the console uses, against a sample or the character's own
 * figures, so the preview and the console cannot disagree. A dialog over the
 * settings screen, in the file browser's box. `mudengine-settings` § The
 * Rewrites section is a list, and a design opens in an editor.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react';

import Icon from './Icon';
import Popup from './Popup';
import { CheckField, SelectField, TextField } from './FormField';
import { MARK_GLYPH } from './marks';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { ItemEntity } from '@shared/entities';
import { equipVerdict, type Wearer } from '@shared/gear';
import { readEffects } from '@shared/abilities';
import {
  CHARACTER_FIELDS,
  ENTITY_SPECS,
  DEFAULT_REWRITES,
  NO_EFFECTS,
  renderRewrite,
  REWRITE_ENTITIES,
  ROW_FIELDS,
  type FieldSpec,
  type ReadEffects,
  type RewriteDesign,
  type RewriteEntity,
  type RewriteFacts,
  type VitalBands
} from '@shared/rewrites';
import { STATLINE_MAX_CELLS, type StatlineFigures } from '@shared/statline';
import {
  ANSI_COLOURS,
  isAnsiColour,
  parseTemplate,
  type Drawn,
  type PlacedGlyph,
  type Segment
} from '@shared/template';
import type { TerminalPalette } from '@shared/themes';
import { quotedInCopper } from '@shared/coins';

export interface RewriteEditorProps {
  value: RewriteDesign;
  onChange(next: RewriteDesign): void;
  onClose(): void;
  palette: TerminalPalette;
  /** The character's own figures, or null to draw the sample. */
  figures: StatlineFigures | null;
  bands: VitalBands;
  /** The stem every control's name is built from. */
  idPrefix: string;
}

/* Literal calls, one per entity, so the dictionary's coverage test reads them. */
export const ENTITY_WORD: Record<RewriteEntity, string> = {
  statline: t('settings.rewrites.entities.statline'),
  inventory: t('settings.rewrites.entities.inventory'),
  who: t('settings.rewrites.entities.who'),
  shop: t('settings.rewrites.entities.shop'),
  party: t('settings.rewrites.entities.party'),
  experience: t('settings.rewrites.entities.experience')
};

const KIND_WORD: Record<FieldSpec['kind'], string> = {
  text: t('settings.rewrites.editor.sidebar.kindText'),
  number: t('settings.rewrites.editor.sidebar.kindNumber'),
  flag: t('settings.rewrites.editor.sidebar.kindFlag'),
  glyph: t('settings.rewrites.editor.sidebar.kindGlyph'),
  list: t('settings.rewrites.editor.sidebar.kindList'),
  record: t('settings.rewrites.editor.sidebar.kindRecord')
};

const ENTITY_OPTIONS = REWRITE_ENTITIES.map((entity) => ({
  value: entity,
  label: ENTITY_WORD[entity]
}));

/** The shipped template for an entity: what a new design starts from. */
export function shippedTemplate(entity: RewriteEntity): string {
  return DEFAULT_REWRITES.find((design) => design.entity === entity)?.template ?? '';
}

/** Where the caret goes after an insertion: an offset into the new text. */
interface Insertion {
  text: string;
  /** Offset within `text` to land the caret at; the end when absent. */
  caret?: number;
}

export default function RewriteEditor({
  value,
  onChange,
  onClose,
  palette,
  figures,
  bands,
  idPrefix
}: RewriteEditorProps): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);

  // The template is the whole point of opening this, so it takes the caret.
  useEffect(() => {
    area.current?.focus();
  }, []);

  // A press on the sidebar changed the template; once the value has drawn,
  // the caret lands after what was put in, and the field takes it back.
  useLayoutEffect(() => {
    if (caret.current === null) return;
    const node = area.current;
    if (node !== null) {
      node.focus();
      node.setSelectionRange(caret.current, caret.current);
    }
    caret.current = null;
  }, [value.template]);

  const insert = useCallback(
    (piece: Insertion | ((selected: string) => Insertion)): void => {
      const node = area.current;
      const start = node?.selectionStart ?? value.template.length;
      const end = node?.selectionEnd ?? start;
      const selected = value.template.slice(start, end);
      const { text, caret: at } = typeof piece === 'function' ? piece(selected) : piece;
      caret.current = start + (at ?? text.length);
      onChange({
        ...value,
        template: value.template.slice(0, start) + text + value.template.slice(end)
      });
    },
    [onChange, value]
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // The settings dialog behind handles Escape on the way past; without
    // this one keystroke would close the editor and the screen it sits on.
    event.stopPropagation();
    event.preventDefault();
    onClose();
  };

  /*
   * Changing what a design draws swaps in that entity's shipped template
   * where the old one was untouched: a pack template offered for the roster
   * names figures the roster does not have, and a blank is no start at all.
   */
  const chooseEntity = (entity: string): void => {
    if (entity === value.entity || !ENTITY_OPTIONS.some((option) => option.value === entity)) {
      return;
    }
    const chosen = entity as RewriteEntity;
    const untouched =
      value.template.trim().length === 0 || value.template === shippedTemplate(value.entity);
    onChange({
      ...value,
      entity: chosen,
      template: untouched ? shippedTemplate(chosen) : value.template
    });
  };

  const spec = ENTITY_SPECS[value.entity];
  const parsed = parseTemplate(value.template);
  const drawn = renderRewrite(value, sampleFacts(value.entity, figures), bands, t);
  const cells = drawn[0]?.cells ?? 0;
  const tooWide = spec.oneLine && cells > STATLINE_MAX_CELLS;
  const manyLines = spec.oneLine && value.template.includes('\n');
  const stem = `${idPrefix}-editor`;

  return (
    <div className="palette-scrim rewrite-editor-scrim" onMouseDown={onClose} role="presentation">
      <div
        aria-label={t('settings.rewrites.editor.ariaLabel')}
        aria-modal="true"
        className="surface palette rewrite-editor"
        data-owns-keys="true"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={frame}
        role="dialog"
        tabIndex={-1}
      >
        <header className="rewrite-editor-head settings-form">
          <div className="settings-inline">
            <TextField
              label={t('settings.rewrites.editor.nameLabel')}
              name={`${stem}-name`}
              onChange={(name) => onChange({ ...value, name })}
              placeholder={ENTITY_WORD[value.entity]}
              spellCheck={false}
              value={value.name}
            />
            <SelectField
              label={t('settings.rewrites.editor.entityLabel')}
              name={`${stem}-entity`}
              onChange={chooseEntity}
              options={ENTITY_OPTIONS}
              value={value.entity}
            />
            <CheckField
              checked={value.enabled}
              hint={t('settings.rewrites.editor.enabledHint')}
              label={t('settings.rewrites.editor.enabledLabel')}
              name={`${stem}-enabled`}
              onChange={(enabled) => onChange({ ...value, enabled })}
            />
          </div>
          <button
            aria-label={t('settings.rewrites.editor.done')}
            className="quiet rewrite-editor-done"
            onClick={onClose}
            onMouseDown={keepFocus}
            title={t('settings.rewrites.editor.done')}
            type="button"
          >
            <Icon name="check" />
            {t('settings.rewrites.editor.done')}
          </button>
        </header>

        <div className="rewrite-editor-body">
          <Sidebar entity={value.entity} insert={insert} palette={palette} />
          <div className="rewrite-main settings-form">
            <label className="settings-field settings-field-wide rewrite-template-field">
              <span>{t('settings.rewrites.editor.templateLabel')}</span>
              <textarea
                aria-describedby={`${stem}-template-hint`}
                className="rewrite-template"
                onChange={(event) => onChange({ ...value, template: event.target.value })}
                ref={area}
                rows={spec.oneLine ? 3 : 8}
                spellCheck={false}
                value={value.template}
                wrap="off"
              />
            </label>
            <p className="settings-note" id={`${stem}-template-hint`}>
              {t('settings.rewrites.editor.templateHint')}
            </p>
            {parsed.problems.map((problem) => (
              <p className="settings-warn" key={`${problem.kind}:${problem.tag}`}>
                {problem.kind === 'unclosed'
                  ? t('settings.rewrites.editor.problems.unclosed', { tag: problem.tag })
                  : problem.kind === 'stray'
                    ? t('settings.rewrites.editor.problems.stray', { tag: problem.tag })
                    : t('settings.rewrites.editor.problems.badTest', { tag: problem.tag })}
              </p>
            ))}
            <span className="settings-label">{t('settings.rewrites.editor.previewLabel')}</span>
            <Preview
              lines={drawn}
              palette={palette}
              {...(spec.oneLine ? { typed: t('settings.rewrites.editor.typed') } : {})}
            />
            {spec.oneLine && (
              <p className="settings-note">{t('settings.rewrites.editor.typedNote')}</p>
            )}
            {spec.oneLine &&
              (tooWide ? (
                <p className="settings-warn">
                  {t('settings.rewrites.editor.tooWide', { cells, max: STATLINE_MAX_CELLS })}
                </p>
              ) : (
                <p className="settings-note">
                  {t('settings.rewrites.editor.cells', { cells, max: STATLINE_MAX_CELLS })}
                </p>
              ))}
            {manyLines && <p className="settings-warn">{t('settings.rewrites.editor.oneLine')}</p>}
            {figures === null && (
              <p className="settings-note">{t('settings.rewrites.editor.previewSample')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────── the sidebar */

type Insert = (piece: Insertion | ((selected: string) => Insertion)) => void;

/** A field's tag, at the caret: `{weight}`, or `{me.hp}` under a record. */
const tagOf = (prefix: string, key: string): string => `{${prefix}${key}}`;

function Sidebar({
  entity,
  insert,
  palette
}: {
  entity: RewriteEntity;
  insert: Insert;
  palette: TerminalPalette;
}): React.JSX.Element {
  const spec = ENTITY_SPECS[entity];
  const selfPrefix = spec.self === 'top' ? '' : 'me.';
  const lists = spec.fields.filter((field) => field.kind === 'list' && field.row !== undefined);
  return (
    <aside className="rewrite-sidebar">
      {spec.fields.length > 0 && (
        <Category label={t('settings.rewrites.editor.sidebar.listing')} open>
          {spec.fields.map((field) => (
            <FieldRow field={field} insert={insert} key={field.key} prefix="" />
          ))}
        </Category>
      )}
      {/*
        Every figure a row of each list holds, written out under a heading of
        its own (todo 14).
        
        They were reachable only behind a chevron beside the list, and reported
        as *"it has {items} but I don't even see {item} in the list — it has
        weight, which is an item attribute, and that is not in the list
        either"*. A figure nobody can find is a figure the client does not
        offer, which is this project's own rule about a command. They are
        addressed through the row's name because that is what the `{for}` above
        them binds: `{for item in items}` and then `{item.weight}`.
      */}
      {lists.map((field) => (
        <Category key={field.key} label={t(`rewrites.rows.${field.key}`)}>
          <RepeatRow field={field} insert={insert} />
          {(field.fields ?? []).map((inner) => (
            <FieldRow
              field={inner}
              insert={insert}
              key={inner.key}
              prefix={`${field.row ?? ''}.`}
            />
          ))}
        </Category>
      ))}
      <Category label={t('settings.rewrites.editor.sidebar.character')} open={spec.self === 'top'}>
        {CHARACTER_FIELDS.map((field) => (
          <FieldRow field={field} insert={insert} key={field.key} prefix={selfPrefix} />
        ))}
      </Category>
      {lists.length > 0 && (
        <Category label={t('settings.rewrites.editor.sidebar.row')}>
          {ROW_FIELDS.map((field) => (
            <FieldRow field={field} insert={insert} key={field.key} prefix="" />
          ))}
        </Category>
      )}
      <Colours insert={insert} palette={palette} />
      <Controls insert={insert} />
    </aside>
  );
}

/** The `{for}` that opens a list, with the row named: what every figure under it is addressed by. */
function RepeatRow({ field, insert }: { field: FieldSpec; insert: Insert }): React.JSX.Element {
  const open = `{for ${field.row ?? ''} in ${field.key}}`;
  return (
    <button
      className="rewrite-tag"
      onClick={() =>
        insert((selected) => ({
          text: `${open}\n${selected}\n{/for}`,
          caret: `${open}\n`.length + selected.length
        }))
      }
      onMouseDown={keepFocus}
      title={t('settings.rewrites.editor.sidebar.repeatHint')}
      type="button"
    >
      <code>{open}</code>
      <span className="hint">{t('settings.rewrites.editor.sidebar.repeat')}</span>
    </button>
  );
}

function Category({
  label,
  open,
  children
}: {
  label: string;
  open?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <details className="rewrite-category" open={open}>
      <summary>{label}</summary>
      <div className="rewrite-category-body">{children}</div>
    </details>
  );
}

/**
 * One figure: a press puts its tag at the caret, and a list or record has a
 * second press opening its own fields beside it. The sentence about it is
 * the row's hint, from the dictionary by the figure's name.
 */
function FieldRow({
  field,
  insert,
  prefix
}: {
  field: FieldSpec;
  insert: Insert;
  prefix: string;
}): React.JSX.Element {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const tag = tagOf(prefix, field.key);
  const description = t(`rewrites.fields.${field.key}`);
  const dismiss = useCallback(() => setOpen(null), []);
  return (
    <div className="rewrite-field-row">
      <button
        className="rewrite-tag"
        onClick={() => insert({ text: tag })}
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.insertHint', { tag })}
        type="button"
      >
        <code>{tag}</code>
        <span className="hint">{description}</span>
        <span className="rewrite-kind">{KIND_WORD[field.kind]}</span>
      </button>
      {field.fields !== undefined && (
        <button
          aria-expanded={open !== null}
          aria-label={t('settings.rewrites.editor.sidebar.rowsOf', { tag })}
          className="quiet rewrite-more"
          onClick={(event: MouseEvent<HTMLButtonElement>) =>
            setOpen(open === null ? event.currentTarget : null)
          }
          onMouseDown={keepFocus}
          title={t('settings.rewrites.editor.sidebar.rowsOf', { tag })}
          type="button"
        >
          <Icon name="chevronRight" />
        </button>
      )}
      {open !== null && field.fields !== undefined && (
        <Popup
          at={open}
          className="popup-menu rewrite-popout"
          label={t('settings.rewrites.editor.sidebar.rowsOf', { tag })}
          onDismiss={dismiss}
          role="dialog"
        >
          {field.kind === 'list' && (
            <button
              className="entry"
              onClick={() => {
                dismiss();
                const open = `{for ${field.row ?? ''} in ${prefix}${field.key}}`;
                insert((selected) => ({
                  text: `${open}\n${selected}\n{/for}`,
                  caret: `${open}\n`.length + selected.length
                }));
              }}
              title={t('settings.rewrites.editor.sidebar.repeatHint')}
              type="button"
            >
              <Icon name="loop" />
              <span>
                {t('settings.rewrites.editor.sidebar.repeat')}{' '}
                <code>{`{for ${field.row ?? ''} in ${prefix}${field.key}}`}</code>
              </span>
            </button>
          )}
          {field.fields.map((inner) => {
            /*
             * A row's field is addressed through the name its `{for}` binds —
             * `{item.weight}` — and a record's through the record. One rule,
             * since a bound row *is* a record: the prefix is the only thing
             * that differs, and it is the list's own singular (`FieldSpec.row`).
             */
            const innerTag = tagOf(
              field.kind === 'list' ? `${field.row ?? ''}.` : `${prefix}${field.key}.`,
              inner.key
            );
            return (
              <button
                className="entry"
                key={inner.key}
                onClick={() => {
                  dismiss();
                  insert({ text: innerTag });
                }}
                title={t(`rewrites.fields.${inner.key}`)}
                type="button"
              >
                <code>{innerTag}</code>
                <span className="hint">{t(`rewrites.fields.${inner.key}`)}</span>
              </button>
            );
          })}
        </Popup>
      )}
    </div>
  );
}

/** The sixteen as swatches in the console's own palette, a colour of one's own, and the attributes. */
function Colours({
  insert,
  palette
}: {
  insert: Insert;
  palette: TerminalPalette;
}): React.JSX.Element {
  const [ground, setGround] = useState(false);
  const prefix = ground ? 'bg:' : '';
  return (
    <Category label={t('settings.rewrites.editor.sidebar.colours')}>
      <div className="rewrite-swatches" role="group">
        {ANSI_COLOURS.map((colour) => (
          <button
            aria-label={`{${prefix}${colour}}`}
            className="rewrite-swatch"
            key={colour}
            onClick={() => insert({ text: `{${prefix}${colour}}` })}
            onMouseDown={keepFocus}
            style={{ background: palette[colour] }}
            title={`{${prefix}${colour}}`}
            type="button"
          />
        ))}
      </div>
      <label className="rewrite-check">
        <input
          checked={ground}
          onChange={(event) => setGround(event.target.checked)}
          type="checkbox"
        />
        <span>{t('settings.rewrites.editor.sidebar.ground')}</span>
      </label>
      <label
        className="rewrite-tag rewrite-pick"
        title={t('settings.rewrites.editor.sidebar.pickColourHint')}
      >
        <input
          aria-label={t('settings.rewrites.editor.sidebar.pickColour')}
          onChange={(event) => insert({ text: `{${prefix}${event.target.value}}` })}
          type="color"
        />
        <span className="hint">{t('settings.rewrites.editor.sidebar.pickColour')}</span>
      </label>
      {['bold', 'dim', 'reset'].map((tag) => (
        <button
          className="rewrite-tag"
          key={tag}
          onClick={() => insert({ text: `{${tag}}` })}
          onMouseDown={keepFocus}
          type="button"
        >
          <code>{`{${tag}}`}</code>
        </button>
      ))}
      <span className="settings-label">{t('settings.rewrites.editor.sidebar.closers')}</span>
      <div className="rewrite-tag-row" title={t('settings.rewrites.editor.sidebar.closersHint')}>
        {['/colour', '/bg', '/bold', '/dim'].map((tag) => (
          <button
            className="rewrite-tag"
            key={tag}
            onClick={() => insert({ text: `{${tag}}` })}
            onMouseDown={keepFocus}
            type="button"
          >
            <code>{`{${tag}}`}</code>
          </button>
        ))}
      </div>
    </Category>
  );
}

/** The three controls, each wrapping whatever is selected, and the filters in one sentence. */
function Controls({ insert }: { insert: Insert }): React.JSX.Element {
  const wrap = (before: string, after: string, caretInside: number) =>
    insert((selected) => ({
      text: `${before}${selected}${after}`,
      caret: selected.length === 0 ? caretInside : before.length + selected.length
    }));
  return (
    <Category label={t('settings.rewrites.editor.sidebar.controls')}>
      <button
        className="rewrite-tag"
        onClick={() => wrap('{if }', '{/if}', '{if '.length)}
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.ifHint')}
        type="button"
      >
        <code>{'{if …}…{/if}'}</code>
      </button>
      <button
        className="rewrite-tag"
        onClick={() => insert({ text: '{else if }', caret: '{else if '.length })}
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.ifHint')}
        type="button"
      >
        <code>{'{else if …}'}</code>
      </button>
      <button
        className="rewrite-tag"
        onClick={() => insert({ text: '{else}' })}
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.ifHint')}
        type="button"
      >
        <code>{'{else}'}</code>
      </button>
      <button
        className="rewrite-tag"
        onClick={() => wrap('{for }\n', '\n{/for}', '{for '.length)}
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.forHint')}
        type="button"
      >
        <code>{'{for …}…{/for}'}</code>
      </button>
      <button
        className="rewrite-tag"
        onClick={() =>
          insert({
            text: '{group items matching "^token of " as tokens}\n',
            caret: '{group items matching "^'.length
          })
        }
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.groupHint')}
        type="button"
      >
        <code>{'{group …}'}</code>
      </button>
      <button
        className="rewrite-tag"
        onClick={() => wrap('{table}\n', '\n{/table}', '{table}\n'.length)}
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.tableHint')}
        type="button"
      >
        <code>{'{table}…{/table}'}</code>
      </button>
      <button
        className="rewrite-tag"
        onClick={() => wrap('{table header}\n', '\n{/table}', '{table header}\n'.length)}
        onMouseDown={keepFocus}
        title={t('settings.rewrites.editor.sidebar.tableHint')}
        type="button"
      >
        <code>{'{table header}…{/table}'}</code>
      </button>
      <p className="settings-note">{t('settings.rewrites.editor.sidebar.filtersHint')}</p>
    </Category>
  );
}

/* ───────────────────────────────────────────────── the sample listing */

/**
 * Figures for a page with no character in the realm — the Global page, or a
 * character that is not connected. Plausible rather than round, so the bands
 * have something to colour and a wide layout shows its width.
 */
export const SAMPLE_FIGURES: StatlineFigures = {
  hp: 120,
  hpMax: 156,
  mana: 17,
  manaMax: 28,
  exp: 1386670,
  need: 14402,
  wealth: 2350,
  state: null,
  name: 'Vaelor',
  fullName: 'Vaelor Stone',
  race: 'Human',
  className: 'Mystic',
  manaType: 'KAI',
  level: 12,
  room: 'Town Square',
  lives: 9,
  expSession: 12500,
  encumbrance: 1744,
  encumbranceMax: 4128,
  encumbranceWord: 'Medium'
};

const SAMPLE_WEARER: Wearer = {
  classId: 2,
  raceId: 1,
  level: 12,
  strength: 60,
  classNames: { 1: 'Warrior', 2: 'Mystic' },
  raceNames: { 1: 'Human' }
};

function sampleItem(
  name: string,
  realm: Partial<ItemEntity>,
  wire: { slot?: string; equipped?: boolean; charges?: number; count?: number } = {}
): ItemEntity {
  return {
    name,
    source: realm.id === undefined ? 'wire' : 'hybrid',
    slot: wire.slot ?? null,
    equipped: wire.equipped ?? false,
    charges: wire.charges ?? null,
    ...(wire.count === undefined ? {} : { count: wire.count }),
    ...realm
  };
}

const SAMPLE_PACK: ItemEntity[] = [
  sampleItem(
    'visored greathelm',
    { id: 1, encumbrance: 120, kind: 'armour', realmSlot: 'Head', armour: { ac: 4, dr: 1 } },
    { slot: 'Head', equipped: true }
  ),
  sampleItem(
    'shimmering longsword',
    {
      id: 2,
      encumbrance: 200,
      kind: 'weapon',
      realmSlot: 'Weapon Hand',
      weapon: { min: 4, max: 13 },
      /*
       * Real pairs, so `{item.effects}` previews as the realm words it: `AC`
       * and `Resist-Fire` are a magnitude and a percentage, which are the two
       * shapes a reader meets most. Invented figures on a real vocabulary,
       * like every other number in this sample.
       */
      abilities: [
        [2, 3],
        [5, 15]
      ]
    },
    { slot: 'Weapon Hand', equipped: true }
  ),
  sampleItem('golden battleaxe', {
    id: 3,
    encumbrance: 400,
    kind: 'weapon',
    realmSlot: 'Weapon Hand',
    weapon: { min: 8, max: 20 },
    classes: [1]
  }),
  sampleItem('padded gloves', {
    id: 4,
    encumbrance: 40,
    kind: 'armour',
    realmSlot: 'Hands',
    armour: { ac: 1, dr: 0 }
  }),
  sampleItem(
    'torch',
    { id: 5, encumbrance: 20, kind: 'light', realmSlot: 'Readied' },
    { count: 6 }
  ),
  sampleItem('token of Silvermere', { encumbrance: 0, notDroppable: false })
];

/**
 * The sample's own effects, read exactly as main reads a real pack's.
 *
 * Through `readEffects` rather than a written-out list, so the preview cannot
 * word an ability differently from the console: the sidebar teaches
 * `{item.effects}` off this.
 */
function sampleEffects(item: ItemEntity): ReadEffects {
  const pairs = item.abilities;
  if (pairs === undefined || pairs.length === 0) return NO_EFFECTS;
  return readEffects(pairs, { table: 'item', family: 'other' }, t);
}

/** The listing a design is previewed against: the character's own figures, and a sample of the rest. */
export function sampleFacts(entity: RewriteEntity, own: StatlineFigures | null): RewriteFacts {
  const figures = own ?? SAMPLE_FIGURES;
  switch (entity) {
    case 'statline':
      return { entity, figures };
    case 'inventory':
      return {
        entity,
        figures,
        pack: {
          items: SAMPLE_PACK.map((item) => ({
            item,
            verdict: equipVerdict(item, SAMPLE_WEARER, t),
            effects: sampleEffects(item)
          })),
          keys: ['bone key'],
          /*
           * The purse and the total agree, because the preview is what the
           * template teaches: `{wealthLong}` states the realm's own count and
           * `{wealth}` the realm's own `Wealth:` line (todo 04), and a sample
           * where the two disagreed would draw a purse that is not the number
           * beside it. 23 gold, 5 silver = 2350 copper.
           */
          coins: { gold: 23, silver: 5 },
          wealth: 2350,
          encumbrance: 1744,
          encumbranceMax: 4128,
          encumbranceWord: 'Medium'
        }
      };
    case 'who':
      return {
        entity,
        figures,
        rows: [
          {
            name: 'Vaelor',
            title: 'Kai Warrior',
            alignment: 'Good',
            gang: 'Mudengine',
            flags: 'S'
          },
          { name: 'Rand', title: 'Apprentice', alignment: null, gang: 'Mudengine', flags: null },
          { name: 'Beaver IzCoo', title: 'Squire', alignment: 'Seedy', gang: null, flags: null }
        ]
      };
    case 'shop': {
      const rows = [
        ['padded gloves', 3, '12 silver crowns', SAMPLE_PACK[3]!],
        ['golden battleaxe', 1, '18 gold crowns', SAMPLE_PACK[2]!],
        ['torch', 20, '5 copper farthings', SAMPLE_PACK[4]!]
      ] as const;
      return {
        entity,
        figures,
        rows: rows.map(([name, quantity, price, item]) => ({
          name,
          quantity,
          price,
          cost: quotedInCopper(price),
          note: null,
          item,
          verdict: equipVerdict(item, SAMPLE_WEARER, t),
          effects: sampleEffects(item)
        }))
      };
    }
    case 'party':
      return {
        entity,
        figures,
        rows: [
          {
            name: 'Vaelor',
            class: 'Mystic',
            health: 92,
            mana: 40,
            rank: 'Frontrank',
            flag: null,
            invited: false
          },
          {
            name: 'Soul',
            class: 'Warrior',
            health: 35,
            mana: null,
            rank: 'Backrank',
            flag: 'R',
            invited: false
          }
        ]
      };
    case 'experience':
      return {
        entity,
        figures,
        gain: { gained: 25, exp: 1386695, need: 14377, level: 12, expSession: 12525 }
      };
  }
}

/* ────────────────────────────────────────────────────────── the preview */

type Piece =
  { kind: 'text'; segment: Segment; text: string } | { kind: 'glyph'; glyph: PlacedGlyph };

/**
 * A drawn line as pieces to render: its runs, with each glyph's two blank
 * cells replaced by the glyph itself. Walked cell by cell, because the
 * blanks may have merged into the run before them.
 */
export function piecesOf(line: Drawn): Piece[] {
  const pieces: Piece[] = [];
  const glyphs = [...line.glyphs].sort((a, b) => a.x - b.x);
  let cells = 0;
  let next = 0;
  for (const segment of line.segments) {
    let text = '';
    const chars = [...segment.text];
    for (let i = 0; i < chars.length; i += 1) {
      const glyph = glyphs[next];
      if (glyph !== undefined && glyph.x === cells && chars[i] === ' ' && chars[i + 1] === ' ') {
        if (text.length > 0) pieces.push({ kind: 'text', segment, text });
        text = '';
        pieces.push({ kind: 'glyph', glyph });
        next += 1;
        cells += 2;
        i += 1;
        continue;
      }
      text += chars[i];
      cells += 1;
    }
    if (text.length > 0) pieces.push({ kind: 'text', segment, text });
  }
  return pieces;
}

export function Preview({
  lines,
  palette,
  typed
}: {
  lines: readonly Drawn[];
  palette: TerminalPalette;
  /**
   * A sample of what the player types, drawn after the last line in the state
   * that line ends in.
   *
   * Only the prompt row has one, because only the prompt row is shared with a
   * caret. A colour left standing at the end of a template is the one thing
   * about the row that cannot be seen otherwise — it has no text of its own to
   * wear — and not seeing it is how a `{cyan}` at the end reads as a tag that
   * does nothing.
   */
  typed?: string;
}): React.JSX.Element {
  const colourOf = (colour: string | null): string | undefined =>
    colour === null ? undefined : isAnsiColour(colour) ? palette[colour] : colour;
  /* The run the line ends in, zero-width or not; nothing drawn is plain ink. */
  const ending = lines[lines.length - 1]?.segments.at(-1);
  return (
    <output
      className="rewrite-preview"
      style={{ background: palette.background, color: palette.foreground }}
    >
      {lines.length === 0
        ? t('settings.rewrites.editor.previewEmpty')
        : lines.map((line, row) => {
            /*
             * Once, because the blank-row test is asked of the drawn pieces
             * rather than of the runs: a line whose only run is the template's
             * zero-width ending (`…{cyan}`) draws nothing, and a `<div>` with
             * no text in it has no height.
             */
            const pieces = piecesOf(line);
            return (
              <div key={row}>
                {pieces.map((piece, index) =>
                  piece.kind === 'glyph' ? (
                    <span
                      aria-label={piece.glyph.label}
                      className="rewrite-glyph"
                      dangerouslySetInnerHTML={{ __html: MARK_GLYPH[piece.glyph.icon] }}
                      data-mark={piece.glyph.icon}
                      key={index}
                      role="img"
                      title={piece.glyph.label}
                    />
                  ) : (
                    <span
                      key={index}
                      style={{
                        background: colourOf(piece.segment.bg),
                        color: colourOf(piece.segment.fg),
                        fontWeight: piece.segment.bold ? 700 : undefined,
                        opacity: piece.segment.dim ? 0.6 : undefined
                      }}
                    >
                      {piece.text}
                    </span>
                  )
                )}
                {pieces.length === 0 && !(typed && row === lines.length - 1) ? ' ' : null}
                {typed !== undefined && row === lines.length - 1 ? (
                  <span
                    className="rewrite-typed"
                    style={{
                      background: colourOf(ending?.bg ?? null),
                      color: colourOf(ending?.fg ?? null),
                      fontWeight: ending?.bold ? 700 : undefined,
                      opacity: ending?.dim ? 0.6 : undefined
                    }}
                  >
                    {typed}
                  </span>
                ) : null}
              </div>
            );
          })}
    </output>
  );
}
