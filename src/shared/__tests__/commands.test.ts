/*
 * The realm's vocabulary, and the one word this client has to be stopped from
 * inventing again.
 *
 * `NOT_COMMANDS` is a claim about the server — that `flee` is not a command —
 * and a consequence for this codebase: nothing may send it. The claim is
 * checked against the table extracted from `Commands.cs`; the consequence is
 * checked by reading the source, because it is the half that actually cost a
 * character. `flee` reached the wire through configuration, a settings screen,
 * an options template and a hangup refusal that recommended it by name, and
 * every one of those repeated it without anything checking.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMMAND_WORDS, NOT_COMMANDS, commandOf, movementEffect } from '../commands';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Comments out, so the paragraph explaining why a word is forbidden is not read
 * as somebody using it. The same light stripping `i18n-coverage.test.ts` does,
 * and for the same reason.
 */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Every `.ts`/`.tsx` under a directory, tests excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('words that are not commands', () => {
  it('names at least the one that cost a character', () => {
    expect(NOT_COMMANDS).toContain('flee');
  });

  /*
   * The claim itself. 94 commands, 325 words, extracted whole from the
   * server's own dispatch table — and the server does no prefix matching, so
   * absence from this map is absence, full stop.
   */
  it('is absent from the realm’s own command table, under every spelling', () => {
    for (const word of NOT_COMMANDS) {
      expect(COMMAND_WORDS[word], `${word} is in COMMAND_WORDS`).toBeUndefined();
      expect(commandOf(word), `${word} resolves to a command`).toBeNull();
      // And so it cannot be modelled as a way through the realm, either: an
      // unknown word is what a text exit looks like, which is the one shape
      // `WorldMemory` learns from.
      expect(movementEffect(word)).toBe('unknown');
    }
  });

  /*
   * The consequence, read out of the source the way `guard-fields.test.ts`
   * reads the three halves of its union: nothing in `src/` may carry the word
   * as a string literal.
   *
   * **The whole tree, not the two directories that send commands.** It reached
   * the wire from `SessionManager`, but it *came* from `config.ts`'s strategy
   * list, the settings screen's fallback, `drafts.ts` and the locale copy —
   * four surfaces that repeated it and none that checked. Guarding only the
   * place it was sent from would leave every place it was learned from open.
   *
   * **Comments are stripped first**, and that is not a loophole — it is the
   * point. Why the word is forbidden has to be writable down beside the code
   * that forbids it, and the paragraphs doing that are the only reason the next
   * person will not re-derive it. What may not exist is a *value*: a command in
   * this codebase is always a quoted bare word (`command: 'n'`), so that is
   * what is matched, with the comments taken out from around it.
   */
  it('appears as a string literal nowhere in the client', () => {
    const offenders: string[] = [];
    for (const word of NOT_COMMANDS) {
      const literal = new RegExp(`['"\`]${word}['"\`]`, 'i');
      for (const file of sourceFiles(join(ROOT, 'src'))) {
        /*
         * Two files may say it, and both say it in order to get rid of it:
         * `commands.ts` declares the list, and `Migration.ts` has to name the
         * key it is renaming in somebody's file — a migration that could not
         * spell the thing it removes could not remove it. Neither ever reaches
         * a socket: `Migration.ts` imports nothing that sends, which is the
         * property that makes this exemption safe rather than convenient.
         */
        if (file.endsWith(join('shared', 'commands.ts'))) continue;
        if (file.endsWith(join('config', 'Migration.ts'))) continue;
        if (literal.test(withoutComments(readFileSync(file, 'utf8')))) {
          offenders.push(`${file.slice(ROOT.length + 1)} sends '${word}'`);
        }
      }
    }
    expect(offenders, 'a word the server has no command for, sent anyway').toEqual([]);
  });

  /*
   * And the shipped templates, which are the worst place of the lot for one.
   * `default.yaml` is copied into every player's home on first run and its
   * rules and events sections hold example *commands*. A `do: flee` there would
   * teach a vocabulary the realm does not have and then fail silently in
   * everybody's file at once — the failure `template.test.ts` exists for,
   * applied to a word rather than to a field.
   */
  it('appears in no shipped template, outside the paragraph retiring it', () => {
    const templates = ['default.yaml', 'internal.yaml', 'profile.default.yaml'];
    const offenders: string[] = [];
    for (const word of NOT_COMMANDS) {
      const spelled = new RegExp(`\\b${word}\\b`, 'i');
      for (const name of templates) {
        const lines = readFileSync(join(ROOT, 'resources', 'config', name), 'utf8').split('\n');
        for (const [index, line] of lines.entries()) {
          // A `#` line is documentation, and the retraction has to be sayable
          // in the file the player actually reads.
          if (line.trim().startsWith('#')) continue;
          if (spelled.test(line)) offenders.push(`${name}:${index + 1} ${line.trim()}`);
        }
      }
    }
    expect(offenders, 'a word the server has no command for, shipped to everybody').toEqual([]);
  });
});
