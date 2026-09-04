/**
 * The dictionary and its readers are a closed union, and the halves move
 * together — the same claim `ipc-wiring.test.ts` makes for channels and
 * `guard-fields.test.ts` makes for guard fields, made here for words.
 *
 * Two failures this exists to catch, both of which type-check clean:
 * a `t('…')` call naming a key `locales/ui.en.yaml` does not have (the screen
 * would show the raw key), and a key in the YAML that nothing reads (copy
 * that looks maintained and is dead). Both directions are walked from the
 * sources themselves, so neither list can drift from the code it describes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { asUiDict, flattenDict } from '../i18n';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * A `t(<not a plain literal>)` call is allowed only where a row here claims
 * it, with the prefix it draws from — the keys under that prefix then count
 * as read. An exemption is a claim with a date on it; when the call site
 * goes, the row goes.
 */
const DYNAMIC_CALLS: readonly { file: string; prefix: string; reason: string }[] = [];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Light comment stripping, so a key quoted in a doc comment is not "usage". */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

interface Usage {
  literal: Map<string, string[]>; // key -> files using it
  dynamic: { file: string; at: string }[];
}

function scanUsage(): Usage {
  const literal = new Map<string, string[]>();
  const dynamic: Usage['dynamic'] = [];
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const raw = readFileSync(path, 'utf8');
    if (!/from\s+'[^']*\/i18n'/.test(raw)) continue;
    const code = stripComments(raw);
    const file = path.slice(ROOT.length);
    for (const match of code.matchAll(/\bt\(/g)) {
      const rest = code.slice((match.index ?? 0) + match[0].length);
      const literalCall = /^\s*'([^'\n]*)'\s*[,)]/.exec(rest);
      if (literalCall !== null) {
        const key = literalCall[1] ?? '';
        literal.set(key, [...(literal.get(key) ?? []), file]);
      } else {
        dynamic.push({ file, at: rest.slice(0, 40).replace(/\s+/g, ' ') });
      }
    }
  }
  return { literal, dynamic };
}

function dictionaryKeys(): Set<string> {
  const raw = readFileSync(join(ROOT, 'locales', 'ui.en.yaml'), 'utf8');
  const dict = asUiDict(parse(raw));
  expect(dict, 'locales/ui.en.yaml must parse to a dictionary of strings').not.toBeNull();
  return new Set(flattenDict(dict ?? {}).keys());
}

describe('the UI dictionary and its readers agree', () => {
  const keys = dictionaryKeys();
  const usage = scanUsage();

  it('every key the code asks for is in the dictionary', () => {
    const missing = [...usage.literal.entries()]
      .filter(([key]) => !keys.has(key))
      .map(([key, files]) => `${key} (${files.join(', ')})`);
    expect(missing, 'keys used in code but absent from locales/ui.en.yaml').toEqual([]);
  });

  it('every key in the dictionary is read by something', () => {
    const dead = [...keys].filter(
      (key) => !usage.literal.has(key) && !DYNAMIC_CALLS.some((d) => key.startsWith(`${d.prefix}.`))
    );
    expect(dead, 'keys in locales/ui.en.yaml that nothing reads').toEqual([]);
  });

  it('a dynamic t() call appears only where a DYNAMIC_CALLS row claims it', () => {
    const unclaimed = usage.dynamic
      .filter((d) => !DYNAMIC_CALLS.some((row) => d.file.includes(row.file)))
      .map((d) => `${d.file}: t(${d.at}…`);
    expect(unclaimed, 'dynamic t() calls with no DYNAMIC_CALLS exemption').toEqual([]);
  });

  it('every exemption still names a real call site', () => {
    const stale = DYNAMIC_CALLS.filter(
      (row) => !usage.dynamic.some((d) => d.file.includes(row.file))
    ).map((row) => row.file);
    expect(stale, 'DYNAMIC_CALLS rows whose call site is gone').toEqual([]);
  });
});
