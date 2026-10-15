import fs from 'node:fs';
import path from 'node:path';

import {
  describedRoom,
  DESCRIPTIONS_VERSION,
  type RealmDescriptions,
  type RoomDescription
} from '../../shared/descriptions';
import type { Room } from '../../shared/character';
import type { RoomId } from '../../shared/world';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { DeferredFile } from './DeferredFile';

interface DescriptionsFile {
  version: typeof DESCRIPTIONS_VERSION;
  /** The realm these were read in; a file for another realm is kept and ignored. */
  realm: string;
  /** Read as `unknown[]` and checked a row at a time. */
  rooms: unknown[];
}

/**
 * Every room description read in one realm, on disk at
 * `memory/descriptions-<key>.json` (todo 140), kept like `ShopBook`: a room
 * says the same to every character. Bounded by the realm's rooms, one entry
 * each, and written only when a room says something new.
 */
export class DescriptionBook implements RealmDescriptions {
  private readonly rooms = new Map<RoomId, RoomDescription>();
  private readonly disk: DeferredFile;

  constructor(
    file: string,
    private readonly realm: string,
    private readonly onError?: (message: string) => void
  ) {
    this.disk = new DeferredFile(
      file,
      (): DescriptionsFile => ({
        version: DESCRIPTIONS_VERSION,
        realm,
        rooms: [...this.rooms.values()]
      }),
      (error) =>
        this.onError?.(
          t('notices.world.descriptions.saveError', {
            fileName: path.basename(file),
            message: errorMessage(error)
          })
        )
    );
    this.load();
  }

  /** Called on every character push, so it compares before it writes. */
  saw(room: Room, at: number): void {
    const read = describedRoom(room);
    if (read === null) return;
    const kept = this.rooms.get(read.room);
    if (kept !== undefined && kept.text === read.text && kept.name === read.name) return;
    this.rooms.set(read.room, { ...read, at });
    this.disk.schedule();
  }

  /** Writes anything outstanding. Safe to call twice. */
  close(): void {
    this.disk.close();
  }

  private load(): void {
    const { file } = this.disk;
    const fileName = path.basename(file);
    try {
      if (!fs.existsSync(file)) return;
      const read: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isDescriptionsFile(read) || !read.rooms.every(isDescription)) {
        // Kept beside it, once, since the next room read writes this file afresh.
        if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
        this.onError?.(t('notices.world.descriptions.invalidFile', { fileName }));
        return;
      }
      if (read.realm !== this.realm) return;
      for (const room of read.rooms) this.rooms.set(room.room, room);
    } catch (error) {
      this.onError?.(
        t('notices.world.descriptions.readError', { fileName, message: errorMessage(error) })
      );
    }
  }
}

function isDescriptionsFile(
  value: unknown
): value is Omit<DescriptionsFile, 'rooms'> & { rooms: RoomDescription[] } {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<DescriptionsFile>;
  return (
    file.version === DESCRIPTIONS_VERSION &&
    typeof file.realm === 'string' &&
    Array.isArray(file.rooms)
  );
}

function isDescription(value: unknown): value is RoomDescription {
  if (typeof value !== 'object' || value === null) return false;
  const room = value as Partial<RoomDescription>;
  return (
    typeof room.room === 'string' &&
    typeof room.name === 'string' &&
    typeof room.text === 'string' &&
    typeof room.at === 'number'
  );
}
