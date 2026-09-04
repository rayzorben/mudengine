import CardTable, { type Column } from './CardTable';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';
import { affordable, mergeStock, priceValue, type StockRow } from '../lib/shop';
import { bankKey, type BankBalance, type ShopListing } from '@shared/character';
import type { SessionId } from '@shared/ipc';
import type { ShopKind, WorldShop } from '@shared/world';

/**
 * What the shop you are standing in sells, without asking it.
 *
 * A shop is a property of a **room**, and the realm database records which shop
 * each room holds — so the client already knows the answer to `list` before the
 * question is asked. That is the standing rule of the world layer, stated in
 * docs/greatermud/rooms-and-items.md: *asking the server for something the
 * shipped data already knows is a command spent for nothing, and commands are
 * the scarce resource.*
 *
 * **It is a lead, not the shelf.** Stock rotates, a shop can be sold out, and a
 * derivative may have edited the table since the realm file was built — so this
 * says what the realm *says*, and the shop itself remains the authority. The
 * distinction matters because the useful thing it buys is planning: it is worth
 * walking across the map for a shop that stocks a lantern, and worth knowing
 * before you walk.
 *
 * **A face of the Room card rather than a card of its own.** It was one, and it
 * appeared and disappeared as the character walked in and out of shops — which
 * is the rail churn a fixed card exists to prevent, applied to the rail itself.
 * A shop is not a thing beside the room; it is a thing *about* the room, and
 * that is what a face says.
 *
 * **And once the counter has been asked, the counter speaks.** A real `list`
 * carries two things the realm file cannot: `(You can't use)`, the counter's
 * judgment for *this* character's class and race — the annotation that decides
 * whether a line is worth reading at all — and prices in coin, which against
 * the purse in copper say for the first time whether the character can pay.
 * `mergeStock` in `lib/shop.ts` is the merge: the file leads, the counter
 * overrides where both name a thing, a thing the counter sells that the file
 * does not know is added, and a thing the file names that the counter did not
 * list is marked rather than hidden. A room with a listing and no realm shop
 * shows the listing alone.
 */
export interface ShopFaceProps {
  /** What the realm data says is sold here, or null where it has no shop for this room. */
  shop: WorldShop | null;
  /** What the counter said when this character asked `list` here, or null. */
  listing: ShopListing | null;
  /** The purse in copper — `Wealth:` — or null while no listing has counted it. */
  wealth: number | null;
  /**
   * What each bank has said it holds. Read only when this face is a bank's.
   *
   * The whole list rather than the one balance, because the vault standing here
   * is matched by the realm's shop id — the printed name varies by realm and is
   * the fallback key, never the first one. See `BankBalance`.
   */
  banks: readonly BankBalance[];
  /** Which character is standing in it, so the stock's sort is remembered per character. */
  session: SessionId;
  /** Opens the realm's answer beside a clicked line of stock. */
  inspect?(name: string, anchor: HTMLElement): void;
  /** Hands the caret back to the game when the find field is left. */
  returnFocus?(): void;
}

/**
 * What to call the face, from what the realm says the place is.
 *
 * `WorldShop.kind` was computed by `shopKind()` and read by nothing — a produced
 * fact with no consumer, which is the shape this project calls dead. It is the
 * face's name now, so a temple reads `TEMPLE` and a bank `BANK` instead of all
 * six reading `SHOP`.
 *
 * **The label carries the kind and no glyph does.** There is no shop, temple,
 * bank, tavern, inn or trainer in `Icon`, and inventing six would put a glyph on
 * this face and none on `Found` — which is the failure the icon rule already
 * records for menus: some rows with one and some without is worse than none at
 * all, because the labels stop starting in the same column.
 */
const KIND_LABEL: Record<ShopKind, string> = {
  shop: t('cards.room.faces.shop'),
  temple: t('cards.room.faces.temple'),
  tavern: t('cards.room.faces.tavern'),
  bank: t('cards.room.faces.bank'),
  trainer: t('cards.room.faces.trainer'),
  inn: t('cards.room.faces.inn')
};

/**
 * The face's name. `shop` for a realm built before the type was sampled and for
 * a type the sample did not name — the fallback is the word that is true of
 * every one of them, not a guess at which.
 */
export function shopFaceLabel(shop: WorldShop | null): string {
  return KIND_LABEL[shop?.kind ?? 'shop'];
}

/**
 * One line per thing, with its price, for pasting to somebody who asked — the
 * counter's words where it has spoken, the realm's figure where it has not,
 * and the counter's note, because that is the half the reader wants.
 */
/**
 * The balance for the vault this face is about, or null where none has spoken.
 *
 * Matched on the realm's shop id first, because that is the only key both
 * realms agree on — MajorMUD prints `The Bank of Godfrey (#8)` where the wire
 * here prints `Bank of Godfrey`. The folded name is the fallback, for the realm
 * that prints no id at all.
 *
 * Exported so the Room card's **first** face can state the same figure the Bank
 * face does. Two lookups matching a printed name to a vault in two files is two
 * answers that come to disagree about whether `The Bank of Godfrey (#8)` is the
 * bank you are standing in.
 */
export function balanceHere(
  shop: WorldShop | null,
  banks: readonly BankBalance[]
): BankBalance | null {
  if (shop === null) return null;
  const byId = banks.find((bank) => bank.shop !== null && bank.shop === shop.id);
  if (byId) return byId;
  const key = bankKey(shop.name);
  return banks.find((bank) => bankKey(bank.name) === key) ?? null;
}

/**
 * What a bank's face puts on the clipboard: the vault and what it holds.
 *
 * Separate from `shopCopyText` because the face itself is separate — a bank
 * draws a balance where a shop draws its stock, and copying the shop's version
 * would put the bank's *name alone* on the clipboard while a balance was on
 * screen. That is the one thing the copy rule forbids: a card with faces copies
 * the face on screen, and the balance is exactly the fact somebody would copy.
 *
 * The absence is copied too, and as itself. "This vault has not been asked" and
 * "this vault holds nothing" are different answers, and a copy that flattened
 * them would be the reassuring one.
 */
export function bankCopyText(
  shop: WorldShop | null,
  banks: readonly BankBalance[],
  now: number
): string {
  const name = shop !== null && shop.name.length > 0 ? shop.name : shopFaceLabel(shop);
  const held = balanceHere(shop, banks);
  return held === null
    ? `${name}\n${t('cards.room.bank.unasked')}`
    : `${name}\n${t('cards.room.bank.onDeposit')}: ${t('cards.room.bank.copper', {
        copper: held.copper.toLocaleString()
      })} (${ago(held.at, now)})`;
}

export function shopCopyText(shop: WorldShop | null, listing: ShopListing | null): string {
  const rows = mergeStock(shop, listing);
  return [
    shop?.name ?? shopFaceLabel(shop),
    ...rows.map((row) => {
      const price = row.quoted ?? (row.realmPrice === null ? null : String(row.realmPrice));
      const note = row.note === null ? '' : ` (${row.note})`;
      return price === null ? `${row.name}${note}` : `${row.name} — ${price}${note}`;
    })
  ].join('\n');
}

export default function ShopFace({
  shop,
  listing,
  wealth,
  banks,
  session,
  inspect,
  returnFocus
}: ShopFaceProps): React.JSX.Element {
  const rows = mergeStock(shop, listing);
  /**
   * Two columns and no filters: the stock has no kind in the realm data — the
   * shop table carries a name and a price and nothing that says a sword is a
   * sword — so chips here would be a control invented out of nothing. The find
   * field is what this face actually needed: a general store runs to three
   * hundred lines, and "does this place sell a lantern" was a question you
   * could only answer by reading all of them.
   */
  const columns: Column<StockRow>[] = [
    {
      id: 'item',
      label: t('cards.room.shop.columnItem'),
      wide: true,
      value: (row) => row.name,
      cell: (row) => (
        <>
          {inspect ? (
            /* The row shows the buy decision's number — the price. The name opens
               the Reference card for the rest: weight, provenance, and who else
               sells it. */
            <button
              className="what lookup"
              onClick={(event) => inspect(row.name, event.currentTarget)}
              onMouseDown={keepFocus}
              title={t('cards.room.itemLookupTooltip')}
              type="button"
            >
              {row.name}
            </button>
          ) : (
            <span className="what">{row.name}</span>
          )}
          {/*
            The counter's judgments, as words beside the name — §6, a
            condition is never a hue alone. "can't use" is the counter's; "not
            listed" is the file naming a thing the counter did not, today;
            "short" is the purse against the quoted price, and is offered only
            when both are known — an unasked counter is not a price.
          */}
          {row.note !== null && (
            <span className="chip warn">{t('cards.room.shop.cantUseChip')}</span>
          )}
          {row.listed === false && (
            <span className="chip quiet">{t('cards.room.shop.notListedChip')}</span>
          )}
          {affordable(row, wealth) === false && (
            <span
              className="chip warn"
              title={t('cards.room.shop.shortTooltip', { wealth: (wealth ?? 0).toLocaleString() })}
            >
              {t('cards.room.shop.shortChip')}
            </span>
          )}
        </>
      )
    },
    {
      /*
       * One unit per column. With a listing, the counter's words on every
       * quoted row and nothing on the rest — the file's figure is not copper
       * (`StockRow.realmPrice`), and putting it beside `20 gold crowns` would
       * be two numbers 200× apart reading as one quantity. Without a listing,
       * the file's base figure, with the markup said separately below rather
       * than multiplied into it: a number this face invented would be one the
       * shop can disagree with, and "250% of 4" is checkable where "10" is not.
       */
      id: 'price',
      label: t('cards.room.shop.columnPrice'),
      numeric: true,
      value: (row) => priceValue(row, listing),
      cell: (row) =>
        listing !== null ? (
          row.quoted === null ? null : (
            <span className="price">{row.quoted}</span>
          )
        ) : row.realmPrice === null ? null : (
          <span className="price">{row.realmPrice}</span>
        )
    }
  ];
  const listed = rows.filter((row) => row.listed === true).length;
  const unlisted = rows.filter((row) => row.listed === false).length;

  /*
   * A bank sells nothing, and the stock table is not merely empty here — it is
   * empty *by construction*. Every bank in the shipped realm data carries
   * `items: []`, so this face drew a table that could never have a row in it,
   * on every bank room, forever. That is the "a face that would say nothing is
   * not offered" rule broken by a face that was offered and then said nothing.
   *
   * What a bank has to say is the balance, so it says that instead — and where
   * no balance has been read it says *that*, which is a different and honest
   * sentence: the vault has not been asked. An unasked bank is absence, never a
   * balance of zero, and here the comfortable reading is wrong twice over, as
   * a character told they have no savings may well have some.
   */
  if (shop?.kind === 'bank') {
    const held = balanceHere(shop, banks);
    return (
      <>
        <div className="room-name">{shop.name.length > 0 ? shop.name : shopFaceLabel(shop)}</div>
        {held === null ? (
          <div className="aside">{t('cards.room.bank.unasked')}</div>
        ) : (
          <dl className="readout">
            <dt>{t('cards.room.bank.onDeposit')}</dt>
            <dd>
              {t('cards.room.bank.copper', { copper: held.copper.toLocaleString() })}{' '}
              {/*
                The time is not decoration. Nothing maintains this figure — a
                deposit's own sentence names no bank, so it cannot be credited
                to one — which makes every balance a quotation from a moment
                rather than a reading. Drawn the way a player's `@health` answer
                is, and for the same reason: a number from five minutes ago
                shown as though it were live is the readout claiming to know
                something it does not.
              */}
              <span className="quiet-note">({ago(held.at, Date.now())})</span>
            </dd>
          </dl>
        )}
      </>
    );
  }

  return (
    <>
      {/*
        The shop's own name, which used to be the card's title and now has
        nowhere else to be: the card is called Room. Drawn like the room's name
        for the same reason — it is the thing this face is about.
      */}
      <div className="room-name">
        {shop !== null && shop.name.length > 0 ? shop.name : shopFaceLabel(shop)}
      </div>

      <CardTable
        caption={t('cards.room.shop.tableCaption')}
        className="stock"
        columns={columns}
        empty={t('cards.room.shop.emptyStock')}
        find={t('cards.room.shop.findPlaceholder')}
        /*
          Keyed by position, not by the item's own id: a shop's stock is a list
          of slots and three of this realm's shops fill two of theirs with the
          same id. A duplicate key costs React the ability to delete the older
          of the pair, and the row is left in the document after the shop that
          sold it — see `entryKey` in ReferenceDetail, where the same realm data
          left dead rows in the Reference card's matches. The index is the row's
          place in the stock as the realm gave it, so it survives being filtered
          and sorted.
        */
        keyOf={(row, at) => `${at}:${row.id ?? row.name}`}
        name="shop"
        returnFocus={returnFocus}
        rows={rows}
        session={session}
      />

      <div className="aside">
        {listing !== null
          ? t('cards.room.shop.asideListed', { listed, unlisted })
          : shop?.markup !== undefined
            ? t('cards.room.shop.asideWithMarkup', { markup: shop.markup })
            : t('cards.room.shop.asideNoMarkup')}
      </div>
    </>
  );
}
