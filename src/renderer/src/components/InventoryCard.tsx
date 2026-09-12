import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';

import BentoCard, { type CardAction, type CardChrome } from './BentoCard';
import Icon from './Icon';
import CardTable, { type Column, type Facet } from './CardTable';
import EntityNumber, { entityNumberText } from './EntityNumber';
import { keepFocus } from '../lib/focus';
import { entityNumber } from '@shared/entities';
import { equipVerdict, UNKNOWN_WEARER, type GearAction, type Wearer } from '@shared/gear';
import { t } from '../lib/i18n';
import { coinText } from '../lib/coins';
import { type CarriedItem, type CharacterState, type Coins } from '@shared/character';
import { countedList, ITEM_KIND_WORD, type ItemKind } from '@shared/items';
import type { SessionId } from '@shared/ipc';
import type { WorldItem } from '@shared/world';

/**
 * The purse: the coins, then what the realm says they come to.
 *
 * The total is the server's own `Wealth:` figure and is not computed here —
 * `Wealth:` **is** a normalised total in copper, confirmed against the wire
 * (`51 gold crowns, 7 copper farthings` → `Wealth: 5107`) and seven more times
 * in the capture corpus. Like every maintained listing it is the number from
 * the last one until the next, so it can lag a coin picked up; the counts
 * beside it are what move.
 */
function Purse({ coins, wealth }: { coins: Coins; wealth: number | null }): React.JSX.Element {
  const value = useRef<HTMLElement>(null);
  const [tier, setTier] = useState(0);
  const full = coinText(coins, 0);

  /*
   * Which tier fits is *measured*, never guessed at.
   *
   * No pixel constant may exist in this path: the card is resizable, it can be
   * docked, floated or railed, and `App.tsx` overwrites the typography tokens at
   * runtime from the config — so a width decided at build time is wrong for
   * somebody. This renders the longest form, asks the laid-out element whether
   * it overflowed, and steps down until it does not.
   */
  useLayoutEffect(() => {
    const node = value.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => setTier(0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Back to the longest form whenever what is drawn changes, so a row that
  // shrank for a long count grows again when the count gets shorter.
  useLayoutEffect(() => setTier(0), [full]);

  useLayoutEffect(() => {
    const node = value.current;
    if (node === null || tier >= 2) return;
    if (node.scrollWidth > node.clientWidth) setTier(tier + 1);
  });

  return (
    <dd className="purse" ref={value}>
      {full.length > 0 && <span className="coins">{coinText(coins, tier)}</span>}
      {/* Thousands separated, because this is the one number on the card
          somebody reads as a quantity rather than as an identifier. */}
      {wealth !== null && <span className="total">({wealth.toLocaleString()})</span>}
    </dd>
  );
}

/**
 * What a pack can be cut down to: the kinds the realm's own item table
 * distinguishes (`Items.ItemType`, read as words in `shared/items.ts`).
 *
 * `unknown` is one of them and is not a tidy-up. Most of what a monster drops
 * is a name the realm data cannot place, so it is a real group with real things
 * in it — and one somebody filters *to* as often as away from, because it is
 * where everything the client cannot tell them about has collected.
 *
 * Every kind is listed here whether or not anything in the pack is one: the
 * remembered filters are checked against this list, so a kind missing from it
 * would silently drop a player's choice the first time they were carrying none.
 * Which chips are *drawn* is a separate question, and the table answers it.
 */
const KIND_FACETS: readonly Facet[] = [
  ...(Object.entries(ITEM_KIND_WORD) as [ItemKind, string][]).map(([kind, word]) => ({
    id: kind,
    label: word
  })),
  { id: 'unknown', label: t('cards.realm.facet.unknown') }
];

export interface InventoryCardProps extends CardChrome {
  character: CharacterState;
  /** Which character's pack this is, so its filters and its sort are remembered per character. */
  session: SessionId;
  /** Opens the realm's answer beside a clicked item name. */
  inspect?(name: string, anchor: HTMLElement): void;
  /**
   * Asks the realm what it knows about these item names.
   *
   * A callback, like the Shop and Reference cards take, rather than a prop
   * the whole app threads down: the answer is a fact about *this character's*
   * realm, and the query is addressed for the same reason every other world
   * query is.
   */
  load?(names: string[]): Promise<Record<string, WorldItem>>;
  /**
   * Who this character is, in the realm's own row ids, for deciding what may
   * go on. Addressed like `load`, and for the same reason.
   *
   * Its own query rather than a field of the item answers: it changes when a
   * stat sheet prints, and the items change when the pack does.
   */
  loadWearer?(): Promise<Wearer>;
  /**
   * A gear button: put one item on, put on everything the realm says can be
   * worn, or put the whole pack on the floor.
   *
   * A callback rather than the commands themselves, for the reason every other
   * action on a card is: **main decides**. It holds the pack, the remembered
   * loadout and the realm's own word on what is wearable, and an
   * unrecognised command on this server is said out loud in the room — so the
   * card names an action from a closed list and never composes one. Absent on
   * a surface with nowhere to send it, and then no button is drawn, which is
   * what this client does with every control bound to nowhere.
   */
  gear?(action: GearAction, item?: string): void;
}

/**
 * What the character is carrying.
 *
 * Read from the `i` block the client already parses, so this asks the server
 * for nothing — the card appears when an inventory has been seen and says so
 * plainly when one has not, rather than showing an empty bag that looks like a
 * fact.
 *
 * Encumbrance is the number worth a meter: it is a fraction of a maximum, which
 * is the one shape this app draws as a bar, and being over it is a condition a
 * player acts on rather than a total they read.
 */
function InventoryCard({
  character,
  inspect,
  load,
  loadWearer,
  gear,
  session,
  ...chrome
}: InventoryCardProps) {
  const { items } = character.inventory;
  void load;
  const [finding, setFinding] = useState(false);

  /*
   * The two bulk gear controls, in the action column where every card puts
   * what it can do. *Drop all* is `danger`-toned: it is the one here that
   * costs something, and on this realm a floor is not a container — anybody
   * standing there can pick the lot up.
   *
   * Absent rather than greyed when there is nothing in the pack. The
   * greyed-not-absent rule is about controls whose availability flickers while
   * somebody reaches for them; an empty pack is a card that is saying so in
   * words above them.
   */
  const actions: CardAction[] = [findAction(finding, setFinding, chrome.returnFocus)];
  if (gear && items.length > 0) {
    actions.push({
      id: 'equip-all',
      label: t('cards.inventory.equipAll'),
      icon: 'shirt',
      run: () => gear('equip-all')
    });
    actions.push({
      id: 'drop-all',
      label: t('cards.inventory.dropAll'),
      icon: 'trash',
      danger: true,
      run: () => gear('drop-all')
    });
  }

  return (
    <BentoCard
      badge={
        items.length > 0 ? (
          <span className="chip off">
            {t('cards.inventory.carriedBadge', { count: items.length })}
          </span>
        ) : undefined
      }
      actions={actions}
      className="inventory-card"
      {...chrome}
      copyText={() => packCopyText(character)}
      paned
      title={t('cards.inventory.title')}
    >
      <InventoryBody
        character={character}
        finding={finding}
        gear={gear}
        inspect={inspect}
        loadWearer={loadWearer}
        onFindDismiss={() => setFinding(false)}
        returnFocus={chrome.returnFocus}
        session={session}
      />
    </BentoCard>
  );
}

/**
 * One item per line, worn things marked, for pasting to somebody who asked
 * "what have you got". The weight and the meter stay on the card: a paste
 * is a list, not a readout.
 */
function packCopyText(character: CharacterState): string {
  const { items, keys, wealth, coins } = character.inventory;
  const coinLine = coinText(coins, 0);
  const hasPurse = wealth !== null || coinLine.length > 0;
  return [
    // The same sentence the card shows, at the longest tier: a paste has no
    // width to run out of, and `48 p` in somebody else's chat window is not
    // what the card said.
    ...(hasPurse
      ? [
          t('cards.inventory.copy.wealthPrefix', {
            amountText: [coinLine, wealth === null ? '' : `(${wealth.toLocaleString()})`]
              .filter((part) => part.length > 0)
              .join(' ')
          })
        ]
      : []),
    ...(keys.length > 0
      ? [t('cards.inventory.copy.keysPrefix', { keyList: countedList(keys).join(', ') })]
      : []),
    ...items.map((item) =>
      item.slot !== null
        ? `${item.name} (${item.slot})`
        : item.equipped
          ? `${item.name} (${t('cards.inventory.inUseStatus')})`
          : item.name
    )
  ].join('\n');
}

/**
 * The search glyph for a pack, and what it does.
 *
 * The Talk card's arrangement, and now the pack's: a find field standing open
 * above a listing spends a whole row on a question nobody is asking, and this
 * listing is the one whose rows are worth the most — a pack is read to find one
 * thing in it. Behind the glyph the row appears when it is asked for, takes the
 * caret, and clears itself on the way out.
 *
 * Written once because two cards draw the same pack: the Inventory card in its
 * own action column, the Self card on its PACK face's. Two copies would drift.
 */
export function findAction(
  finding: boolean,
  setFinding: (open: boolean) => void,
  returnFocus?: () => void
): CardAction {
  return {
    id: 'find',
    label: t('cards.inventory.findPlaceholder'),
    icon: 'search',
    run: () => {
      if (!finding) {
        setFinding(true);
        return;
      }
      setFinding(false);
      returnFocus?.();
    }
  };
}

export interface InventoryBodyProps {
  character: CharacterState;
  session: SessionId;
  inspect?: InventoryCardProps['inspect'];
  gear?: InventoryCardProps['gear'];
  loadWearer?: InventoryCardProps['loadWearer'];
  returnFocus?: () => void;
  /**
   * Whether the find row is out. Driven from the search glyph in the action
   * column — the card's, or the Self card's PACK face's — because a whole row
   * spent on a question nobody is asking is a row this listing needs for its
   * own contents. See `CardTableProps.findOpen`.
   */
  finding?: boolean;
  onFindDismiss?(): void;
}

/**
 * The pack itself — the meter, the purse and the table — without a card
 * around it, so the Self card can draw the same listing on its PACK face.
 * One component rather than two listings, because two would drift.
 */
export function InventoryBody({
  character,
  session,
  inspect,
  gear,
  loadWearer,
  returnFocus,
  finding,
  onFindDismiss
}: InventoryBodyProps) {
  const { items, keys, wealth, coins, encumbrance, encumbranceMax } = character.inventory;
  /**
   * Who the realm thinks this character is.
   *
   * `UNKNOWN_WEARER` until asked, and unknown never refuses — a pack greyed
   * out because a stat sheet has not printed yet would hide wearable kit
   * behind a reason the client cannot state.
   */
  const [wearer, setWearer] = useState<Wearer>(UNKNOWN_WEARER);

  /*
   * Asked again when the *names* change, not when the listing object does.
   *
   * The tracker rebuilds `inventory.items` on every equip and every slot
   * change, and none of those change what an item weighs. Keying on the joined
   * names is what keeps a fight — where items go in and out of use — from
   * asking the realm the same question once a round.
   */
  /*
   * What the realm knows about each item is **on the item**.
   *
   * This was a `useEffect` making an `itemsKnown` round trip keyed on the
   * joined names, with a loading state and a failure branch — the same four
   * facts (weight, price, kind, slot) that main already held the moment the
   * listing was parsed. `CharacterTracker.replayPack` joins them there now, so
   * the weight column and the kind chips draw on the first paint instead of
   * appearing a tick later.
   */

  /*
   * Asked when the *facts that decide it* move, not on every character push.
   *
   * Race, class and level arrive together off the stat sheet and change a
   * handful of times in a session; the character object is replaced on every
   * status line. Keying on the three words is what keeps this from asking main
   * the same question several times a second in a fight.
   */
  const identity = `${character.race ?? ''}\u0000${character.className ?? ''}\u0000${character.progress.level ?? ''}\u0000${character.progress.strength ?? ''}`;
  useEffect(() => {
    if (!loadWearer) {
      setWearer(UNKNOWN_WEARER);
      return;
    }
    let live = true;
    void loadWearer()
      .then((found) => {
        if (live) setWearer(found);
      })
      .catch((error: unknown) => {
        // Unknown, loudly — and unknown is the answer that refuses nothing.
        if (live) {
          console.error('wearer lookup failed', error);
          setWearer(UNKNOWN_WEARER);
        }
      });
    return () => {
      live = false;
    };
  }, [loadWearer, identity]);
  const seen = items.length > 0 || keys.length > 0 || wealth !== null || encumbrance !== null;

  // Computed once per render: the copy guard, the copy line and the readout's
  // wealth-row guard all ask the same question of the same coins.
  const coinLine = coinText(coins, 0);
  const hasPurse = wealth !== null || coinLine.length > 0;

  // Null is not zero: an unknown maximum draws no bar rather than a full one.
  const carried =
    encumbrance !== null && encumbranceMax !== null && encumbranceMax > 0
      ? Math.min(1, encumbrance / encumbranceMax)
      : null;

  /**
   * The pack, as three columns: what it is, what it weighs, and where it is worn.
   *
   * The weight is the whole reason this card asks the realm for anything. The
   * meter above says 917 of 3,360 and cannot say *what is heavy*, which is the
   * only question anybody puts to it — the one that decides what to drop. It is
   * absent, never zero, for a name the realm cannot place: that is most of what
   * a monster drops, and a `0` beside it would be a claim the data does not
   * make. The column sorts those to the bottom whichever way it points, so
   * "what is heaviest" is one click and not a screen of blanks.
   */
  const columns: Column<CarriedItem>[] = [
    /*
     * Put this one on, or take it off again, from its own row.
     *
     * A column of its own and to the *left* of the name, which is where it was
     * asked for and where it belongs: it is the one control on the row that
     * acts rather than explains, and beside the weight it would read as a
     * property of the item. The column has no header — a word above a run of
     * glyphs would be a label for a thing that is not a fact.
     *
     * The cell is empty rather than greyed for a row the question does not
     * apply to at all: drawing a control that does nothing is worse than
     * drawing none.
     */
    {
      id: 'equip',
      label: '',
      control: true,
      value: (item) => item.name,
      cell: (item) => {
        if (!gear) return null;
        /*
         * Decided once, in `equipVerdict`, for this cell and for the console's
         * rewritten listing alike — a second reading of the same rules had
         * the two disagreeing about a private realm's kit. Worn is tested
         * first there, before anything the realm file says: a lit torch has
         * no `Worn` slot and still comes off. Green is the one row-level
         * statement in the pack that is *in force*, drawn on every worn row;
         * a refusal is a `span`, not a disabled `button`, so the reason on it
         * stays reachable from the keyboard; a thing that is not kit gets no
         * control at all, because one could only ever earn a refusal.
         */
        const verdict = equipVerdict(item, wearer, t);
        switch (verdict.state) {
          case 'worn':
            return (
              <button
                className="row-action worn"
                onClick={() => gear('remove', item.name)}
                onMouseDown={keepFocus}
                title={verdict.label}
                type="button"
              >
                <Icon name="shirtWorn" />
              </button>
            );
          case 'blocked':
            return (
              <span
                aria-label={verdict.label}
                className="row-action blocked"
                role="img"
                title={verdict.label}
              >
                <Icon name="shirtOff" />
              </span>
            );
          case 'wearable':
            return (
              <button
                className="row-action"
                onClick={() => gear('equip', item.name)}
                onMouseDown={keepFocus}
                title={verdict.label}
                type="button"
              >
                <Icon name="shirt" />
              </button>
            );
          case 'none':
            return null;
        }
      }
    },
    {
      id: 'item',
      label: t('cards.room.shop.columnItem'),
      wide: true,
      value: (item) => item.name,
      cell: (item) =>
        inspect ? (
          /* The name opens the Reference card: price, provenance, everything
             the weight figure here leaves out. Clicked, never typed into, so
             the caret stays with the game. */
          <button
            className="what lookup"
            onClick={(event) => inspect(item.name, event.currentTarget)}
            onMouseDown={keepFocus}
            title={t('cards.room.itemLookupTooltip')}
            type="button"
          >
            {item.name}
          </button>
        ) : (
          <span className="what">{item.name}</span>
        )
    },
    {
      /*
       * The realm's own `Items` row — the number MegaMUD printed and the
       * number the realm editor is indexed by, which the client has held
       * since the data was indexed and drew nowhere.
       *
       * A column rather than a figure beside the name, because in a table it
       * earns the two things a column is: it is **findable**, so typing
       * `1234` narrows a hundred-item pack to the thing, and sortable, which
       * groups a realm's content by when it was authored. Numeric, so it
       * sorts as a magnitude and sits under a right-aligned heading like the
       * weight beside it.
       *
       * `value` is the plain text and `cell` the drawn figure, which is the
       * split every column here makes — and it is what puts the *rows* answer
       * (`iron key` is three) into the find text as well as on screen.
       */
      id: 'number',
      label: t('entity.numberColumn'),
      name: t('entity.numberColumnLabel'),
      numeric: true,
      value: (item) => entityNumber(item) ?? entityNumberText(item),
      cell: (item) => <EntityNumber of={item} />
    },
    {
      id: 'weight',
      label: t('cards.inventory.columns.weight'),
      numeric: true,
      value: (item) => item.encumbrance ?? null,
      // The figure and nothing around it: the cell is already the `weight`
      // column, and a span inside it carrying the same name would be a second
      // thing to select by that can disagree with the first.
      cell: (item) => item.encumbrance ?? null
    },
    {
      /*
       * Worn and wielded things read differently from things in the pack,
       * because the question the card answers is not only "what have I got" but
       * "what have I got *on*" — the difference between carrying a shield and
       * holding one.
       *
       * The slot is shown when anything names it and nothing at all is shown
       * when nothing does. An item in use whose slot is unknown gets a plain
       * "in use" instead, deliberately in lower case so it cannot be misread
       * as one of the server's own slot words.
       *
       * A word the *realm file* supplied — the item's `Worn` code, for an item
       * no listing has ever named a slot for — is drawn outlined rather than
       * filled and says so on hover. It is a real answer and is shown as one;
       * it is this client reading a number rather than the server printing a
       * word, and this column would otherwise look like the server's
       * throughout (`CarriedItem.slotSource`).
       */
      id: 'where',
      label: t('cards.player.detail.where'),
      value: (item) => item.slot ?? (item.equipped ? t('cards.inventory.inUseStatus') : null),
      cell: (item) =>
        item.slot !== null ? (
          item.slotSource === 'realm' ? (
            <span className="slot inferred" title={t('cards.inventory.realmSlotTooltip')}>
              {item.slot}
            </span>
          ) : (
            <span className="slot">{item.slot}</span>
          )
        ) : item.equipped ? (
          <span className="slot unknown" title={t('cards.inventory.inUseTooltip')}>
            {t('cards.inventory.inUseStatus')}
          </span>
        ) : null
    }
  ];

  return (
    <>
      {!seen ? (
        <div className="empty">{t('cards.inventory.emptyUnseen')}</div>
      ) : (
        <>
          {carried !== null && (
            <div
              className="meter"
              data-level={carried >= 0.9 ? 'critical' : carried >= 0.7 ? 'caution' : 'ok'}
            >
              <span className="track">
                <span className="fill" style={{ width: `${carried * 100}%` }} />
              </span>
              <span className="figures">
                {encumbrance}/{encumbranceMax}
              </span>
            </div>
          )}

          <dl className="readout">
            {hasPurse && (
              <>
                <dt>{t('cards.inventory.wealthLabel')}</dt>
                <Purse coins={coins} wealth={wealth} />
              </>
            )}
            {keys.length > 0 && (
              <>
                {/* Keys stay a row rather than joining the table: they are not
                carried things the listing counts, and a `key` filter over
                the pack answers a different question from this one. */}
                <dt>{t('cards.inventory.keysLabel')}</dt>
                <dd>{countedList(keys).join(', ')}</dd>
              </>
            )}
          </dl>

          {/*
        A pack is the listing on this client whose length the player least
        controls — a hundred things after an hour of looting — so it is the
        table this all started with. Filtered by what the realm says a thing
        *is*, which costs no command: `Items.ItemType` is shipped in the
        realm file and already asked for, one query per set of names.
      */}
          <CardTable
            caption={t('cards.inventory.tableCaption')}
            className="carried"
            columns={columns}
            empty={t('cards.inventory.tableEmpty')}
            facetOf={(item) => item.kind ?? 'unknown'}
            facets={KIND_FACETS}
            find={t('cards.inventory.findPlaceholder')}
            findOpen={finding}
            keyOf={(item, at) => `${item.name}-${at}`}
            onFindDismiss={onFindDismiss}
            name="inventory"
            returnFocus={returnFocus}
            rowAttrs={(item) => ({ 'data-equipped': item.equipped ? 'true' : 'false' })}
            rows={items}
            session={session}
          />
        </>
      )}
    </>
  );
}

export default memo(InventoryCard);
