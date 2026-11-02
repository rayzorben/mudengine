import path from 'node:path';

import type { Room } from '../../shared/character';
import {
  floorKey,
  floorOf,
  FLOOR_VERSION,
  type FloorSeen,
  type RealmFloor
} from '../../shared/floor';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { DeferredFile } from './DeferredFile';
import { readRecordFile } from './recordFile';

interface FloorFile {
  version: typeof FLOOR_VERSION;
  /** The realm these were seen in; a file for another realm is kept and ignored. */
  realm: string;
  /** Read as `unknown[]` and checked a row at a time. */
  seen: unknown[];
}

/**
 * Every item seen lying in a room of one realm, on disk at
 * `memory/floor-<key>.json`, kept like `DescriptionBook`: a floor looks the
 * same to every character. One row per item per room, held in last-seen order
 * so the longest unseen is dropped first past `world.floorSeenRows`.
 */
export class FloorBook implements RealmFloor {
  private readonly rows = new Map<string, FloorSeen>();
  private readonly disk: DeferredFile;

  constructor(
    file: string,
    private readonly realm: string,
    private readonly onError?: (message: string) => void
  ) {
    this.disk = new DeferredFile(
      file,
      (): FloorFile => ({ version: FLOOR_VERSION, realm, seen: [...this.rows.values()] }),
      (error) =>
        this.onError?.(
          t('notices.world.floor.saveError', {
            fileName: path.basename(file),
            message: errorMessage(error)
          })
        )
    );
    this.load();
  }

  /** Oldest sighting first. */
  get all(): readonly FloorSeen[] {
    return [...this.rows.values()];
  }

  /**
   * Called on every character push, so a row already seen within
   * `world.floorSeenRefreshMs` is left alone and nothing is written.
   */
  saw(room: Room, at: number): void {
    const { floorSeenRefreshMs, floorSeenRows } = tuning().world;
    let changed = false;
    for (const row of floorOf(room)) {
      const key = floorKey(row);
      const kept = this.rows.get(key);
      if (kept !== undefined && at - kept.at < floorSeenRefreshMs) continue;
      // Taken out and put back, so the map's order stays last seen.
      this.rows.delete(key);
      this.rows.set(key, { ...row, first: kept?.first ?? at, at });
      changed = true;
    }
    if (!changed) return;
    for (const key of this.rows.keys()) {
      if (this.rows.size <= floorSeenRows) break;
      this.rows.delete(key);
    }
    this.disk.schedule();
  }

  /** Writes anything outstanding. Safe to call twice. */
  close(): void {
    this.disk.close();
  }

  private load(): void {
    const rows = readRecordFile(
      this.disk.file,
      this.realm,
      {
        version: FLOOR_VERSION,
        field: 'seen',
        // A row this build cannot read is skipped; it never costs the file.
        rows: (rows) => rows.filter(isFloorSeen).sort((a, b) => a.at - b.at),
        invalid: (fileName) => t('notices.world.floor.invalidFile', { fileName }),
        readError: (fileName, message) => t('notices.world.floor.readError', { fileName, message })
      },
      this.onError
    );
    for (const row of rows) this.rows.set(floorKey(row), row);
  }
}

function isFloorSeen(value: unknown): value is FloorSeen {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<FloorSeen>;
  return (
    typeof row.room === 'string' &&
    typeof row.roomName === 'string' &&
    typeof row.name === 'string' &&
    typeof row.first === 'number' &&
    typeof row.at === 'number'
  );
}
