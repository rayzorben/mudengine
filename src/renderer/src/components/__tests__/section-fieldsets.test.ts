import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AUTOMATION_SWITCHES } from '@shared/config';

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

/**
 * A form's own source and the shared sections it imports (`…Fields`,
 * `…Fieldset`, `…Sections`, `…Switches`), since those draw fieldsets for both
 * forms (`PartyFields`, todo 831; `HangUpFieldset`, todo 118).
 */
function sourcesOf(file: string, seen = new Set<string>()): string[] {
  seen.add(file);
  const source = read(file);
  const local = [
    ...source.matchAll(
      /^import \w+(?:, \{[^}]*\})? from '\.\/(\w+(?:Fields|Fieldset|Sections|Switches))';$/gm
    )
  ]
    .map((hit) => `${hit[1]!}.tsx`)
    .filter((name) => !seen.has(name));
  // Followed down, since a section can be drawn by a section it composes (`MacroSections`, todo 134).
  return [source, ...local.flatMap((name) => sourcesOf(name, seen))];
}

const composed = (file: string): string => sourcesOf(file).join('\n');

/** Where each switch the file holds lives, as a field's `setting` names it. */
const SWITCH_SETTINGS = new Set(
  Object.values(AUTOMATION_SWITCHES).flatMap((path) =>
    path === 'session' ? [] : [`automation.${path.join('.')}`]
  )
);

/** The expression each switch's checkbox draws from: its `checked={…}`. */
function switchChecks(source: string): string[] {
  return [...source.matchAll(/<CheckField\b([\s\S]*?)\/>/g)].flatMap((hit) => {
    const props = hit[1]!;
    const setting = /setting="([^"]+)"/.exec(props)?.[1];
    const checked = /checked=\{([^}]+)\}/.exec(props)?.[1];
    return setting !== undefined && checked !== undefined && SWITCH_SETTINGS.has(setting)
      ? [checked.trim()]
      : [];
  });
}

// The form, the file its rail table is in, and the fieldsets that are not jump targets.
describe.each([
  ['CharacterForm.tsx', 'characterNav.ts', [] as string[]],
  ['GlobalSettings.tsx', 'GlobalSettings.tsx', [] as string[]]
])('%s', (file, tableFile, notNavigable) => {
  const source = composed(file);
  const table = read(tableFile);

  /* The positive control: a regex that matched nothing would pass everything. */
  it('finds both halves at all', () => {
    expect(offered(table).length).toBeGreaterThan(5);
    expect(drawn(source).length).toBeGreaterThan(5);
  });

  it('draws a fieldset for every jump target the rail offers', () => {
    const missing = offered(table).filter((id) => !drawn(source).includes(id));
    expect(missing).toEqual([]);
  });

  /*
   * The other direction, minus the fieldsets that are deliberately not jump
   * targets. The Realms page has no sections at all (`sections={[]}`), so
   * `ServerForm.tsx` has no rail to list its fieldsets in and is not here.
   */
  it('offers a jump target for every fieldset it tags', () => {
    const stray = drawn(source).filter(
      (id) => !offered(table).includes(id) && !notNavigable.includes(id)
    );
    expect(stray).toEqual([]);
  });

  /*
   * Todo 20261102-1830-01: a switch's checkbox is the character's standing
   * value, and no field is drawn only while it is ticked. A run hid the whole
   * Combat page behind the Auto-Attack box.
   */
  it("draws no field behind a switch's checkbox", () => {
    // File by file: a name such as `enabled` means a different switch in each.
    const files = sourcesOf(file);
    const checks = files.flatMap((one) => switchChecks(one).map((expr) => ({ one, expr })));
    // Positive control: the switches' checkboxes are found at all.
    expect(checks.length).toBeGreaterThan(5);
    const hidden = checks
      .filter(({ one, expr }) => one.includes(`{${expr} && (`) || one.includes(`{${expr} ? (`))
      .map(({ expr }) => expr);
    expect(hidden).toEqual([]);
  });

  it('tags each fieldset exactly once', () => {
    const seen = new Set<string>();
    const twice = drawn(source).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(twice).toEqual([]);
  });
});
