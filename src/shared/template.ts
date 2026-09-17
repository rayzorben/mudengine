/**
 * The template grammar every console rewrite is authored in.
 *
 * A template is text with `{tags}`: a figure (`{hp}`, `{item.weight}`,
 * `{keys|or:none}`), a colour (`{red}`, `{#ff8800}`, `{bg:blue}`), `{bold}`,
 * `{dim}`, `{reset}`, a closer that puts back what was in effect before
 * (`{/red}`, `{/colour}`, `{/bold}`), and three controls: `{if …}` with
 * `{else if …}` and `{else}`, `{for list}` once per row with the row's
 * fields in scope, and `{table}` / `{table header}` in which every figure is a
 * column. A tag it does not know is drawn as typed, so a typo shows itself.
 * `mudengine-ui` § The console is rewritten in one grammar.
 */
import type { InlineGlyph } from './types';

/** The sixteen colours a design may name, in the console's own palette. */
export const ANSI_COLOURS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;
export type AnsiColour = (typeof ANSI_COLOURS)[number];

export function isAnsiColour(value: unknown): value is AnsiColour {
  return typeof value === 'string' && (ANSI_COLOURS as readonly string[]).includes(value);
}

/** A colour a figure wears from this fraction of its maximum up. */
export interface ColourBand {
  atLeast: number;
  colour: AnsiColour;
}

/** The band a figure sits in, highest floor first, or null while its maximum is unknown. */
export function bandFor(
  bands: readonly ColourBand[],
  value: number | null,
  max: number | null
): AnsiColour | null {
  if (value === null || max === null || max <= 0 || bands.length === 0) return null;
  const share = value / max;
  const sorted = [...bands].sort((a, b) => b.atLeast - a.atLeast);
  return sorted.find((band) => share >= band.atLeast)?.colour ?? null;
}

/** One run of a drawn line, with the attributes it wears. */
export interface Segment {
  text: string;
  /** A palette name, a `#rrggbb`, or null for the console's own ink. */
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}

/**
 * A glyph drawn over the cells rather than typed into them: two cells of
 * the row are left blank and the renderer lays the picture over them, the
 * way it lays a shop's glyph beside a room's name. A glyph carrying commands
 * is a button; one without is a statement, and its label says what.
 */
export type Glyph = Omit<InlineGlyph, 'x'>;

/** A glyph placed on a drawn line, at the cell it starts in. */
export type PlacedGlyph = InlineGlyph;

/** Cells a glyph occupies in the row it is drawn over. */
export const GLYPH_CELLS = 2;

/** What a glyph's cells hold in the text: blank, so the picture has room. */
export const GLYPH_BLANK = ' '.repeat(GLYPH_CELLS);

/** What an unknown figure is drawn as: never a zero, which would lie. */
export const UNKNOWN = '?';

/* ───────────────────────────────────────────────────────────── values */

/** What a figure is worth: a number compares and adds, a string is drawn. */
export type Scalar = string | number | boolean | null;

/**
 * A figure that carries more than its value: the text it is drawn as, a
 * colour of its own that ends with the text, or a glyph drawn in its place.
 * `value` is what an expression sees, where it differs from the text.
 */
export interface Figure {
  text: string;
  value?: Scalar;
  colour?: string | null;
  glyph?: Glyph;
}

/** A row of a list, or a record such as the character's own figures. */
export type Row = { readonly [key: string]: Value };

/** Anything a scope may hold. A list is drawn as its rows' names, joined. */
export type Value = Scalar | Figure | readonly Value[] | Row;

/** What a template draws from. */
export type Scope = Row;

export function isFigure(value: Value): value is Figure {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'text' in value;
}

export function isRow(value: Value): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('text' in value);
}

function isScalar(value: Value): value is Scalar {
  return value === null || typeof value !== 'object';
}

/* ───────────────────────────────────────────────────────── the grammar */

/**
 * The template as parsed: what to draw, in order. A control's body is more
 * of the same. `figure` names a path and the filters after it.
 */
export type Node =
  | { kind: 'text'; text: string }
  | { kind: 'newline' }
  | { kind: 'figure'; path: string; filters: Filter[]; raw: string }
  | { kind: 'style'; tag: string }
  | { kind: 'if'; branches: Array<{ test: Expr | null; body: Node[] }> }
  /**
   * A list drawn once per row.
   *
   * `as` is the name the row is bound under — `{for item in items}` makes the
   * row's own figures reachable as `{item.weight}`. Absent for the older
   * spelling `{for items}`, which binds the row's fields bare and nothing
   * else; both bindings are made where a name is given, because they are two
   * addresses for one value rather than two answers to one question, and the
   * bare one is what every template written before this says.
   */
  | { kind: 'for'; path: string; as?: string; where?: Expr; body: Node[] }
  | { kind: 'table'; header: boolean; body: Node[] }
  /**
   * Partitions a list in scope into matching entries and remaining entries.
   *
   * Matching entries are placed into `target` in scope, and removed from
   * `source` unless `keep` is true.
   */
  | {
      kind: 'group';
      source: string;
      target: string;
      pattern?: string;
      where?: Expr;
      keep?: boolean;
    };

export interface Filter {
  name: string;
  arg: string | null;
}

/**
 * What could not be parsed: a control left open, a closer with nothing to
 * close, or a test the grammar does not read. The template still draws;
 * the designer says each out loud in the dictionary's words.
 */
export interface Problem {
  kind: 'unclosed' | 'stray' | 'badTest';
  /** The tag as typed, braces included. */
  tag: string;
}

/** A parsed template with what could not be parsed. */
export interface Template {
  nodes: Node[];
  problems: Problem[];
}

/** The filters a figure may wear, closed so a typo is drawn as typed. */
export const FILTERS = ['upper', 'lower', 'left', 'right', 'center', 'width', 'or'] as const;
const FILTER_SET: ReadonlySet<string> = new Set(FILTERS);

const HEX = /^#[0-9a-f]{6}$/i;
const TAG = /\{([^{}\n]{1,120})\}/g;
const PATH = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/;

/** One segment of a path: what a `{for}` may bind its row under. */
const NAME = /^[A-Za-z_]\w*$/;

/** The tags that stand for a control rather than something drawn. */
const BLOCK_OPEN = /^(if|else if|elif|else|for|table|group)(?:\s|$)/;
const BLOCK_CLOSE = /^\/(if|for|table)$/;

function isStyleTag(tag: string): boolean {
  if (tag === 'bold' || tag === 'dim' || tag === 'reset') return true;
  if (tag.startsWith('bg:')) {
    const colour = tag.slice(3);
    return isAnsiColour(colour) || HEX.test(colour);
  }
  return isAnsiColour(tag) || HEX.test(tag);
}

/** `{/red}`, `{/colour}`, `{/bg}`, `{/bold}`, `{/dim}`: a closer of a style. */
function isStyleCloser(tag: string): boolean {
  if (!tag.startsWith('/')) return false;
  const name = tag.slice(1);
  if (name === 'colour' || name === 'color' || name === 'bg' || name === 'bold' || name === 'dim') {
    return true;
  }
  if (name.startsWith('bg:')) return isStyleTag(name);
  return isAnsiColour(name) || HEX.test(name);
}

type Token =
  { kind: 'text'; text: string } | { kind: 'newline' } | { kind: 'tag'; tag: string; raw: string };

/**
 * A line holding only control tags and blanks draws nothing and takes no
 * row: `{for items}` on a line of its own is the author laying the template
 * out, not asking for an empty line. Decided before parsing, on the tokens.
 */
function dropControlLines(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let line: Token[] = [];
  const flush = (ended: boolean): void => {
    const onlyControls =
      line.some((token) => token.kind === 'tag') &&
      line.every(
        (token) =>
          (token.kind === 'tag' && (BLOCK_OPEN.test(token.tag) || BLOCK_CLOSE.test(token.tag))) ||
          (token.kind === 'text' && token.text.trim().length === 0)
      );
    if (onlyControls) {
      for (const token of line) if (token.kind === 'tag') out.push(token);
    } else {
      out.push(...line);
      if (ended) out.push({ kind: 'newline' });
    }
    line = [];
  };
  for (const token of tokens) {
    if (token.kind === 'newline') flush(true);
    else line.push(token);
  }
  flush(false);
  return out;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const text = (piece: string): void => {
    const parts = piece.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) tokens.push({ kind: 'newline' });
      if (part.length > 0) tokens.push({ kind: 'text', text: part });
    });
  };
  let at = 0;
  for (const match of source.matchAll(TAG)) {
    text(source.slice(at, match.index));
    at = match.index + match[0].length;
    tokens.push({ kind: 'tag', tag: match[1]!.trim(), raw: match[0] });
  }
  text(source.slice(at));
  return tokens;
}

function parseFigure(tag: string, raw: string): Node | null {
  const [head, ...rest] = tag.split('|');
  const path = head!.trim();
  if (!PATH.test(path)) return null;
  const filters: Filter[] = [];
  for (const piece of rest) {
    const colon = piece.indexOf(':');
    const name = (colon === -1 ? piece : piece.slice(0, colon)).trim();
    if (!FILTER_SET.has(name)) return null;
    filters.push({ name, arg: colon === -1 ? null : piece.slice(colon + 1) });
  }
  return { kind: 'figure', path, filters, raw };
}

/**
 * The template parsed once, so the console draws a listing without reading
 * the grammar again per row, and the designer can say what is wrong with it.
 * A control left open closes at the end, said in `problems`; a closer with
 * nothing open is drawn as typed, the rule for every unknown tag.
 */
export function parseTemplate(source: string): Template {
  const tokens = dropControlLines(tokenize(source));
  const problems: Problem[] = [];
  const problem = (kind: Problem['kind'], tag: string): void => {
    if (!problems.some((seen) => seen.kind === kind && seen.tag === tag)) {
      problems.push({ kind, tag: `{${tag}}` });
    }
  };
  let at = 0;

  const parseBody = (until: (tag: string) => boolean): Node[] => {
    const nodes: Node[] = [];
    while (at < tokens.length) {
      const token = tokens[at]!;
      if (token.kind === 'text') {
        nodes.push({ kind: 'text', text: token.text });
        at += 1;
        continue;
      }
      if (token.kind === 'newline') {
        nodes.push({ kind: 'newline' });
        at += 1;
        continue;
      }
      const { tag, raw } = token;
      if (until(tag)) return nodes;
      at += 1;
      if (tag.startsWith('if ')) {
        nodes.push(parseIf(tag));
        continue;
      }
      if (tag.startsWith('group ')) {
        const groupNode = parseGroup(tag);
        if (groupNode === null) {
          problem('badTest', tag);
          nodes.push({ kind: 'text', text: raw });
        } else {
          nodes.push(groupNode);
        }
        continue;
      }
      if (tag.startsWith('for ')) {
        // `{for item in items}` names the row; `{for items}` does not.
        // Also supports inline filter: `{for item in items where ...}`.
        const said = tag.slice(4).trim();
        const whereMatch = /\s+where\s+(.+)$/.exec(said);
        let forPart = said;
        let whereExpr: Expr | undefined;
        if (whereMatch) {
          forPart = said.slice(0, whereMatch.index).trim();
          whereExpr = parseExpr(whereMatch[1]!.trim());
          if (whereExpr === undefined) problem('badTest', tag);
        }
        const bound = /^([A-Za-z_]\w*)\s+in\s+(.+)$/.exec(forPart);
        const as = bound?.[1];
        const path = bound === null ? forPart : bound[2]!.trim();
        if (!PATH.test(path) || (as !== undefined && !NAME.test(as))) {
          nodes.push({ kind: 'text', text: raw });
          continue;
        }
        const body = parseBody((next) => next === '/for');
        if (tokens[at]?.kind === 'tag') at += 1;
        else problem('unclosed', tag);
        nodes.push({
          kind: 'for',
          path,
          ...(as === undefined ? {} : { as }),
          ...(whereExpr === undefined ? {} : { where: whereExpr }),
          body
        });
        continue;
      }
      if (tag === 'table' || tag === 'table header') {
        const body = parseBody((next) => next === '/table');
        if (tokens[at]?.kind === 'tag') at += 1;
        else problem('unclosed', tag);
        nodes.push({ kind: 'table', header: tag === 'table header', body });
        continue;
      }
      if (BLOCK_CLOSE.test(tag) || isElse(tag)) {
        // A closer with nothing to close, or an else outside its if.
        problem('stray', tag);
        nodes.push({ kind: 'text', text: raw });
        continue;
      }
      if (isStyleTag(tag) || isStyleCloser(tag)) {
        nodes.push({ kind: 'style', tag });
        continue;
      }
      const figure = parseFigure(tag, raw);
      nodes.push(figure ?? { kind: 'text', text: raw });
    }
    return nodes;
  };

  const parseGroup = (tag: string): Node | null => {
    let said = tag.slice(6).trim();
    let keep = false;
    if (/\s+keep$/i.test(said)) {
      keep = true;
      said = said.replace(/\s+keep$/i, '').trim();
    }
    let rest = '';
    let target = '';
    const asMatch = /^(.*?)\s+as\s+([A-Za-z_]\w*)$/i.exec(said);
    if (asMatch) {
      rest = asMatch[1]!.trim();
      target = asMatch[2]!;
    } else {
      const lastWordMatch = /^(.*?)\s+([A-Za-z_]\w*)$/.exec(said);
      if (lastWordMatch) {
        rest = lastWordMatch[1]!.trim();
        target = lastWordMatch[2]!;
      } else {
        return null;
      }
    }
    if (!NAME.test(target) || rest.length === 0) return null;

    let source = 'items';
    let condition = rest;
    const sourceMatch = /^([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s+(.*)$/.exec(rest);
    if (sourceMatch) {
      const first = sourceMatch[1]!;
      const remainder = sourceMatch[2]!;
      if (
        remainder.startsWith('where ') ||
        remainder.startsWith('matching ') ||
        /^["']/.test(remainder) ||
        first === 'items' ||
        first === 'players' ||
        first === 'members' ||
        first === 'keys'
      ) {
        source = first;
        condition = remainder;
      }
    }

    if (condition.startsWith('where ')) {
      const expr = parseExpr(condition.slice(6).trim());
      if (expr === undefined) return null;
      return { kind: 'group', source, target, where: expr, ...(keep ? { keep: true } : {}) };
    }
    if (condition.startsWith('matching ')) {
      let pattern = condition.slice(9).trim();
      if (
        (pattern.startsWith('"') && pattern.endsWith('"')) ||
        (pattern.startsWith("'") && pattern.endsWith("'"))
      ) {
        pattern = pattern.slice(1, -1);
      }
      if (pattern.length === 0) return null;
      return { kind: 'group', source, target, pattern, ...(keep ? { keep: true } : {}) };
    }
    if (
      (condition.startsWith('"') && condition.endsWith('"')) ||
      (condition.startsWith("'") && condition.endsWith("'"))
    ) {
      const pattern = condition.slice(1, -1);
      return { kind: 'group', source, target, pattern, ...(keep ? { keep: true } : {}) };
    }
    return { kind: 'group', source, target, pattern: condition, ...(keep ? { keep: true } : {}) };
  };

  const isElse = (tag: string): boolean =>
    tag === 'else' || tag.startsWith('else if ') || tag.startsWith('elif ');

  const parseIf = (open: string): Node => {
    const branches: Array<{ test: Expr | null; body: Node[] }> = [];
    let head: string | null = open;
    while (head !== null) {
      const test =
        head === 'else'
          ? null
          : parseExpr(
              head.startsWith('if ')
                ? head.slice(3)
                : head.startsWith('else if ')
                  ? head.slice(8)
                  : head.slice(5)
            );
      if (test === undefined) problem('badTest', head);
      const body = parseBody((next) => next === '/if' || isElse(next));
      // An unreadable test is a branch never taken; `else` has none and is always.
      branches.push({ test: test === undefined ? { kind: 'literal', value: null } : test, body });
      const next = tokens[at];
      if (next?.kind === 'tag' && next.tag === '/if') {
        at += 1;
        head = null;
      } else if (next?.kind === 'tag' && isElse(next.tag)) {
        at += 1;
        head = next.tag;
      } else {
        problem('unclosed', open);
        head = null;
      }
    }
    return { kind: 'if', branches };
  };

  const nodes = parseBody(() => false);
  return { nodes, problems };
}

/* ───────────────────────────────────────────────────────── expressions */

export type Expr =
  | { kind: 'literal'; value: Scalar }
  | { kind: 'path'; path: string }
  | { kind: 'not'; operand: Expr }
  | { kind: 'neg'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr };

type BinaryOp =
  | 'or'
  | 'and'
  | '=='
  | '!='
  | '=~'
  | '!~'
  | 'matches'
  | '<'
  | '<='
  | '>'
  | '>='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

const EXPR_TOKEN =
  /\s*(?:(\d+(?:\.\d+)?|\.\d+)|("[^"]*"|'[^']*')|(=~|!~|==|!=|<=|>=|<|>|\+|-|\*|\/|%|\(|\))|([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*))/y;

const REGEX_CACHE = new Map<string, RegExp | null>();

/**
 * Compiles a string into a regular expression.
 *
 * If the string is enclosed in slashes (e.g. `/^pattern/i`), the slashes and
 * flags are respected. Otherwise, the pattern is compiled with the `'i'` flag
 * (case-insensitive) by default. If the pattern is invalid, null is returned.
 * Compiled patterns are cached so rows in a loop do not recompile.
 */
export function compileRegex(pattern: string): RegExp | null {
  const cached = REGEX_CACHE.get(pattern);
  if (cached !== undefined) return cached;
  let rx: RegExp | null = null;
  try {
    const slashMatch = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
    rx = slashMatch ? new RegExp(slashMatch[1]!, slashMatch[2]) : new RegExp(pattern, 'i');
  } catch {
    rx = null;
  }
  REGEX_CACHE.set(pattern, rx);
  return rx;
}

type ExprToken =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'word'; value: string };

function tokenizeExpr(source: string): ExprToken[] | null {
  const tokens: ExprToken[] = [];
  EXPR_TOKEN.lastIndex = 0;
  let at = 0;
  while (at < source.length) {
    EXPR_TOKEN.lastIndex = at;
    const match = EXPR_TOKEN.exec(source);
    if (match === null || match.index !== at) {
      return source.slice(at).trim().length === 0 ? tokens : null;
    }
    at = EXPR_TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: 'string', value: match[2].slice(1, -1) });
    else if (match[3] !== undefined) tokens.push({ kind: 'op', value: match[3] });
    else if (match[4] !== undefined) tokens.push({ kind: 'word', value: match[4] });
  }
  return tokens;
}

/**
 * A test or a sum, in the words a rule already uses: `and`, `or`, `not`,
 * the six comparisons, the four operations and `%`, numbers, quoted text,
 * `true`, `false`, `null`, and a figure's path. Undefined for anything else,
 * which the parser says out loud and the branch then never takes.
 */
export function parseExpr(source: string): Expr | undefined {
  const tokens = tokenizeExpr(source);
  if (tokens === null || tokens.length === 0) return undefined;
  let at = 0;
  const peek = (): ExprToken | undefined => tokens[at];
  const takeOp = (...ops: string[]): string | null => {
    const token = peek();
    if (token && (token.kind === 'op' || token.kind === 'word') && ops.includes(token.value)) {
      at += 1;
      return token.value;
    }
    return null;
  };

  const primary = (): Expr | undefined => {
    const token = peek();
    if (token === undefined) return undefined;
    at += 1;
    if (token.kind === 'number') return { kind: 'literal', value: token.value };
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'op') {
      if (token.value === '(') {
        const inner = expr();
        if (inner === undefined || takeOp(')') === null) return undefined;
        return inner;
      }
      if (token.value === '-') {
        const operand = primary();
        return operand === undefined ? undefined : { kind: 'neg', operand };
      }
      return undefined;
    }
    if (token.value === 'true') return { kind: 'literal', value: true };
    if (token.value === 'false') return { kind: 'literal', value: false };
    if (token.value === 'null') return { kind: 'literal', value: null };
    if (token.value === 'not') {
      const operand = primary();
      return operand === undefined ? undefined : { kind: 'not', operand };
    }
    if (token.value === 'and' || token.value === 'or') return undefined;
    return { kind: 'path', path: token.value };
  };

  const level = (next: () => Expr | undefined, ops: string[]): (() => Expr | undefined) => {
    return () => {
      let left = next();
      if (left === undefined) return undefined;
      let op = takeOp(...ops);
      while (op !== null) {
        const right = next();
        if (right === undefined) return undefined;
        left = { kind: 'binary', op: op as BinaryOp, left, right };
        op = takeOp(...ops);
      }
      return left;
    };
  };

  const term = level(primary, ['*', '/', '%']);
  const sum = level(term, ['+', '-']);
  const cmp = level(sum, ['==', '!=', '=~', '!~', 'matches', '<=', '>=', '<', '>']);
  const and = level(cmp, ['and']);
  const expr = level(and, ['or']);

  const out = expr();
  return out !== undefined && at === tokens.length ? out : undefined;
}

/** What a figure is worth to an expression: its value, else its text, else itself. */
function scalarOf(value: Value | undefined): Scalar {
  if (value === undefined) return null;
  if (isFigure(value)) return value.value !== undefined ? value.value : value.text;
  if (Array.isArray(value)) return value.length;
  if (isRow(value)) return true;
  return value as Scalar;
}

/** False for null, false, zero, blank text and an empty list. */
export function truthy(value: Scalar): boolean {
  if (value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

export function evaluate(expr: Expr, lookup: (path: string) => Value | undefined): Scalar {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'path':
      return scalarOf(lookup(expr.path));
    case 'not':
      return !truthy(evaluate(expr.operand, lookup));
    case 'neg': {
      const value = evaluate(expr.operand, lookup);
      return typeof value === 'number' ? -value : null;
    }
    case 'binary': {
      if (expr.op === 'and') {
        const left = evaluate(expr.left, lookup);
        return truthy(left) ? evaluate(expr.right, lookup) : left;
      }
      if (expr.op === 'or') {
        const left = evaluate(expr.left, lookup);
        return truthy(left) ? left : evaluate(expr.right, lookup);
      }
      const left = evaluate(expr.left, lookup);
      const right = evaluate(expr.right, lookup);
      switch (expr.op) {
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '=~':
        case 'matches': {
          if (left === null || right === null || typeof right !== 'string') return false;
          const rx = compileRegex(right);
          return rx !== null && rx.test(String(left));
        }
        case '!~': {
          if (left === null || right === null || typeof right !== 'string') return false;
          const rx = compileRegex(right);
          return rx !== null && !rx.test(String(left));
        }
        case '<':
        case '<=':
        case '>':
        case '>=': {
          // An unknown figure is not less than anything: the comparison is
          // false both ways, so a branch on it is never taken by accident.
          if (left === null || right === null) return false;
          if (typeof left === 'number' && typeof right === 'number')
            return compare(expr.op, left, right);
          if (typeof left === 'string' && typeof right === 'string') {
            return compare(expr.op, left.localeCompare(right), 0);
          }
          return false;
        }
        default: {
          if (typeof left !== 'number' || typeof right !== 'number') {
            return expr.op === '+' && (typeof left === 'string' || typeof right === 'string')
              ? `${left ?? ''}${right ?? ''}`
              : null;
          }
          switch (expr.op) {
            case '+':
              return left + right;
            case '-':
              return left - right;
            case '*':
              return left * right;
            case '/':
              return right === 0 ? null : left / right;
            case '%':
              return right === 0 ? null : left % right;
          }
        }
      }
    }
  }
}

function compare(op: '<' | '<=' | '>' | '>=', a: number, b: number): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
}

/* ────────────────────────────────────────────────────────── rendering */

/**
 * Cells a string paints in a fixed grid: emoji and East Asian wide characters
 * take two, marks, joiners and variation selectors none. An approximation of
 * the terminal's own measurement, used to hold the prompt row under the
 * repaint's seventy-nine columns and to line a table's columns up.
 */
export function cellsOf(text: string): number {
  let cells = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x200d || code === 0xfe0f || /\p{M}/u.test(ch)) continue;
    if (/\p{Extended_Pictographic}/u.test(ch) && code > 0x2000) cells += 2;
    else if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      cells += 2;
    } else cells += 1;
  }
  return cells;
}

export interface Drawn {
  segments: Segment[];
  glyphs: PlacedGlyph[];
  cells: number;
}

export interface RenderOptions {
  /** The column's name over a table, for a figure's path. */
  label?: (path: string) => string;
}

interface Style {
  fg: string[];
  bg: string[];
  bold: number;
  dim: number;
}

type Align = 'left' | 'right' | 'center';

/** One run of a line before the table pass: text, or a figure that may become a column. */
interface Piece {
  text: string;
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  glyph?: Glyph;
  /** Set on a figure drawn inside a table: the column it belongs to. */
  column?: { key: string; align: Align | null; numeric: boolean; header: boolean };
  /** Padding placed before a glyph, so a right-aligned picture keeps its cells. */
  lead?: string;
}

const NOTHING: Row = {};

/** `a.b.c` walked through the scope chain, innermost first. */
function lookupIn(chain: readonly Row[], path: string): Value | undefined {
  const [head, ...rest] = path.split('.');
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const row = chain[i]!;
    if (!(head! in row)) continue;
    let value: Value | undefined = row[head!];
    for (const key of rest) {
      // Any object with fields, a `Figure` included: a `{for}`'s bound row is
      // both — drawn as its name, read into for the rest of the path.
      if (value === undefined || value === null || typeof value !== 'object') return undefined;
      if (Array.isArray(value)) {
        if (key === 'length' || key === 'count') {
          value = value.length;
          continue;
        }
        return undefined;
      }
      value = (value as Row)[key];
    }
    return value;
  }
  return undefined;
}

/** The name a row is drawn by when its list is drawn whole. */
function nameOf(value: Value): string {
  if (isRow(value)) {
    const name = value['name'] ?? value['item'] ?? Object.values(value)[0];
    return name === undefined ? '' : textOf(name);
  }
  return textOf(value);
}

function textOf(value: Value | undefined): string {
  if (value === undefined || value === null) return UNKNOWN;
  if (isFigure(value)) return value.text;
  if (Array.isArray(value)) return value.map(nameOf).join(', ');
  /*
   * A record drawn on its own is drawn by its name, the way a row of a list
   * is when the list is drawn whole. `{for item in items}` makes `{item}` the
   * ordinary thing to write, and a blank there would read as a figure the
   * client does not have rather than as the author addressing the row.
   */
  if (isRow(value)) return nameOf(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function applyFilters(
  figure: Figure,
  filters: readonly Filter[]
): { figure: Figure; align: Align | null } {
  let text = figure.text;
  let align: Align | null = null;
  for (const filter of filters) {
    switch (filter.name) {
      case 'upper':
        text = text.toUpperCase();
        break;
      case 'lower':
        text = text.toLowerCase();
        break;
      case 'left':
      case 'right':
      case 'center':
        align = filter.name;
        break;
      case 'width': {
        const width = Number.parseInt(filter.arg ?? '', 10);
        if (!Number.isFinite(width) || width < 0) break;
        const have = cellsOf(text);
        if (have > width) text = [...text].slice(0, width).join('');
        else text = text + ' '.repeat(width - have);
        break;
      }
      case 'or':
        if (text.length === 0 || text === UNKNOWN || figure.value === null) text = filter.arg ?? '';
        break;
    }
  }
  return { figure: { ...figure, text }, align };
}

/**
 * The template drawn against a scope: one `Drawn` per line, in order. A
 * figure with a colour of its own wears it for its own characters only; a
 * glyph leaves its two blank cells; a table pads every figure in it to its
 * column's widest cell. Empty for a template that draws nothing.
 */
export function renderTemplate(
  template: Template | string,
  scope: Scope,
  options: RenderOptions = {}
): Drawn[] {
  const parsed = typeof template === 'string' ? parseTemplate(template) : template;
  const label = options.label ?? ((path: string) => path.split('.').pop() ?? path);

  const style: Style = { fg: [], bg: [], bold: 0, dim: 0 };
  const chain: Row[] = [{ ...scope }];
  const lines: Piece[][] = [[]];
  /** The lines a table is collecting, or null outside one. */
  let table: { lines: Piece[][]; header: boolean } | null = null;

  const current = (): Piece[] => {
    const target = table ? table.lines : lines;
    return target[target.length - 1]!;
  };
  const push = (piece: Omit<Piece, 'fg' | 'bg' | 'bold' | 'dim'> & Partial<Piece>): void => {
    current().push({
      fg: style.fg[style.fg.length - 1] ?? null,
      bg: style.bg[style.bg.length - 1] ?? null,
      bold: style.bold > 0,
      dim: style.dim > 0,
      ...piece
    });
  };
  const newline = (): void => {
    (table ? table.lines : lines).push([]);
  };

  const applyStyle = (tag: string): void => {
    if (tag === 'reset') {
      style.fg = [];
      style.bg = [];
      style.bold = 0;
      style.dim = 0;
    } else if (tag === 'bold') style.bold += 1;
    else if (tag === 'dim') style.dim += 1;
    else if (tag === '/bold') style.bold = Math.max(0, style.bold - 1);
    else if (tag === '/dim') style.dim = Math.max(0, style.dim - 1);
    else if (tag === '/bg' || tag.startsWith('/bg:')) style.bg.pop();
    else if (tag.startsWith('/')) style.fg.pop();
    else if (tag.startsWith('bg:')) style.bg.push(tag.slice(3));
    else style.fg.push(tag);
  };

  const drawFigure = (node: Extract<Node, { kind: 'figure' }>, asHeader: boolean): void => {
    const found = lookupIn(chain, node.path);
    if (found === undefined) {
      push({ text: node.raw });
      return;
    }
    const base: Figure = isFigure(found)
      ? found
      : isScalar(found)
        ? { text: textOf(found), value: found }
        : { text: textOf(found) };
    const numeric = typeof base.value === 'number';
    const { figure, align } = asHeader
      ? {
          figure: { text: base.glyph === undefined ? label(node.path) : '', colour: 'brightBlack' },
          align: applyFilters(base, node.filters).align
        }
      : applyFilters(base, node.filters);
    const piece: Piece = {
      text: figure.text,
      fg: figure.colour ?? style.fg[style.fg.length - 1] ?? null,
      bg: style.bg[style.bg.length - 1] ?? null,
      bold: style.bold > 0,
      dim: style.dim > 0,
      ...(figure.glyph === undefined ? {} : { glyph: figure.glyph }),
      ...(table === null ? {} : { column: { key: node.path, align, numeric, header: asHeader } })
    };
    current().push(piece);
  };

  const draw = (nodes: readonly Node[], asHeader: boolean): void => {
    for (const node of nodes) {
      switch (node.kind) {
        case 'text':
          push({ text: node.text });
          break;
        case 'newline':
          newline();
          break;
        case 'style':
          applyStyle(node.tag);
          break;
        case 'figure':
          drawFigure(node, asHeader);
          break;
        case 'group': {
          const list = lookupIn(chain, node.source);
          if (!Array.isArray(list)) {
            const curr = chain[chain.length - 1] as Record<string, Value>;
            curr[node.target] = [];
            curr[`${node.target}Count`] = 0;
            break;
          }
          const matched: Value[] = [];
          const remaining: Value[] = [];
          const rx = node.pattern !== undefined ? compileRegex(node.pattern) : null;

          for (const entry of list) {
            let isMatch = false;
            if (node.where !== undefined) {
              const fields = isRow(entry) ? entry : { name: entry };
              const rowScope: Row = {
                ...fields,
                ...(node.source === 'items' && !('item' in fields) ? { item: fields } : {})
              };
              chain.push(rowScope);
              isMatch = truthy(evaluate(node.where, (p) => lookupIn(chain, p)));
              chain.pop();
            } else if (rx !== null) {
              const nameStr = isRow(entry)
                ? String(entry['name'] ?? entry['item'] ?? '')
                : String(entry);
              const itemStr =
                isRow(entry) && entry['item'] !== undefined ? String(entry['item']) : nameStr;
              isMatch = rx.test(nameStr) || rx.test(itemStr);
            }
            if (isMatch) matched.push(entry);
            else remaining.push(entry);
          }

          if (!node.keep) {
            for (let i = chain.length - 1; i >= 0; i -= 1) {
              if (node.source in chain[i]!) {
                (chain[i] as Record<string, Value>)[node.source] = remaining;
                if (`${node.source}Count` in chain[i]!) {
                  (chain[i] as Record<string, Value>)[`${node.source}Count`] = remaining.length;
                } else if (node.source === 'items' && 'itemCount' in chain[i]!) {
                  (chain[i] as Record<string, Value>)['itemCount'] = remaining.length;
                }
                break;
              }
            }
          }

          const curr = chain[chain.length - 1] as Record<string, Value>;
          curr[node.target] = matched;
          curr[`${node.target}Count`] = matched.length;
          break;
        }
        case 'if': {
          for (const branch of node.branches) {
            const taken =
              branch.test === null ||
              truthy(evaluate(branch.test, (path) => lookupIn(chain, path)));
            if (taken) {
              draw(branch.body, asHeader);
              break;
            }
          }
          break;
        }
        case 'for': {
          const rawList = lookupIn(chain, node.path);
          if (!Array.isArray(rawList)) {
            // Not a list: the control is drawn as typed, like any unknown tag.
            push({ text: `{for ${node.as === undefined ? '' : `${node.as} in `}${node.path}}` });
            draw(node.body, asHeader);
            push({ text: '{/for}' });
            break;
          }
          /*
           * The row bound under its own name as well as bare, where the
           * template gave one: `{for item in items}` reaches `{item.weight}`
           * through the record, and `{item}` draws the row's own name. Both,
           * because they are two addresses for one value — see `Node`.
           */
          const bind = (row: Value): Row => {
            const fields = isRow(row) ? row : { name: row };
            if (node.as === undefined) return fields;
            /*
             * The bound row is drawn as the row and read as a record: `{item}`
             * is what the row would be called if the list were drawn whole,
             * and `{item.weight}` is a figure inside it. A `text` makes it a
             * `Figure`, which is what `textOf` draws; `lookupIn` descends
             * into it for the rest of the path.
             *
             * **The name the binding takes may be a field of the row**, and in
             * the pack it is: `item` is the listing's own counted label. The
             * drawn text is that field where it exists, so `{item}` says the
             * same thing under either spelling of the `{for}`.
             */
            const own = fields[node.as];
            const label = own === undefined ? nameOf(fields) : textOf(own);
            return { ...fields, [node.as]: { ...fields, text: label } };
          };

          const list =
            node.where === undefined
              ? rawList
              : rawList.filter((row) => {
                  chain.push(bind(row));
                  const ok = truthy(evaluate(node.where!, (path) => lookupIn(chain, path)));
                  chain.pop();
                  return ok;
                });

          // The header is the body drawn once with the labels for cells, on
          // the first row's fields; a list with no rows names no columns.
          const first = list[0];
          const head = (): Row => ({
            n: 0,
            rows: list.length,
            first: true,
            last: true,
            ...(first === undefined ? NOTHING : bind(first))
          });
          if (asHeader) {
            if (first !== undefined) {
              chain.push(head());
              draw(node.body, true);
              chain.pop();
            }
            break;
          }
          if (table !== null && table.header) {
            table.header = false;
            if (first !== undefined) {
              chain.push(head());
              draw(node.body, true);
              chain.pop();
            }
          }
          list.forEach((row, index) => {
            // The row's own fields win: a carried thing's `count` is its own.
            chain.push({
              n: index + 1,
              rows: list.length,
              first: index === 0,
              last: index === list.length - 1,
              ...bind(row)
            });
            draw(node.body, false);
            chain.pop();
          });
          break;
        }
        case 'table': {
          if (table !== null) {
            // A table inside a table is drawn as part of the outer one.
            draw(node.body, asHeader);
            break;
          }
          table = { lines: [[]], header: node.header };
          draw(node.body, asHeader);
          const done = alignColumns(table.lines);
          table = null;
          // The table's rows join the line the table opened on, which is
          // where its first row starts, and the rest follow.
          const last = lines[lines.length - 1]!;
          last.push(...(done[0] ?? []));
          lines.push(...done.slice(1));
          break;
        }
      }
    }
  };

  if (source(parsed).trim().length === 0) return [];
  draw(parsed.nodes, false);

  // A trailing newline in the template ends the last line; it does not add
  // an empty one. A blank line inside is kept, as typed.
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();

  /*
   * A colour left standing at the end of the template is not nothing: a prompt
   * row written `…]: {cyan}` is asking for what the player types next to be
   * cyan, and there is no text of its own to carry it. Kept as a zero-width
   * piece on the last line — after the pop, because a trailing newline says
   * nothing follows on *this* line, not that the colour was withdrawn — so
   * `toAnsi` can leave the console in that state rather than resetting out of
   * it. Only the last line: every earlier one is followed by another drawn
   * line, and each of those opens with a full SGR of its own.
   */
  const tail = lines[lines.length - 1]!;
  const last = tail[tail.length - 1];
  const ending = {
    fg: style.fg[style.fg.length - 1] ?? null,
    bg: style.bg[style.bg.length - 1] ?? null,
    bold: style.bold > 0,
    dim: style.dim > 0
  };
  if (
    last === undefined ||
    last.fg !== ending.fg ||
    last.bg !== ending.bg ||
    last.bold !== ending.bold ||
    last.dim !== ending.dim
  ) {
    tail.push({ text: '', ...ending });
  }

  return lines.map(toDrawn);
}

/** The template's text, for the one question asked of it whole: is there anything to draw. */
function source(template: Template): string {
  let out = '';
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.kind === 'text') out += node.text;
      else if (node.kind === 'figure' || node.kind === 'style') out += '{}';
      else if (node.kind === 'if') node.branches.forEach((branch) => walk(branch.body));
      else if (node.kind === 'for' || node.kind === 'table') walk(node.body);
    }
  };
  walk(template.nodes);
  return out;
}

/** Cells a piece takes: its text, and a glyph's two blank cells. */
function widthOf(piece: Piece): number {
  return cellsOf(piece.text) + (piece.glyph === undefined ? 0 : GLYPH_CELLS);
}

/**
 * Every figure in a table padded to its column's widest cell — text flush
 * left, a column of numbers flush right, or as its filter says. Columns are
 * keyed by the figure's path, so a row that leaves one out stays lined up.
 */
function alignColumns(lines: Piece[][]): Piece[][] {
  const widths = new Map<string, number>();
  const numeric = new Map<string, boolean>();
  const aligns = new Map<string, Align>();
  for (const line of lines) {
    for (const piece of line) {
      if (piece.column === undefined) continue;
      const { key } = piece.column;
      widths.set(key, Math.max(widths.get(key) ?? 0, widthOf(piece)));
      if (piece.text.length > 0 && piece.glyph === undefined && !piece.column.header) {
        numeric.set(key, (numeric.get(key) ?? true) && piece.column.numeric);
      }
      if (piece.column.align !== null) aligns.set(key, piece.column.align);
    }
  }
  if (widths.size === 0) return lines;
  return lines.map((line) =>
    line.map((piece) => {
      if (piece.column === undefined) return piece;
      const { key } = piece.column;
      const pad = Math.max(0, (widths.get(key) ?? 0) - widthOf(piece));
      if (pad === 0) return piece;
      const align = aligns.get(key) ?? (numeric.get(key) === true ? 'right' : 'left');
      const before = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0;
      const after = pad - before;
      if (piece.glyph !== undefined) {
        return { ...piece, lead: ' '.repeat(before), text: piece.text + ' '.repeat(after) };
      }
      return { ...piece, text: ' '.repeat(before) + piece.text + ' '.repeat(after) };
    })
  );
}

/** A line's pieces as runs, glyphs placed at the cell they start in. */
function toDrawn(pieces: readonly Piece[]): Drawn {
  const segments: Segment[] = [];
  const glyphs: PlacedGlyph[] = [];
  let cells = 0;
  const push = (text: string, piece: Piece): void => {
    if (text.length === 0) return;
    cells += cellsOf(text);
    const last = segments[segments.length - 1];
    if (
      last &&
      last.fg === piece.fg &&
      last.bg === piece.bg &&
      last.bold === piece.bold &&
      last.dim === piece.dim
    ) {
      last.text += text;
    } else {
      segments.push({ text, fg: piece.fg, bg: piece.bg, bold: piece.bold, dim: piece.dim });
    }
  };
  for (const piece of pieces) {
    if (piece.glyph !== undefined) {
      push(piece.lead ?? '', piece);
      glyphs.push({ ...piece.glyph, x: cells });
      push(GLYPH_BLANK, piece);
    }
    push(piece.text, piece);
  }
  /*
   * The state the line ends in, when the template said one and gave it no
   * text to wear (`renderTemplate`'s zero-width tail). A run of no cells, so
   * nothing measures or draws differently; `toAnsi` emits its SGR and skips
   * the reset it would otherwise undo it with.
   */
  const ending = pieces[pieces.length - 1];
  if (ending !== undefined && ending.text.length === 0 && ending.glyph === undefined) {
    const drawn = segments[segments.length - 1];
    if (
      drawn === undefined ||
      drawn.fg !== ending.fg ||
      drawn.bg !== ending.bg ||
      drawn.bold !== ending.bold ||
      drawn.dim !== ending.dim
    ) {
      segments.push({
        text: '',
        fg: ending.fg,
        bg: ending.bg,
        bold: ending.bold,
        dim: ending.dim
      });
    }
  }
  return { segments, glyphs, cells };
}

/** The figure paths a template names, in order: drawn, tested and repeated over alike. */
export function pathsIn(template: Template | string): string[] {
  const parsed = typeof template === 'string' ? parseTemplate(template) : template;
  const out: string[] = [];
  const tested = (expr: Expr): void => {
    if (expr.kind === 'path') out.push(expr.path);
    else if (expr.kind === 'not' || expr.kind === 'neg') tested(expr.operand);
    else if (expr.kind === 'binary') {
      tested(expr.left);
      tested(expr.right);
    }
  };
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (node.kind === 'figure') out.push(node.path);
      else if (node.kind === 'if') {
        for (const branch of node.branches) {
          if (branch.test !== null) tested(branch.test);
          walk(branch.body);
        }
      } else if (node.kind === 'group') {
        out.push(node.source);
        if (node.where !== undefined) tested(node.where);
        out.push(node.target);
      } else if (node.kind === 'for') {
        out.push(node.path);
        if (node.where !== undefined) tested(node.where);
        walk(node.body);
      } else if (node.kind === 'table') walk(node.body);
    }
  };
  walk(parsed.nodes);
  return out;
}

/* ─────────────────────────────────────────────────────────── to bytes */

function sgrColour(colour: string, background: boolean): string {
  if (isAnsiColour(colour)) {
    const index = ANSI_COLOURS.indexOf(colour);
    const base = index < 8 ? (background ? 40 : 30) + index : (background ? 100 : 90) + index - 8;
    return String(base);
  }
  const r = Number.parseInt(colour.slice(1, 3), 16);
  const g = Number.parseInt(colour.slice(3, 5), 16);
  const b = Number.parseInt(colour.slice(5, 7), 16);
  return `${background ? 48 : 38};2;${r};${g};${b}`;
}

/**
 * The runs as bytes for the console: one SGR per run, and by default a reset
 * at the end so whatever the server prints after the line starts clean.
 * Palette names become the sixteen SGR colours, so the drawn line follows
 * whichever palette the console wears; a hex is a truecolor SGR.
 *
 * **Unless the template ended in a colour of its own.** A prompt row written
 * `…]: {cyan}` is asking for what the player types next to be cyan — the one
 * thing on the row the client does not draw — and a reset after it would
 * throw away the only reason that tag was typed. That intent arrives as a
 * zero-width final run whose SGR is emitted and then left standing; a
 * template that ends in no styling produces a run with no styling, whose SGR
 * *is* the reset, so the default is unchanged rather than special-cased.
 */
export function toAnsi(segments: readonly Segment[]): string {
  let out = '';
  for (const segment of segments) {
    const codes = ['0'];
    if (segment.bold) codes.push('1');
    if (segment.dim) codes.push('2');
    if (segment.fg !== null) codes.push(sgrColour(segment.fg, false));
    if (segment.bg !== null) codes.push(sgrColour(segment.bg, true));
    out += `\x1b[${codes.join(';')}m${segment.text}`;
  }
  return segments[segments.length - 1]?.text === '' ? out : `${out}\x1b[0m`;
}
