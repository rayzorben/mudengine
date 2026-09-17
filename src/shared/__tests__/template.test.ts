import { describe, expect, it } from 'vitest';

import {
  bandFor,
  cellsOf,
  evaluate,
  GLYPH_BLANK,
  parseExpr,
  parseTemplate,
  pathsIn,
  renderTemplate,
  toAnsi,
  type ColourBand,
  type Drawn,
  type Scope
} from '../template';

const plainOf = (line: Drawn | undefined): string =>
  (line?.segments ?? []).map((segment) => segment.text).join('');
const draw = (template: string, scope: Scope): string[] =>
  renderTemplate(template, scope).map((line) => plainOf(line));

const SCOPE: Scope = {
  hp: 120,
  hpMax: 156,
  gang: '',
  room: null,
  worn: true,
  items: [
    { name: 'visored greathelm', weight: 120, slot: 'Head' },
    { name: 'torch', weight: '', slot: '' }
  ],
  me: { level: 12, class: 'Mystic' }
};

describe('the tags', () => {
  it('draws a figure, a nested one, and a tag it does not know as typed', () => {
    expect(draw('{hp}/{hpMax} {me.level} {nope}', SCOPE)).toEqual(['120/156 12 {nope}']);
  });

  it('draws an unknown figure as ? and a fact the realm lacks blank', () => {
    expect(draw('[{room}][{gang}]', SCOPE)).toEqual(['[?][]']);
  });

  it('draws a list as its names, a flag as a word, and a figure with a colour for its own characters', () => {
    expect(draw('{items} {worn}', SCOPE)).toEqual(['visored greathelm, torch true']);
    const [line] = renderTemplate('{red}a{x}b', {
      x: { text: 'X', colour: 'green' }
    });
    expect(line?.segments.map((s) => [s.text, s.fg])).toEqual([
      ['a', 'red'],
      ['X', 'green'],
      ['b', 'red']
    ]);
  });

  it('leaves two blank cells for a glyph and places it where they start', () => {
    const [line] = renderTemplate('ab{g}cd', {
      g: { text: '', glyph: { icon: 'head', label: 'Head' } }
    });
    expect(plainOf(line)).toBe(`ab${GLYPH_BLANK}cd`);
    expect(line?.glyphs).toEqual([{ x: 2, icon: 'head', label: 'Head' }]);
    expect(line?.cells).toBe(6);
  });

  it('applies the filters: case, a fallback for a blank, and a width', () => {
    expect(draw('{me.class|upper} {gang|or:-} {room|or:?} {me.class|width:3}|', SCOPE)).toEqual([
      'MYSTIC - ? Mys|'
    ]);
    expect(draw('{me.class|width:8}|', SCOPE)).toEqual(['Mystic  |']);
    // A filter the grammar lacks is a typo, drawn as typed.
    expect(draw('{hp|shout}', SCOPE)).toEqual(['{hp|shout}']);
  });
});

describe('the styles', () => {
  const plain = { bg: null, bold: false, dim: false };

  it('takes a hex, a background and the attributes, and reset clears them all', () => {
    const [line] = renderTemplate('{#ff8800}{bg:blue}{bold}{dim}x{reset}y', {});
    expect(line?.segments).toEqual([
      { text: 'x', fg: '#ff8800', bg: 'blue', bold: true, dim: true },
      { text: 'y', fg: null, ...plain }
    ]);
  });

  it('puts back what was in effect before when a colour or attribute is closed', () => {
    const [line] = renderTemplate('{red}a{green}b{/green}c{/colour}d{bold}e{/bold}f', {});
    expect(line?.segments.map((s) => [s.text, s.fg, s.bold])).toEqual([
      ['a', 'red', false],
      ['b', 'green', false],
      ['c', 'red', false],
      ['d', null, false],
      ['e', null, true],
      ['f', null, false]
    ]);
    const [ground] = renderTemplate('{bg:blue}a{/bg}b', {});
    expect(ground?.segments.map((s) => [s.text, s.bg])).toEqual([
      ['a', 'blue'],
      ['b', null]
    ]);
  });

  it('draws a colour the palette does not name as typed', () => {
    expect(draw('{plaid}x{bg:plaid}', {})).toEqual(['{plaid}x{bg:plaid}']);
  });

  it('writes bytes the console reads: one SGR per run and a reset at the end', () => {
    expect(
      toAnsi([
        { text: 'HP ', fg: 'brightWhite', bg: null, bold: true, dim: false },
        { text: '120', fg: '#ff8800', bg: 'blue', bold: false, dim: false }
      ])
    ).toBe('\x1b[0;1;97mHP \x1b[0;38;2;255;136;0;44m120\x1b[0m');
  });

  /*
   * todo 08. A prompt row ending `]: {cyan}` is asking for the one thing on
   * the row the client does not draw — what the player types next. The reset
   * that keeps a listing from leaking its colour was throwing that away.
   */
  it('ends in the colour the template ends in, rather than resetting out of it', () => {
    const [row] = renderTemplate('[HP {hp}]: {cyan}', SCOPE);
    // A run of no cells, so nothing measures or draws differently.
    expect(row?.cells).toBe(renderTemplate('[HP {hp}]: ', SCOPE)[0]?.cells);
    expect(toAnsi(row!.segments).endsWith('\x1b[0;36m')).toBe(true);
  });

  it('still resets after a template that ends in no colour of its own', () => {
    const [row] = renderTemplate('{cyan}[HP {hp}]{reset}: ', SCOPE);
    expect(toAnsi(row!.segments).endsWith('\x1b[0m')).toBe(true);
    // And after one that never mentioned a colour at all.
    expect(toAnsi(renderTemplate('[HP {hp}]: ', SCOPE)[0]!.segments).endsWith('\x1b[0m')).toBe(
      true
    );
  });

  /*
   * Only the last line. Every earlier one is followed by another drawn line,
   * and each of those opens with a full SGR of its own.
   */
  it('leaves the reset on every line but the last', () => {
    const lines = renderTemplate('{cyan}one\ntwo{red}', SCOPE);
    expect(toAnsi(lines[0]!.segments).endsWith('\x1b[0m')).toBe(true);
    expect(toAnsi(lines[1]!.segments).endsWith('\x1b[0;31m')).toBe(true);
  });
});

describe('the controls', () => {
  it('takes the first branch whose test holds, else the else', () => {
    const template = '{if hp/hpMax >= .9}full{else if hp/hpMax >= .5}half{else}low{/if}';
    expect(draw(template, SCOPE)).toEqual(['half']);
    expect(draw(template, { ...SCOPE, hp: 150 })).toEqual(['full']);
    expect(draw(template, { ...SCOPE, hp: 10 })).toEqual(['low']);
    // An unknown maximum takes no numbered branch: the comparison is false both ways.
    expect(draw(template, { ...SCOPE, hpMax: null })).toEqual(['low']);
    expect(draw('{if worn}on{/if}{if gang}named{/if}{if not gang}unnamed{/if}', SCOPE)).toEqual([
      'onunnamed'
    ]);
  });

  it('draws a row per entry, with the row in scope and its place beside it', () => {
    expect(draw('{for items}{n}/{rows} {name}{if last}.{else},{/if}\n{/for}', SCOPE)).toEqual([
      '1/2 visored greathelm,',
      '2/2 torch.'
    ]);
    // The outer scope stays reachable inside a row.
    expect(draw('{for items}{name} {me.level}\n{/for}', SCOPE)).toEqual([
      'visored greathelm 12',
      'torch 12'
    ]);
    expect(draw('{for hp}x{/for}', SCOPE)).toEqual(['{for hp}x{/for}']);
  });

  /*
   * `{for item in items}` names the row, so every figure of it is addressed
   * through that name (todo 14). Reported as *"it has {items} but I don't even
   * see {item} in the list — it has weight, an item attribute, and that is not
   * in the list either"*: the figures were reachable and unnameable.
   */
  it('binds the row under the name the for gives it, drawn and read', () => {
    expect(draw('{for item in items}{item} {item.weight}\n{/for}', SCOPE)).toEqual([
      'visored greathelm 120',
      'torch '
    ]);
    // The row's own fields stay bare beside it: one value, two addresses.
    expect(draw('{for item in items}{name}={item.name}\n{/for}', SCOPE)).toEqual([
      'visored greathelm=visored greathelm',
      'torch=torch'
    ]);
    // And the row's place is still its own, never the bound record's.
    expect(draw('{for item in items}{n}/{rows} {item.slot}\n{/for}', SCOPE)).toEqual([
      '1/2 Head',
      '2/2 '
    ]);
    // A name that is already a field of the row draws that field, so `{item}`
    // says the same thing under either spelling of the `{for}`.
    const counted: Scope = { things: [{ item: '6 torch', name: 'torch', weight: 20 }] };
    expect(draw('{for item in things}{item} {item.weight}{/for}', counted)).toEqual(['6 torch 20']);
    // An if inside it reads the bound row too.
    expect(draw('{for item in items}{if item.weight > 100}heavy{/if}{/for}', SCOPE)).toEqual([
      'heavy'
    ]);
  });

  /* A binding that is not a name is not a control: drawn as typed, like any
     other tag the grammar does not know. */
  it('draws a malformed binding as typed', () => {
    expect(draw('{for 2 in items}x{/for}', SCOPE)).toEqual(['{for 2 in items}x{/for}']);
  });

  it('takes no row for a line holding only controls, and keeps a blank line typed inside', () => {
    const template = ['{for items}', '{name}', '{/for}', '', 'done'].join('\n');
    expect(draw(template, SCOPE)).toEqual(['visored greathelm', 'torch', '', 'done']);
    expect(draw('a\n', SCOPE)).toEqual(['a']);
    expect(renderTemplate('   ', SCOPE)).toEqual([]);
  });

  it('lines every figure in a table up under its name, numbers flush right, the header dim', () => {
    const template = [
      '{table header}',
      '{for items}',
      '{n} {name} {weight}|',
      '{/for}',
      '{/table}'
    ].join('\n');
    const lines = renderTemplate(template, SCOPE, {
      label: (path) => ({ n: '#', name: 'Name', weight: 'Wt' })[path] ?? path
    });
    // The numbers' column takes its name flush right too.
    expect(lines.map((line) => plainOf(line))).toEqual([
      '# Name               Wt|',
      '1 visored greathelm 120|',
      '2 torch                |'
    ]);
    expect(lines[0]?.segments[0]?.fg).toBe('brightBlack');
    expect(lines[1]?.segments[0]?.fg).toBeNull();
  });

  it('lets a filter choose a column’s side, and pads a glyph’s column too', () => {
    const scope: Scope = {
      items: [
        { name: 'ab', g: { text: '', glyph: { icon: 'head', label: 'Head' } } },
        { name: 'abcd', g: { text: '' } }
      ]
    };
    const lines = renderTemplate('{table}{for items}{name|right}|{g}|\n{/for}{/table}', scope);
    expect(lines.map((line) => plainOf(line))).toEqual(['  ab|  |', 'abcd|  |']);
    expect(lines[0]?.glyphs).toEqual([{ x: 5, icon: 'head', label: 'Head' }]);
  });

  it('keeps two tables apart', () => {
    const scope: Scope = { a: [{ name: 'x' }], b: [{ name: 'longer' }] };
    expect(
      draw('{table}{for a}{name}|\n{/for}{/table}{table}{for b}{name}|\n{/for}{/table}', scope)
    ).toEqual(['x|', 'longer|']);
  });

  it('says what could not be parsed, and still draws', () => {
    const open = parseTemplate('{if hp}a{for items}b');
    expect(open.problems).toEqual([
      { kind: 'unclosed', tag: '{for items}' },
      { kind: 'unclosed', tag: '{if hp}' }
    ]);
    expect(draw('{if hp}a{for items}b', SCOPE)).toEqual(['abb']);
    expect(parseTemplate('a{/if}{else}').problems).toEqual([
      { kind: 'stray', tag: '{/if}' },
      { kind: 'stray', tag: '{else}' }
    ]);
    expect(draw('a{/if}', SCOPE)).toEqual(['a{/if}']);
    expect(parseTemplate('{if hp >}x{/if}').problems).toEqual([
      { kind: 'badTest', tag: '{if hp >}' }
    ]);
    expect(draw('{if hp >}x{else}y{/if}', SCOPE)).toEqual(['y']);
  });

  it('names the figure paths a template draws, controls’ bodies included', () => {
    expect(pathsIn('{hp} {for items}{name}{if worn and hp > 1}{me.level}{/if}{/for}')).toEqual([
      'hp',
      'items',
      'name',
      'worn',
      'hp',
      'me.level'
    ]);
    expect(
      pathsIn(
        '{group items matching "^token of " as tokens}{for token in tokens}{token.name}{/for}'
      )
    ).toEqual(['items', 'tokens', 'tokens', 'token.name']);
  });

  it('partitions a list into a group and removes matching items from source', () => {
    const scope: Scope = {
      items: [
        { name: 'visored greathelm', weight: 500 },
        { name: 'token of Silvermere', weight: 0 },
        { name: 'torch', weight: 20 },
        { name: 'token of Rhudaur', weight: 0 }
      ]
    };
    const template = [
      '{group items matching "^token of " as tokens}',
      '{group items matching "^nonexistent" as empty}',
      '{for item in items}{item.name}, {/for}',
      'Tokens: {tokens}',
      'Empty: {empty|or:none}'
    ].join('\n');
    expect(draw(template, scope)).toEqual([
      'visored greathelm, torch, ',
      'Tokens: token of Silvermere, token of Rhudaur',
      'Empty: none'
    ]);
  });

  it('supports grouping with user sketch syntax, where expression, and keep option', () => {
    const scope: Scope = {
      items: [
        { name: 'visored greathelm', weight: 500, worn: true },
        { name: 'token of Silvermere', weight: 0, worn: false },
        { name: 'torch', weight: 20, worn: false }
      ]
    };
    // Sketch syntax: {group ^token of (.*)$ tokens}
    expect(draw('{group ^token of (.*)$ tokens}items:{items} tokens:{tokens}', scope)).toEqual([
      'items:visored greathelm, torch tokens:token of Silvermere'
    ]);

    // Where expression grouping
    expect(
      draw('{group items where weight == 0 as weightless}items:{items} zero:{weightless}', scope)
    ).toEqual(['items:visored greathelm, torch zero:token of Silvermere']);

    // Keep option: copies into target without removing from source
    expect(
      draw('{group items matching "^token" as tokens keep}items:{items} tokens:{tokens}', scope)
    ).toEqual(['items:visored greathelm, token of Silvermere, torch tokens:token of Silvermere']);

    // Length and count properties
    expect(
      draw('{group items matching "^token" as tokens}{tokens.length} {tokens.count}', scope)
    ).toEqual(['1 1']);
  });

  it('filters a for loop inline with where', () => {
    const scope: Scope = {
      items: [
        { name: 'visored greathelm', weight: 500, worn: true },
        { name: 'token of Silvermere', weight: 0, worn: false },
        { name: 'torch', weight: 20, worn: false }
      ]
    };
    const template = [
      '{table header}',
      '{for item in items where not item.worn}',
      '{n} {item.name} {item.weight}',
      '{/for}',
      '{/table}'
    ].join('\n');
    const lines = renderTemplate(template, scope, {
      label: (path) => ({ 'item.name': 'Name', 'item.weight': 'Wt', n: '#' })[path] ?? path
    });
    expect(lines.map((l) => plainOf(l))).toEqual([
      '# Name                Wt',
      '1 token of Silvermere  0',
      '2 torch               20'
    ]);
  });
});

describe('an expression', () => {
  const lookup = (path: string) => {
    const [head, ...rest] = path.split('.');
    let value = SCOPE[head!];
    for (const key of rest) value = (value as Scope | undefined)?.[key];
    return value;
  };

  it('adds, compares, and reads and, or and not', () => {
    const value = (source: string) => evaluate(parseExpr(source)!, lookup);
    expect(value('hp / hpMax >= .5 and hp < hpMax')).toBe(true);
    expect(value('hp + 1 * 2')).toBe(122);
    expect(value('(hp + 1) * 2')).toBe(242);
    expect(value('hp % 100')).toBe(20);
    expect(value('-hp')).toBe(-120);
    expect(value('not worn or gang == ""')).toBe(true);
    expect(value("me.class == 'Mystic'")).toBe(true);
    expect(value('room == null')).toBe(true);
    expect(value('items')).toBe(2);
  });

  it('matches regexes with =~, !~ and matches', () => {
    const value = (source: string) => evaluate(parseExpr(source)!, lookup);
    expect(value("me.class =~ '^mys'")).toBe(true);
    expect(value("me.class =~ '^war'")).toBe(false);
    expect(value("me.class matches 'TIC$'")).toBe(true);
    expect(value("me.class !~ '^war'")).toBe(true);
    expect(value("me.class !~ '^mys'")).toBe(false);
    // Invalid regex evaluates safely to false
    expect(value("me.class =~ '[unclosed'")).toBe(false);
  });

  it('is null, never a number, for arithmetic on an unknown or a division by zero', () => {
    const value = (source: string) => evaluate(parseExpr(source)!, lookup);
    expect(value('room + 1')).toBeNull();
    expect(value('hp / 0')).toBeNull();
    expect(value('room < 1')).toBe(false);
    expect(value('room > 1')).toBe(false);
  });

  it('refuses what it cannot read', () => {
    expect(parseExpr('')).toBeUndefined();
    expect(parseExpr('hp >')).toBeUndefined();
    expect(parseExpr('(hp')).toBeUndefined();
    expect(parseExpr('hp and')).toBeUndefined();
    expect(parseExpr('hp $ 1')).toBeUndefined();
  });
});

describe('the measurements', () => {
  it('counts an emoji as two cells and a variation selector as none', () => {
    expect(cellsOf('{nope} ❤️ 120')).toBe(13);
  });

  it('picks the highest floor a share reaches, whatever order the bands were stated in', () => {
    const bands: ColourBand[] = [
      { atLeast: 0, colour: 'red' },
      { atLeast: 0.5, colour: 'yellow' },
      { atLeast: 0.75, colour: 'green' }
    ];
    expect(bandFor(bands, 120, 156)).toBe('green');
    expect(bandFor(bands, 100, 156)).toBe('yellow');
    expect(bandFor(bands, 10, 156)).toBe('red');
    expect(bandFor(bands, 10, null)).toBeNull();
    expect(bandFor([], 10, 156)).toBeNull();
  });
});
