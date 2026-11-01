import { memo, useMemo, Fragment } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { coinText } from '../lib/coins';
import { ago } from '../lib/players';
import { lightNote } from '../lib/room';
import Icon from './Icon';
import { nicknameMarks } from '../lib/nicknames';
import { useCardSize } from '../hooks/useCardSize';
import { useRoomNickname } from '../hooks/useRoomNickname';
import ExitCompass, { ExitNotes, exitWords, sortExits } from './RoomExits';
import RoomFight, { FightChip } from './RoomFight';
import RoomOccupants, { OccupantTally } from './RoomOccupants';
import RoomPicture from './RoomPicture';
import type { RoomArtApi } from '../hooks/useRoomArt';
import type { FoundRoom } from '@shared/destinations';
import type { RoomNickname } from '@shared/roomNicknames';
import ShopFace, { balanceHere, bankCopyText, shopCopyText, shopFaceLabel } from './ShopFace';
import FindsFace, { findsCopyText } from './FindsFace';
import LairList, { lairCopyText } from './LairList';
import RoomSpellRows, { hazardAtLevel, roomSpellCopyLines } from './RoomSpellRows';
import { roomId, type RoomCommand, type SpellHazard, type WorldShop } from '@shared/world';
import { type Discovery } from '@shared/memory';
import type { Find } from '@shared/finds';
import type { SessionId } from '@shared/ipc';
import { standingOf, type CharacterState } from '@shared/character';
import type { RoomVerdict } from '@shared/verdict';
import type { RoomAsk } from '@shared/quests';
import { askLine } from '@shared/asking';
import { gatesWords } from '@shared/gateWords';
import { countedLabel } from '@shared/items';
import type { Wearer } from '@shared/gear';
import { useWearer } from '../hooks/useWearer';
import FloorItems from './FloorItems';

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
  /** Who this character is in the realm's rows, for the floor's use marks (`useWearer`). */
  loadWearer?(): Promise<Wearer>;
  /**
   * Strikes one of the found ways out, because the player says it is wrong.
   *
   * Theirs to say: nothing automatic can tell a mistyped direction the server
   * accepted from a genuine way through, and a record that cannot be corrected
   * is one that is eventually ignored.
   */
  forget?(discovery: Pick<Discovery, 'from' | 'command'>): void;
  /** Sends a probe through the arbiter: a word the room answers to. */
  ask?(command: string): void;
  /**
   * Asks the realm where the character is, in the realm's own word, which main
   * chooses (todo 811); a realm with none refuses out loud. Quiet in the
   * console when `internal.yaml` says so.
   */
  locate?(): void;
  /**
   * Ways through the realm this character has found that the realm data does
   * not have.
   *
   * Passed in rather than fetched, because it arrives with everything else a
   * character publishes — and a card that asked for it separately would show a
   * record from one moment beside a room from another.
   */
  learned: Discovery[];
  /**
   * What a `search` has turned up in this **realm** — every room, not this one.
   *
   * The one thing on this card that is not about where the character is
   * standing, and deliberately: a find is worth writing down precisely because
   * the room will not mention it again, so a face scoped to *here* would be
   * empty in the moment anybody wanted it. See `FindsFace`.
   */
  finds: readonly Find[];
  /** Opens the route panel at a room. Null on a pinned float, which cannot. */
  goToRoom: ((room: string) => void) | null;
  /** Strikes a find out, because the person reading it says it is wrong. */
  forgetFind?(find: Pick<Find, 'room' | 'name'>): void;
  /**
   * The room appraised — *can I fight this?* Pushed beside the character it is
   * about and for the same reason `learned` is passed in: the row and the
   * occupants it prices are one moment.
   */
  verdict: RoomVerdict;
  /**
   * What the things standing in the room answer to, for this character as it
   * stands — one chip each, beside the words the *room* answers to.
   *
   * Decided in main, where the quest book, the counters `abil` stated and the
   * listed pack all live, and pushed beside the verdict for the same reason:
   * three of its four inputs move without the room moving. See `asksHere`.
   */
  asks: readonly RoomAsk[];
  /** The room search, asked for MegaMUD's name for this room (todo 144); absent, none is shown. */
  searchRooms?(query: string): Promise<FoundRoom[]>;
  /** The room's picture as main holds it, drawn in the compass on a card past small; absent, a dot. */
  art?: RoomArtApi;
}

/**
 * Where you are standing.
 *
 * A room only appears once the `Obvious exits:` line has completed it — see
 * `RoomTracker.exits` (`parse/room.ts`). A partially assembled room is worse than the previous
 * one, because it looks current.
 */
function RoomCard({
  character,
  session,
  inspect,
  forget,
  ask,
  locate,
  asks,
  learned,
  finds,
  goToRoom,
  forgetFind,
  verdict,
  searchRooms,
  loadWearer,
  art,
  ...chrome
}: RoomCardProps) {
  const { room } = character;
  const wearer = useWearer(character, loadWearer);
  const nickname = useRoomNickname(searchRooms, room.map, room.number);
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
   * The Finds face's window, and whether the face is offered at all.
   *
   * `0` means show everything, which is also the shipped answer, so an absent
   * setting and a stated zero are the same thing here rather than two.
   */
  const findDays = chrome.settings?.value.findDays ?? 0;

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
   * `RoomTracker.attachRealm` now joins them at the point the room is
   * placed, so this is a field read. The card draws the right thing on its
   * first paint, there is no flash of a room without its shop, and switching
   * characters cannot show one character's stock beside another's room.
   */
  const shop = room.shop ?? null;
  const lair = room.lair ?? null;
  const answers = room.commands ?? [];
  // The room's spell as it applies at this character's level (todo 01, 72).
  const spellHazard = hazardAtLevel(room.spell, character.progress.level);

  const face = (
    <RoomBody
      answers={answers}
      art={art}
      session={session}
      ask={ask}
      asks={asks}
      character={character}
      inspect={inspect}
      nickname={nickname}
      shop={shop}
      spellHazard={spellHazard}
      verdict={verdict}
      wearer={wearer}
    />
  );
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
    lines.push(
      ...roomSpellCopyLines({
        spell: room.spell ?? null,
        hazard: spellHazard,
        stoppedBy: room.spellStoppedBy,
        passage: room.passage
      })
    );
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
          exitList: sortExits(room.exits).map(exitWords).join(', ')
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
          itemList: [coinText(room.cash), ...room.items.map(countedLabel)]
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
          itemList: [coinText(room.hiddenCash), ...room.hidden.map(countedLabel)]
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
        locate && character.phase === 'in-game'
          ? [
              {
                id: 'locate',
                label: t('cards.room.actions.askLocationTooltip'),
                icon: 'search',
                run: () => locate()
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
        hasShop || lair !== null || answers.length > 0 || here.length > 0 || finds.length > 0
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
                      content: (
                        <LairList inspect={inspect} lair={lair} standing={standingOf(character)} />
                      ),
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
                          here={located ? roomId(room.map!, room.number!) : null}
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
                : []),
              /*
               * What searching has turned up, last of the fixed order — it is
               * the one face about the realm rather than about this room, so it
               * reads last for the same reason the row is general to particular
               * everywhere else on this screen.
               */
              ...(finds.length > 0
                ? [
                    {
                      id: 'finds',
                      label: t('cards.room.tabs.finds'),
                      // A table's tools stay put and the table scrolls under
                      // them, which on a face is declared per face.
                      paned: true,
                      content: (
                        <FindsFace
                          days={findDays}
                          finds={finds}
                          forget={forgetFind}
                          goToRoom={goToRoom}
                          returnFocus={chrome.returnFocus}
                          session={session}
                        />
                      ),
                      copyText: () => findsCopyText(finds, findDays, Date.now())
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

function RoomBody({
  answers,
  art,
  ask,
  asks,
  character,
  inspect,
  nickname,
  session,
  shop,
  spellHazard,
  verdict,
  wearer
}: Pick<RoomCardProps, 'ask' | 'asks' | 'character' | 'inspect' | 'verdict' | 'art' | 'session'> & {
  /** Who this character is, for the floor's use marks. */
  wearer: Wearer;
  /** MegaMUD's name for the room, or null (`useRoomNickname`). */
  nickname: RoomNickname | null;
  shop: WorldShop | null;
  /** The room spell's hazard at this character's level (`hazardAtLevel`). */
  spellHazard: SpellHazard | undefined;
  /** What the realm says this room answers to. See the row below the exits. */
  answers: RoomCommand[];
}) {
  const { room, phase } = character;
  const light = lightNote(room);
  // The picture is a medium card's and up: a small one holds no subscription for it.
  const pictured = useCardSize() !== 'small' && art !== undefined;
  // One element while the picture's inputs hold, so the memoised compass does not redraw per status line.
  const hub = useMemo(
    () => (pictured && art !== undefined ? <RoomPicture art={art} session={session} /> : undefined),
    [pictured, art, session]
  );
  /*
   * What the vault holds, on the **first** face rather than only on the Bank
   * one behind it: in a bank the room's own subject is a number about this
   * character, already on state and restored across sessions. Null in every
   * other room, so no other room grows a row.
   */
  const vault = shop?.kind === 'bank' ? balanceHere(shop, character.banks) : null;
  const inBank = shop?.kind === 'bank';
  // The floors' coins in the purse's own words (`lib/coins.ts`), the longest tier: this row wraps.
  const floorCoins = coinText(room.cash);
  const hiddenCoins = coinText(room.hiddenCash);
  if (phase !== 'in-game' || (room.name === null && light === null)) {
    return <div className="empty">{t('cards.room.empty')}</div>;
  }
  return (
    <div className="room-face">
      {/* The compass and who the room is beside it: the glance at every size.
          Large, the compass's hub is the room's picture. */}
      <div className="room-hero">
        <ExitCompass hub={hub} room={room} />
        <div className="room-hero-text">
          {room.name !== null && <div className="room-name">{room.name}</div>}
          {/* MegaMUD's name and what its goto list records: marks, deciding nothing. */}
          {nickname !== null && (
            <div className="chip-row" data-megamud={nickname.code}>
              <span className="chip info">{nickname.name}</span>
              {nicknameMarks(nickname).map((mark) => (
                <span className="chip quiet" key={mark}>
                  {mark}
                </span>
              ))}
            </div>
          )}

          {/*
            The light, in the server's words, and what the client did about a
            room it could not see: `pitch black` is a fact about the room;
            *placed by dead reckoning* is a fact about the location, and is
            what the badge's lower confidence means. A name still on the card
            when the dark arrived is the last one *read*, and says so; a room
            the realm data would not let it place says so instead of nothing.
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

          {/* From the realm data, the one source of it so far (todo 87). */}
          {room.safe === true && (
            <div className="chip-row" data-safe="realm">
              <span className="chip info" title={t('cards.room.safeTitle')}>
                {t('cards.room.safe')}
              </span>
            </div>
          )}

          <ExitNotes room={room} />
          <div className="only-small room-glance">
            <FightChip verdict={verdict} />
            <OccupantTally character={character} />
          </div>

          {/* Clamped at medium, whole at large: context, while the exits are
              what the card is consulted for. The full text is in the terminal. */}
          {room.description !== null && (
            <p className="room-description from-medium">{room.description}</p>
          )}
        </div>
      </div>

      {/* One run of chips for both rows below: each is a few words, and a row apiece left most of each line empty. */}
      <div className="room-acts from-medium">
        {/*
        What the room answers to, as controls, on the face that is on screen
        (todo 11). The detail (where each phrase leads, what it wants) stays on
        the ANSWERS face; this row says *there is something to do here*. Only
        the first spelling of each, as the face does.
      */}
        {answers.length > 0 && (
          <div className="exits room-answers from-medium">
            {answers.map((answer, index) => {
              const phrase = answer.say[0] ?? '';
              return ask && phase === 'in-game' ? (
                <button
                  className="chip"
                  key={`${phrase}-${index}`}
                  onClick={() => ask(phrase)}
                  onMouseDown={keepFocus}
                  title={t('cards.room.answers.sendTooltip', { phrase })}
                  type="button"
                >
                  {phrase}
                </button>
              ) : (
                <span className="chip" key={`${phrase}-${index}`}>
                  {phrase}
                </span>
              );
            })}
          </div>
        )}

        {/*
        And what the things *standing* here answer to (todo 01), in the same
        row grammar: a chip only where every gate the client has read is met.
        A step that still wants something is drawn and marked, never removed.
      */}
        {asks.length > 0 && (
          <div className="exits room-asks from-medium">
            {asks.map((offer, index) => {
              const line = askLine(offer.who, offer.say);
              const wants = offer.wants?.join(', ');
              const title =
                wants === undefined
                  ? t('cards.room.asks.sendTooltip', { quest: offer.quest, line })
                  : t('cards.room.asks.wantsTooltip', { quest: offer.quest, items: wants });
              const body = (
                <>
                  {line}
                  {wants !== undefined && (
                    <span className="exit-note">
                      {' '}
                      {t('cards.room.asks.wants', { items: wants })}
                    </span>
                  )}
                </>
              );
              return ask && phase === 'in-game' ? (
                <button
                  className={`chip${wants === undefined ? '' : ' warn'}`}
                  key={`${offer.who}-${offer.say}-${index}`}
                  onClick={() => ask(line)}
                  onMouseDown={keepFocus}
                  title={title}
                  type="button"
                >
                  {body}
                </button>
              ) : (
                <span
                  className={`chip${wants === undefined ? '' : ' warn'}`}
                  key={`${offer.who}-${offer.say}-${index}`}
                  title={title}
                >
                  {body}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* The verdict before the names, because it is the question the names
          raise: *can I fight this room?* */}
      {verdict.monsters.length > 0 && (
        <div className="from-medium">
          <RoomFight hp={character.vitals.hp} verdict={verdict} />
        </div>
      )}
      {room.occupants.length > 0 && (
        <div className="from-medium">
          <RoomOccupants character={character} inspect={inspect} verdict={verdict} />
        </div>
      )}

      {/*
        One grid, not one per row: a CSS grid sizes an `auto` column from its
        own container's children, so two `.readout` blocks would each measure
        their label column and the value columns would start at different x.
      */}
      {(inBank ||
        room.spell ||
        room.passage ||
        room.items.length > 0 ||
        room.hidden.length > 0 ||
        floorCoins.length > 0 ||
        hiddenCoins.length > 0) && (
        <dl className="readout from-medium">
          {/*
           * First in a bank, because it is what the room is *for*. **The
           * absence is stated as itself**: a vault nobody has asked is not a
           * vault holding nothing. See `BankBalance.at` for the time beside it.
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

          {/* What the room casts on whoever stands in it (todo 72). */}
          {(room.spell || room.passage) && (
            <RoomSpellRows
              hazard={spellHazard}
              hpMax={character.vitals.hpMax}
              inspect={inspect}
              passage={room.passage}
              spell={room.spell ?? null}
              stoppedBy={room.spellStoppedBy}
            />
          )}

          {/*
            What a `search` turned up, which the room's own listing does not
            carry: its own row, since these are not lying in the open, and the
            difference is what stops the client asking for the cash the way
            that does not work (`AutoLoot`).
          */}
          {(room.hidden.length > 0 || hiddenCoins.length > 0) && (
            <>
              <dt title={t('cards.room.readout.hiddenTooltip')}>
                {t('cards.room.readout.hiddenLabel')}
              </dt>
              <FloorItems
                coins={hiddenCoins}
                inspect={inspect}
                items={room.hidden}
                wearer={wearer}
              />
            </>
          )}

          {(room.items.length > 0 || floorCoins.length > 0) && (
            <>
              <dt>{t('cards.room.readout.itemsLabel')}</dt>
              <FloorItems coins={floorCoins} inspect={inspect} items={room.items} wearer={wearer} />
            </>
          )}
        </dl>
      )}
    </div>
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
 * `ask`, the same path the card's own typed commands take, so the tracker observes it
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
  inRealm,
  here
}: {
  answers: RoomCommand[];
  ask: RoomCardProps['ask'];
  /** A phrase is a control only while there is a socket to send it down. */
  inRealm: boolean;
  /** Where the character is standing, so a lever's own exit needs no address. */
  here: string | null;
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
              {/*
                A lever, and what it opens — todo 01. The exit is usually this
                room's, so the direction alone says it; where it is another
                room's the address goes with it, because *pull lever* with no
                consequence beside it is the client repeating the realm at
                somebody. `opens` is what tells a lever from a scripted answer.
              */}
              {answer.opens !== undefined && (
                <span className="chip quiet">
                  {answer.opens.room === here
                    ? t('cards.room.answers.opensExit', { direction: answer.opens.direction })
                    : t('cards.room.answers.opensExitElsewhere', {
                        direction: answer.opens.direction,
                        roomRef: answer.opens.room
                      })}
                </span>
              )}
              {answer.gates !== undefined && (
                <span className="quiet"> {gatesWords(answer.gates, t)}</span>
              )}
              {answer.to === undefined &&
                answer.gates === undefined &&
                answer.opens === undefined && (
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
      if (answer.opens !== undefined) {
        parts.push(`(opens ${answer.opens.direction} of ${answer.opens.room})`);
      }
      if (answer.gates !== undefined) parts.push(`(${gatesWords(answer.gates, t)})`);
      return parts.join(' ');
    })
    .join('\n');
}

export default memo(RoomCard);
