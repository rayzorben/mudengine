/**
 * The shipped spell message table, read once.
 *
 * `resources/world/spell-messages.csv` is the server's message data for every
 * duration effect — the sentence printed when it lands and the one printed
 * when it ends — extracted from the server because no realm database on hand
 * carries the table (a Spells row holds only the message *number*). It is
 * realm-independent in the way the spell ids are: the same rows read the same
 * on GreaterMUD and Paradigm, checked against both converted realms for the
 * kai powers.
 *
 * Read the way `i18n.ts` reads its file: once, at startup, into a structure
 * every session shares. A file that is missing or will not parse is reported
 * and answered with an empty book, so a client without it falls back to the
 * frames in `patterns.ts` rather than failing to start.
 */
import fs from 'node:fs';

import { parseSpellMessagesCsv, SpellMessageBook } from '../../shared/spell-messages';
import { t } from '../app/i18n';

export function loadSpellMessages(
  file: string,
  notify?: (message: string) => void
): SpellMessageBook {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    notify?.(
      t('notices.world.spellMessages.readError', {
        file,
        message: error instanceof Error ? error.message : String(error)
      })
    );
    return new SpellMessageBook();
  }
  const rows = parseSpellMessagesCsv(text);
  if (rows.length === 0) {
    notify?.(t('notices.world.spellMessages.empty', { file }));
  }
  return SpellMessageBook.fromRows(rows);
}
