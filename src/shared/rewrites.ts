/**
 * The listings the client draws in place of the realm's.
 *
 * A rewrite takes a block the parser already reads — the pack, the roster,
 * a shop's shelf, the party, an experience line — and draws it again with
 * what the client knows laid beside it: an item's weight and figures from
 * the realm data, whether this character may put it on, what a price comes
 * to against the purse. Authored in the one template grammar (`template.ts`),
 * off by default, rendered in main at write time like the status line, so
 * what was drawn stays drawn. Every renderer here is pure: main gathers the
 * facts, this lays them out. `mudengine-ui` § The console is rewritten in one
 * grammar, and a listing is rewritten only whole.
 */
import type { Denomination } from './character';
import { DENOMINATIONS } from './character';
import { copperSpread } from './coins';
import type { ItemEntity } from './entities';
import type { EquipVerdict } from './gear';
import type { UiLookup } from './i18n';
import { countedLabel, ITEM_KIND_WORD } from './items';
import type { StatlineDesign } from './statline';
import {
  bandFor,
  cellsOf,
  GLYPH_CELLS,
  renderTemplate,
  toAnsi,
  type Cell,
  type Drawn,
  type Glyph
} from './template';
import type { BlockType } from './blocks';
import type { MarkIcon, TerminalMark } from './types';

export const REWRITE_KINDS = ['inventory', 'who', 'shop', 'party', 'experience'] as const;
export type RewriteKind = (typeof REWRITE_KINDS)[number];

/** Columns lined up under a header, or each line as its template reads. */
export type RewriteStyle = 'table' | 'lines';
export const REWRITE_STYLES: readonly RewriteStyle[] = ['table', 'lines'];

/** What the player authored for one listing: a template per line the listing has. */
export interface RewriteDesign {
  enabled: boolean;
  style: RewriteStyle;
  /** Whether a table names its columns on a first row. */
  header: boolean;
  lines: Record<string, string>;
}

export interface RewriteLineSpec {
  key: string;
  /** Drawn once per row of the listing, rather than once. */
  repeated: boolean;
  /** The figure tags this line may draw. */
  tags: readonly string[];
}

/** What a kind of rewrite is: the block it replaces, the lines it draws, and their figures. */
export interface RewriteSpec {
  kind: RewriteKind;
  /** The block types this rewrite draws in place of; a batch, or one line. */
  blocks: readonly BlockType[];
  lines: readonly RewriteLineSpec[];
  /** Figures a table aligns to the right. */
  numeric: readonly string[];
}

const ITEM_TAGS = [
  'n',
  'item',
  'name',
  'count',
  'slot',
  'equipped',
  'weight',
  'ac',
  'dr',
  'min',
  'max',
  'damage',
  'stats',
  'kind',
  'price',
  'charges',
  'uses',
  'icon',
  'action'
] as const;

export const REWRITE_SPECS: Readonly<Record<RewriteKind, RewriteSpec>> = {
  inventory: {
    kind: 'inventory',
    blocks: ['user-inventory'],
    lines: [
      { key: 'row', repeated: true, tags: ITEM_TAGS },
      { key: 'keys', repeated: false, tags: ['keys', 'keyCount'] },
      {
        key: 'wealth',
        repeated: false,
        tags: ['wealth', 'wealthLong', 'runic', 'platinum', 'gold', 'silver', 'copper']
      },
      {
        key: 'load',
        repeated: false,
        tags: ['encumbrance', 'encumbranceMax', 'encumbranceWord', 'encumbrancePercent']
      }
    ],
    numeric: ['n', 'count', 'weight', 'ac', 'dr', 'min', 'max', 'price', 'charges', 'uses']
  },
  who: {
    kind: 'who',
    blocks: ['who-list'],
    lines: [
      { key: 'head', repeated: false, tags: ['count'] },
      { key: 'row', repeated: true, tags: ['n', 'name', 'title', 'alignment', 'gang', 'flags'] }
    ],
    numeric: ['n']
  },
  shop: {
    kind: 'shop',
    blocks: ['shop-list'],
    lines: [
      {
        key: 'row',
        repeated: true,
        tags: [
          'n',
          'item',
          'quantity',
          'price',
          'cost',
          'afford',
          'usable',
          'note',
          'weight',
          'stats',
          'kind',
          'icon'
        ]
      }
    ],
    numeric: ['n', 'quantity', 'cost', 'weight']
  },
  party: {
    kind: 'party',
    blocks: ['party-roster', 'party-alone'],
    lines: [
      {
        key: 'row',
        repeated: true,
        tags: ['n', 'name', 'class', 'health', 'mana', 'rank', 'flag', 'state']
      }
    ],
    numeric: ['n', 'health', 'mana']
  },
  experience: {
    kind: 'experience',
    blocks: ['user-gain-experience'],
    lines: [
      {
        key: 'line',
        repeated: false,
        tags: ['gained', 'exp', 'need', 'level', 'nextLevel', 'expSession']
      }
    ],
    numeric: []
  }
};

/**
 * The shipped designs, every one off. The pack as a table is the one that
 * shows what the grammar can do: the equip control first, the realm's figures
 * beside the name, and the slot's picture at the end of the row.
 */
export const DEFAULT_REWRITES: Readonly<Record<RewriteKind, RewriteDesign>> = {
  inventory: {
    enabled: false,
    style: 'table',
    header: true,
    lines: {
      row: '{action} {bold}{item}{reset}  {dim}{weight}{reset}  {stats}  {brightGreen}{equipped}{reset} {icon}',
      keys: '{dim}Keys:{reset} {keys}',
      wealth: '{dim}Wealth:{reset} {brightYellow}{wealthLong}{reset}  ({wealth} copper)',
      load: '{dim}Load:{reset} {encumbrance}/{encumbranceMax} {encumbranceWord}'
    }
  },
  who: {
    enabled: false,
    style: 'table',
    header: true,
    lines: {
      head: '{bold}{count} adventurers{reset}',
      row: '{alignment}  {bold}{name}{reset}  {title}  {dim}{gang}{reset}  {flags}'
    }
  },
  shop: {
    enabled: false,
    style: 'table',
    header: true,
    lines: {
      row: '{bold}{item}{reset}  {dim}x{quantity}{reset}  {price}  {afford}  {usable}  {icon}'
    }
  },
  party: {
    enabled: false,
    style: 'table',
    header: true,
    lines: {
      row: '{rank}  {bold}{name}{reset}  {dim}{class}{reset}  {health}%  {mana}%  {state}'
    }
  },
  experience: {
    enabled: false,
    style: 'lines',
    header: false,
    lines: {
      line: '{brightYellow}+{gained} exp{reset}  {exp} total, {need} to level {nextLevel}, {expSession} this session'
    }
  }
};

/** What an unknown figure is drawn as: never a zero, which would lie. */
const UNKNOWN = '?';

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

/** A listing drawn: one `Drawn` per line, in order. */
export interface Rewritten {
  lines: Drawn[];
}

/**
 * A row's cells, keyed by tag. A tag the row leaves out is drawn blank in a
 * table and as typed in lines — the same rule the template has for a tag it
 * does not know, so a typo shows itself.
 */
export type Cells = Readonly<Record<string, Cell>>;

/**
 * The rows of one repeated line, laid out.
 *
 * In `table` style every figure tag is a column as wide as its widest cell,
 * text flush left and numbers flush right, and the header — the columns'
 * names — is the same template drawn once with the labels for cells, in the
 * console's dim ink so it reads as a heading whatever the row's own colours.
 * In `lines` style each row is its template as written.
 */
export function renderRows(
  design: RewriteDesign,
  spec: RewriteSpec,
  line: RewriteLineSpec,
  rows: readonly Cells[],
  t: UiLookup
): Drawn[] {
  const template = design.lines[line.key] ?? '';
  if (template.trim().length === 0) return [];
  const table = design.style === 'table';
  const numeric = new Set(spec.numeric);
  const tagSet = new Set(line.tags);
  const width = (cell: Cell): number =>
    cellsOf(cell.text) + (cell.glyph === undefined ? 0 : GLYPH_CELLS);

  const header: Cells | null =
    table && design.header
      ? Object.fromEntries(
          line.tags.map((tag) => [
            tag,
            {
              text: tag === 'icon' || tag === 'action' ? '' : t(`rewrites.labels.${tag}`),
              colour: 'brightBlack'
            }
          ])
        )
      : null;

  const widths = new Map<string, number>();
  if (table) {
    for (const row of [...(header ? [header] : []), ...rows]) {
      for (const tag of line.tags) {
        const cell = row[tag];
        if (cell === undefined) continue;
        widths.set(tag, Math.max(widths.get(tag) ?? 0, width(cell)));
      }
    }
  }

  const resolveIn =
    (row: Cells) =>
    (tag: string): Cell | null => {
      if (!tagSet.has(tag)) return null;
      const cell = row[tag] ?? { text: '' };
      if (!table) return cell;
      const pad = ' '.repeat(Math.max(0, (widths.get(tag) ?? 0) - width(cell)));
      return numeric.has(tag)
        ? { ...cell, text: pad + cell.text }
        : { ...cell, text: cell.text + pad };
    };

  const drawn: Drawn[] = [];
  if (header) {
    const head = renderTemplate(template, resolveIn(header));
    if (head) drawn.push(head);
  }
  for (const row of rows) {
    const one = renderTemplate(template, resolveIn(row));
    if (one) drawn.push(one);
  }
  return drawn;
}

/** One line that is not repeated: its template against its cells, or nothing for a blank template. */
export function renderOne(
  design: RewriteDesign,
  line: RewriteLineSpec,
  cells: Cells
): Drawn | null {
  const template = design.lines[line.key] ?? '';
  const tagSet = new Set(line.tags);
  return renderTemplate(template, (tag) => (tagSet.has(tag) ? (cells[tag] ?? { text: '' }) : null));
}

function figure(value: number | null | undefined): string {
  return typeof value === 'number' ? String(value) : UNKNOWN;
}

/** A realm fact drawn blank where the realm has none: an absent weight is not a zero. */
function fact(value: number | string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/* ─────────────────────────────────────────────────────────── the pack */

/** One carried thing with the verdict main reached about wearing it. */
export interface InventoryRow {
  item: ItemEntity;
  verdict: EquipVerdict;
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

/** The listing's own annotation for a thing in use — `(Head)`, `(Readied/79)` — or nothing. */
function equippedText(item: ItemEntity): string {
  if (!item.equipped || item.slot === null) return '';
  return item.charges === null ? `(${item.slot})` : `(${item.slot}/${item.charges})`;
}

export function itemCells(row: InventoryRow, n: number): Cells {
  const { item, verdict } = row;
  const slot = item.slot ?? item.realmSlot ?? null;
  const icon = slotIcon(slot);
  const action = actionGlyph(verdict);
  const cells: Record<string, Cell> = {
    n: { text: String(n) },
    item: { text: countedLabel(item) },
    name: { text: item.name },
    count: { text: String(item.count ?? 1) },
    slot: { text: slot ?? '' },
    equipped: { text: equippedText(item) },
    weight: { text: fact(item.encumbrance) },
    ac: { text: fact(item.armour?.ac) },
    dr: { text: fact(item.armour?.dr) },
    min: { text: fact(item.weapon?.min) },
    max: { text: fact(item.weapon?.max) },
    damage: { text: item.weapon === undefined ? '' : `${item.weapon.min}-${item.weapon.max}` },
    stats: { text: statsOf(item) },
    kind: { text: item.kind === undefined ? '' : ITEM_KIND_WORD[item.kind] },
    price: { text: fact(item.price) },
    charges: { text: fact(item.charges) },
    uses: { text: fact(item.uses) },
    icon: icon === null ? { text: '' } : { text: '', glyph: { icon, label: slot ?? '' } },
    action:
      action === null
        ? { text: '' }
        : {
            text: '',
            glyph: action,
            colour: verdict.state === 'blocked' ? 'yellow' : null
          }
  };
  return cells;
}

/** `2 gold, 3 silver, 50 copper` — the total on the ladder, named in the dictionary's words. */
export function wealthLong(copper: number | null, t: UiLookup): string {
  if (copper === null) return UNKNOWN;
  const spread = copperSpread(copper);
  const parts = DENOMINATIONS.filter((which) => spread[which] > 0).map(
    (which) => `${spread[which]} ${t(`rewrites.coins.${which}`)}`
  );
  return parts.length === 0 ? `0 ${t('rewrites.coins.copper')}` : parts.join(', ');
}

export function renderInventory(
  design: RewriteDesign,
  facts: InventoryFacts,
  t: UiLookup
): Rewritten {
  const spec = REWRITE_SPECS.inventory;
  const [row, keys, wealth, load] = spec.lines as [
    RewriteLineSpec,
    RewriteLineSpec,
    RewriteLineSpec,
    RewriteLineSpec
  ];
  const lines: Drawn[] = [];
  lines.push(
    ...renderRows(
      design,
      spec,
      row,
      facts.items.map((item, i) => itemCells(item, i + 1)),
      t
    )
  );
  const keyLine = renderOne(design, keys, {
    keys: {
      text: facts.keys.length === 0 ? t('rewrites.inventory.noKeys') : facts.keys.join(', ')
    },
    keyCount: { text: String(facts.keys.length) }
  });
  if (keyLine) lines.push(keyLine);
  const coins: Record<string, Cell> = {};
  for (const which of DENOMINATIONS) coins[which] = { text: String(facts.coins[which] ?? 0) };
  const wealthLine = renderOne(design, wealth, {
    ...coins,
    wealth: { text: figure(facts.wealth) },
    wealthLong: { text: wealthLong(facts.wealth, t) }
  });
  if (wealthLine) lines.push(wealthLine);
  const percent =
    facts.encumbrance !== null && facts.encumbranceMax !== null && facts.encumbranceMax > 0
      ? String(Math.round((100 * facts.encumbrance) / facts.encumbranceMax))
      : UNKNOWN;
  const loadLine = renderOne(design, load, {
    encumbrance: { text: figure(facts.encumbrance) },
    encumbranceMax: { text: figure(facts.encumbranceMax) },
    encumbranceWord: { text: facts.encumbranceWord ?? '' },
    encumbrancePercent: { text: percent }
  });
  if (loadLine) lines.push(loadLine);
  return { lines };
}

/* ────────────────────────────────────────────────────────── the roster */

export interface WhoRow {
  name: string;
  title: string | null;
  alignment: string | null;
  gang: string | null;
  flags: string | null;
}

export function renderWho(design: RewriteDesign, rows: readonly WhoRow[], t: UiLookup): Rewritten {
  const spec = REWRITE_SPECS.who;
  const [head, row] = spec.lines as [RewriteLineSpec, RewriteLineSpec];
  const lines: Drawn[] = [];
  const headLine = renderOne(design, head, { count: { text: String(rows.length) } });
  if (headLine) lines.push(headLine);
  lines.push(
    ...renderRows(
      design,
      spec,
      row,
      rows.map((who, i) => ({
        n: { text: String(i + 1) },
        name: { text: who.name },
        title: { text: who.title ?? '' },
        alignment: { text: who.alignment ?? '' },
        gang: { text: who.gang ?? '' },
        flags: { text: who.flags ?? '' }
      })),
      t
    )
  );
  return { lines };
}

/* ─────────────────────────────────────────────────────────── the shelf */

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
}

export function renderShop(
  design: RewriteDesign,
  rows: readonly ShopRow[],
  wealth: number | null,
  t: UiLookup
): Rewritten {
  const spec = REWRITE_SPECS.shop;
  const [row] = spec.lines as [RewriteLineSpec];
  return {
    lines: renderRows(
      design,
      spec,
      row,
      rows.map((sold, i) => {
        const short = wealth !== null && sold.cost !== null && sold.cost > wealth;
        const icon = slotIcon(sold.item.realmSlot);
        return {
          n: { text: String(i + 1) },
          item: { text: sold.name },
          quantity: { text: fact(sold.quantity) },
          price: { text: sold.price },
          cost: { text: fact(sold.cost) },
          afford: short ? { text: t('rewrites.shop.short'), colour: 'brightRed' } : { text: '' },
          usable:
            sold.verdict.state === 'blocked'
              ? { text: sold.verdict.label, colour: 'yellow' }
              : { text: '' },
          note: { text: sold.note ?? '' },
          weight: { text: fact(sold.item.encumbrance) },
          stats: { text: statsOf(sold.item) },
          kind: { text: sold.item.kind === undefined ? '' : ITEM_KIND_WORD[sold.item.kind] },
          icon:
            icon === null
              ? { text: '' }
              : { text: '', glyph: { icon, label: sold.item.realmSlot ?? '' } }
        };
      }),
      t
    )
  };
}

/* ─────────────────────────────────────────────────────────── the party */

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

export function renderParty(
  design: RewriteDesign,
  rows: readonly PartyRow[],
  bands: StatlineDesign['bands'],
  t: UiLookup
): Rewritten {
  const spec = REWRITE_SPECS.party;
  const [row] = spec.lines as [RewriteLineSpec];
  return {
    lines: renderRows(
      design,
      spec,
      row,
      rows.map((member, i) => ({
        n: { text: String(i + 1) },
        name: { text: member.name },
        class: { text: member.class ?? '' },
        health: { text: fact(member.health), colour: bandFor(bands.hp, member.health, 100) },
        mana: { text: fact(member.mana), colour: bandFor(bands.mana, member.mana, 100) },
        rank: { text: member.rank ?? '' },
        flag: { text: member.flag ?? '' },
        state: { text: partyState(member, t) }
      })),
      t
    )
  };
}

/* ────────────────────────────────────────────────── the experience line */

export interface ExperienceFacts {
  gained: number;
  /** The total after this gain, where the total was known. */
  exp: number | null;
  /** What the next level still costs after it, where that was known. */
  need: number | null;
  level: number | null;
  expSession: number | null;
}

export function renderExperience(design: RewriteDesign, facts: ExperienceFacts): Rewritten {
  const [line] = REWRITE_SPECS.experience.lines as [RewriteLineSpec];
  const drawn = renderOne(design, line, {
    gained: { text: String(facts.gained) },
    exp: { text: figure(facts.exp) },
    need: { text: figure(facts.need) },
    level: { text: figure(facts.level) },
    nextLevel: { text: facts.level === null ? UNKNOWN : String(facts.level + 1) },
    expSession: { text: figure(facts.expSession) }
  });
  return { lines: drawn ? [drawn] : [] };
}

/* ─────────────────────────────────────────────────────────── to bytes */

/**
 * The drawn lines as what the console is fed: each line's runs as SGR, a
 * CRLF after every one, and a mark at each line that carries glyphs, keyed
 * by the offset the line starts at — the shape `StreamChunk.marks` has for
 * a room's name.
 */
export function rewriteToChunk(rewritten: Rewritten): {
  text: string;
  marks: Array<{ offset: number; mark: TerminalMark }>;
} {
  let text = '';
  const marks: Array<{ offset: number; mark: TerminalMark }> = [];
  for (const line of rewritten.lines) {
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

/** The tags a line of a kind may draw, as `{tag}` words for a hint. */
export function tagsOf(kind: RewriteKind, key: string): string[] {
  const line = REWRITE_SPECS[kind].lines.find((entry) => entry.key === key);
  return line === undefined ? [] : line.tags.map((tag) => `{${tag}}`);
}
