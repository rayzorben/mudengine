/**
 * What a card layout file is (the rail head's Layouts menu), for both ends:
 * main refuses to write or hand back a file that is not one, so the read
 * channel can never return another file's text (a profile with its
 * password); the window reads the layout inside it (`lib/cardLayouts.ts`).
 */
import { isRecord } from './values';

/** What a card layout file says it is. */
export const LAYOUT_FILE_KIND = 'mudengine.card-layout';

/** A file's text as JSON when it is a card layout file; null for anything else. */
export function layoutFileValue(text: string): Readonly<Record<string, unknown>> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(value) && value['kind'] === LAYOUT_FILE_KIND ? value : null;
}
