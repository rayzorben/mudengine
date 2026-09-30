/**
 * The planner's records on disk (todos 56–58), under one directory per
 * character: `decisions.jsonl`, appended a line at a time, and one folder per
 * death or stuck log, `deaths/<stamp>/` and `stucks/<stamp>/`.
 *
 * Every write is asynchronous and in order: a death log holds a hundred
 * briefs and ten thousand lines, and writing it synchronously would stall the
 * socket at the one moment the character needs it least. The folder's path is
 * known before the files land, so the card can name it at once; a write that
 * fails is said out loud.
 */
import fs from 'node:fs';
import path from 'node:path';

import { stripAnsi } from '../net/LineTokenizer';
import type { KonamiIncidentKind, KonamiRecords } from '../../shared/konamiRecords';
import { errorMessage } from '../../shared/values';

export interface KonamiRecordsOptions {
  dir: string;
  /** The newest `lines` lines of the console, as painted. */
  backscroll(lines: number): string;
  onProblem(message: string): void;
}

/** A moment as a folder name: sortable, and without the colons a path cannot hold everywhere. */
function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

export function konamiRecords(options: KonamiRecordsOptions): KonamiRecords {
  let chain: Promise<void> = Promise.resolve();
  const inOrder = (write: () => Promise<void>): void => {
    chain = chain.then(write).catch((error: unknown) => options.onProblem(errorMessage(error)));
  };
  return {
    journal: (line) =>
      inOrder(async () => {
        await fs.promises.mkdir(options.dir, { recursive: true });
        await fs.promises.appendFile(path.join(options.dir, 'decisions.jsonl'), `${line}\n`);
      }),
    incident: (kind: KonamiIncidentKind, at, files) => {
      const folder = path.join(options.dir, `${kind}s`, stamp(at));
      inOrder(async () => {
        await fs.promises.mkdir(folder, { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          await fs.promises.writeFile(path.join(folder, name), content);
        }
      });
      return folder;
    },
    recentLines: (lines) => stripAnsi(options.backscroll(lines))
  };
}
