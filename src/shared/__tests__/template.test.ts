import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { normalizeConfig, parseGuard } from '../config';
import type { GuardField } from '../rules';

const TEMPLATE = path.resolve('resources/config/default.yaml');
const text = fs.readFileSync(TEMPLATE, 'utf8');

/*
 * The template is the documentation. Every claim in it is a claim somebody will
 * copy, and a commented example that does not load is worse than none — it
 * teaches a vocabulary the client does not have and fails silently.
 */
describe('the options template', () => {
  it('parses', () => {
    expect(() => YAML.parse(text)).not.toThrow();
  });

  it('loads into a configuration without falling back to defaults', () => {
    const config = normalizeConfig(YAML.parse(text));
    expect(config.connection.port).toBeGreaterThan(0);
    expect(config.automation.safety.hangUp.onlyWhenClean).toBe(true);
  });

  /**
   * The commented rule examples, uncommented.
   *
   * This is the check that would have caught `target`, `attackers`, `players`,
   * `hostiles` and `hangUpClean` being added to the guard *type* and to the
   * reader but not to the parser: the examples using them loaded as nothing at
   * all, and the only symptom was a rule that never fired.
   */
  const examples = (): unknown => {
    const block = text.split('# rules:')[1]?.split('rules: []')[0] ?? '';
    const yaml =
      'rules:\n' +
      block
        .split('\n')
        .filter((line) => line.trim().startsWith('#'))
        .map((line) => line.replace(/^\s*#\s?/, '  '))
        .join('\n');
    return YAML.parse(yaml);
  };

  it('has rule examples, and every one of them loads', () => {
    const parsed = examples() as { rules?: unknown[] };
    const written = parsed.rules?.length ?? 0;
    expect(written).toBeGreaterThan(0);

    const config = normalizeConfig({ automation: parsed });
    // Every example survives coercion. One that does not is a rule the client
    // silently drops, which reads exactly like a rule that never matches.
    expect(config.automation.rules).toHaveLength(written);
  });

  it('names only guard fields the parser accepts', () => {
    const config = normalizeConfig({ automation: examples() });
    for (const rule of config.automation.rules) {
      for (const guard of rule.if) {
        expect(parseGuard(`${guard.field} ${guard.op} ${String(guard.value)}`)).not.toBeNull();
      }
    }
  });

  /*
   * Both halves of a closed union have to move together: the list the parser
   * checks against, and the reader that answers for a field. One without the
   * other is a field the type system accepts and the parser refuses.
   */
  it('documents every guard field the parser accepts, and no others', () => {
    const documented = new Set(
      [...text.matchAll(/^\s*#\s{16}(\w[\w.]*)\s{2,}/gm)].map((match) => match[1])
    );
    // The block that lists them is indented under `if`; anything it names must
    // be a field, and every field a rule can use ought to be named there.
    const fields: GuardField[] = [
      'hp.percent',
      'hp',
      'mana.percent',
      'mana',
      'level',
      'inCombat',
      'resting',
      'meditating',
      'occupants',
      'mobs',
      'players',
      'hostiles',
      'hangUpClean',
      'target',
      'attackers',
      'wealth',
      'phase'
    ];
    for (const field of fields) {
      expect(
        parseGuard(`${field} == 1`),
        `parser rejects documented field ${field}`
      ).not.toBeNull();
    }
    for (const named of documented) {
      expect(
        parseGuard(`${named} == 1`),
        `template documents unknown field ${named}`
      ).not.toBeNull();
    }
  });
});

/*
 * The other half of the same trap.
 *
 * The template is copied once, on first run, and never rewritten wholesale, so
 * a block added to the configuration and not to the template is one no
 * existing file will ever grow. `reconcileWithTemplate` closes that gap by
 * copying the template's own block — comments and all — into a file that lacks
 * it, which means a block the template does not state is a block it cannot
 * bring. That is exactly how automatic login shipped, was verified, and still
 * looked completely broken.
 */
describe('the shipped options template', () => {
  /**
   * Assembled from the tree beside the file rather than stated in it.
   *
   * A realm is a directory under `realms/` with its own menus and its own
   * loops. `AppConfig` still carries the assembled list, because everything
   * that reads a configuration wants one complete thing — but the options file
   * never states it, so the template must not either.
   */
  const ELSEWHERE = new Set(['servers']);

  it('states every top-level block of the configuration', () => {
    const stated = new Set(Object.keys((YAML.parse(text) ?? {}) as Record<string, unknown>));
    for (const key of Object.keys(normalizeConfig({}))) {
      if (ELSEWHERE.has(key)) continue;
      expect(stated.has(key), `the template says nothing about \`${key}\``).toBe(true);
    }
  });

  it('does not state what lives in a directory of its own', () => {
    const stated = new Set(Object.keys((YAML.parse(text) ?? {}) as Record<string, unknown>));
    for (const key of ELSEWHERE) {
      expect(stated.has(key), `the template still states \`${key}\``).toBe(false);
    }
  });
});
