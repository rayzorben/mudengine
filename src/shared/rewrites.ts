/**
 * The listings the client draws in place of the realm's.
 *
 * A rewrite is a design the player named: an entity — the prompt row, the
 * pack, the roster, a shop's shelf, the party, the experience line — and one
 * template in the grammar of `template.ts`. Main gathers the facts, this lays
 * them out; every renderer here is pure. `ENTITY_SPECS` is the catalogue the
 * designer's sidebar is built from, so what a template may name and what
 * the console will resolve cannot drift apart. `mudengine-ui` § The console
 * is rewritten in one grammar, and a listing is rewritten only whole.
 */
import type { Denomination } from './character';
import { DENOMINATIONS } from './character';
import { copperSpread } from './coins';
import { entityNumber, type ItemEntity } from './entities';
import type { ReadEffect } from './abilities';
import type { EquipVerdict } from './gear';
import type { UiLookup } from './i18n';
import { countedLabel, ITEM_KIND_WORD } from './items';
import type { StatlineFigures } from './statline';
import {
  bandFor,
  renderTemplate,
  toAnsi,
  UNKNOWN,
  type ColourBand,
  type Drawn,
  type Figure,
  type Glyph,
  type Row,
  type Scope,
  type Value
} from './template';
import type { BlockType } from './blocks';
import type { MarkIcon, TerminalMark } from './types';

export const REWRITE_ENTITIES = [
  'statline',
  'inventory',
  'who',
  'shop',
  'party',
  'experience'
] as const;
export type RewriteEntity = (typeof REWRITE_ENTITIES)[number];

export function isRewriteEntity(value: unknown): value is RewriteEntity {
  return typeof value === 'string' && (REWRITE_ENTITIES as readonly string[]).includes(value);
}

/** The pairs read into words, and how many the client could not read. */
export interface ReadEffects {
  shown: readonly ReadEffect[];
  quiet: number;
}

/** Nothing read, for a row nobody has realm data for. */
export const NO_EFFECTS: ReadEffects = { shown: [], quiet: 0 };

/** One design the player keeps: what it redraws, and the template it draws. */
export interface RewriteDesign {
  /** The player's own name for it; blank draws the entity's word. */
  name: string;
  entity: RewriteEntity;
  enabled: boolean;
  template: string;
}

/** The colours a health or mana figure wears by its share of maximum, on every line. */
export interface VitalBands {
  hp: ColourBand[];
  mana: ColourBand[];
}

/* ─────────────────────────────────────────────────────── the catalogue */

export type FieldKind = 'text' | 'number' | 'flag' | 'glyph' | 'list' | 'record';

/** One figure a template may name, and for a list or record, what it holds. */
export interface FieldSpec {
  key: string;
  kind: FieldKind;
  fields?: readonly FieldSpec[];
  /**
   * What one row of a list is called, for `{for item in items}`.
   *
   * A list only. The singular is written down rather than derived from the
   * plural, for the reason nothing here guesses a rule from a name: `keys`
   * gives `key` and `droppedBy` gives nothing a rule would find. It is the
   * name the designer writes into the template and the one every row of that
   * list is addressed by, so the sidebar and the drawn line cannot disagree.
   */
  row?: string;
}

/** What an entity is: the blocks it replaces and the figures it offers. */
export interface EntitySpec {
  entity: RewriteEntity;
  /** The block types this rewrite draws in place of; none for the prompt row. */
  blocks: readonly BlockType[];
  /** The prompt row: one line, under the repaint's ceiling. */
  oneLine: boolean;
  /** The listing's own figures. */
  fields: readonly FieldSpec[];
  /** Where the character's own figures sit: at the top, or under `me`. */
  self: 'top' | 'me';
}

const text = (key: string): FieldSpec => ({ key, kind: 'text' });
const number = (key: string): FieldSpec => ({ key, kind: 'number' });
const flag = (key: string): FieldSpec => ({ key, kind: 'flag' });
const glyph = (key: string): FieldSpec => ({ key, kind: 'glyph' });
const list = (key: string, fields: readonly FieldSpec[], row: string): FieldSpec => ({
  key,
  kind: 'list',
  fields,
  row
});
const record = (key: string, fields: readonly FieldSpec[]): FieldSpec => ({
  key,
  kind: 'record',
  fields
});

/** The character's own figures, offered on every entity. */
export const CHARACTER_FIELDS: readonly FieldSpec[] = [
  text('name'),
  text('fullName'),
  text('race'),
  text('class'),
  number('level'),
  number('hp'),
  number('hpMax'),
  number('mana'),
  number('manaMax'),
  text('manaType'),
  number('exp'),
  number('need'),
  number('expSession'),
  number('lives'),
  number('wealth'),
  text('wealthLong'),
  text('room'),
  text('state'),
  flag('resting'),
  flag('meditating'),
  number('encumbrance'),
  number('encumbranceMax'),
  text('encumbranceWord')
];

/** What the realm data says about a kind of thing, beside what the listing said. */
const REALM_ITEM_FIELDS: readonly FieldSpec[] = [
  number('weight'),
  number('ac'),
  number('dr'),
  number('min'),
  number('max'),
  text('damage'),
  text('stats'),
  text('kind'),
  text('realmSlot'),
  number('speed'),
  number('strength'),
  number('accuracy'),
  text('weaponType'),
  number('hands'),
  text('material'),
  number('uses'),
  number('minLevel'),
  number('limit'),
  flag('gettable'),
  flag('droppable'),
  number('id'),
  number('number'),
  /*
   * What the realm says the thing *does*, read into words once
   * (`readEffects`): the alignment gates, the resistances, the grants, the
   * spell a weapon procs. The realm states no alignment column on an item —
   * the four gates are ability rows — so this is where an alignment
   * restriction appears, and inventing a field beside it would be a second
   * reading of one fact.
   */
  list('effects', [text('name'), text('value')], 'effect'),
  number('effectsUnread'),
  list('shops', [text('name')], 'shop'),
  list('droppedBy', [text('name')], 'dropper'),
  glyph('icon')
];

const CARRIED_FIELDS: readonly FieldSpec[] = [
  text('item'),
  text('name'),
  number('count'),
  text('slot'),
  text('equipped'),
  flag('worn'),
  flag('wearable'),
  text('reason'),
  number('price'),
  number('charges'),
  record('action', [glyph('toggleEquip'), glyph('drop')]),
  ...REALM_ITEM_FIELDS
];

const SOLD_FIELDS: readonly FieldSpec[] = [
  text('item'),
  text('name'),
  number('quantity'),
  text('price'),
  text('priceLong'),
  number('cost'),
  text('afford'),
  flag('short'),
  text('usable'),
  flag('wearable'),
  text('note'),
  number('basePrice'),
  ...REALM_ITEM_FIELDS
];

export const ENTITY_SPECS: Readonly<Record<RewriteEntity, EntitySpec>> = {
  statline: { entity: 'statline', blocks: [], oneLine: true, fields: [], self: 'top' },
  inventory: {
    entity: 'inventory',
    blocks: ['user-inventory'],
    oneLine: false,
    self: 'me',
    fields: [
      list('items', CARRIED_FIELDS, 'item'),
      number('itemCount'),
      list('keys', [text('name')], 'key'),
      number('keyCount'),
      number('wealth'),
      text('wealthLong'),
      number('runic'),
      number('platinum'),
      number('gold'),
      number('silver'),
      number('copper'),
      number('encumbrance'),
      number('encumbranceMax'),
      text('encumbranceWord'),
      number('encumbrancePercent')
    ]
  },
  who: {
    entity: 'who',
    blocks: ['who-list'],
    oneLine: false,
    self: 'me',
    fields: [
      list(
        'players',
        [text('name'), text('title'), text('alignment'), text('gang'), text('flags')],
        'player'
      ),
      number('count')
    ]
  },
  shop: {
    entity: 'shop',
    blocks: ['shop-list'],
    oneLine: false,
    self: 'me',
    fields: [list('items', SOLD_FIELDS, 'item'), number('count')]
  },
  party: {
    entity: 'party',
    blocks: ['party-roster', 'party-alone'],
    oneLine: false,
    self: 'me',
    fields: [
      list(
        'members',
        [
          text('name'),
          text('class'),
          number('health'),
          number('mana'),
          text('rank'),
          text('flag'),
          text('state'),
          flag('invited'),
          flag('resting'),
          flag('meditating')
        ],
        'member'
      ),
      number('count')
    ]
  },
  experience: {
    entity: 'experience',
    blocks: ['user-gain-experience'],
    oneLine: false,
    self: 'me',
    fields: [
      number('gained'),
      number('exp'),
      number('need'),
      number('level'),
      number('nextLevel'),
      number('expSession')
    ]
  }
};

/** The figures inside a repeated row, from `for`: its place, the list's length, and the ends. */
export const ROW_FIELDS: readonly FieldSpec[] = [
  number('n'),
  number('rows'),
  flag('first'),
  flag('last')
];

/** Every key a column may be named by, so the dictionary can be asked for exactly those. */
export function columnKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (fields: readonly FieldSpec[]): void => {
    for (const field of fields) {
      if (field.fields === undefined) continue;
      for (const inner of field.fields) {
        // A glyph is a picture and a record is a family of them: neither is a
        // column, and neither is ever the heading over one.
        if (inner.kind !== 'glyph' && inner.kind !== 'record') keys.add(inner.key);
        if (inner.fields !== undefined) walk([inner]);
      }
    }
  };
  for (const spec of Object.values(ENTITY_SPECS)) walk(spec.fields);
  walk([{ key: 'me', kind: 'record', fields: CHARACTER_FIELDS }]);
  for (const field of ROW_FIELDS) keys.add(field.key);
  return keys;
}

/**
 * The column's name over a table, for the figure that fills it. A figure the
 * dictionary has no word for is headed by its own name, so a template is
 * never refused for a column.
 */
export function columnLabel(t: UiLookup): (path: string) => string {
  const known = columnKeys();
  return (path) => {
    const key = path.split('.').pop() ?? path;
    return known.has(key) ? t(`rewrites.labels.${key}`) : key;
  };
}

/* ────────────────────────────────────────────────────── the shipped six */

/**
 * The shipped designs, every one off. The pack as a table is the one that
 * shows what the grammar can do: the equip control first, the realm's figures
 * beside the name, and the slot's picture at the end of the row.
 */
export const DEFAULT_REWRITES: readonly RewriteDesign[] = [
  {
    name: 'Status line',
    entity: 'statline',
    enabled: false,
    template:
      '{bold}{brightWhite}HP {hp}/{hpMax}{reset} {brightWhite}MA {mana}/{manaMax}{reset} ' +
      'Exp {exp} Need {need} ${wealth}{state}> '
  },
  {
    name: 'Pack',
    entity: 'inventory',
    enabled: false,
    template: [
      '{table header}',
      '{for item in items}',
      '{item.action.toggleEquip} {bold}{item}{/bold}  {dim}{item.weight}{/dim}  {item.stats}  {brightGreen}{item.equipped}{/brightGreen} {item.icon}',
      '{/for}',
      '{/table}',
      '{dim}Keys:{/dim} {keys|or:none}',
      '{dim}Wealth:{/dim} {brightYellow}{wealthLong}{/brightYellow}  ({wealth} copper)',
      '{dim}Load:{/dim} {encumbrance}/{encumbranceMax} {encumbranceWord}'
    ].join('\n')
  },
  {
    name: 'Roster',
    entity: 'who',
    enabled: false,
    template: [
      '{bold}{count} adventurers{/bold}',
      '{table header}',
      '{for player in players}',
      '{player.alignment}  {bold}{player.name}{/bold}  {player.title}  {dim}{player.gang}{/dim}  {player.flags}',
      '{/for}',
      '{/table}'
    ].join('\n')
  },
  {
    name: 'Shop shelf',
    entity: 'shop',
    enabled: false,
    template: [
      '{table header}',
      '{for item in items}',
      '{bold}{item}{/bold}  {dim}x{item.quantity}{/dim}  {item.priceLong}  {item.afford}  {item.usable}  {item.icon}',
      '{/for}',
      '{/table}'
    ].join('\n')
  },
  {
    name: 'Party',
    entity: 'party',
    enabled: false,
    template: [
      '{table header}',
      '{for member in members}',
      '{member.rank}  {bold}{member.name}{/bold}  {dim}{member.class}{/dim}  {member.health}%  {member.mana}%  {member.state}',
      '{/for}',
      '{/table}'
    ].join('\n')
  },
  {
    name: 'Experience',
    entity: 'experience',
    enabled: false,
    template:
      '{brightYellow}+{gained} exp{/brightYellow}  {exp} total, {need} to level {nextLevel}, ' +
      '{expSession} this session'
  }
];

/** The design that draws this entity: the first enabled one, or null. */
export function activeDesign(
  designs: readonly RewriteDesign[],
  entity: RewriteEntity
): RewriteDesign | null {
  return designs.find((design) => design.enabled && design.entity === entity) ?? null;
}

/**
 * The list with one design turned on or off. Turning one on turns off the
 * others for its entity: only one design draws a listing, and a list where
 * two are on would draw the first and leave the second looking chosen.
 */
export function withEnabled(
  designs: readonly RewriteDesign[],
  index: number,
  enabled: boolean
): RewriteDesign[] {
  const chosen = designs[index];
  if (chosen === undefined) return [...designs];
  return designs.map((design, at) => {
    if (at === index) return { ...design, enabled };
    if (enabled && design.entity === chosen.entity && design.enabled) {
      return { ...design, enabled: false };
    }
    return design;
  });
}

/* ────────────────────────────────────────────────────────── the facts */

/** The realm's word for a slot, as the listing prints it, to the picture the console has. */
const SLOT_ICON: Readonly<Record<string, MarkIcon>> = {
  'weapon hand': 'weapon',
  'off hand': 'offhand',
  head: 'head',
  hands: 'hands',
  finger: 'finger',
  feet: 'feet',
  arms: 'arms',
  back: 'back',
  neck: 'neck',
  legs: 'legs',
  waist: 'waist',
  torso: 'torso',
  wrist: 'wrist',
  ears: 'ears',
  face: 'face',
  readied: 'readied',
  worn: 'kit'
};

/** The picture for a slot's word, or null for a word the console has none for. */
export function slotIcon(slot: string | null | undefined): MarkIcon | null {
  if (!slot) return null;
  return SLOT_ICON[slot.trim().toLowerCase()] ?? null;
}

/** One carried thing with the verdict main reached about wearing it. */
export interface InventoryRow {
  item: ItemEntity;
  verdict: EquipVerdict;
  /**
   * The realm's ability pairs read into words (`readEffects`).
   *
   * Read by main beside the verdict, and for the same reason: naming an
   * ability needs the realm on the other end and the realm's own class table,
   * neither of which a pure renderer has.
   */
  effects: ReadEffects;
}

export interface InventoryFacts {
  items: readonly InventoryRow[];
  keys: readonly string[];
  /** The listing's own coin entries, by denomination. */
  coins: Partial<Record<Denomination, number>>;
  /** The server's `Wealth:` total, in copper. */
  wealth: number | null;
  encumbrance: number | null;
  encumbranceMax: number | null;
  encumbranceWord: string | null;
}

export interface WhoRow {
  name: string;
  title: string | null;
  alignment: string | null;
  gang: string | null;
  flags: string | null;
}

export interface ShopRow {
  name: string;
  quantity: number | null;
  /** Verbatim, as the counter said it. */
  price: string;
  /** The same in copper, or null where the words are not a price this client reads. */
  cost: number | null;
  note: string | null;
  /** The realm's row for the kind, joined by main; the wire half is the shelf's. */
  item: ItemEntity;
  verdict: EquipVerdict;
  /** What the realm says it does, read by main. See `InventoryRow.effects`. */
  effects: ReadEffects;
}

export interface PartyRow {
  name: string;
  class: string | null;
  /** Percentages, as the listing prints them. */
  health: number | null;
  mana: number | null;
  rank: string | null;
  flag: string | null;
  invited: boolean;
}

export interface ExperienceFacts {
  gained: number;
  /** The total after this gain, where the total was known. */
  exp: number | null;
  /** What the next level still costs after it, where that was known. */
  need: number | null;
  level: number | null;
  expSession: number | null;
}

/** What main gathered for one drawing, by entity; the character's figures come with every one. */
export type RewriteFacts =
  | { entity: 'statline'; figures: StatlineFigures }
  | { entity: 'inventory'; figures: StatlineFigures; pack: InventoryFacts }
  | { entity: 'who'; figures: StatlineFigures; rows: readonly WhoRow[] }
  | { entity: 'shop'; figures: StatlineFigures; rows: readonly ShopRow[] }
  | { entity: 'party'; figures: StatlineFigures; rows: readonly PartyRow[] }
  | { entity: 'experience'; figures: StatlineFigures; gain: ExperienceFacts };

/* ───────────────────────────────────────────────────────── the scopes */

/** A realm fact drawn blank where the realm has none: an absent weight is not a zero. */
function fact(value: number | string | null | undefined): number | string {
  return value === null || value === undefined ? '' : value;
}

/** A figure the wire should have stated: null draws `?`, never a zero. */
function figure(value: number | string | null | undefined): number | string | null {
  return value === undefined ? null : value;
}

function names(entries: readonly string[] | undefined): Row[] {
  return (entries ?? []).map((name) => ({ name }));
}

/**
 * `98 platinum, 22 gold, 6573 silver` — the purse, in the dictionary's words.
 *
 * **The realm's own count where it has stated one** (2026-09-12, todo 04). It
 * spread the copper total across the ladder, and the ladder is not what a
 * character carries: the server printed *98 platinum pieces, 22 gold crowns,
 * 6573 silver nobles* and the rewrite drew *1 runic, 4 platinum, 79 gold, 3
 * silver* — the same money, arranged into coins nobody has. A player reading
 * it to decide what to spend is reading a conversion, not their purse.
 *
 * `copperSpread` is kept for the case it is right for: the status line carries
 * a copper total and no denominations at all, so there is nothing to state and
 * the ladder is the only answer available. Which of the two is being drawn is
 * decided by whether anything was counted, never guessed.
 */
export function wealthLong(
  copper: number | null,
  t: UiLookup,
  counted?: Partial<Record<Denomination, number>>
): string {
  const stated = counted !== undefined && DENOMINATIONS.some((which) => (counted[which] ?? 0) > 0);
  if (!stated && copper === null) return UNKNOWN;
  const spread = stated ? counted : copperSpread(copper ?? 0);
  const parts = DENOMINATIONS.filter((which) => (spread[which] ?? 0) > 0).map(
    (which) => `${spread[which]} ${t(`rewrites.coins.${which}`)}`
  );
  return parts.length === 0 ? `0 ${t('rewrites.coins.copper')}` : parts.join(', ');
}

/** The character's own figures, health and mana wearing their bands. */
export function characterScope(figures: StatlineFigures, bands: VitalBands, t: UiLookup): Row {
  const banded = (
    value: number | null,
    max: number | null,
    list: readonly ColourBand[]
  ): Figure => ({
    text: value === null ? UNKNOWN : String(value),
    value,
    colour: bandFor(list, value, max)
  });
  return {
    name: figure(figures.name),
    fullName: figure(figures.fullName),
    race: figure(figures.race),
    class: figure(figures.className),
    level: figures.level,
    hp: banded(figures.hp, figures.hpMax, bands.hp),
    hpMax: figures.hpMax,
    mana: banded(figures.mana, figures.manaMax, bands.mana),
    manaMax: figures.manaMax,
    manaType: fact(figures.manaType),
    exp: figures.exp,
    need: figures.need,
    expSession: figures.expSession,
    lives: figures.lives,
    wealth: figures.wealth,
    wealthLong: wealthLong(figures.wealth, t),
    room: figures.room,
    state: {
      text:
        figures.state === 'resting'
          ? ' (Resting)'
          : figures.state === 'meditating'
            ? ' (Meditating)'
            : '',
      value: figures.state
    },
    resting: figures.state === 'resting',
    meditating: figures.state === 'meditating',
    encumbrance: figures.encumbrance,
    encumbranceMax: figures.encumbranceMax,
    encumbranceWord: fact(figures.encumbranceWord)
  };
}

/**
 * What can be done with a thing, as glyphs the console draws over the line.
 *
 * A record rather than one figure (todo 14): `{action.toggleEquip}` is the
 * equip gate that was `{action}`, and `{action.drop}` puts the thing down.
 * They are a family because the question *what can I do with this* has more
 * than one answer, and a template that could only ask for the first had no
 * way to say so.
 *
 * Each is a **button only where the realm names the exact command**: the
 * equip gate already decides that (`equipVerdict`), and a thing the realm
 * marks `Not Droppable` draws a statement with the reason instead. The rule
 * `TerminalMark.actions` states — never a button that sends a command the
 * server will refuse out loud in the room — applies to both.
 */
function actionsOf(item: ItemEntity, verdict: EquipVerdict, t: UiLookup): Row {
  const toggle = actionGlyph(verdict);
  return {
    toggleEquip:
      toggle === null
        ? { text: '' }
        : { text: '', glyph: toggle, colour: verdict.state === 'blocked' ? 'yellow' : null },
    drop:
      item.notDroppable === true
        ? { text: '', glyph: { icon: 'kept', label: t('rewrites.item.notDroppable') } }
        : {
            text: '',
            glyph: {
              icon: 'drop',
              label: t('rewrites.item.drop', { itemName: item.name }),
              commands: [`drop ${item.name}`]
            }
          }
  };
}

/** The glyph for the equip gate, as the pack card draws it; null where there is nothing to draw. */
function actionGlyph(verdict: EquipVerdict): Glyph | null {
  switch (verdict.state) {
    case 'worn':
    case 'wearable': {
      const icon = verdict.state === 'worn' ? 'worn' : 'wear';
      // No command, no button: a blank would go out as a bare Enter, which
      // is the client's own room re-read.
      return verdict.command === null
        ? { icon, label: verdict.label }
        : { icon, label: verdict.label, commands: [verdict.command] };
    }
    case 'blocked':
      return { icon: 'blocked', label: verdict.label };
    case 'none':
      return null;
  }
}

/** The armour's figures, or the weapon's, or nothing: what the realm's row can say in one cell. */
function statsOf(item: ItemEntity): string {
  if (item.armour !== undefined && (item.armour.ac !== undefined || item.armour.dr !== undefined)) {
    return `${fact(item.armour.ac)}/${fact(item.armour.dr)}`;
  }
  if (item.weapon !== undefined) return `${item.weapon.min}-${item.weapon.max}`;
  return '';
}

/**
 * What the realm data says about a kind of thing; blank where it says nothing.
 *
 * `effects` is handed in rather than read here: naming an ability needs the
 * realm on the other end and the realm's own class table, and both are main's
 * (`Rewriter.gather`), exactly as the equip verdict beside it is.
 */
function realmFields(item: ItemEntity, slot: string | null, effects: ReadEffects): Row {
  const icon = slotIcon(slot);
  return {
    weight: fact(item.encumbrance),
    ac: fact(item.armour?.ac),
    dr: fact(item.armour?.dr),
    min: fact(item.weapon?.min),
    max: fact(item.weapon?.max),
    damage: item.weapon === undefined ? '' : `${item.weapon.min}-${item.weapon.max}`,
    stats: statsOf(item),
    kind: item.kind === undefined ? '' : ITEM_KIND_WORD[item.kind],
    realmSlot: fact(item.realmSlot),
    speed: fact(item.weapon?.speed),
    strength: fact(item.weapon?.strength),
    accuracy: fact(item.weapon?.accuracy),
    weaponType: fact(item.weapon?.type),
    hands: fact(item.weapon?.hands),
    material: fact(item.armour?.material),
    uses: fact(item.uses),
    minLevel: fact(item.minLevel),
    limit: fact(item.limit),
    gettable: item.gettable ?? null,
    // The realm records only the refusal, so absent is droppable — the same
    // rule `gettable` keeps, and the reason `drop` is offered on a thing the
    // realm says nothing about.
    droppable: item.notDroppable !== true,
    id: fact(item.id),
    /*
     * The row the realm would answer for *this* thing, which is not `id`: a
     * name several rows share settles to none (`entityNumber`), and picking
     * one would be the guess the reference list refuses to make.
     */
    number: fact(entityNumber(item)),
    effects: effects.shown.map((effect) => ({ name: effect.label, value: effect.value })),
    effectsUnread: effects.quiet,
    shops: names(item.shops),
    droppedBy: names(item.droppedBy),
    icon: icon === null ? { text: '' } : { text: '', glyph: { icon, label: slot ?? '' } }
  };
}

/** The listing's own annotation for a thing in use — `(Head)`, `(Readied/79)` — or nothing. */
function equippedText(item: ItemEntity): string {
  if (!item.equipped || item.slot === null) return '';
  return item.charges === null ? `(${item.slot})` : `(${item.slot}/${item.charges})`;
}

export function carriedRow(row: InventoryRow, t: UiLookup): Row {
  const { item, verdict } = row;
  const slot = item.slot ?? item.realmSlot ?? null;
  return {
    item: countedLabel(item),
    name: item.name,
    count: item.count ?? 1,
    slot: slot ?? '',
    equipped: equippedText(item),
    worn: item.equipped,
    wearable: verdict.state === 'wearable' || verdict.state === 'worn',
    reason: verdict.state === 'blocked' ? verdict.label : '',
    price: fact(item.price),
    charges: fact(item.charges),
    action: actionsOf(item, verdict, t),
    ...realmFields(item, slot, row.effects)
  };
}

export function inventoryScope(facts: InventoryFacts, t: UiLookup): Row {
  const coins: Record<string, Value> = {};
  for (const which of DENOMINATIONS) coins[which] = facts.coins[which] ?? 0;
  const percent =
    facts.encumbrance !== null && facts.encumbranceMax !== null && facts.encumbranceMax > 0
      ? Math.round((100 * facts.encumbrance) / facts.encumbranceMax)
      : null;
  return {
    items: facts.items.map((row) => carriedRow(row, t)),
    itemCount: facts.items.length,
    keys: names(facts.keys),
    keyCount: facts.keys.length,
    ...coins,
    wealth: facts.wealth,
    wealthLong: wealthLong(facts.wealth, t, facts.coins),
    encumbrance: facts.encumbrance,
    encumbranceMax: facts.encumbranceMax,
    encumbranceWord: fact(facts.encumbranceWord),
    encumbrancePercent: percent
  };
}

export function whoScope(rows: readonly WhoRow[]): Row {
  return {
    players: rows.map((who) => ({
      name: who.name,
      title: fact(who.title),
      alignment: fact(who.alignment),
      gang: fact(who.gang),
      flags: fact(who.flags)
    })),
    count: rows.length
  };
}

export function shopScope(rows: readonly ShopRow[], wealth: number | null, t: UiLookup): Row {
  return {
    items: rows.map((sold) => {
      const short = wealth !== null && sold.cost !== null && sold.cost > wealth;
      return {
        item: sold.name,
        name: sold.name,
        quantity: fact(sold.quantity),
        price: sold.price,
        /*
         * The counter's price on the coin ladder, richest coins first: `50003
         * gold crowns` is `5 runic, 3 gold`. The counter's own words where it
         * said nothing the ladder can carry — an unreadable price, or `Free`.
         */
        priceLong: sold.cost === null || sold.cost === 0 ? sold.price : wealthLong(sold.cost, t),
        cost: fact(sold.cost),
        afford: short ? { text: t('rewrites.shop.short'), colour: 'brightRed' } : { text: '' },
        short: wealth === null || sold.cost === null ? null : short,
        usable:
          sold.verdict.state === 'blocked'
            ? { text: sold.verdict.label, colour: 'yellow' }
            : { text: '' },
        wearable: sold.verdict.state === 'wearable' || sold.verdict.state === 'worn',
        note: fact(sold.note),
        basePrice: fact(sold.item.price),
        ...realmFields(sold.item, sold.item.realmSlot ?? null, sold.effects)
      };
    }),
    count: rows.length
  };
}

/** The word for a row's status letter: the listing's `R`, `M`, and what it left unexplained. */
function partyState(row: PartyRow, t: UiLookup): string {
  if (row.invited) return t('rewrites.party.invited');
  switch (row.flag) {
    case 'R':
      return t('rewrites.party.resting');
    case 'M':
      return t('rewrites.party.meditating');
    case null:
      return '';
    default:
      return row.flag;
  }
}

export function partyScope(rows: readonly PartyRow[], bands: VitalBands, t: UiLookup): Row {
  return {
    members: rows.map((member) => ({
      name: member.name,
      class: fact(member.class),
      health: {
        text: String(fact(member.health)),
        value: member.health,
        colour: bandFor(bands.hp, member.health, 100)
      },
      mana: {
        text: String(fact(member.mana)),
        value: member.mana,
        colour: bandFor(bands.mana, member.mana, 100)
      },
      rank: fact(member.rank),
      flag: fact(member.flag),
      state: partyState(member, t),
      invited: member.invited,
      resting: member.flag === 'R',
      meditating: member.flag === 'M'
    })),
    count: rows.length
  };
}

export function experienceScope(gain: ExperienceFacts): Row {
  return {
    gained: gain.gained,
    exp: gain.exp,
    need: gain.need,
    level: gain.level,
    nextLevel: gain.level === null ? null : gain.level + 1,
    expSession: gain.expSession
  };
}

/** Everything a design for this entity may name, the character's figures included. */
export function scopeOf(facts: RewriteFacts, bands: VitalBands, t: UiLookup): Scope {
  const me = characterScope(facts.figures, bands, t);
  switch (facts.entity) {
    case 'statline':
      return me;
    case 'inventory':
      return { ...inventoryScope(facts.pack, t), me };
    case 'who':
      return { ...whoScope(facts.rows), me };
    case 'shop':
      return { ...shopScope(facts.rows, facts.figures.wealth, t), me };
    case 'party':
      return { ...partyScope(facts.rows, bands, t), me };
    case 'experience':
      return { ...experienceScope(facts.gain), me };
  }
}

/* ─────────────────────────────────────────────────────────── drawing */

/**
 * A design drawn against the facts: one `Drawn` per line. The prompt row is
 * the first line only; the designer says so where a template has more.
 */
export function renderRewrite(
  design: Pick<RewriteDesign, 'template' | 'entity'>,
  facts: RewriteFacts,
  bands: VitalBands,
  t: UiLookup
): Drawn[] {
  const lines = renderTemplate(design.template, scopeOf(facts, bands, t), {
    label: columnLabel(t)
  });
  return ENTITY_SPECS[design.entity].oneLine ? lines.slice(0, 1) : lines;
}

/**
 * The drawn lines as what the console is fed: each line's runs as SGR, a
 * CRLF after every one, and a mark at each line that carries glyphs, keyed
 * by the offset the line starts at — the shape `StreamChunk.marks` has for
 * a room's name.
 */
export function rewriteToChunk(lines: readonly Drawn[]): {
  text: string;
  marks: Array<{ offset: number; mark: TerminalMark }>;
} {
  let text = '';
  const marks: Array<{ offset: number; mark: TerminalMark }> = [];
  for (const line of lines) {
    if (line.glyphs.length > 0) {
      marks.push({
        offset: text.length,
        mark: { label: line.glyphs[0]!.label, inline: line.glyphs }
      });
    }
    text += `${toAnsi(line.segments)}\r\n`;
  }
  return { text, marks };
}
