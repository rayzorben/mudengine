import fs from 'node:fs';

/**
 * One client-written JSON record read from disk (todo 28): parsed, absent, or
 * a failure the caller reports and then stops writing to the file. A missing
 * file is a first run, never a fault; any other read or parse failure is, and
 * the file is the only copy of what it holds, so it must not be written over.
 */
export type JsonRecordRead =
  { kind: 'absent' } | { kind: 'read'; value: unknown } | { kind: 'unreadable'; error: unknown };

export function readJsonRecord(file: string): JsonRecordRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', error };
  }
  try {
    return { kind: 'read', value: JSON.parse(text) as unknown };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}
