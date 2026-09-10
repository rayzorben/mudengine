import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REWRITES,
  REWRITE_KINDS,
  REWRITE_SPECS,
  renderExperience,
  renderInventory,
  renderParty,
  renderRows,
  renderShop,
  renderWho,
  rewriteToChunk,
  slotIcon,
  wealthLong,
  type InventoryRow,
  type RewriteDesign
} from '../rewrites';
import { GLYPH_BLANK, renderTemplate, toAnsi } from '../template';
import { DEFAULT_CONFIG, normalizeRewrites } from '../config';
import { DENOMINATIONS } from '../character';
import { equipVerdict, UNKNOWN_WEARER, type Wearer } from '../gear';
import { asUiDict, flattenDict, makeT } from '../i18n';
import { wireItem, type ItemEntity } from '../entities';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const dict = asUiDict(parse(readFileSync('locales/ui.en.yaml', 'utf8')));
if (dict === null) throw new Error('dictionary');
const t = makeT(dict, (problem) => {
  throw new Error(problem);
});
const keys = flattenDict(dict);

const plainOf = (line: { segments: { text: string }[] }): string =>
  line.segments.map((segment) => segment.text).join('');

const design = (
  kind: keyof typeof DEFAULT_REWRITES,
  over: Partial<RewriteDesign> = {}
): RewriteDesign => ({
  ...structuredClone(DEFAULT_REWRITES[kind]),
  enabled: true,
  ...over
});

describe('the template grammar', () => {
  it('draws a figure with its own colour and hands the layout colour back', () => {
    const drawn = renderTemplate('{red}a{x}b', (tag) =>
      tag === 'x' ? { text: 'X', colour: 'green' } : null
    );
    expect(drawn?.segments.map((s) => [s.text, s.fg])).toEqual([
      ['a', 'red'],
      ['X', 'green'],
      ['b', 'red']
    ]);
    expect(drawn?.cells).toBe(3);
  });

  it('leaves two blank cells for a glyph and places it where they start', () => {
    const drawn = renderTemplate('ab{g}cd', (tag) =>
      tag === 'g' ? { text: '', glyph: { icon: 'head', label: 'Head' } } : null
    );
    expect(plainOf(drawn!)).toBe(`ab${GLYPH_BLANK}cd`);
    expect(drawn?.glyphs).toEqual([{ x: 2, icon: 'head', label: 'Head' }]);
  });

  it('draws a tag it does not know as typed', () => {
    expect(plainOf(renderTemplate('{nope} {bold}x', () => null)!)).toBe('{nope} x');
  });

  it('ends its bytes with a reset so what follows starts clean', () => {
    expect(toAnsi([{ text: 'x', fg: 'red', bg: null, bold: true, dim: false }])).toBe(
      '\x1b[0;1;31mx\x1b[0m'
    );
  });
});

describe('a table', () => {
  const spec = REWRITE_SPECS.who;
  const row = spec.lines[1]!;
  const rows = [
    { n: { text: '1' }, name: { text: 'Vaelor' }, title: { text: 'Kai Warrior' } },
    { n: { text: '10' }, name: { text: 'Beaver IzCoo' }, title: { text: 'Squire' } }
  ];

  it('lines every column up under its name, numbers flush right', () => {
    const lines = renderRows(
      design('who', { lines: { row: '{n} {name} {title}|' } }),
      spec,
      row,
      rows,
      t
    );
    expect(lines.map(plainOf)).toEqual([
      ' # Name         Title      |',
      ' 1 Vaelor       Kai Warrior|',
      '10 Beaver IzCoo Squire     |'
    ]);
  });

  it('draws the header in the dim ink and drops it when asked', () => {
    const [head] = renderRows(design('who', { lines: { row: '{name}' } }), spec, row, rows, t);
    expect(head?.segments[0]?.fg).toBe('brightBlack');
    const lines = renderRows(
      design('who', { header: false, lines: { row: '{name}' } }),
      spec,
      row,
      rows,
      t
    );
    expect(lines.map(plainOf)).toEqual(['Vaelor      ', 'Beaver IzCoo']);
  });

  it('draws each row as its template reads in lines style', () => {
    const lines = renderRows(
      design('who', { style: 'lines', lines: { row: '{n}. {name}' } }),
      spec,
      row,
      rows,
      t
    );
    expect(lines.map(plainOf)).toEqual(['1. Vaelor', '10. Beaver IzCoo']);
  });

  it('draws nothing for a line whose template is blank', () => {
    expect(renderRows(design('who', { lines: { row: '' } }), spec, row, rows, t)).toEqual([]);
  });
});

describe('the pack', () => {
  const wearer: Wearer = {
    ...UNKNOWN_WEARER,
    classId: 2,
    classNames: { 1: 'Warrior', 2: 'Mystic' }
  };
  const item = (
    name: string,
    realm: Partial<ItemEntity>,
    wire: Partial<ItemEntity> = {}
  ): ItemEntity => ({
    ...wireItem(name),
    ...realm,
    ...wire
  });
  const rows: InventoryRow[] = [
    item(
      'visored greathelm',
      { id: 1, encumbrance: 120, realmSlot: 'Head', armour: { ac: 4, dr: 1 } },
      { slot: 'Head', equipped: true }
    ),
    item('golden battleaxe', {
      id: 3,
      encumbrance: 400,
      realmSlot: 'Weapon Hand',
      weapon: { min: 8, max: 20 },
      classes: [1]
    }),
    item('padded gloves', { id: 4, encumbrance: 40, realmSlot: 'Hands', armour: { ac: 1, dr: 0 } }),
    item('glass jug', { id: 5, encumbrance: 10 }),
    item('torch', {}, { count: 6 })
  ].map((entity) => ({ item: entity, verdict: equipVerdict(entity, wearer, t) }));

  const facts = {
    items: rows,
    keys: ['bone key', 'bone key'],
    coins: { gold: 2, silver: 3, copper: 50 },
    wealth: 2350,
    encumbrance: 1744,
    encumbranceMax: 4128,
    encumbranceWord: 'Medium'
  };

  it("reaches the pack card's verdict for every row and draws it as the glyph", () => {
    const drawn = renderInventory(
      design('inventory', {
        style: 'lines',
        lines: { ...DEFAULT_REWRITES.inventory.lines, row: '{action}{item}' }
      }),
      facts,
      t
    );
    const glyphs = drawn.lines.slice(0, 5).map((line) => line.glyphs[0] ?? null);
    expect(glyphs.map((g) => g?.icon ?? null)).toEqual(['worn', 'blocked', 'wear', null, 'wear']);
    expect(glyphs[0]?.commands).toEqual(['remove visored greathelm']);
    expect(glyphs[1]?.label).toBe('Only Warrior may use this');
    expect(glyphs[1]?.commands).toBeUndefined();
    expect(glyphs[2]?.commands).toEqual(['wear padded gloves']);
    // The unknown item keeps its control: unknown never refuses.
    expect(glyphs[4]?.commands).toEqual(['wear torch']);
    expect(plainOf(drawn.lines[4]!)).toBe(`${GLYPH_BLANK}6 torch`);
  });

  it("draws the realm's figures and leaves blank what the realm lacks", () => {
    const drawn = renderInventory(
      design('inventory', {
        header: false,
        lines: {
          ...DEFAULT_REWRITES.inventory.lines,
          row: '{item}|{weight}|{stats}|{equipped}|{slot}'
        }
      }),
      facts,
      t
    );
    expect(plainOf(drawn.lines[0]!)).toBe('visored greathelm|120|4/1 |(Head)|Head       ');
    expect(plainOf(drawn.lines[1]!)).toBe('golden battleaxe |400|8-20|      |Weapon Hand');
    expect(plainOf(drawn.lines[4]!)).toBe('6 torch          |   |    |      |           ');
  });

  it('draws the slot picture where the slot has one', () => {
    const drawn = renderInventory(
      design('inventory', {
        header: false,
        lines: { ...DEFAULT_REWRITES.inventory.lines, row: '{icon}{name}' }
      }),
      facts,
      t
    );
    expect(drawn.lines[0]?.glyphs).toEqual([{ x: 0, icon: 'head', label: 'Head' }]);
    expect(drawn.lines[3]?.glyphs).toEqual([]);
    expect(slotIcon('Weapon Hand')).toBe('weapon');
    expect(slotIcon('Readied')).toBe('readied');
    expect(slotIcon('Pocket')).toBeNull();
  });

  it('states the keys, the purse on the ladder and the load', () => {
    const drawn = renderInventory(design('inventory'), facts, t);
    const text = drawn.lines.map(plainOf);
    expect(text.at(-3)).toBe('Keys: bone key, bone key');
    expect(text.at(-2)).toBe('Wealth: 23 gold, 5 silver  (2350 copper)');
    expect(text.at(-1)).toBe('Load: 1744/4128 Medium');
    expect(wealthLong(null, t)).toBe('?');
    expect(wealthLong(0, t)).toBe('0 copper');
    expect(wealthLong(1_010_203, t)).toBe('1 runic, 1 platinum, 2 gold, 3 copper');
  });

  it('says none for an empty key ring and draws nothing for a blanked line', () => {
    const drawn = renderInventory(
      design('inventory', { lines: { ...DEFAULT_REWRITES.inventory.lines, wealth: '', load: '' } }),
      { ...facts, keys: [] },
      t
    );
    expect(drawn.lines.map(plainOf).at(-1)).toBe('Keys: none');
  });
});

describe('the other listings', () => {
  it('draws the roster with its count', () => {
    const drawn = renderWho(
      design('who', { lines: { head: '{count} here', row: '{name} {gang}' } }),
      [
        { name: 'Vaelor', title: 'Kai Warrior', alignment: 'Good', gang: 'Mudengine', flags: 'S' },
        { name: 'Rand', title: null, alignment: null, gang: null, flags: null }
      ],
      t
    );
    expect(drawn.lines.map(plainOf)).toEqual([
      '2 here',
      'Name   Gang     ',
      'Vaelor Mudengine',
      'Rand            '
    ]);
  });

  it('marks a price the purse cannot meet and a thing this character may not wear', () => {
    const wearer: Wearer = { ...UNKNOWN_WEARER, classId: 2, classNames: { 1: 'Warrior' } };
    const axe = { ...wireItem('golden battleaxe'), id: 3, realmSlot: 'Weapon Hand', classes: [1] };
    const drawn = renderShop(
      design('shop', { header: false, lines: { row: '{item}|{afford}|{usable}' } }),
      [
        {
          name: 'golden battleaxe',
          quantity: 1,
          price: '18 gold crowns',
          cost: 1800,
          note: null,
          item: axe,
          verdict: equipVerdict(axe, wearer, t)
        },
        {
          name: 'torch',
          quantity: 20,
          price: '5 copper farthings',
          cost: 5,
          note: null,
          item: wireItem('torch'),
          verdict: equipVerdict(wireItem('torch'), wearer, t)
        }
      ],
      100,
      t
    );
    expect(drawn.lines.map(plainOf)).toEqual([
      'golden battleaxe|short|Only Warrior may use this',
      'torch           |     |                         '
    ]);
    expect(drawn.lines[0]?.segments.find((s) => s.text.startsWith('short'))?.fg).toBe('brightRed');
  });

  it("colours a member's health by the status line's bands and names the flag", () => {
    const drawn = renderParty(
      design('party', { header: false, lines: { row: '{name} {health} {state}' } }),
      [
        {
          name: 'Soul',
          class: 'Warrior',
          health: 35,
          mana: null,
          rank: 'Backrank',
          flag: 'R',
          invited: false
        }
      ],
      DEFAULT_CONFIG.ui.rewrites.statline.bands,
      t
    );
    expect(plainOf(drawn.lines[0]!)).toBe('Soul 35 resting');
    expect(drawn.lines[0]?.segments.find((s) => s.text === '35')?.fg).toBe('brightRed');
  });

  it('draws the experience line with what is known and ? for what is not', () => {
    const drawn = renderExperience(
      design('experience', { lines: { line: '+{gained} {exp} {need} {nextLevel}' } }),
      {
        gained: 25,
        exp: null,
        need: 100,
        level: 12,
        expSession: 25
      }
    );
    expect(drawn.lines.map(plainOf)).toEqual(['+25 ? 100 13']);
  });
});

describe('the bytes the console is fed', () => {
  it('ends every line and keys a mark to each line carrying a glyph', () => {
    const drawn = renderInventory(
      design('inventory', {
        header: false,
        lines: { row: '{action}{name}', keys: '', wealth: '', load: '' }
      }),
      {
        items: [
          { item: wireItem('torch'), verdict: equipVerdict(wireItem('torch'), UNKNOWN_WEARER, t) }
        ],
        keys: [],
        coins: {},
        wealth: null,
        encumbrance: null,
        encumbranceMax: null,
        encumbranceWord: null
      },
      t
    );
    const chunk = rewriteToChunk(drawn);
    expect(chunk.text.endsWith('\r\n')).toBe(true);
    expect(chunk.marks).toHaveLength(1);
    expect(chunk.marks[0]?.offset).toBe(0);
    expect(chunk.marks[0]?.mark.inline?.[0]).toMatchObject({
      x: 0,
      icon: 'wear',
      commands: ['wear torch']
    });
  });
});

describe('the dictionary', () => {
  it('names every column a table can have and every coin', () => {
    for (const kind of REWRITE_KINDS) {
      for (const line of REWRITE_SPECS[kind].lines) {
        if (!line.repeated) continue;
        for (const tag of line.tags) {
          if (tag === 'icon' || tag === 'action') continue;
          expect(keys.has(`rewrites.labels.${tag}`), `rewrites.labels.${tag}`).toBe(true);
        }
      }
    }
    for (const which of DENOMINATIONS) expect(keys.has(`rewrites.coins.${which}`)).toBe(true);
  });

  it('ships every kind off, and the block reads back as itself', () => {
    for (const kind of REWRITE_KINDS) expect(DEFAULT_REWRITES[kind].enabled).toBe(false);
    expect(normalizeRewrites(DEFAULT_CONFIG.ui.rewrites)).toEqual(DEFAULT_CONFIG.ui.rewrites);
  });
});
