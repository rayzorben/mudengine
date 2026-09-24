import { describe, expect, it } from 'vitest';

import {
  NO_EFFECTS,
  activeDesign,
  CHARACTER_FIELDS,
  columnKeys,
  DEFAULT_REWRITES,
  ENTITY_SPECS,
  renderRewrite,
  REWRITE_ENTITIES,
  rewriteToChunk,
  ROW_FIELDS,
  slotIcon,
  wealthLong,
  withEnabled,
  type FieldSpec,
  type InventoryRow,
  type RewriteDesign,
  type RewriteFacts,
  type VitalBands
} from '../rewrites';
import { GLYPH_BLANK, parseTemplate, pathsIn, type Drawn } from '../template';
import { DEFAULT_CONFIG, normalizeRewrites } from '../config';
import { DENOMINATIONS } from '../character';
import { equipVerdict, UNKNOWN_WEARER, type Wearer } from '../gear';
import { asUiDict, flattenDict, makeT } from '../i18n';
import { wireItem, type ItemEntity } from '../entities';
import { readEffects } from '../abilities';
import type { StatlineFigures } from '../statline';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const dict = asUiDict(parse(readFileSync('locales/ui.en.yaml', 'utf8')));
if (dict === null) throw new Error('dictionary');
const t = makeT(dict, (problem) => {
  throw new Error(problem);
});
const keys = flattenDict(dict);

const plainOf = (line: Drawn): string => line.segments.map((segment) => segment.text).join('');

const BANDS: VitalBands = DEFAULT_CONFIG.ui.rewrites.bands;
const NO_BANDS: VitalBands = { hp: [], mana: [] };

const FIGURES: StatlineFigures = {
  hp: 120,
  hpMax: 156,
  mana: 5,
  manaMax: 28,
  exp: 10,
  need: 90,
  wealth: 7,
  state: 'resting',
  name: 'Vaelor',
  fullName: 'Vaelor Stone',
  race: 'Human',
  className: 'Mystic',
  manaType: 'KAI',
  level: 3,
  room: 'Town Square',
  lives: 9,
  expSession: 12,
  encumbrance: 100,
  encumbranceMax: 400,
  encumbranceWord: 'None'
};

const design = (entity: RewriteDesign['entity'], template: string): RewriteDesign => ({
  name: '',
  entity,
  enabled: true,
  template
});

const shipped = (entity: RewriteDesign['entity']): RewriteDesign => ({
  ...DEFAULT_REWRITES.find((entry) => entry.entity === entity)!,
  enabled: true
});

describe('the prompt row', () => {
  const facts: RewriteFacts = { entity: 'statline', figures: FIGURES };
  const plain = { bg: null, bold: false, dim: false };

  it('draws the figures, colours a banded one for its own characters only, and hands the colour back', () => {
    const bands: VitalBands = {
      hp: [
        { atLeast: 0.75, colour: 'green' },
        { atLeast: 0, colour: 'red' }
      ],
      mana: []
    };
    const [line] = renderRewrite(
      design('statline', '{brightWhite}HP {hp}/{hpMax}{reset} ${wealth}{state}'),
      facts,
      bands,
      t
    );
    expect(line?.segments).toEqual([
      { text: 'HP ', fg: 'brightWhite', ...plain },
      { text: '120', fg: 'green', ...plain },
      { text: '/156', fg: 'brightWhite', ...plain },
      { text: ' $7 (Resting)', fg: null, ...plain }
    ]);
    expect(line?.cells).toBe('HP 120/156 $7 (Resting)'.length);
  });

  it('draws an unknown figure as a question mark, never a zero, and no band without a maximum', () => {
    const [line] = renderRewrite(
      design('statline', '{brightWhite}HP {hp}/{hpMax}'),
      { entity: 'statline', figures: { ...FIGURES, hpMax: null } },
      BANDS,
      t
    );
    expect(plainOf(line!)).toBe('HP 120/?');
    expect(line?.segments).toEqual([{ text: 'HP 120/?', fg: 'brightWhite', ...plain }]);
  });

  it('offers the character whole: the names, the resource word, the load, and the state as a test', () => {
    const [line] = renderRewrite(
      design(
        'statline',
        '{name} {fullName} {race} {class} {manaType} {encumbrance}/{encumbranceMax} {encumbranceWord}' +
          ' {wealthLong} {if resting}zz{/if}{if state == "resting"}!{/if}'
      ),
      facts,
      BANDS,
      t
    );
    expect(plainOf(line!)).toBe('Vaelor Vaelor Stone Human Mystic KAI 100/400 None 7 copper zz!');
  });

  it('is one line: a second line of the template is not drawn', () => {
    const lines = renderRewrite(design('statline', 'a\nb'), facts, BANDS, t);
    expect(lines.map(plainOf)).toEqual(['a']);
    expect(renderRewrite(design('statline', '   '), facts, BANDS, t)).toEqual([]);
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
      weapon: { min: 8, max: 20, speed: 1100, type: 'Slash' },
      classes: [1]
    }),
    item('padded gloves', { id: 4, encumbrance: 40, realmSlot: 'Hands', armour: { ac: 1, dr: 0 } }),
    item('glass jug', { id: 5, encumbrance: 10 }),
    item('torch', {}, { count: 6 })
  ].map((entity) => ({
    item: entity,
    effects: NO_EFFECTS,
    verdict: equipVerdict(entity, wearer, t)
  }));

  const facts: RewriteFacts = {
    entity: 'inventory',
    figures: FIGURES,
    pack: {
      items: rows,
      keys: ['bone key', 'bone key'],
      coins: { gold: 2, silver: 3, copper: 50 },
      wealth: 2350,
      encumbrance: 1744,
      encumbranceMax: 4128,
      encumbranceWord: 'Medium'
    }
  };
  const pack = (template: string): Drawn[] =>
    renderRewrite(design('inventory', template), facts, BANDS, t);

  /*
   * What can be done with a thing is a family (todo 14): the equip gate, and
   * putting it down. A thing the realm marks `Not Droppable` draws the
   * statement instead of the button — the rule `TerminalMark.actions` states,
   * never a command the server will refuse out loud in the room.
   */
  it('offers dropping beside the equip gate, and refuses it where the realm does', () => {
    const drawn = pack('{for item in items}{item.action.drop}{item.name}\n{/for}');
    const glyphs = drawn.slice(0, 3).map((line) => line.glyphs[0] ?? null);
    expect(glyphs.map((glyph) => glyph?.icon ?? null)).toEqual(['drop', 'drop', 'drop']);
    expect(glyphs[0]?.commands).toEqual(['drop visored greathelm']);

    const kept = renderRewrite(
      design('inventory', '{for item in items}{item.action.drop}{/for}'),
      {
        ...facts,
        pack: {
          ...facts.pack,
          items: [
            {
              item: { ...wireItem('bound amulet'), notDroppable: true },
              effects: NO_EFFECTS,
              verdict: equipVerdict(wireItem('bound amulet'), wearer, t)
            }
          ]
        }
      },
      BANDS,
      t
    );
    expect(kept[0]?.glyphs[0]?.icon).toBe('kept');
    expect(kept[0]?.glyphs[0]?.commands).toBeUndefined();
  });

  /* What the realm says a thing does, read once (`readEffects`) and walked
     like any other list. */
  it('lists the effects the realm states, by name and value', () => {
    const drawn = renderRewrite(
      design(
        'inventory',
        '{for item in items}{for effect in item.effects}{effect.name} {effect.value};{/for}{/for}'
      ),
      {
        ...facts,
        pack: {
          ...facts.pack,
          items: [
            {
              item: wireItem('shimmering longsword'),
              effects: readEffects(
                [
                  [2, 3],
                  [5, 15]
                ],
                { table: 'item', family: 'other' },
                t
              ),
              verdict: equipVerdict(wireItem('shimmering longsword'), wearer, t)
            }
          ]
        }
      },
      BANDS,
      t
    );
    expect(plainOf(drawn[0]!)).toBe('AC +3;Resist-Fire 15%;');
  });

  it("reaches the pack card's verdict for every row and draws it as the glyph", () => {
    // `action` is a family since todo 14: the equip gate is one of its members.
    const drawn = pack('{for item in items}{item.action.toggleEquip}{item}\n{/for}');
    const glyphs = drawn.slice(0, 5).map((line) => line.glyphs[0] ?? null);
    expect(glyphs.map((g) => g?.icon ?? null)).toEqual(['worn', 'blocked', 'wear', null, 'wear']);
    expect(glyphs[0]?.commands).toEqual(['remove visored greathelm']);
    expect(glyphs[1]?.label).toBe('Only Warrior may use this');
    expect(glyphs[1]?.commands).toBeUndefined();
    expect(glyphs[2]?.commands).toEqual(['wear padded gloves']);
    // The unknown item keeps its control: unknown never refuses.
    expect(glyphs[4]?.commands).toEqual(['wear torch']);
    expect(plainOf(drawn[4]!)).toBe(`${GLYPH_BLANK}6 torch`);
  });

  it("draws the realm's figures in columns and leaves blank what the realm lacks", () => {
    const drawn = pack(
      '{table}{for items}{item}|{weight}|{stats}|{equipped}|{slot}\n{/for}{/table}'
    );
    expect(plainOf(drawn[0]!)).toBe('visored greathelm|120|4/1 |(Head)|Head       ');
    expect(plainOf(drawn[1]!)).toBe('golden battleaxe |400|8-20|      |Weapon Hand');
    expect(plainOf(drawn[4]!)).toBe('6 torch          |   |    |      |           ');
  });

  it('offers what the realm records about the kind, and the verdict as a test', () => {
    const drawn = pack(
      '{for items}{name}:{speed}:{weaponType}:{realmSlot}:{if wearable}ok{else}{reason}{/if}\n{/for}'
    );
    expect(plainOf(drawn[1]!)).toBe(
      'golden battleaxe:1100:Slash:Weapon Hand:Only Warrior may use this'
    );
    expect(plainOf(drawn[2]!)).toBe('padded gloves:::Hands:ok');
  });

  it('draws the slot picture where the slot has one', () => {
    const drawn = pack('{for items}{icon}{name}\n{/for}');
    expect(drawn[0]?.glyphs).toEqual([{ x: 0, icon: 'head', label: 'Head' }]);
    expect(drawn[3]?.glyphs).toEqual([]);
    expect(slotIcon('Weapon Hand')).toBe('weapon');
    expect(slotIcon('Readied')).toBe('readied');
    expect(slotIcon('Pocket')).toBeNull();
  });

  it('states the keys, the purse on the ladder, the load and the character beside them', () => {
    const drawn = renderRewrite(shipped('inventory'), facts, BANDS, t);
    const text = drawn.map(plainOf);
    expect(text[0]).toMatch(/Item\s+Wt/);
    expect(text.at(-3)).toBe('Keys: bone key, bone key');
    /*
     * The realm's own count, not the ladder (todo 04, 2026-09-12). The fixture
     * states three denominations and a copper total that does not agree with
     * them, which is exactly the case the bug was: the purse is what the server
     * printed, and the total beside it is the server's own `Wealth:` line.
     */
    expect(text.at(-2)).toBe('Wealth: 2 gold, 3 silver, 50 copper  (2350 copper)');
    expect(text.at(-1)).toBe('Load: 1744/4128 Medium');
    expect(wealthLong(null, t)).toBe('?');
    expect(wealthLong(0, t)).toBe('0 copper');
    // No count stated at all -- the status line has a total and nothing else,
    // so the ladder is the only answer there is and is still what is drawn.
    expect(wealthLong(1_010_203, t)).toBe('1 runic, 1 platinum, 2 gold, 3 copper');
    expect(wealthLong(1_010_203, t, {})).toBe('1 runic, 1 platinum, 2 gold, 3 copper');
    /*
     * The transcript from the report: the server said *98 platinum pieces, 22
     * gold crowns, 6573 silver nobles* and `Wealth: 1047930 copper farthings`,
     * and the rewrite drew *1 runic, 4 platinum, 79 gold, 3 silver* -- the same
     * money arranged into coins the character does not have.
     */
    expect(wealthLong(1_047_930, t, { platinum: 98, gold: 22, silver: 6573 })).toBe(
      '98 platinum, 22 gold, 6573 silver'
    );
    expect(
      pack('{keyCount} {itemCount} {gold} {encumbrancePercent}% {me.level} {me.hp}').map(plainOf)
    ).toEqual(['2 5 2 42% 3 120']);
  });

  it('says what the template says for an empty key ring, and draws nothing for a blank template', () => {
    const drawn = renderRewrite(
      design('inventory', '{dim}Keys:{/dim} {keys|or:none}'),
      { ...facts, pack: { ...facts.pack, keys: [] } },
      BANDS,
      t
    );
    expect(drawn.map(plainOf)).toEqual(['Keys: none']);
    expect(pack('')).toEqual([]);
  });

  it('supports grouping item categories and displaying them on their own line', () => {
    const customFacts: RewriteFacts = {
      ...facts,
      pack: {
        ...facts.pack,
        items: [
          {
            item: wireItem('visored greathelm'),
            verdict: equipVerdict(wireItem('visored greathelm'), wearer, t),
            effects: NO_EFFECTS
          },
          {
            item: wireItem('token of Silvermere'),
            verdict: equipVerdict(wireItem('token of Silvermere'), wearer, t),
            effects: NO_EFFECTS
          },
          {
            item: wireItem('throwing hammers'),
            verdict: equipVerdict(wireItem('throwing hammers'), wearer, t),
            effects: NO_EFFECTS
          },
          {
            item: wireItem('token of Rhudaur'),
            verdict: equipVerdict(wireItem('token of Rhudaur'), wearer, t),
            effects: NO_EFFECTS
          }
        ]
      }
    };
    const template = [
      '{group items matching "^token of " as tokens}',
      '{table header}',
      '{for item in items}',
      '{item.name}',
      '{/for}',
      '{/table}',
      'Tokens: {tokens}'
    ].join('\n');
    const drawn = renderRewrite(design('inventory', template), customFacts, BANDS, t);
    expect(drawn.map(plainOf)).toEqual([
      'Name             ',
      'visored greathelm',
      'throwing hammers ',
      'Tokens: token of Silvermere, token of Rhudaur'
    ]);
  });
});

describe('the other listings', () => {
  it('draws the roster with its count', () => {
    const drawn = renderRewrite(
      design('who', '{count} here\n{table header}{for players}{name} {gang}\n{/for}{/table}'),
      {
        entity: 'who',
        figures: FIGURES,
        rows: [
          {
            name: 'Vaelor',
            title: 'Kai Warrior',
            alignment: 'Good',
            gang: 'Mudengine',
            flags: 'S'
          },
          { name: 'Rand', title: null, alignment: null, gang: null, flags: null }
        ]
      },
      BANDS,
      t
    );
    expect(drawn.map(plainOf)).toEqual([
      '2 here',
      'Name   Gang     ',
      'Vaelor Mudengine',
      'Rand            '
    ]);
  });

  it('marks a price the purse cannot meet and a thing this character may not wear', () => {
    const wearer: Wearer = { ...UNKNOWN_WEARER, classId: 2, classNames: { 1: 'Warrior' } };
    const axe = { ...wireItem('golden battleaxe'), id: 3, realmSlot: 'Weapon Hand', classes: [1] };
    const drawn = renderRewrite(
      design('shop', '{table}{for items}{item}|{afford}|{usable}|{if short}!{/if}\n{/for}{/table}'),
      {
        entity: 'shop',
        figures: { ...FIGURES, wealth: 100 },
        rows: [
          {
            name: 'golden battleaxe',
            quantity: 1,
            price: '18 gold crowns',
            cost: 1800,
            note: null,
            item: axe,
            effects: NO_EFFECTS,
            verdict: equipVerdict(axe, wearer, t)
          },
          {
            name: 'torch',
            quantity: 20,
            price: '5 copper farthings',
            cost: 5,
            note: null,
            item: wireItem('torch'),
            effects: NO_EFFECTS,
            verdict: equipVerdict(wireItem('torch'), wearer, t)
          }
        ]
      },
      BANDS,
      t
    );
    expect(drawn.map(plainOf)).toEqual([
      'golden battleaxe|short|Only Warrior may use this|!',
      'torch           |     |                         |'
    ]);
    expect(drawn[0]?.segments.find((s) => s.text.startsWith('short'))?.fg).toBe('brightRed');
  });

  /*
   * Todo 01 (2026-09-23): `50000 gold crowns` asks the reader to do the
   * ladder's arithmetic. Platinum is a hundred gold and runic a hundred
   * platinum (`COPPER_PER`), so the quote is carried up to the richest coin.
   */
  it('puts a price on the coin ladder, and keeps the counter words it cannot carry', () => {
    const row = (price: string, cost: number | null) => ({
      name: 'rope',
      quantity: 1,
      price,
      cost,
      note: null,
      item: wireItem('rope'),
      effects: NO_EFFECTS,
      verdict: equipVerdict(wireItem('rope'), UNKNOWN_WEARER, t)
    });
    const drawn = renderRewrite(
      design('shop', '{for item in items}{item.priceLong}\n{/for}'),
      {
        entity: 'shop',
        figures: FIGURES,
        rows: [
          row('200 platinum pieces', 2_000_000),
          row('50003 gold crowns', 5_000_300),
          row('10 silver nobles', 100),
          row('Free', 0),
          row('3 trade beads', null)
        ]
      },
      BANDS,
      t
    );
    expect(drawn.map(plainOf)).toEqual([
      '2 runic',
      '5 runic, 3 gold',
      '1 gold',
      'Free',
      '3 trade beads'
    ]);
  });

  it("colours a member's health by the bands and names the flag", () => {
    const drawn = renderRewrite(
      design('party', '{for members}{name} {health} {state}{if resting}*{/if}\n{/for}'),
      {
        entity: 'party',
        figures: FIGURES,
        rows: [
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
      },
      BANDS,
      t
    );
    expect(plainOf(drawn[0]!)).toBe('Soul 35 resting*');
    expect(drawn[0]?.segments.find((s) => s.text === '35')?.fg).toBe('brightRed');
  });

  it('draws the experience line with what is known and ? for what is not', () => {
    const drawn = renderRewrite(
      design('experience', '+{gained} {exp} {need} {nextLevel}'),
      {
        entity: 'experience',
        figures: FIGURES,
        gain: { gained: 25, exp: null, need: 100, level: 12, expSession: 25 }
      },
      NO_BANDS,
      t
    );
    expect(drawn.map(plainOf)).toEqual(['+25 ? 100 13']);
  });
});

describe('the bytes the console is fed', () => {
  it('ends every line and keys a mark to each line carrying a glyph', () => {
    const drawn = renderRewrite(
      design('inventory', '{for item in items}{item.action.toggleEquip}{item.name}\n{/for}'),
      {
        entity: 'inventory',
        figures: FIGURES,
        pack: {
          items: [
            {
              item: wireItem('torch'),
              effects: NO_EFFECTS,
              verdict: equipVerdict(wireItem('torch'), UNKNOWN_WEARER, t)
            }
          ],
          keys: [],
          coins: {},
          wealth: null,
          encumbrance: null,
          encumbranceMax: null,
          encumbranceWord: null
        }
      },
      BANDS,
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

describe('the list', () => {
  const designs: RewriteDesign[] = [
    design('inventory', 'a'),
    { ...design('inventory', 'b'), enabled: false },
    design('who', 'c')
  ];

  it('draws an entity by the first design that is on for it', () => {
    expect(activeDesign(designs, 'inventory')?.template).toBe('a');
    expect(activeDesign(designs, 'party')).toBeNull();
    expect(activeDesign([{ ...designs[0]!, enabled: false }], 'inventory')).toBeNull();
  });

  it('turning one on turns off the others for its entity, and nothing else', () => {
    const next = withEnabled(designs, 1, true);
    expect(next.map((entry) => entry.enabled)).toEqual([false, true, true]);
    expect(withEnabled(next, 1, false).map((entry) => entry.enabled)).toEqual([false, false, true]);
    expect(withEnabled(designs, 9, true)).toEqual(designs);
  });
});

describe('the catalogue and the dictionary', () => {
  /** Every figure a template may name, by entity, from the catalogue. */
  const offered = (entity: RewriteDesign['entity']): Set<string> => {
    const out = new Set<string>();
    /*
     * Two spellings reach a row's own figures and both are offered: bare
     * inside the `{for}` that opens the list, which is what every template
     * written before todo 14 says, and through the name `{for item in items}`
     * binds, which is what the sidebar now teaches. A record is always reached
     * through itself, from wherever it is reachable.
     */
    const walk = (fields: readonly FieldSpec[], prefixes: readonly string[]): void => {
      for (const field of fields) {
        for (const prefix of prefixes) out.add(`${prefix}${field.key}`);
        if (field.fields === undefined) continue;
        if (field.kind === 'list') {
          walk(field.fields, ['', ...(field.row === undefined ? [] : [`${field.row}.`])]);
        } else {
          walk(
            field.fields,
            prefixes.map((prefix) => `${prefix}${field.key}.`)
          );
        }
      }
    };
    walk(ENTITY_SPECS[entity].fields, ['']);
    walk(CHARACTER_FIELDS, [ENTITY_SPECS[entity].self === 'top' ? '' : 'me.']);
    for (const field of ROW_FIELDS) out.add(field.key);
    return out;
  };

  it('ships every design off, parsing clean, naming only figures the catalogue offers', () => {
    for (const shippedDesign of DEFAULT_REWRITES) {
      expect(shippedDesign.enabled).toBe(false);
      expect(parseTemplate(shippedDesign.template).problems).toEqual([]);
      const known = offered(shippedDesign.entity);
      for (const path of pathsIn(shippedDesign.template)) {
        expect(known.has(path), `${shippedDesign.entity} names {${path}}`).toBe(true);
      }
    }
    expect(DEFAULT_REWRITES.map((entry) => entry.entity)).toEqual([...REWRITE_ENTITIES]);
    expect(normalizeRewrites(DEFAULT_CONFIG.ui.rewrites)).toEqual(DEFAULT_CONFIG.ui.rewrites);
  });

  /*
   * Every list is walked by name, and the name is written down rather than
   * derived from the plural: `keys` gives `key` and `droppedBy` gives nothing
   * a rule would find. The heading over each one in the designer's sidebar is
   * dictionary copy keyed by the list, so both halves move together.
   */
  it('names one row of every list, and has a heading for it', () => {
    const lists: FieldSpec[] = [];
    const walk = (fields: readonly FieldSpec[]): void => {
      for (const field of fields) {
        if (field.kind === 'list') lists.push(field);
        if (field.fields !== undefined) walk(field.fields);
      }
    };
    for (const spec of Object.values(ENTITY_SPECS)) walk(spec.fields);
    // The positive control: an empty list would pass every assertion below.
    expect(lists.length).toBeGreaterThan(5);
    for (const field of lists) {
      expect(field.row, `${field.key} names its row`).toBeDefined();
      expect(keys.has(`rewrites.rows.${field.key}`), `rewrites.rows.${field.key}`).toBe(true);
    }
  });

  it('names every column a table can have, describes every figure, and names every coin', () => {
    for (const key of columnKeys()) {
      expect(keys.has(`rewrites.labels.${key}`), `rewrites.labels.${key}`).toBe(true);
    }
    const described = new Set<string>();
    const walk = (fields: readonly FieldSpec[]): void => {
      for (const field of fields) {
        described.add(field.key);
        if (field.fields !== undefined) walk(field.fields);
      }
    };
    for (const spec of Object.values(ENTITY_SPECS)) walk(spec.fields);
    walk(CHARACTER_FIELDS);
    walk(ROW_FIELDS);
    for (const key of described) {
      expect(keys.has(`rewrites.fields.${key}`), `rewrites.fields.${key}`).toBe(true);
    }
    // And nothing described that is not offered: a sentence about a figure
    // nobody can name is copy that looks maintained and is dead.
    for (const key of keys.keys()) {
      if (!key.startsWith('rewrites.fields.')) continue;
      expect(described.has(key.slice('rewrites.fields.'.length)), key).toBe(true);
    }
    for (const which of DENOMINATIONS) expect(keys.has(`rewrites.coins.${which}`)).toBe(true);
  });

  it('draws every shipped design against the character alone, so an unlisted figure shows itself', () => {
    // A figure a design names that its scope lacks is drawn as typed; the
    // shipped six name only what their entity offers, so none shows.
    const facts: Record<RewriteDesign['entity'], RewriteFacts> = {
      statline: { entity: 'statline', figures: FIGURES },
      inventory: {
        entity: 'inventory',
        figures: FIGURES,
        pack: {
          items: [],
          keys: [],
          coins: {},
          wealth: null,
          encumbrance: null,
          encumbranceMax: null,
          encumbranceWord: null
        }
      },
      who: { entity: 'who', figures: FIGURES, rows: [] },
      shop: { entity: 'shop', figures: FIGURES, rows: [] },
      party: { entity: 'party', figures: FIGURES, rows: [] },
      experience: {
        entity: 'experience',
        figures: FIGURES,
        gain: { gained: 1, exp: null, need: null, level: null, expSession: null }
      }
    };
    for (const shippedDesign of DEFAULT_REWRITES) {
      const text = renderRewrite(shippedDesign, facts[shippedDesign.entity], BANDS, t).map(plainOf);
      expect(text.join('\n'), shippedDesign.entity).not.toMatch(/\{[a-z]/);
    }
  });
});
