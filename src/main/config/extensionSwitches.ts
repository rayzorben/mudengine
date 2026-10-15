/**
 * The options file's `extensions:` switches, read once at startup (todo 118).
 * The extensions are loaded before anything is built, so before `ConfigStore`
 * reads the file and before the migration states the block: this reads the
 * file as it stands. An absent file switches nothing off. A file that is there
 * and cannot be read or parsed is unknown, and unknown loads no extension: the
 * switch is how a player turns off one they do not trust.
 */
import fs from 'node:fs';
import { parse } from 'yaml';

import {
  DEFAULT_EXTENSION_SWITCHES,
  normalizeExtensionSwitches,
  type ExtensionSwitches
} from '../../shared/extensionSwitches';
import { errorMessage, isRecord } from '../../shared/values';

/** The switches as stated, or why the file could not say. */
export type SwitchesRead = { switches: ExtensionSwitches } | { unread: string };

export function readExtensionSwitches(file: string): SwitchesRead {
  try {
    const document: unknown = parse(fs.readFileSync(file, 'utf8'));
    // An empty file states nothing; any other top level than a map is no options file.
    if (document === null || document === undefined)
      return { switches: DEFAULT_EXTENSION_SWITCHES };
    if (!isRecord(document)) return { unread: 'its top level is not a map of settings' };
    return { switches: normalizeExtensionSwitches(document['extensions']) };
  } catch (error) {
    // First run, or a layout `migrateHome` has not moved yet: nothing switched off.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { switches: DEFAULT_EXTENSION_SWITCHES };
    }
    return { unread: errorMessage(error) };
  }
}
