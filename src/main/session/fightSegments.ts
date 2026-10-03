/**
 * The fight log on disk: a directory per character holding numbered segments
 * (`0001.jsonl.gz`, …) of `records.fightsPerSegment` fights each, every one a
 * run of appended gzip members, and beside each closed segment its fold
 * (`0001.folds.json`). A read loads the saved folds and folds only the open
 * segment, so it holds one segment's text at a time where it used to hold the
 * whole record. `mudengine-world` › *Every fight is written down* has why.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  FOLD_FIELDS,
  FOLD_VERSION,
  OUTPUT_FIELDS,
  foldFight,
  foldOutput,
  type FightFold,
  type FightFolds,
  type FightOutput,
  type FightOutputs,
  type FightRecord
} from '../../shared/fights';
import { isRecord } from '../../shared/values';
import { tuning } from '../app/tuning';

/** Fights folded both ways, per monster and per level, and how many there were. */
export interface FoldedRecord {
  folds: FightFolds;
  outputs: FightOutputs;
  fights: number;
}

export const emptyFold = (): FoldedRecord => ({ folds: new Map(), outputs: new Map(), fights: 0 });

const SEGMENT = /^(\d{4,})\.jsonl\.gz$/;
const name = (segment: number): string => String(segment).padStart(4, '0');

export const segmentFile = (dir: string, segment: number): string =>
  path.join(dir, `${name(segment)}.jsonl.gz`);

export const foldFile = (dir: string, segment: number): string =>
  path.join(dir, `${name(segment)}.folds.json`);

let pendingWrites = 0;

/**
 * A fold being written, named with a leading dot so the character export and
 * a segment listing pass over it, and left behind only by a crash mid-write.
 * Each write has its own, so two folds of one segment at once (a log closing
 * it while another reads it) never rename each other's.
 */
const pendingFoldFile = (dir: string, segment: number): string =>
  path.join(dir, `.${name(segment)}.folds.json.${process.pid}-${(pendingWrites += 1)}.tmp`);

/** Whether a name in a record's directory is a fold write a crash left behind. */
export const isPendingFold = (entry: string): boolean =>
  /^\.\d{4,}\.folds\.json\..*\.tmp$/.test(entry);

/** The segment numbers in `dir`, in order; none for a directory that is not there. */
export function segmentsIn(dir: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // Not there, or a file where a directory on the way should be: no record.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  return names
    .map((entry) => SEGMENT.exec(entry)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** A file's length, or zero for one not there yet. */
export function lengthOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** One record line folded in; false for a line that is not one, which costs that fight. */
export function foldLine(into: FoldedRecord, line: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isFoldable(value)) return false;
  const record = value as FightRecord;
  foldFight(into.folds, record);
  foldOutput(into.outputs, record);
  into.fights += 1;
  return true;
}

/**
 * Folds the first `bytes` of a segment (all of it when not given), off the
 * thread: the gunzip runs on the pool, and the parse yields to the event loop
 * every `records.fightsFoldSlice` fights, so a socket read is never behind
 * more than one slice of it. A prefix that ends on a member boundary is a
 * valid stream, and the length a log measured on opening ends on one.
 */
export async function foldSegment(file: string, bytes?: number): Promise<FoldedRecord> {
  const into = emptyFold();
  const raw = await readPrefix(file, bytes);
  if (raw.length === 0) return into;
  // `Z_SYNC_FLUSH`: a truncated last member is what a crash leaves, and every
  // member before it is still the record.
  const text = await new Promise<string>((resolve, reject) => {
    zlib.gunzip(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }, (error, out) =>
      error ? reject(error) : resolve(out.toString('utf8'))
    );
  });
  const slice = tuning().records.fightsFoldSlice;
  let start = 0;
  let parsed = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (end > start) {
      foldLine(into, text.slice(start, end));
      parsed += 1;
      if (parsed % slice === 0) await new Promise<void>((next) => setImmediate(next));
    }
    start = end + 1;
  }
  return into;
}

async function readPrefix(file: string, bytes: number | undefined): Promise<Buffer> {
  if (bytes === undefined) return fs.promises.readFile(file);
  if (bytes === 0) return Buffer.alloc(0);
  const raw = Buffer.alloc(bytes);
  const handle = await fs.promises.open(file, 'r');
  try {
    const { bytesRead } = await handle.read(raw, 0, bytes, 0);
    return raw.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** What is written beside a closed segment. */
interface SavedFold {
  version: number;
  /** The segment's length when it was folded; a segment of another length is refolded. */
  bytes: number;
  fights: number;
  folds: Array<[string, FightFold]>;
  outputs: Array<[number, FightOutput]>;
}

/** Writes a segment's fold beside it, whole or not at all. */
export async function saveFold(
  dir: string,
  segment: number,
  folded: FoldedRecord,
  bytes: number
): Promise<void> {
  const saved: SavedFold = {
    version: FOLD_VERSION,
    bytes,
    fights: folded.fights,
    folds: [...folded.folds],
    outputs: [...folded.outputs]
  };
  const pending = pendingFoldFile(dir, segment);
  await fs.promises.writeFile(pending, JSON.stringify(saved));
  await fs.promises.rename(pending, foldFile(dir, segment));
}

/**
 * A closed segment's saved fold, or null when it is missing, unreadable, made
 * by an older `foldFight`/`foldOutput`, or made of a segment `bytes` long no
 * longer.
 */
export async function readSavedFold(
  dir: string,
  segment: number,
  bytes: number
): Promise<FoldedRecord | null> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.promises.readFile(foldFile(dir, segment), 'utf8'));
  } catch {
    return null;
  }
  return asSavedFold(value, bytes);
}

function asSavedFold(value: unknown, bytes: number): FoldedRecord | null {
  if (!isRecord(value) || value['version'] !== FOLD_VERSION || value['bytes'] !== bytes) {
    return null;
  }
  const fights = value['fights'];
  const folds = value['folds'];
  const outputs = value['outputs'];
  if (!isCount(fights) || !Array.isArray(folds) || !Array.isArray(outputs)) return null;
  const into = emptyFold();
  into.fights = fights;
  for (const entry of folds as unknown[]) {
    const [mob, figures] = Array.isArray(entry) ? (entry as unknown[]) : [];
    const fold = asFold(figures);
    if (fold === null || typeof mob !== 'string') return null;
    into.folds.set(mob, fold);
  }
  for (const entry of outputs as unknown[]) {
    const [level, figures] = Array.isArray(entry) ? (entry as unknown[]) : [];
    const output = asOutput(figures);
    if (output === null || typeof level !== 'number') return null;
    into.outputs.set(level, output);
  }
  return into;
}

function asFold(value: unknown): FightFold | null {
  return sums(value, Object.keys(FOLD_FIELDS) as Array<keyof FightFold>);
}

function asOutput(value: unknown): FightOutput | null {
  return sums(value, Object.keys(OUTPUT_FIELDS) as Array<keyof FightOutput>);
}

function sums<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(value)) return null;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const sum = value[key];
    if (typeof sum !== 'number' || !Number.isFinite(sum)) return null;
    out[key] = sum;
  }
  return out;
}

/**
 * Whether a parsed line carries every field the folds read, so a line of
 * another shape costs one fight rather than a total of `NaN` that no saved
 * fold could hold.
 */
function isFoldable(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const number = (key: string): boolean =>
    typeof value[key] === 'number' && Number.isFinite(value[key]);
  const orNull = (key: string): boolean => value[key] === null || number(key);
  return (
    typeof value['mob'] === 'string' &&
    typeof value['killed'] === 'boolean' &&
    typeof value['opened'] === 'boolean' &&
    number('at') &&
    number('mine') &&
    number('others') &&
    number('blows') &&
    orNull('ms') &&
    orNull('level')
  );
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * A closed segment's fold: the saved one, or refolded from its fights and
 * written again. `refolded` says which, so a reader can report it. A fold
 * that cannot be written is handed to `unsaved` and still answers.
 */
export async function closedFold(
  dir: string,
  segment: number,
  unsaved: (error: unknown) => void
): Promise<{ folded: FoldedRecord; refolded: boolean }> {
  const file = segmentFile(dir, segment);
  const bytes = (await fs.promises.stat(file)).size;
  const saved = await readSavedFold(dir, segment, bytes);
  if (saved !== null) return { folded: saved, refolded: false };
  const folded = await foldSegment(file, bytes);
  await saveFold(dir, segment, folded, bytes).catch(unsaved);
  return { folded, refolded: true };
}

/**
 * How many fights a segment holds: the player's number, never under one,
 * since a segment of none would close forever without taking a fight.
 */
export function fightsPerSegment(): number {
  return Math.max(1, Math.floor(tuning().records.fightsPerSegment));
}

/** Appends one gzip member holding `fights` to a segment, creating it and its directory. */
export function appendFights(dir: string, segment: number, fights: readonly FightRecord[]): void {
  const lines = fights.map((fight) => `${JSON.stringify(fight)}\n`).join('');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(segmentFile(dir, segment), zlib.gzipSync(Buffer.from(lines, 'utf8')));
}

/**
 * Reads a character's whole log back, segment by segment, in order. For a
 * later analysis and for the tests. A truncated last member is what a crash
 * leaves, so `Z_SYNC_FLUSH` keeps every record before it rather than none.
 */
export function readFights(dir: string): FightRecord[] {
  const fights: FightRecord[] = [];
  for (const segment of segmentsIn(dir)) {
    let text: string;
    try {
      text = zlib
        .gunzipSync(fs.readFileSync(segmentFile(dir, segment)), {
          finishFlush: zlib.constants.Z_SYNC_FLUSH
        })
        .toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        fights.push(JSON.parse(line) as FightRecord);
      } catch {
        // One malformed line costs one fight, not the segment.
      }
    }
  }
  return fights;
}
