/**
 * What this character writes down about the realm that its data does not
 * have: a way through (`RealmMemory`, off the tracker's discoveries), what a
 * search turned up (`RealmFinds`) and what a counter listed (`RealmShops`).
 * A way through is said once when it is news; each is struck out only by the
 * player (a shop list only by the next one) and republished to its card when
 * it moves. A room the client cannot place is never written down. The stores are the
 * host's, keyed per realm; this is the session's reading and wording of them.
 * See `mudengine-session` › *The rest of the session's decisions are units
 * beside it*.
 */
import { t } from '../app/i18n';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { SessionSink } from './SessionSink';
import { findKey, type Find, type RealmFinds, type Sighting } from '../../shared/finds';
import {
  describeDiscovery,
  discoveryKey,
  type Discovery,
  type RealmMemory
} from '../../shared/memory';
import type { Block } from '../../shared/blocks';
import type { RealmShops } from '../../shared/shops';
import { roomAddress } from '../../shared/world';

/** Where the character stands, the realm's names for rooms, and the two stores. */
export interface RecordsParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly world: Pick<WorldGraph, 'byId' | 'shop'> | undefined;
  /** See `SessionDeps.memory`. */
  readonly memory: RealmMemory | undefined;
  /** See `SessionDeps.finds`. */
  readonly finds: RealmFinds;
  /** See `SessionDeps.shops`. */
  readonly shops: RealmShops;
}

export class Records {
  private readonly tracker: RecordsParts['tracker'];
  private readonly world: RecordsParts['world'];
  private readonly memory: RecordsParts['memory'];
  private readonly finds: RecordsParts['finds'];
  private readonly shops: RecordsParts['shops'];

  constructor(
    parts: RecordsParts,
    private readonly sink: Pick<SessionSink, 'notice' | 'learned' | 'finds' | 'shops'>
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.memory = parts.memory;
    this.finds = parts.finds;
    this.shops = parts.shops;
  }

  /**
   * Writes down what a line just applied told the realm's records: a search's
   * answer, or a counter's `list`.
   *
   * Called after `apply`, rather than from the `onBlock` fan-out, because
   * `room.hidden` and `shopListing` are set by this very block, so a module's
   * pre-apply state still holds the last room's answer. A shop list is an
   * array rule, so it arrives as the batch.
   * The tracker has already parsed the line, so this reads its facts.
   */
  noted(block: Block, batch: Block | null | undefined): void {
    if (
      block.type === 'room-hidden-items' ||
      // The bare search's empty answer; `to the north` asked about an exit.
      (block.type === 'user-search-failed' && block.groups['direction'] === undefined)
    ) {
      this.recordSearch();
    }
    if (batch?.type === 'shop-list') this.recordListing();
  }

  /** What this character has learned about the realm the data does not have. */
  get learned(): Discovery[] {
    return [...(this.memory?.all ?? [])];
  }

  /**
   * Writes down a way through the realm the realm data does not have, once.
   *
   * Said out loud the first time and never again, which is what the store's
   * de-duplication buys: walking a new corridor every day should not announce
   * it every day. It is worth saying at all because the alternative is a file
   * quietly filling up with observations nobody knows were made — and because
   * the client having *noticed* is the part a player would otherwise assume
   * had not happened.
   */
  remember(discovery: Discovery): void {
    const fresh = this.memory?.learn(discovery);
    if (!fresh) return;
    this.sink.notice(t('session.memory.learned', { discovery: describeDiscovery(fresh) }));
    this.sink.learned?.(this.learned);
  }

  /**
   * Strikes an observation out because the player says it is wrong.
   *
   * The player's call, not the client's: nothing automatic can tell a
   * mistyped direction the server accepted from a genuine way through. Said
   * out loud like learning was, so the record and the terminal agree, and
   * republished so every window showing the card sees it go.
   */
  forget(discovery: Pick<Discovery, 'from' | 'command'>): boolean {
    const struck = this.memory?.forget(discoveryKey(discovery)) ?? false;
    if (!struck) return false;
    this.sink.notice(
      t('session.memory.forgot', { command: discovery.command, from: discovery.from })
    );
    this.sink.learned?.(this.learned);
    return true;
  }

  /**
   * Counts the search just answered here and writes down what it turned up,
   * saying so once a find.
   *
   * Both answers count — `Your search revealed nothing.` is the search a rate
   * most needs — and the listing is read after `apply`, so an empty answer
   * reads the empty floor the tracker has just written. Silent about a
   * repeat: a lair searched every lap should not announce the same key every
   * lap. The rows still move, and the card is told whenever this room has
   * any, because every one of their rates just changed.
   *
   * A room the client cannot place is **not** written down. A find whose room
   * is a guess is a row nobody can walk back to, and the map cannot mark it;
   * refusing rather than guessing is the standing rule, and the search is still
   * on screen where the player can see it.
   */
  recordSearch(): void {
    const state = this.tracker.current;
    const { room } = state;
    const where = roomAddress(room);
    if (where === null) return;
    /*
     * The realm's name for the room where the wire has not printed one, and the
     * id where neither has. A row has to read without the database open beside
     * it, and `1/2150` is a worse answer than `Bank of Godfrey` but a far
     * better one than an empty cell.
     */
    const roomName = room.name ?? this.world?.byId(where)?.name ?? where;
    const at = Date.now();
    const found: Sighting[] = room.hidden.map((item) => ({
      roomName,
      name: item.name,
      // Absent is *not one*: the server counts stacks and says nothing about
      // a single thing. See `Find.quantity`.
      quantity: item.count ?? null,
      copper: null,
      at
    }));

    const cash = room.hiddenCash;
    if (cash !== null) {
      found.push({
        roomName,
        // The server's own phrase where it printed one, so a row reads as the
        // line did: `4 copper farthings`, not a reconstruction of it.
        name: cash.rawText ?? t('session.finds.coins'),
        quantity: null,
        copper: cash.totalCopper,
        at
      });
    }

    // Recorded silently: the search's own line is on screen, and the Room
    // card's Found tab is where the record is read.
    this.finds.search(where, found);
    const all = this.finds.all;
    if (all.some((find) => find.room === where)) this.sink.finds?.([...all]);
  }

  /**
   * Strikes a find out because the player says it is wrong.
   *
   * The player's call for the reason `forget` above is theirs: the client
   * cannot tell a room it mis-resolved from one that really hides a thing, and
   * a record that cannot be corrected is one that stops being read.
   */
  forgetFind(find: Pick<Find, 'room' | 'name'>): boolean {
    if (!this.finds.forget(findKey(find))) return false;
    this.sink.notice(t('session.finds.forgot', { what: find.name, room: find.room }));
    this.sink.finds?.([...this.finds.all]);
    return true;
  }

  /**
   * Writes down the counter's whole `list` against the room it was typed in.
   * A room the client cannot place is not written down, for `recordSearch`'s
   * reason; one the realm records no shop for is, under the room's name.
   */
  recordListing(): void {
    const { room, shopListing, name } = this.tracker.current;
    const where = roomAddress(room);
    if (where === null || shopListing === null) return;
    const here = this.world?.byId(where);
    const shop = here?.shop === undefined ? undefined : this.world?.shop(here.shop);
    this.shops.stock({
      room: where,
      shopName: shop?.name || room.name || here?.name || where,
      shop: shop?.id ?? null,
      by: name,
      at: shopListing.at,
      items: shopListing.items
    });
    this.sink.shops?.([...this.shops.all]);
  }

  /** Everything a search has turned up in this realm. See `RealmFinds`. */
  get found(): Find[] {
    return [...this.finds.all];
  }
}
