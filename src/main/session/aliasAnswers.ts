/**
 * What `alias` and `unalias` typed in the game do (todo 134,
 * `shared/aliasCommand.ts`): each answer is a notice in the console. Set and
 * remove write this character's own file and never Global's; removing a word
 * that comes from Global writes it empty, which drops it for this character
 * as the settings page's empty line does. A refused alias is said and not
 * written.
 */
import {
  aliasRefusal,
  aliasRefusalText,
  aliasWord,
  type AliasRefusal,
  type Aliases
} from '../../shared/aliases';
import type { AliasCommand } from '../../shared/aliasCommand';
import type { NoticeSink } from '../../shared/decisionSettings';
import type { KeyBindings } from '../../shared/keys';
import { macroBook } from '../../shared/macroBook';
import { loopingMacros } from '../../shared/macroSteps';
import type { StatedPair } from '../../shared/pairs';
import { t } from '../app/i18n';

/** The character's own file, as far as its aliases go. */
export interface AliasFile {
  /** This character's own entries, as its file writes them. */
  own(): readonly StatedPair[];
  /** Writes one entry (null removes it) and reads the file back: the error, or null. */
  write(word: string, line: string | null): string | null;
}

/** How an alias's line reads in one notice: a list's entries joined as the Talk box joins them. */
function shown(line: string): string {
  return line.split('\n').join(';');
}

/** Why `word` may not stand for `line` beside this character's other macros, or null. */
function setRefusal(word: string, line: string, book: MacroSet): AliasRefusal | null {
  const own = aliasRefusal(word, line);
  if (own !== null) return own;
  // Through any key or alias in force, Global's included: one that loops would load as nothing.
  const looping = loopingMacros(macroBook(book.keys, { ...book.aliases, [word]: line }));
  return looping.has(word) ? 'loops' : null;
}

/** The macros in force for this character, its own over Global's. */
export interface MacroSet {
  keys: KeyBindings;
  aliases: Aliases;
}

/** The answer to one alias command, given the macros in force and the file, if it can be written. */
export function answerAlias(
  command: AliasCommand,
  book: MacroSet,
  file: AliasFile | null,
  notice: NoticeSink
): void {
  const { aliases } = book;
  const own = new Set((file?.own() ?? []).map((pair) => aliasWord(pair.name)));
  const line = (word: string): string =>
    own.has(word)
      ? t('session.alias.own', { word, line: shown(aliases[word]!) })
      : t('session.alias.global', { word, line: shown(aliases[word]!) });
  switch (command.kind) {
    case 'list': {
      const words = Object.keys(aliases).sort();
      if (words.length === 0) return notice(t('session.alias.none'));
      notice(t('session.alias.listed', { count: words.length }));
      for (const word of words) notice(line(word));
      return;
    }
    case 'show':
      return notice(
        Object.hasOwn(aliases, command.word)
          ? line(command.word)
          : t('session.alias.unknown', { word: command.word })
      );
    case 'set': {
      const why = setRefusal(command.word, command.line, book);
      if (why !== null) {
        return notice(
          t('session.alias.refused', { word: command.word, reason: aliasRefusalText(why, t) })
        );
      }
      return written(file, command.word, command.line, notice, () =>
        t('session.alias.set', { word: command.word, line: command.line })
      );
    }
    case 'remove':
      if (!Object.hasOwn(aliases, command.word) && !own.has(command.word)) {
        return notice(t('session.alias.unknown', { word: command.word }));
      }
      return written(file, command.word, null, notice, () =>
        t('session.alias.removed', { word: command.word })
      );
    case 'usage':
      return notice(t('session.alias.usage'));
    default: {
      const never: never = command;
      return never;
    }
  }
}

function written(
  file: AliasFile | null,
  word: string,
  line: string | null,
  notice: NoticeSink,
  done: () => string
): void {
  if (file === null) return notice(t('session.alias.noFile'));
  const error = file.write(word, line);
  notice(error === null ? done() : t('session.alias.notWritten', { word, error }));
}
