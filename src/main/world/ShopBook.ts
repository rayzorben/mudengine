import fs from 'node:fs';
import path from 'node:path';

import type { ShopListedItem } from '../../shared/character';
import { SHOPS_VERSION, type RealmShops, type Shelf } from '../../shared/shops';
import type { RoomId } from '../../shared/world';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { DeferredFile } from './DeferredFile';

interface ShopsFile {
  version: typeof SHOPS_VERSION;
  /** The realm these were listed in; a file for another realm is kept and ignored. */
  realm: string;
  /** Read as `unknown[]` and checked a row at a time. */
  shelves: unknown[];
}

/**
 * Every shop's last `list` in one realm, on disk at `memory/shops-<key>.json`.
 *
 * One file per realm, like `FindBook`: what a counter sells is a fact about
 * the world, and a second character should not walk to a shop to learn what
 * the first already read there. Gang house shops are kept like any other:
 * the server lists them through the same code (`ListCommand.cs`), and since
 * the realm never restocks one, this is the only record of what they hold.
 *
 * Bounded by the realm's rooms: one shelf per room that answered `list`.
 */
export class ShopBook implements RealmShops {
  private readonly shelves = new Map<RoomId, Shelf>();
  private readonly disk: DeferredFile;

  /**
   * @param file Where this realm's shops are kept.
   * @param realm What realm it is kept against, as `RealmLoad.source`.
   * @param onError Reported rather than thrown: a record that cannot be read
   *   must not stop a character connecting.
   */
  constructor(
    file: string,
    private readonly realm: string,
    private readonly onError?: (message: string) => void
  ) {
    this.disk = new DeferredFile(
      file,
      (): ShopsFile => ({ version: SHOPS_VERSION, realm, shelves: [...this.shelves.values()] }),
      (error) =>
        this.onError?.(
          t('notices.world.shops.saveError', {
            fileName: path.basename(file),
            message: errorMessage(error)
          })
        )
    );
    this.load();
  }

  /** Every shelf, in the order first listed. The card sorts. */
  get all(): readonly Shelf[] {
    return [...this.shelves.values()];
  }

  /** The counter's whole listing for its room, replacing what that room said before. */
  stock(shelf: Shelf): void {
    this.shelves.set(shelf.room, shelf);
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
      if (!isShopsFile(read) || !read.shelves.every(isShelf)) {
        // Kept beside it, since the next listing writes this file afresh.
        fs.copyFileSync(file, `${file}.bak`);
        this.onError?.(t('notices.world.shops.invalidFile', { fileName }));
        return;
      }
      if (read.realm !== this.realm) return;
      for (const shelf of read.shelves) this.shelves.set(shelf.room, shelf);
    } catch (error) {
      this.onError?.(
        t('notices.world.shops.readError', { fileName, message: errorMessage(error) })
      );
    }
  }
}

function isShopsFile(value: unknown): value is Omit<ShopsFile, 'shelves'> & { shelves: Shelf[] } {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<ShopsFile>;
  return (
    file.version === SHOPS_VERSION && typeof file.realm === 'string' && Array.isArray(file.shelves)
  );
}

function isShelf(value: unknown): value is Shelf {
  if (typeof value !== 'object' || value === null) return false;
  const shelf = value as Partial<Shelf>;
  return (
    typeof shelf.room === 'string' &&
    typeof shelf.shopName === 'string' &&
    (shelf.shop === null || Number.isInteger(shelf.shop)) &&
    (shelf.by === null || typeof shelf.by === 'string') &&
    typeof shelf.at === 'number' &&
    Array.isArray(shelf.items) &&
    shelf.items.every(isListedItem)
  );
}

function isListedItem(value: unknown): value is ShopListedItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<ShopListedItem>;
  return (
    typeof item.name === 'string' &&
    (item.quantity === null || typeof item.quantity === 'number') &&
    typeof item.price === 'string' &&
    (item.note === null || typeof item.note === 'string')
  );
}
