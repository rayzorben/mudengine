import ts from 'typescript';

/**
 * Where a source walks a room's ways out from a frontier: the shape of a
 * route search or a reachability flood written by hand. Read by the compiler
 * for `structure.test.ts` › *one navigation engine*, which pins the files
 * allowed one.
 *
 * A walk is a loop or array call over an expression that reads `.exits` or
 * calls a function listing a room's ways (`STEP_LISTS`), made inside a
 * frontier loop: a `while`, `do` or `for` whose header reads a name its own
 * body pushes to or assigns, as a queue or a next ring is. A scan over every
 * room reads exits too, and its loop grows nothing, so it is not a walk.
 */
const STEP_LISTS: ReadonlySet<string> = new Set([
  'planeSteps',
  'leapSteps',
  'portalsFrom',
  'movesFrom',
  'waysOut'
]);
const ARRAY_WALKS: ReadonlySet<string> = new Set([
  'forEach',
  'map',
  'filter',
  'flatMap',
  'some',
  'every',
  'find'
]);

/** The 1-based lines of `text` holding a walk over a room's ways out from a frontier. */
export function exitWalks(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node, inFrontier: boolean): void => {
    // A named function starts afresh; a callback inside the loop is still in it.
    if (ts.isFunctionLike(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
      ts.forEachChild(node, (child) => visit(child, false));
      return;
    }
    const over = iterated(node);
    if (inFrontier && over !== null && readsWays(over))
      lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    const frontier = inFrontier || isFrontier(node);
    ts.forEachChild(node, (child) => visit(child, frontier));
  };
  visit(source, false);
  return lines;
}

/** What a `for…of` or an array call walks over, or null for anything else. */
function iterated(node: ts.Node): ts.Expression | null {
  if (ts.isForOfStatement(node)) return node.expression;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ARRAY_WALKS.has(node.expression.name.text)
  )
    return node.expression.expression;
  return null;
}

function readsWays(expression: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'exits') found = true;
    if (ts.isCallExpression(node) && STEP_LISTS.has(calleeName(node.expression))) found = true;
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function calleeName(callee: ts.Expression): string {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

/** A loop whose header reads a name its body grows. */
function isFrontier(node: ts.Node): boolean {
  if (ts.isWhileStatement(node) || ts.isDoStatement(node))
    return grows(node.statement, namesIn(node.expression));
  if (ts.isForStatement(node)) return grows(node.statement, namesIn(node.condition));
  if (ts.isForOfStatement(node)) return grows(node.statement, namesIn(node.expression));
  return false;
}

function namesIn(node: ts.Node | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  };
  if (node !== undefined) visit(node);
  return names;
}

/** Whether `body` pushes to or assigns any of `names`. */
function grows(body: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'push' || node.expression.name.text === 'unshift') &&
      ts.isIdentifier(node.expression.expression) &&
      names.has(node.expression.expression.text)
    )
      found = true;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      names.has(node.left.text)
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}
