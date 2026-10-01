/**
 * The planner's records on disk (todos 56–58), under one directory per
 * character: `decisions.jsonl`, appended a line at a time, one folder per
 * death or stuck log, `deaths/<stamp>/` and `stucks/<stamp>/`, and the running
 * log, `log/<run>.log`: one file per launch, every step the planner takes, and
 * `lessons.jsonl`, what each plan came to, read back when the planner starts.
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
import { stamp as runStamp } from './filename';
import { isHistoryEntry } from '../../shared/konamiHistory';
import type { KonamiLesson } from '../../shared/konamiLessons';
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

/** Every row of a JSON-lines file; a line that does not parse is skipped and said. None before the first. */
function readLines<T>(
  file: string,
  onProblem: (message: string) => void,
  accept: (value: unknown) => value is T
): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (accept(value)) rows.push(value);
      else onProblem(`${file}: a line that is not a record`);
    } catch (error) {
      onProblem(`${file}: ${errorMessage(error)}`);
    }
  }
  return rows;
}

const anyLesson = (value: unknown): value is KonamiLesson =>
  typeof value === 'object' && value !== null;

export function konamiRecords(options: KonamiRecordsOptions): KonamiRecords {
  const logFile = path.join(options.dir, 'log', `${runStamp(new Date())}.log`);
  const lessonsFile = path.join(options.dir, 'lessons.jsonl');
  const historyFile = path.join(options.dir, 'history.jsonl');
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
    log: (text) =>
      inOrder(async () => {
        await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
        await fs.promises.appendFile(logFile, text.endsWith('\n') ? text : `${text}\n`);
      }),
    logPath: logFile,
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
    recentLines: (lines) => stripAnsi(options.backscroll(lines)),
    lesson: (row) =>
      inOrder(async () => {
        await fs.promises.mkdir(options.dir, { recursive: true });
        await fs.promises.appendFile(lessonsFile, `${JSON.stringify(row)}\n`);
      }),
    lessons: () => readLines(lessonsFile, options.onProblem, anyLesson),
    historyLine: (entry) =>
      inOrder(async () => {
        await fs.promises.mkdir(options.dir, { recursive: true });
        await fs.promises.appendFile(historyFile, `${JSON.stringify(entry)}\n`);
      }),
    history: () => readLines(historyFile, options.onProblem, isHistoryEntry),
    rewriteLessons: (rows) => {
      const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
      inOrder(async () => {
        await fs.promises.mkdir(options.dir, { recursive: true });
        await fs.promises.writeFile(lessonsFile, text);
      });
    }
  };
}
