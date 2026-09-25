import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The rail's jump targets and the fieldsets they scroll to are two halves of
 * one fact, written in two places: a table of `{id, label}` beside the section
 * list, and a `data-fieldset` attribute on the fieldset itself (todo 02).
 *
 * Nothing else pairs them. A fieldset renamed without its table entry leaves a
 * rail row that scrolls nowhere; a table entry with no fieldset is a control
 * that does nothing. Neither typecheck nor any other test would notice, which
 * is the closed-union failure this project watches for -- `GUARD_FIELDS` and
 * `readField`, `ALERT_EVENTS` and `NOTABLE`.
 *
 * Read out of the source rather than rendered, because rendering either screen
 * means standing up a config, a realm and a session for a question that is
 * entirely about two lists of strings.
 */
const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/** The ids the rail offers: every `{ id: '...' }` inside `SECTION_FIELDSETS`. */
function offered(source: string): string[] {
  const table = source.slice(source.indexOf('const SECTION_FIELDSETS'));
  const end = table.indexOf('\n};');
  return [...table.slice(0, end).matchAll(/\{\s*id:\s*'([^']+)'/g)].map((hit) => hit[1]!);
}

/** The ids the form draws: every `data-fieldset="..."`. */
function drawn(source: string): string[] {
  return [...source.matchAll(/data-fieldset="([^"]+)"/g)].map((hit) => hit[1]!);
}

describe.each([
  ['CharacterForm.tsx', [] as string[]],
  ['GlobalSettings.tsx', [] as string[]]
])('%s', (file, notNavigable) => {
  const source = read(file);

  /* The positive control: a regex that matched nothing would pass everything. */
  it('finds both halves at all', () => {
    expect(offered(source).length).toBeGreaterThan(5);
    expect(drawn(source).length).toBeGreaterThan(5);
  });

  it('draws a fieldset for every jump target the rail offers', () => {
    const missing = offered(source).filter((id) => !drawn(source).includes(id));
    expect(missing).toEqual([]);
  });

  /*
   * The other direction, minus the fieldsets that are deliberately not jump
   * targets. The Realms page has no sections at all (`sections={[]}`), so
   * `ServerForm.tsx` has no rail to list its fieldsets in and is not here.
   */
  it('offers a jump target for every fieldset it tags', () => {
    const stray = drawn(source).filter(
      (id) => !offered(source).includes(id) && !notNavigable.includes(id)
    );
    expect(stray).toEqual([]);
  });

  it('tags each fieldset exactly once', () => {
    const seen = new Set<string>();
    const twice = drawn(source).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(twice).toEqual([]);
  });
});
