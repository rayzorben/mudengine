import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { repoPath } from './sources';

/**
 * What a file imports, read and resolved by the compiler against
 * `tsconfig.node.json`, so an alias (`@main/…`) or an `index.ts` is followed
 * to the file it names. One reading for every guard that asks where an import
 * leads (`structure.test.ts`, `lifecycle.test.ts`).
 */
export interface Import {
  readonly from: string;
  /** The resolved file, repo-relative, or the specifier where it is not a file here (npm, `node:`). */
  readonly target: string;
  readonly typeOnly: boolean;
  /** A named import's bindings: the name exported, and the local name it is bound to. */
  readonly bindings: ReadonlyArray<{ readonly name: string; readonly as: string }>;
}

const ROOT = path.resolve('.');
const compilerOptions = ts.parseJsonConfigFileContent(
  ts.readConfigFile(path.join(ROOT, 'tsconfig.node.json'), ts.sys.readFile).config,
  ts.sys,
  ROOT
).options;
const resolutionCache = ts.createModuleResolutionCache(ROOT, (name) => name, compilerOptions);

/** Where a specifier in a repo-relative file leads. */
export function resolveImport(spec: string, from: string): string {
  const containing = path.join(ROOT, from);
  const resolved = ts.resolveModuleName(
    spec,
    containing,
    compilerOptions,
    ts.sys,
    resolutionCache
  ).resolvedModule;
  if (resolved !== undefined && !resolved.isExternalLibraryImport) {
    return repoPath(resolved.resolvedFileName);
  }
  // A Vite asset (`?raw`) resolves by path; the compiler does not know it.
  if (spec.startsWith('.')) {
    return repoPath(path.resolve(path.dirname(containing), spec.split('?')[0] ?? spec));
  }
  return spec;
}

/** Every import a repo-relative file makes: static, re-exported, `import =`, dynamic and `import()` types. */
export function importsOf(file: string): Import[] {
  const found: Import[] = [];
  const add = (
    spec: ts.Expression | undefined,
    typeOnly: boolean,
    bindings: Import['bindings'] = []
  ): void => {
    if (spec === undefined || !ts.isStringLiteralLike(spec)) return;
    found.push({ from: file, target: resolveImport(spec.text, file), typeOnly, bindings });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const named = node.importClause?.namedBindings;
      const bindings =
        named !== undefined && ts.isNamedImports(named)
          ? named.elements.map((element) => ({
              name: (element.propertyName ?? element.name).text,
              as: element.name.text
            }))
          : [];
      add(node.moduleSpecifier, node.importClause?.isTypeOnly === true, bindings);
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0], false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    }
    ts.forEachChild(node, visit);
  };
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}
