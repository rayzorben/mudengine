/**
 * What came out of a chest, told apart from what was already carried.
 *
 * `open <chest>` casts the chest's spell, whose text block puts items straight
 * into the pack and coins into cash on hand without naming either: the wire
 * has the chest's message (`You open the wooden box, and find...`) and a
 * category per item (`A precious stone!`). So the pack is read again with an
 * `i` after the open and compared with the pack as it stood before it.
 * `mudengine-automation` › `parts/gear.md` › *A chest's loot is read off the
 * pack*.
 */
import type { CharacterState, CarriedItem } from '../../shared/character';
import { bareName, countedLabel } from '../../shared/items';
import { asSpokenDirection, nameAnswersTo } from '../../shared/world';
import { argumentOf, commandOf } from '../../shared/commands';
import type { CommandQueue } from './CommandQueue';
import type { SessionModule } from './Module';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

/** The `i` this unit proposes; opens before it goes out ride the same one. */
const LISTING_KEY = 'chest-opening-count';

/** The pack and purse before an open, or null until the listing before it lands. */
interface Before {
  carried: readonly CarriedItem[];
  wealth: number | null;
}

/** One or more opens one listing answers. */
interface Opening {
  chests: string[];
  before: Before | null;
  expiresAt: number;
  /** Whether its `i` reached the socket; a listing before that answers an older ask. */
  asked: boolean;
}

/** What a chest gave: items gained, counted, and the copper the purse moved by (null where unread). */
export interface ChestYield {
  chest: string;
  items: Array<{ name: string; count: number }>;
  copper: number | null;
}

export interface ChestOpeningEvents {
  notice(message: string): void;
}

/** How many of each name a pack holds, keyed as `sameItem` compares; absent `count` is one. */
function tally(items: readonly CarriedItem[]): Map<string, { name: string; count: number }> {
  const held = new Map<string, { name: string; count: number }>();
  for (const item of items) {
    const key = bareName(item.name);
    const was = held.get(key);
    held.set(key, { name: was?.name ?? item.name, count: (was?.count ?? 0) + (item.count ?? 1) });
  }
  return held;
}

/** The items the second pack holds more of than the first, and the purse's move. */
export function chestYield(
  chest: string,
  before: Before,
  after: Pick<CharacterState['inventory'], 'items' | 'wealth'>
): ChestYield {
  const was = tally(before.carried);
  const items: ChestYield['items'] = [];
  for (const [key, now] of tally(after.items)) {
    const held = was.get(key)?.count ?? 0;
    if (now.count > held) items.push({ name: now.name, count: now.count - held });
  }
  const copper =
    before.wealth === null || after.wealth === null ? null : after.wealth - before.wealth;
  return { chest, items, copper };
}

/**
 * The one carried container the typed word opens, or null for a direction
 * (`OpenCommand` tries an exit first), a word that names none, or one that
 * names several (the server answers `Please be more specific.` and opens
 * nothing).
 */
export function chestTyped(command: string, items: readonly CarriedItem[]): string | null {
  if (commandOf(command) !== 'Open') return null;
  const typed = argumentOf(command).toLowerCase();
  if (asSpokenDirection(typed) !== null) return null;
  const chests = items.filter(
    (item) => item.kind === 'container' && nameAnswersTo(item.name.toLowerCase(), typed)
  );
  const names = new Set(chests.map((item) => item.name.toLowerCase()));
  return names.size === 1 ? (chests[0]?.name ?? null) : null;
}

export class ChestOpening implements SessionModule {
  /** Oldest first; each is dropped at its listing or its expiry. */
  private openings: Opening[] = [];

  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: ChestOpeningEvents,
    private readonly now: () => number = () => Date.now()
  ) {}

  reset(): void {
    this.openings = [];
  }

  /** A command went out; an `open` that names one carried chest asks for the pack behind it. */
  sent(command: string, state: CharacterState): void {
    if (state.phase !== 'in-game') return;
    const chest = chestTyped(command, state.inventory.items);
    if (chest === null) return;
    this.prune();
    const expiresAt = this.now() + tuning().chest.expiresMs;
    const last = this.openings.at(-1);
    if (last !== undefined && !last.asked) {
      // Its `i` has not gone out, so the one listing answers both opens.
      last.chests.push(chest);
      last.expiresAt = expiresAt;
    } else {
      // Behind an open still owed its listing, the pack before this one is that listing.
      const before = last === undefined ? this.purseOf(state) : null;
      this.openings.push({ chests: [chest], before, expiresAt, asked: false });
    }
    // The player typed the open, so its `i` goes out with automation off too (todo 68).
    this.queue.enqueue({
      command: 'i',
      priority: 'user',
      coalesceKey: LISTING_KEY,
      expiresAt,
      reason: t('automation.chest.reasonCount', { chest }),
      onSent: () => {
        for (const opening of this.openings) opening.asked = true;
      }
    });
  }

  /** A pack listing landed; called after the tracker applied it. */
  onListing(state: CharacterState): void {
    this.prune();
    const head = this.openings[0];
    if (head === undefined || !head.asked) return;
    this.openings.shift();
    const next = this.openings[0];
    if (next !== undefined) next.before = this.purseOf(state);
    const chest = head.chests.join(t('automation.chest.and'));
    if (head.before === null) {
      // The listing before this open never came, so there is no pack to compare with.
      this.events.notice(t('automation.chest.unread', { chest }));
      return;
    }
    this.events.notice(describeYield(chestYield(chest, head.before, state.inventory)));
  }

  private purseOf(state: CharacterState): Before {
    return { carried: state.inventory.items, wealth: state.inventory.wealth };
  }

  /**
   * Expired opens are forgotten, oldest first since each expires after the one
   * before; one left behind them keeps `before` null and says it cannot tell.
   */
  private prune(): void {
    const now = this.now();
    this.openings = this.openings.filter((opening) => opening.expiresAt > now);
  }
}

/** An unread purse is said as unknown, never as no coins. */
function describeYield(found: ChestYield): string {
  const items = found.items.map((item) => countedLabel(item)).join(', ');
  const chest = found.chest;
  if (found.copper === null) {
    return items === ''
      ? t('automation.chest.coinsUnknown', { chest })
      : t('automation.chest.itemsCoinsUnknown', { chest, items });
  }
  const copper = found.copper > 0 ? String(found.copper) : null;
  if (items === '' && copper === null) return t('automation.chest.nothing', { chest });
  if (copper === null) return t('automation.chest.items', { chest, items });
  if (items === '') return t('automation.chest.coins', { chest, copper });
  return t('automation.chest.found', { chest, items, copper });
}
