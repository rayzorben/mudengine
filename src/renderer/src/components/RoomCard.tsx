import { memo, Fragment } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { coinText } from '../lib/coins';
import { ago } from '../lib/players';
import { exitsUnseen, lightNote } from '../lib/room';
import Icon from './Icon';
import ShopFace, { balanceHere, bankCopyText, shopCopyText, shopFaceLabel } from './ShopFace';
import {
  DIRECTION_NAME,
  roomId,
  type Direction,
  type RoomCommand,
  type WorldLair,
  type WorldMob,
  type WorldShop
} from '@shared/world';
import { type Discovery } from '@shared/memory';
import type { SessionId } from '@shared/ipc';
import type { Alignment, CharacterState, RoomExit, RoomOccupant } from '@shared/character';
import { attacksOnSight, DISPOSITION_WORD } from '@shared/mobs';

export interface RoomCardProps extends CardChrome {
  character: CharacterState;
  /** Which character is standing here, so the shop face's stock table is remembered per character. */
  session: SessionId;
  /**
   * Opens the realm's answer beside a clicked name — a monster off the
   * occupant line, an item off the floor. The card only names things; what the
   * realm *knows* about them lives one click away rather than crowding this
   * line with figures. The element is passed so the answer can open beside it.
   */
  inspect?(name: string, anchor: HTMLElement): void;
  /**
   * Strikes one of the found ways out, because the player says it is wrong.
   *
   * Theirs to say: nothing automatic can tell a mistyped direction the server
   * accepted from a genuine way through, and a record that cannot be corrected
   * is one that is eventually ignored.
   */
  forget?(discovery: Pick<Discovery, 'from' | 'command'>): void;
  /**
   * Sends a probe through the arbiter — `rm`, to ask the realm where the
   * character is. Quiet in the console when `internal.yaml` says so; this is
   * the button that exercises that.
   */
  ask?(command: string): void;
  /**
   * Ways through the realm this character has found that the realm data does
   * not have.
   *
   * Passed in rather than fetched, because it arrives with everything else a
   * character publishes — and a card that asked for it separately would show a
   * record from one moment beside a room from another.
   */
  learned: Discovery[];
}

/** Compass order, so exits always read in the same sequence regardless of the
 *  order the server happened to list them. */
const ORDER = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw', 'u', 'd'];

function sortExits(exits: RoomExit[]): RoomExit[] {
  return [...exits].sort((a, b) => {
    const ai = ORDER.indexOf(a.direction);
    const bi = ORDER.indexOf(b.direction);
    return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi);
  });
}

/**
 * Where you are standing.
 *
 * A room only appears once the `Obvious exits:` line has completed it — see
 * `CharacterTracker`. A partially assembled room is worse than the previous
 * one, because it looks current.
 */
function RoomCard({ character, session, inspect, forget, ask, learned, ...chrome }: RoomCardProps) {
  const { room } = character;
  const located = room.map !== null && room.number !== null;
  /*
   * The ways out of *this* room the realm data does not have.
   *
   * The Found face exists only while there is one: a second face that says
   * "nothing found here" on every room is a control that almost never does
   * anything, and a heading that changes shape as the character walks says
   * something worth noticing — this room has something the map is missing.
   */
  const here = located
    ? learned.filter((discovery) => discovery.from === roomId(room.map!, room.number!))
    : [];

  /*
   * What the realm knows about this room — read straight off it.
   *
   * These were **four `useEffect`s making four IPC round trips**: the floor's
   * prices, the shop, the lair and the words the room answers, each asked
   * after the card had already drawn once without the answer, each with its
   * own loading state, its own failure branch and its own stale-value hazard.
   * Every one of them was a fact main already had in memory the moment the
   * room resolved — they crossed the wire on demand only because the room was
   * a bag of strings when they were added.
   *
   * `CharacterTracker.attachRealm` now joins them at the point the room is
   * placed, so this is a field read. The card draws the right thing on its
   * first paint, there is no flash of a room without its shop, and switching
   * characters cannot show one character's stock beside another's room.
   */
  const shop = room.shop ?? null;
  const lair = room.lair ?? null;
  const answers = room.commands ?? [];

  const face = <RoomBody character={character} inspect={inspect} shop={shop} />;
  /*
   * The counter's own listing, kept on state by the tracker for as long as the
   * character stands in this room. A room the realm data has no shop for can
   * still have a counter that answered `list`, and the face then shows the
   * listing alone — the file is the lead, not the gate.
   */
  const listing = character.shopListing;
  const hasShop = shop !== null || listing !== null;

  /*
   * What somebody sends a friend about a room: where they are, and how to
   * leave. In text a person would read, not the numbers a machine would.
   */
  const copyText = (): string => {
    if (room.name === null && room.light === null) return '';
    const lines = room.name === null ? [] : [room.name];
    if (located) {
      lines.push(t('cards.room.copy.atCoordinates', { map: room.map!, number: room.number! }));
    }
    const light = lightNote(room);
    if (light !== null) {
      lines.push(
        light.placement === 'dead-reckoning'
          ? t('cards.room.copy.lightLineDeadReckoning', { light: light.phrase })
          : light.placement === 'remembered'
            ? t('cards.room.copy.lightLineRemembered', { light: light.phrase })
            : t('cards.room.copy.lightLine', { light: light.phrase })
      );
    }
    /*
     * The balance, where the room is a bank, because the face on screen shows
     * it — and a card copies the face on screen. Absent everywhere else, and
     * the absence copied as itself where it is a bank nobody has asked: "not
     * asked" and "holds nothing" are different answers and the flattened one
     * is the reassuring one.
     */
    if (shop?.kind === 'bank') {
      const held = balanceHere(shop, character.banks);
      lines.push(
        held === null
          ? `${t('cards.room.bank.onDeposit')}: ${t('cards.room.bank.unasked')}`
          : `${t('cards.room.bank.onDeposit')}: ${t('cards.room.bank.copper', {
              copper: held.copper.toLocaleString()
            })} (${ago(held.at, Date.now())})`
      );
    }
    if (room.exits.length > 0) {
      lines.push(
        t('cards.room.copy.exitsLine', {
          exitList: sortExits(room.exits)
            .map((exit) => {
              const name = DIRECTION_NAME[exit.direction as Direction] ?? exit.direction;
              return exit.note ? `${name} (${exit.note})` : name;
            })
            .join(', ')
        })
      );
    }
    if (room.occupants.length > 0) {
      lines.push(
        t('cards.room.copy.hereLine', {
          occupantList: room.occupants.map((who) => who.name).join(', ')
        })
      );
    }
    /*
     * `.join` on an `ItemEntity[]` gives `[object Object]` per row, which is
     * what the clipboard had been getting since the floor stopped being
     * `string[]`. The names, which is what the card shows.
     */
    if (room.items.length > 0 || coinText(room.cash).length > 0) {
      lines.push(
        t('cards.room.copy.itemsLine', {
          itemList: [coinText(room.cash), ...room.items.map((item) => item.name)]
            .filter((part) => part.length > 0)
            .join(', ')
        })
      );
    }
    // What a search turned up is on the card, so it is on the clipboard: the
    // copy rule is that what is copied is what the reader can see.
    if (room.hidden.length > 0 || coinText(room.hiddenCash).length > 0) {
      lines.push(
        t('cards.room.copy.hiddenLine', {
          itemList: [coinText(room.hiddenCash), ...room.hidden.map((item) => item.name)]
            .filter((part) => part.length > 0)
            .join(', ')
        })
      );
    }
    return lines.join('\n');
  };

  return (
    <BentoCard
      {...chrome}
      badge={
        located ? (
          // How the location was arrived at matters: `movement` is near
          // certain, an exit signature is a deduction, and an ambiguous room
          // says so rather than showing a number it does not believe.
          <span
            className={`chip${room.confidence >= 0.9 ? ' on' : ' warn'}`}
            title={t('cards.room.badge.resolvedByTooltip', { method: String(room.resolvedBy) })}
          >
            {room.map}/{room.number}
          </span>
        ) : room.ambiguous > 1 ? (
          <span className="chip warn" title={t('cards.room.badge.ambiguousTooltip')}>
            {t('cards.room.badge.ambiguousMatches', { count: room.ambiguous })}
          </span>
        ) : undefined
      }
      actions={
        ask && character.phase === 'in-game'
          ? [
              {
                id: 'rm',
                label: t('cards.room.actions.askLocationTooltip'),
                icon: 'search',
                run: () => ask('rm')
              }
            ]
          : undefined
      }
      className="room-card"
      copyText={copyText}
      /* A shop's stock is as long as the realm made it, and the Shop card the
         face replaced scrolled for that reason. On the rail and in a float the
         placement already imposes it; this is what carries it into the docked
         strips, where nothing else would. */
      scroll
      /*
       * The faces this room has, in a fixed order: the room itself, then what
       * is sold here, then what has been found here.
       *
       * Stable regardless of which are present, so a face never moves out from
       * under the pointer — the same reason the map's legend lists every symbol
       * whether or not one is in view. `Room` is first and wears the card's
       * title; a face that would say "nothing" is not offered at all, so a shop
       * with no shop and a room with no discoveries each cost nothing.
       */
      tabs={
        /*
         * Every face's own condition has to be in this gate as well as on its
         * own entry. It is stated twice and that is the trap: `answers` was
         * added to the list below and not here, so a room that answers a word
         * and holds no shop, no lair and no discovery — which is most of the
         * 1,077 of them — built an empty `tabs` and drew no face at all. The
         * smoke check for it failed and the data path was fine, which is
         * exactly the shape of a click-path bug.
         */
        hasShop || lair !== null || answers.length > 0 || here.length > 0
          ? [
              { id: 'room', label: t('cards.room.title'), content: face, copyText },
              ...(hasShop
                ? [
                    {
                      id: 'shop',
                      // What the realm says the place *is*, not what its table
                      // is called: a temple reads TEMPLE and a bank BANK.
                      label: shopFaceLabel(shop),
                      content: (
                        <ShopFace
                          banks={character.banks}
                          inspect={inspect}
                          listing={listing}
                          returnFocus={chrome.returnFocus}
                          session={session}
                          shop={shop}
                          wealth={character.inventory.wealth}
                        />
                      ),
                      /*
                       * The stock is a table, and its find field stays put
                       * while the stock scrolls under it.
                       *
                       * **Not for a bank**, which draws no table and so has no
                       * `.scroller` inside it: `paned` is `overflow: hidden`
                       * with the scrolling delegated to a child, so a face
                       * with no such child clips what will not fit instead of
                       * scrolling it. The ordinary body rule scrolls it.
                       */
                      paned: shop?.kind !== 'bank',
                      /*
                       * A card with faces copies the face on screen, and a
                       * bank's face is not the shop's: copying the stock text
                       * here would put the vault's *name alone* on the
                       * clipboard while its balance was being read.
                       */
                      copyText: () =>
                        shop?.kind === 'bank'
                          ? bankCopyText(shop, character.banks, Date.now())
                          : shopCopyText(shop, listing)
                    }
                  ]
                : []),
              ...(lair !== null
                ? [
                    {
                      id: 'lair',
                      label: t('cards.room.tabs.lair'),
                      content: <LairFace character={character} inspect={inspect} lair={lair} />,
                      copyText: () => lairCopyText(lair)
                    }
                  ]
                : []),
              /*
               * What the room answers to, between the lair and what was found
               * here — the fixed order every face on this card keeps, so a face
               * never moves out from under the pointer as the character walks.
               */
              ...(answers.length > 0
                ? [
                    {
                      id: 'answers',
                      label: t('cards.room.tabs.answers'),
                      content: (
                        <AnswersFace
                          answers={answers}
                          ask={ask}
                          inRealm={character.phase === 'in-game'}
                        />
                      ),
                      copyText: () => answersCopyText(answers)
                    }
                  ]
                : []),
              ...(here.length > 0
                ? [
                    {
                      id: 'learned',
                      label: t('cards.room.tabs.found'),
                      content: (
                        <Learned
                          forget={forget}
                          here={here}
                          elsewhere={learned.length - here.length}
                        />
                      )
                    }
                  ]
                : [])
            ]
          : undefined
      }
      title={t('cards.room.title')}
    >
      {face}
    </BentoCard>
  );
}

/**
 * What one occupant is, in the words a person would use, for the tooltip.
 *
 * The name alone is what the server printed; this is everything the client
 * worked out about it. `unknown` says so rather than picking one — a named NPC
 * and a player nobody has listed yet look identical from here, and reassuring
 * somebody that a stranger is harmless is the guess this project refuses.
 */
function describe(who: RoomOccupant, mine: Alignment | null): string {
  if (who.kind === 'player') {
    return who.free ? t('cards.room.occupant.playerFree') : t('cards.room.occupant.player');
  }
  if (who.kind === 'unknown') return t('cards.room.occupant.unknownKind');
  if (who.disposition === null) return t('cards.room.occupant.unplacedMonster');

  const word = DISPOSITION_WORD[who.disposition];
  const sure = attacksOnSight(who.disposition, mine);
  const parts = [sure === null ? t('cards.room.occupant.dependsOnStanding', { word }) : word];
  if (who.uncertain) parts.push(t('cards.room.occupant.uncertainName'));
  /*
   * The cost, which is about the *character* rather than the fight: ten evil
   * points, cumulative, moving you towards Outlaw. Worth saying out loud
   * because nothing else ever will — the server charges it silently.
   */
  if (who.costly === 'always') parts.push(t('cards.room.occupant.alwaysCostly'));
  if (who.costly === 'sometimes') parts.push(t('cards.room.occupant.sometimesCostly'));
  return parts.join('; ');
}

function RoomBody({
  character,
  inspect,
  shop
}: Pick<RoomCardProps, 'character' | 'inspect'> & {
  shop: WorldShop | null;
}) {
  const { room, phase } = character;
  const mine = ownAlignment(character);
  const light = lightNote(room);
  /*
   * What the vault holds, on the **first** face rather than only on the Bank
   * one behind it.
   *
   * A bank is the one kind of shop where the room's own subject *is* a number
   * about this character. Standing in one and reading `ROOM · BANK` says the
   * place is a bank and withholds the only thing anybody came in to find out,
   * behind a face that has to be opened — while the balance is already on
   * state, already restored across sessions, and already what the `Deposit
   * All` button beside the console is offered from.
   *
   * Null in every other room, so no other room grows a row.
   */
  const vault = shop?.kind === 'bank' ? balanceHere(shop, character.banks) : null;
  const inBank = shop?.kind === 'bank';
  /*
   * The two floors' coins, in the same words the Carrying card uses for the
   * purse — one vocabulary, in `lib/coins.ts`, because two copies is how one
   * card comes to say `plat` and another `pl`. Always the longest tier: this
   * row wraps, unlike the purse, so there is nothing to measure against.
   */
  const floorCoins = coinText(room.cash);
  const hiddenCoins = coinText(room.hiddenCash);
  return (
    <>
      {phase !== 'in-game' || (room.name === null && light === null) ? (
        <div className="empty">{t('cards.room.empty')}</div>
      ) : (
        <>
          {room.name !== null && <div className="room-name">{room.name}</div>}

          {/*
            The light, in the server's words, and what the client did about a
            room it could not see. `pitch black` is a fact about the room and is
            always shown; *placed by dead reckoning* is a fact about the
            location — inferred from the last room and the step, at 0.75 — and
            is what the badge's lower confidence was quietly meaning. A name
            still on the card when the dark arrived with no move pending is
            the last one *read*, not one read now, and says so; the badge is
            reassuring there (`movement`, 0.9+) for a room the character can
            no longer see. A room the realm data would not let it place says so
            instead of saying nothing: refusing is only worth anything said
            out loud.
          */}
          {light !== null && (
            <div className="room-light" data-light={light.phrase}>
              <span className={`chip${light.blinding ? ' warn' : ' quiet'}`}>{light.phrase}</span>
              {light.placement === 'dead-reckoning' && (
                <span className="chip warn">{t('cards.room.light.deadReckoning')}</span>
              )}
              {light.placement === 'remembered' && (
                <span className="chip warn">{t('cards.room.light.remembered')}</span>
              )}
              {light.placement === 'unplaced' && (
                <span className="chip bad">{t('cards.room.light.unplaced')}</span>
              )}
            </div>
          )}

          {/* Clamped rather than scrolled: the description is context, and the
              exits below it are what the card is actually consulted for. The
              full text is in the terminal, a few lines up. */}
          {room.description !== null && <p className="room-description">{room.description}</p>}

          <div className="exits">
            {/* Null is not zero: exits the server would not print are unseen,
                not absent, and `no exits` would be a claim nothing supports. */}
            {exitsUnseen(room) ? (
              <span className="chip warn">{t('cards.room.exits.unseen')}</span>
            ) : room.exits.length === 0 ? (
              <span className="chip bad">{t('cards.room.exits.none')}</span>
            ) : (
              sortExits(room.exits).map((exit) => (
                // A blocked exit is still an exit; saying why beats hiding it.
                <span
                  className={`chip${exit.note ? ' warn' : ''}`}
                  key={exit.direction}
                  title={exit.note ?? undefined}
                >
                  {/* Short codes are canonical; expand them for reading. */}
                  {DIRECTION_NAME[exit.direction as Direction] ?? exit.direction}
                  {exit.note && <span className="exit-note"> {exit.note}</span>}
                </span>
              ))
            )}
          </div>

          {/*
            One grid, not one per row -- and that is the whole reason `Here` and
            `Items` are inside a single `<dl>` rather than beside each other in
            two. A CSS grid sizes an `auto` column from *its own* container's
            children, so two `.readout` blocks each measured their label column
            against their own longest label: `Here` set one width and `Items`
            set another, and the two value columns started at different x inside
            one card. Splitting them again re-opens it silently.
          */}
          {(inBank ||
            room.occupants.length > 0 ||
            room.items.length > 0 ||
            room.hidden.length > 0 ||
            floorCoins.length > 0 ||
            hiddenCoins.length > 0) && (
            <dl className="readout">
              {/*
               * First, and before `Here` and `Items`, because in a bank it is
               * what the room is *for*. The order is fixed whether or not each
               * group is present, so a row never moves out from under the
               * pointer as the room fills and empties.
               *
               * **The absence is stated as itself.** A vault nobody has asked
               * is not a vault holding nothing, and here the reassuring reading
               * is wrong twice over: a character told they have no savings may
               * well have some. The time beside the figure is not decoration
               * either — see `BankBalance.at`.
               */}
              {inBank && (
                <>
                  <dt>{t('cards.room.bank.onDeposit')}</dt>
                  <dd>
                    {vault === null ? (
                      <span className="quiet-note">{t('cards.room.bank.unasked')}</span>
                    ) : (
                      <>
                        {t('cards.room.bank.copper', { copper: vault.copper.toLocaleString() })}{' '}
                        <span className="quiet-note">({ago(vault.at, Date.now())})</span>
                      </>
                    )}
                  </dd>
                </>
              )}

              {room.occupants.length > 0 && (
                <>
                  <dt>{t('cards.room.readout.hereLabel')}</dt>
                  <dd className="occupants">
                    {room.occupants.map((who, index) => (
                      <span key={`${who.name}-${index}`}>
                        {/*
                      A monster's name opens the Reference card — health,
                      temper, the alignment cost spelled out. A player's does
                      not: the realm data has nothing to say about a person,
                      and a click that does nothing teaches people to stop
                      clicking. `keepFocus` because this is clicked, never
                      typed into — the caret stays with the game.
                    */}
                        {inspect && who.kind !== 'player' ? (
                          <button
                            className={`occupant ${who.kind} lookup`}
                            onClick={(event) => inspect(who.name, event.currentTarget)}
                            onMouseDown={keepFocus}
                            title={describe(who, mine)}
                            type="button"
                          >
                            {who.name}
                          </button>
                        ) : (
                          <span className={`occupant ${who.kind}`} title={describe(who, mine)}>
                            {who.name}
                          </span>
                        )}
                        {/* A monster that will open the fight itself, which is the
                        one thing on this line worth deciding on. A word, not a
                        hue: docs/ui-design.md §6, and this is the readout a
                        decision about whether to keep walking is made off. */}
                        {attacksOnSight(who.disposition, mine) === true && (
                          <span className={`chip warn${who.uncertain ? ' quiet' : ''}`}>
                            {who.uncertain
                              ? t('cards.room.occupant.hostileUncertainChip')
                              : t('cards.realm.facet.hostile')}
                          </span>
                        )}
                        {/*
                        Not a fight cost but a standing one, and the server
                        charges it in silence — which is why it is on the card
                        rather than left to be noticed later.

                        `−10 align` rather than `costs align`, and `?` rather
                        than `may cost`, because this line carries up to three
                        chips *per occupant* and a room with four monsters in it
                        was a wall of words. The `?` is the same mark `hostile?`
                        already uses for the same fact — the realm data
                        disagrees with itself about this name — so it is one
                        thing to learn rather than two. The sentence is still
                        there, on the name's own tooltip.
                      */}
                        {who.costly !== 'never' && (
                          <span className="chip quiet" title={describe(who, mine)}>
                            {who.costly === 'always'
                              ? t('cards.room.occupant.alignCostChip')
                              : t('cards.room.occupant.alignCostUncertainChip')}
                          </span>
                        )}
                        {who.charmed && (
                          <span className="chip quiet">{t('cards.room.occupant.charmedChip')}</span>
                        )}
                        {index < room.occupants.length - 1 && ', '}
                      </span>
                    ))}
                  </dd>
                </>
              )}

              {/*
                What a `search` turned up, which the room's own listing does not
                carry — until this it was parsed and read by nothing, because a
                search answers long after `Obvious exits:` closed the room and
                the draft it was written into had already been discarded.

                Its own row rather than folded into `Items`, for the reason it
                is its own list in state: these are not lying in the open. The
                distinction is also what stops the client asking for the cash
                the way that does not work — see `AutoLoot`.
              */}
              {(room.hidden.length > 0 || hiddenCoins.length > 0) && (
                <>
                  <dt title={t('cards.room.readout.hiddenTooltip')}>
                    {t('cards.room.readout.hiddenLabel')}
                  </dt>
                  <dd className="floor">
                    {/*
                      The coins first, and they are the reason this row exists
                      at all: a search that turns up only cash — `You notice 4
                      copper farthings here.`, the line in the report — has no
                      items in it, so a row gated on `hidden.length` alone drew
                      nothing while the tooltip promised to say what the cash
                      needed. They are not `ItemEntity`s and are not lookups:
                      the realm has no row for a pile of coins.
                    */}
                    {hiddenCoins.length > 0 && (
                      <span className="coins">
                        {hiddenCoins}
                        {room.hidden.length > 0 && ', '}
                      </span>
                    )}
                    {room.hidden.map((item, index) => (
                      <span key={`${item.name}-${index}`}>
                        {inspect ? (
                          <button
                            className="lookup"
                            onClick={(event) => inspect(item.name, event.currentTarget)}
                            onMouseDown={keepFocus}
                            title={t('cards.room.itemLookupTooltip')}
                            type="button"
                          >
                            {item.name}
                          </button>
                        ) : (
                          item.name
                        )}
                        {item.price !== undefined && <span className="price"> {item.price}</span>}
                        {index < room.hidden.length - 1 && ', '}
                      </span>
                    ))}
                  </dd>
                </>
              )}

              {(room.items.length > 0 || floorCoins.length > 0) && (
                <>
                  <dt>{t('cards.room.readout.itemsLabel')}</dt>
                  <dd className="floor">
                    {/*
                      And the open floor's coins, for the same reason and to
                      keep the two rows honest with each other: a card that
                      showed cash a search found and not cash lying in plain
                      sight would be inventing a distinction the floor does not
                      have. `Room.cash` had been produced and read by nothing
                      since it was split out of the item list.
                    */}
                    {floorCoins.length > 0 && (
                      <span className="coins">
                        {floorCoins}
                        {room.items.length > 0 && ', '}
                      </span>
                    )}
                    {room.items.map((item, index) => (
                      <span key={`${item.name}-${index}`}>
                        {inspect ? (
                          <button
                            className="lookup"
                            onClick={(event) => inspect(item.name, event.currentTarget)}
                            onMouseDown={keepFocus}
                            title={t('cards.room.itemLookupTooltip')}
                            type="button"
                          >
                            {item.name}
                          </button>
                        ) : (
                          item.name
                        )}
                        {/*
                      What the realm says it is worth, which is the question
                      asked of something lying on the floor. Absent — not zero —
                      for a name the realm cannot place, and for the many things
                      it says are worth nothing.

                      Off the entity now rather than out of a lookup table this
                      card fetched over IPC: the price arrived with the room.
                    */}
                        {item.price !== undefined && <span className="price"> {item.price}</span>}
                        {index < room.items.length - 1 && ', '}
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          )}
        </>
      )}
    </>
  );
}

/**
 * What this character has found leaving this room that the realm data does not
 * have.
 *
 * On the Room card rather than in a card of its own because that is where it is
 * *actionable*: the useful question is "is there a way out of here the map does
 * not know about", and the answer belongs beside the exits it is missing from.
 * The rest of the record is a count — a client that made somebody scroll a
 * hundred observations to find the two about this room would have buried the
 * two.
 *
 * Read-only towards the pathfinder, and it says so: an observation is one
 * sample of one walk, and a route planned through a wrong one sends a
 * character somewhere it may not get back from. The one edit is the player's
 * — striking a row out — because a mistyped direction the server happened to
 * accept is written down by exactly the same rule as a real discovery, and
 * only a person can tell them apart.
 */
function Learned({
  here,
  elsewhere,
  forget
}: {
  here: Discovery[];
  elsewhere: number;
  forget?: RoomCardProps['forget'];
}) {
  return (
    <>
      <ul className="found">
        {here.map((discovery) => {
          /*
           * Three kinds of record share this list, and the row has to say
           * which: two are ways through the realm and the third is a shop's
           * stock. A sold item labelled "new exit" is not a smaller mistake
           * than an unlabelled one — it is a claim about the map, made about
           * something that is not on it, and the only edit offered is one that
           * strikes it out for the wrong reason.
           */
          const stock = discovery.reason === 'unknown-stock';
          return (
            <li key={`${discovery.from}|${discovery.command}`}>
              <span className="how">{discovery.command}</span>
              {/* A stock row's `name` *is* its command — the item, twice — so
                  the second column is left off rather than repeated. */}
              {!stock && (
                <span className="what">
                  {discovery.name || t('cards.room.found.unnamedDestination')}
                </span>
              )}
              {/* A word as well as a hue, per the design language: this is the
                  difference between "the map is missing an edge" and "the map
                  is missing a room", and only the second is unroutable. */}
              <span className={discovery.reason === 'unknown-room' ? 'chip warn' : 'chip off'}>
                {stock
                  ? t('cards.room.found.soldItemChip')
                  : discovery.reason === 'unknown-room'
                    ? t('cards.room.found.newRoomChip')
                    : t('cards.room.found.newExitChip')}
              </span>
              {forget && (
                <button
                  aria-label={t('cards.room.found.forgetAriaLabel', { command: discovery.command })}
                  className="found-forget"
                  onClick={() => forget({ from: discovery.from, command: discovery.command })}
                  onMouseDown={keepFocus}
                  title={
                    stock
                      ? t('cards.room.found.forgetStockTooltip')
                      : t('cards.room.found.forgetTooltip')
                  }
                  type="button"
                >
                  <Icon name="trash" />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {elsewhere > 0 && (
        <div className="aside">
          {elsewhere === 1
            ? t('cards.room.found.elsewhereSingular')
            : t('cards.room.found.elsewherePlural', { count: elsewhere })}
        </div>
      )}
    </>
  );
}

/**
 * How the realm ranks this character, which two of the seven monster
 * alignments decide by. Null until a `who` listing has arrived, and null
 * makes those monsters read as *unknown* rather than harmless. Stated once
 * for the occupant line and the lair, which decide the same chip from it.
 */
function ownAlignment(character: CharacterState): Alignment | null {
  if (character.name === null) return null;
  const self = character.name.toLowerCase();
  return character.online.find((entry) => entry.name.toLowerCase() === self)?.alignment ?? null;
}

/** One line per thing that can spawn, with its health, for pasting. */
function lairCopyText(lair: WorldLair): string {
  const head =
    lair.max === null
      ? t('cards.room.tabs.lair')
      : `${t('cards.room.tabs.lair')} — ${
          lair.max === 1
            ? t('cards.room.lair.upTo.one')
            : t('cards.room.lair.upTo.many', { max: lair.max })
        }`;
  return [head, ...lair.mobs.map((mob) => `${mob.name} — ${healthOf(mob)}`)].join('\n');
}

/** The realm's figure, or its range where rows sharing the name disagree. */
function healthOf(mob: WorldMob): string {
  return mob.span === undefined
    ? t('cards.room.lair.health', { hp: mob.hp })
    : t('cards.room.lair.healthSpan', { low: mob.span[0], high: mob.span[1] });
}

/**
 * What lives here, per the realm data.
 *
 * The room's own `Also here:` line says what is up *now*; this says what the
 * room spawns and how many at once, which is the thing to know before walking
 * in and the thing the line cannot say when the room is empty. Each name opens
 * the realm's answer, like a name on the occupant line, and the disposition is
 * said in words beside it — this is the readout a decision about whether to
 * keep walking is made off, and §6 says a condition is never a hue alone.
 */
/**
 * What the room answers to, and what each of them wants.
 *
 * From the realm's own script table (`Rooms.CMD` → `TBInfo.Action`, see
 * `src/main/world/roomScript.ts`). This is the face that says a room has a
 * portal in it — 1,077 rooms of the shipped realm carry a script, and some of
 * the phrases move you somewhere **no exit records**, which is the whole reason
 * they are worth drawing.
 *
 * **The phrase is a control, and it sends the realm's own word verbatim.** Down
 * `ask`, the same path the Room card's `rm` takes, so the tracker observes it
 * and a walk in progress stands down — a second route to the socket is a second
 * copy of all of that. Only the *first* spelling is offered: a script writes
 * four ways to say one thing and offering all four is four controls for one
 * act.
 *
 * **What it wants is drawn beside it, in the realm's own words.** A verb this
 * client does not model — `nomonsters`, `testskill`, `checkability` — is still
 * a thing the room wants, and dropping it would show a portal as free when it
 * is not.
 */
function AnswersFace({
  answers,
  ask,
  inRealm
}: {
  answers: RoomCommand[];
  ask: RoomCardProps['ask'];
  /** A phrase is a control only while there is a socket to send it down. */
  inRealm: boolean;
}) {
  return (
    <dl className="readout answers">
      {answers.map((answer, index) => {
        const phrase = answer.say[0] ?? '';
        return (
          <Fragment key={`${phrase}-${index}`}>
            <dt>
              {ask && inRealm ? (
                <button
                  className="lookup"
                  onClick={() => ask(phrase)}
                  onMouseDown={keepFocus}
                  title={t('cards.room.answers.sendTooltip', { phrase })}
                  type="button"
                >
                  {phrase}
                </button>
              ) : (
                phrase
              )}
            </dt>
            <dd>
              {answer.to !== undefined && (
                <span className="chip quiet">
                  {t('cards.room.answers.leadsTo', { roomRef: answer.to })}
                </span>
              )}
              {answer.need !== undefined && (
                <span className="quiet"> {answer.need.join(', ')}</span>
              )}
              {answer.to === undefined && answer.need === undefined && (
                <span className="quiet">{t('cards.room.answers.noEffectKnown')}</span>
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/** One line per phrase, for pasting to somebody who asked how to get through. */
function answersCopyText(answers: RoomCommand[]): string {
  return answers
    .map((answer) => {
      const parts = [answer.say[0] ?? ''];
      if (answer.to !== undefined) parts.push(`→ ${answer.to}`);
      if (answer.need !== undefined) parts.push(`(${answer.need.join(', ')})`);
      return parts.join(' ');
    })
    .join('\n');
}

function LairFace({
  character,
  inspect,
  lair
}: Pick<RoomCardProps, 'character' | 'inspect'> & { lair: WorldLair }) {
  const mine = ownAlignment(character);
  if (lair.mobs.length === 0) {
    /*
     * The realm marks this a lair and this client's data names none of what
     * spawns here — a derivative that added monsters after the data was
     * built. Said, because the map has already drawn the glyph and a face
     * that quietly did not appear would read as the face being broken.
     */
    return <div className="empty">{t('cards.room.lair.unnamed')}</div>;
  }
  return (
    <>
      {lair.max !== null && (
        <div className="chip-row">
          <span className="chip quiet">
            {lair.max === 1
              ? t('cards.room.lair.upTo.one')
              : t('cards.room.lair.upTo.many', { max: lair.max })}
          </span>
        </div>
      )}
      <dl className="readout">
        {lair.mobs.map((mob) => {
          const sure = attacksOnSight(mob.disposition, mine);
          return (
            <Fragment key={mob.name}>
              <dt>
                {inspect ? (
                  <button
                    className="occupant mob lookup"
                    onClick={(event) => inspect(mob.name, event.currentTarget)}
                    onMouseDown={keepFocus}
                    title={t('cards.room.itemLookupTooltip')}
                    type="button"
                  >
                    {mob.name}
                  </button>
                ) : (
                  <span className="occupant mob">{mob.name}</span>
                )}
              </dt>
              <dd>
                {healthOf(mob)}
                {/* The same words the occupant line uses, so a lair reads as
                    the room it is: hostile in words, uncertain with a mark. */}
                {sure === true && (
                  <span className={`chip warn${mob.uncertain ? ' quiet' : ''}`}>
                    {mob.uncertain
                      ? t('cards.room.occupant.hostileUncertainChip')
                      : t('cards.realm.facet.hostile')}
                  </span>
                )}
                {mob.disposition !== null && sure !== true && (
                  <span className="chip quiet">{DISPOSITION_WORD[mob.disposition]}</span>
                )}
                {mob.costly !== 'never' && (
                  <span className="chip quiet">
                    {mob.costly === 'always'
                      ? t('cards.room.occupant.alignCostChip')
                      : t('cards.room.occupant.alignCostUncertainChip')}
                  </span>
                )}
              </dd>
            </Fragment>
          );
        })}
      </dl>
      <div className="aside">{t('cards.room.lair.aside')}</div>
    </>
  );
}

export default memo(RoomCard);
