/**
 * The shipped sentence tables, read once: `resources/world/actions.csv` and
 * `death-messages.csv`, the server's own words for an emote and for a monster
 * dying (`src/shared/actions.ts`, `src/shared/death-messages.ts`).
 *
 * Read the way `SpellMessages.ts` reads its file: once, at first use, into a
 * structure every session shares. A file that is missing or will not parse is
 * reported and answered with an empty book, so a client without it falls back
 * to the frames in `patterns.ts` rather than failing to start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ActionBook, parseActionsCsv } from '../../shared/actions';
import { DeathBook, parseDeathMessagesCsv } from '../../shared/death-messages';
import type { ShippedSentences } from '../../shared/sentences';
import { t } from '../app/i18n';

/** The file's text, or `null` once its error has been reported. */
function readText(file: string, failed: (message: string) => void): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function loadShippedSentences(
  dir: string,
  notify?: (message: string) => void
): ShippedSentences {
  const actionsFile = path.join(dir, 'actions.csv');
  const actionsText = readText(actionsFile, (message) =>
    notify?.(t('notices.world.actions.readError', { file: actionsFile, message }))
  );
  const actionRows = actionsText === null ? [] : parseActionsCsv(actionsText);
  if (actionsText !== null && actionRows.length === 0) {
    notify?.(t('notices.world.actions.empty', { file: actionsFile }));
  }

  const deathsFile = path.join(dir, 'death-messages.csv');
  const deathsText = readText(deathsFile, (message) =>
    notify?.(t('notices.world.deathMessages.readError', { file: deathsFile, message }))
  );
  const deathRows = deathsText === null ? [] : parseDeathMessagesCsv(deathsText);
  if (deathsText !== null && deathRows.length === 0) {
    notify?.(t('notices.world.deathMessages.empty', { file: deathsFile }));
  }

  return { actions: ActionBook.fromRows(actionRows), deaths: DeathBook.fromRows(deathRows) };
}
