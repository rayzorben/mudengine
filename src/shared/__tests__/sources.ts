import fs from 'node:fs';
import path from 'node:path';

/**
 * Every file under a directory whose name matches, never entering
 * `node_modules` or a directory named in `skip`. The one walk behind
 * `sourceFiles` and any guard that must also read tests or `scripts/`.
 * Paths are joined onto `dir` as given.
 */
export function filesUnder(
  dir: string,
  name: RegExp,
  skip: ReadonlySet<string> = new Set()
): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, name, skip));
    else if (name.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every `.ts`/`.tsx` under a directory that ships: `__tests__` and
 * `node_modules` skipped, `*.test.ts(x)` dropped. One reading for every
 * guard that scans source text, so a file is never a source to one of them
 * and a test to another. Paths are joined onto `dir` as given.
 */
export function sourceFiles(dir: string): string[] {
  return filesUnder(dir, /\.tsx?$/, new Set(['__tests__'])).filter(
    (file) => !/\.test\.tsx?$/.test(file)
  );
}

/** A path as the guards print and compare it: repo-relative, with `/`. */
export function repoPath(file: string): string {
  return path.relative(path.resolve('.'), path.resolve(file)).split(path.sep).join('/');
}

/**
 * A method's body in a class's source text, from the line `declaration`
 * matches to the class-level closing brace after it. For the guards that
 * hold an order a method states and no behaviour can tell apart
 * (`lifecycle.test.ts`, the walker's units). `where` names the file in the
 * error when nothing matches.
 */
export function methodBody(source: string, declaration: RegExp, where: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => declaration.test(line));
  if (start < 0) throw new Error(`no ${declaration} in ${where}`);
  const end = lines.findIndex((line, i) => i > start && line === '  }');
  return lines.slice(start, end + 1).join('\n');
}
