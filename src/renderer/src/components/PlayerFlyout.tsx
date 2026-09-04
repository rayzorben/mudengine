import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';

import Icon from './Icon';
import RemoteList from './RemoteList';
import PopupMenu from './PopupMenu';
import { useCopyMenu } from '../hooks/useCopyMenu';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { GangName } from '../lib/gangs';
import { ago, place } from '../lib/players';
import {
  anchorNode,
  anchorRect,
  placePopover,
  scrollMovesAnchor,
  type PopoverAnchor,
  type PopoverPlacement
} from '../lib/popover';
import { gangOnRoster, joinedTheParty, ownGang, type CharacterState } from '@shared/character';
import type { RemotesConfig } from '@shared/config';
import type { SessionId } from '@shared/ipc';
import {
  ACTIONABLE_REMOTES,
  grantFor,
  judgeRemote,
  type RemoteGrant,
  type RemoteName
} from '@shared/remotes';
import { playerKey, type PlayerRecord } from '@shared/players';

/**
 * A name somebody clicked on a listing, whose character's listing it was, and
 * where on screen the click landed.
 *
 * Built fresh per click on purpose, like `Asked`: effects key on the object,
 * so the same name clicked twice still re-opens where a bare string would
 * compare equal. The session is carried because a pinned float belongs to
 * somebody other than the shown character, and the detail has to be *that*
 * character's registry and *that* character's permissions.
 */
export interface PlayerAsked {
  session: SessionId;
  name: string;
  anchor: PopoverAnchor;
}

export interface PlayerFlyoutProps {
  asked: PlayerAsked;
  /** The character whose listing was clicked — not necessarily the shown one. */
  character: CharacterState;
  /**
   * How that character's remote answering is configured — `automation.remotes`,
   * resolved for it. The whole block rather than only this person's grant: the
   * Access face has to distinguish "off entirely" from "on, and this person has
   * been granted nothing", and it has to say where an unset remote lands, which
   * is the gang list.
   */
  remotes: RemotesConfig;
  /**
   * Write this person's whole grant — what they may ask for and what they may
   * never — or clear it.
   *
   * Reaches the character's own options file, which is why it is a callback
   * rather than local state: a permission somebody set by clicking and lost on
   * relaunch is one they will not trust enough to use. The **whole** grant,
   * because *Allow all* is one press and twenty writes would be twenty rewrites
   * of the same file racing each other. See `App.tsx`.
   */
  onGrant(name: string, grant: RemoteGrant): void;
  /**
   * A worn item clicked, asking the realm what it is.
   *
   * The same control every other item name in the client is, and it replaces
   * this panel rather than opening beside it — one panel at a time, which is
   * `inspect`'s own rule in `App.tsx` and the reason clicking through never
   * leaves two things to put away.
   *
   * The stats are deliberately **not** inlined here. A `PlayerRecord` is
   * written to a per-realm file on disk, and copying every item's armour class
   * and damage into it would put a slice of the realm database into each
   * player's row — kept in step with nothing, and stale the moment the realm
   * file is rebuilt. The realm's answer is one click away and always current.
   */
  inspect?(name: string, anchor: HTMLElement): void;
  /**
   * Their gang's name clicked: the Gang flyout on it, replacing this panel.
   *
   * Optional, because a surface with no gang panel behind it must draw the name
   * as text rather than as a control bound to nowhere — the rule the Route
   * card's room names already follow.
   */
  onSelectGang?(gang: string, anchor: PopoverAnchor): void;
  onDismiss(): void;
  /** Hands the caret back to the game after a menu that took it. */
  returnFocus(): void;
}

type Face = 'player' | 'equipment' | 'access';

/**
 * One other person, and whether they may drive this character — slid out from
 * the listing they were clicked on.
 *
 * ## A flyout, not a card
 *
 * This was a card for a day: `Player`, put away until a name was clicked and
 * then brought out beside the listing. Two things were wrong with that shape.
 * A card is a *standing instrument* — the rail is the player's arrangement of
 * what they watch — and a clicked name is a question asked right now, which
 * is the distinction the table rules already draw between a filter and a
 * find. And it spent a slot: a card that exists only to be clicked into is
 * one more thing on a rail somebody wanted to keep short. So it is a slide-out,
 * like the realm's answer about a clicked item (`ReferencePopover`), opened
 * beside the card that was clicked and aligned with the row, and it goes away
 * on Escape, a click anywhere else, or the next click on a name.
 *
 * `ReferencePopover`'s docblock once ruled a popover *out* for this job,
 * because the Access face writes to the options file and a control deciding
 * who may drive a character must not vanish because the game printed a line.
 * That objection was to a popover that dismissed on any scroll, and it has
 * been dissolved: `scrollMovesAnchor` closes a slide-out only when the thing
 * that scrolled moved the name it hangs off. The console printing is not news
 * here, so the gate stays open until somebody puts it away.
 *
 * ## Two faces, and the second is the one with teeth
 *
 * The first is everything known — the surface `@seen` would be answered from,
 * and the only place another player's `{HP=…}` answer is ever shown as the
 * numbers it is. `ACCESS` is the gate `todo-megamud-commands.md` §4 waited on:
 * whether this person's `@` commands are answered.
 *
 * ## What it does not do
 *
 * It asks the server for nothing. Every fact here arrived on a broadcast, a
 * listing or a room this character was in anyway. And **nothing here is a
 * bar**: another player's health is a figure their client quoted at a moment
 * they chose, and a bar is how this client draws a number it is reading now.
 * The quotation is printed with the time it came in beside it.
 *
 * Never focused — it is read and clicked, not typed into, so the caret stays
 * with the game and Escape reaches it through a capture listener. In a portal,
 * because the cards that open it scroll and clip.
 */
export default function PlayerFlyout({
  asked,
  character,
  remotes,
  onGrant,
  onSelectGang,
  onDismiss,
  returnFocus,
  inspect
}: PlayerFlyoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [face, setFace] = useState<Face>('player');
  const [placed, setPlaced] = useState<PopoverPlacement | null>(null);
  const copy = useCopyMenu();

  // A direct lookup: `playerKey` is what the registry files a name under.
  const record = character.players[playerKey(asked.name)] ?? null;
  const now = character.updatedAt ?? 0;

  /*
   * Whether this person shares this character's gang, read **once** and handed
   * to both faces.
   *
   * The badge in the heading and the Access face state the same verdict, and
   * the badge used to compute it with `inGang: null` — so somebody the gang was
   * currently answering read as `nothing allowed` in the heading and `5 of 20`
   * two clicks away. Two readings of one permission is how they come to
   * disagree, which is the rule `judgeRemote` exists to keep.
   *
   * Three answers, not two: `undefined` on either row means nobody has said,
   * and an unknown membership must never draw as "not in it" — the reader's
   * next action differs (type `who`, or grant by name).
   */
  const inGang = useMemo<boolean | null>(() => {
    const own = ownGang(character);
    const theirs = gangOnRoster(character, asked.name);
    if (own === undefined || theirs === undefined) return null;
    return own !== null && theirs !== null && own.toLowerCase() === theirs.toLowerCase();
  }, [character, asked.name]);

  // A new name opens on the first face: the Access face a previous person was
  // left on is a decision about somebody else.
  useEffect(() => setFace('player'), [asked]);

  /*
   * Measured before paint from the panel's own size, then placed — the first
   * pass renders it hidden so this is a measurement rather than a guess, the
   * way `ReferencePopover` and `PopupMenu` do. Re-measured when the face or
   * the record changes, because a face with a warning under it is taller than
   * one without, and a health answer arriving adds a row.
   *
   * A row that has left the document — the listing was replaced and this
   * person is no longer in it — leaves the panel beside nothing, so it goes.
   */
  useLayoutEffect(() => {
    const panel = ref.current?.getBoundingClientRect();
    if (!panel) return;
    const within = anchorNode(asked.anchor);
    if (within !== null && 'isConnected' in within && !(within as Node).isConnected) {
      onDismiss();
      return;
    }
    setPlaced(
      placePopover(
        anchorRect(asked.anchor),
        { width: panel.width, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  }, [asked, face, record, onDismiss]);

  const menuOpen = copy.menu !== null;
  useEffect(() => {
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      if (!(target instanceof Element)) {
        onDismiss();
        return;
      }
      /*
       * The copy menu is a portal outside the panel, and choosing an entry in
       * it must not put the panel away. A *containment* test, not "is the
       * menu open": with the flag alone, a click on the console made to put
       * the menu away closed the menu and left the panel stranded, so the
       * player clicked twice for one dismissal.
       */
      if (target.closest('.popup-menu') !== null) return;
      /*
       * A press on any name that opens this panel is left to its click, which
       * replaces the panel rather than toggling it. Without this the press
       * dismissed and the click re-opened, so choosing somebody on the other
       * listing unmounted the panel, flashed it at the origin for a frame and
       * slid it in again. Marked by attribute rather than by class so the
       * listings and this panel agree on one word (`PlayerName`).
       */
      if (target.closest('[data-opens="player"]') !== null) return;
      onDismiss();
    };
    /*
     * Capture, and the panel owns its own Escape: `useHotkeys` listens in
     * capture too and would otherwise hand a bare Escape to whatever else is
     * open — the diagnostics rail, say — leaving this panel over the game.
     * The terminal keeps focus throughout, so this cannot go through focus.
     * While the copy menu is open Escape belongs to it.
     */
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || menuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };
    // A scroll closes the panel only when it moved the row the panel hangs off
    // — `scrollMovesAnchor` has the whole reason.
    const scrolled = (event: Event): void => {
      if (!scrollMovesAnchor(event.target, anchorNode(asked.anchor))) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    // Anything that moves the anchor closes the panel rather than chasing it.
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [asked, menuOpen, onDismiss]);

  // Every entry hands the caret back — see `BentoCard` for why the hook does
  // not do this itself.
  const copyItems = copy.menu
    ? copy.items(copy.menu).map((item) => ({
        ...item,
        run: () => {
          item.run();
          returnFocus();
        }
      }))
    : [];

  const faces: ReadonlyArray<{ id: Face; label: string }> = [
    { id: 'player', label: t('cards.player.title') },
    { id: 'equipment', label: t('cards.player.tabEquipment') },
    { id: 'access', label: t('cards.player.tabAccess') }
  ];

  return createPortal(
    <div
      aria-label={t('cards.player.ariaLabel', { name: asked.name })}
      className="surface popover player-flyout"
      data-side={placed?.side ?? 'right'}
      onContextMenu={copy.onContextMenu}
      ref={ref}
      role="dialog"
      style={{
        top: placed?.top ?? 0,
        left: placed?.left ?? 0,
        visibility: placed === null ? 'hidden' : 'visible'
      }}
    >
      <header className="popover-head">
        {/*
          The faces live in the heading, and the first wears the title — the
          same shape as a card's crumbs, drawn with the same pill, because it
          is the same control.
        */}
        <h2>
          <span className="crumbs" role="tablist">
            {faces.map((entry) => (
              <button
                aria-selected={face === entry.id}
                className="crumb"
                data-active={face === entry.id ? 'true' : 'false'}
                key={entry.id}
                onClick={() => setFace(entry.id)}
                onMouseDown={keepFocus}
                role="tab"
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </span>
        </h2>
        {/*
          No badge. It used to carry the Access face's verdict — `nothing
          allowed`, `5 allowed` — on the reasoning that somebody reading the
          detail would want it without switching faces. That is per-face
          information in the shared header, which is the thing a header must
          not hold: the count belongs to one of the two faces and read as a
          property of whichever was open, so the Player face appeared to be
          reporting a permission it says nothing about. The Access face states
          it in full, on the face that owns it.
        */}
        <button
          aria-label={t('cards.chrome.close')}
          className="card-action card-close"
          onClick={onDismiss}
          onMouseDown={keepFocus}
          title={t('cards.chrome.close')}
          type="button"
        >
          <Icon name="close" />
        </button>
      </header>

      {record === null ? (
        <p className="empty">{t('cards.player.unknownName', { name: asked.name })}</p>
      ) : face === 'player' ? (
        <PlayerDetail now={now} onSelectGang={onSelectGang} record={record} />
      ) : face === 'equipment' ? (
        <PlayerEquipment inspect={inspect} now={now} record={record} />
      ) : (
        <PlayerAccess
          gang={ownGang(character) ?? null}
          inGang={inGang}
          inParty={joinedTheParty(character, asked.name)}
          onGrant={onGrant}
          record={record}
          remotes={remotes}
          returnFocus={returnFocus}
        />
      )}

      {copy.menu !== null && copyItems.length > 0 && (
        <PopupMenu
          at={copy.menu}
          items={copyItems}
          onDismiss={() => {
            copy.dismiss();
            returnFocus();
          }}
        />
      )}
    </div>,
    document.body
  );
}

/**
 * Everything known about one person, and an honest blank where nothing is.
 *
 * **Standing is deliberately not a row here.** It is the Realm card's column —
 * that listing is what a `who` said, and hostility is read there, coloured, on
 * the row that was clicked to get here. Repeating it on the detail said
 * `Standing: unknown` for nearly everybody, a row spent on the absence of a fact.
 *
 * **Two clocks, two rows, because they answer different questions.** *Last
 * online* is whether they are logged in and, if not, when they went — answered
 * from any sighting at all, since a line of chat proves presence. *Last seen*
 * is the last time they were in a room with this character, and *Where* is
 * that room: the pair is one fact, and stamping the time from a telepath would
 * put a fresh time beside a stale room and invite a walk to where they no
 * longer stand.
 */
function PlayerDetail({
  record,
  now,
  onSelectGang
}: {
  record: PlayerRecord;
  now: number;
  onSelectGang?: (gang: string, anchor: PopoverAnchor) => void;
}) {
  return (
    <dl className="readout player-detail">
      <dt>{t('cards.realm.column.name')}</dt>
      <dd>
        {record.name}
        {record.online ? null : <span className="chip off">{t('cards.player.chip.offline')}</span>}
        {record.inParty ? <span className="chip">{t('cards.player.chip.party')}</span> : null}
      </dd>

      {record.title === null ? null : (
        <>
          <dt>{t('cards.realm.column.title')}</dt>
          <dd>{record.title}</dd>
        </>
      )}

      {/* From their who row or a look at them: the one fact the `gang` ground
          is decided on, so it is shown where that decision is made — and a
          control, because a gang is an entity too and the question that follows
          "who is this" is routinely "who else is in that". */}
      {record.gang === null ? null : (
        <>
          <dt>{t('cards.player.detail.gang')}</dt>
          <dd>
            {onSelectGang ? (
              <GangName className="gang-name" gang={record.gang} onSelect={onSelectGang} />
            ) : (
              record.gang
            )}
          </dd>
        </>
      )}

      <dt>{t('cards.player.detail.lastOnline')}</dt>
      <dd>{record.online ? t('cards.player.lastOnlineNow') : ago(record.lastSeen, now)}</dd>

      <dt>{t('cards.player.detail.lastSeen')}</dt>
      <dd>
        {record.lastRoomAt === null ? (
          <span className="quiet-note">{t('cards.player.neverInRoom')}</span>
        ) : (
          ago(record.lastRoomAt, now)
        )}
      </dd>

      <dt>{t('cards.player.detail.where')}</dt>
      <dd>{place(record)}</dd>

      <dt>{t('cards.player.detail.health')}</dt>
      <dd>
        {/*
          The one place another player's absolute figures are ever shown. Printed
          with when they arrived, because they are a quotation and not a reading:
          `@health` is answered at a moment somebody chose, and a number from five
          minutes ago drawn as though it were live is the readout claiming to know
          something it does not.
        */}
        {record.vitals === null ? (
          <span className="quiet-note">{t('cards.player.healthNeverAnswered')}</span>
        ) : (
          <>
            {record.vitals.hp}/{record.vitals.hpMax}
            {record.vitals.mana === null ? null : (
              <>
                {' · '}
                {record.vitals.mana}/{record.vitals.manaMax}
              </>
            )}
            <span className="quiet-note"> ({ago(record.vitalsAt ?? now, now)})</span>
          </>
        )}
      </dd>

      {record.commandsSent === 0 ? null : (
        <>
          <dt>{t('cards.player.detail.commands')}</dt>
          <dd>
            {t('cards.player.commandsValue', {
              commandsSent: record.commandsSent,
              lastCommand: record.lastCommand ?? '',
              agoText: ago(record.lastCommandAt ?? now, now)
            })}
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * What they were wearing the last time a character on this realm looked at them.
 *
 * *A* character, not this one: the record is the realm's (`PlayerBook`), so
 * what Vaelor saw Soul wearing is what Rand's flyout shows too, and what was
 * seen last week is still here after a restart.
 *
 * **Worn kit, not a pack**, and the face says so in its own words rather than
 * being called Inventory: `look <player>` prints an equipment block and that is
 * the whole of what this server volunteers about another player's belongings.
 * What somebody is *carrying* is not on the wire at any price — a field for it
 * was declared on `PlayerRecord` once, drawn on a card, and removed again
 * because the condition guarding it could never be true.
 *
 * **Stamped, because it is a sighting and not a reading.** Somebody changes
 * armour between one look and the next, and a list drawn without saying when it
 * was true invites a decision about a fight against kit they took off an hour
 * ago — the same rule the health quotation on the first face follows.
 *
 * Three states, not two. Never looked at is not the same as looked at and
 * wearing nothing, and the reader's next action differs: look at them, or
 * believe the answer.
 */
function PlayerEquipment({
  record,
  now,
  inspect
}: {
  record: PlayerRecord;
  now: number;
  inspect?: (name: string, anchor: HTMLElement) => void;
}) {
  if (record.equipment === null) {
    return <p className="empty">{t('cards.player.equipmentNeverLooked', { name: record.name })}</p>;
  }
  if (record.equipment.length === 0) {
    return (
      <p className="empty">
        {t('cards.player.equipmentNothing', {
          name: record.name,
          agoText: ago(record.equipmentAt ?? now, now)
        })}
      </p>
    );
  }
  return (
    <>
      <p className="settings-note">
        {t('cards.player.equipmentAsOf', { agoText: ago(record.equipmentAt ?? now, now) })}
      </p>
      {/* One `.readout` for the whole face, the rule a card's label column
          keeps: the slot is the label and the item is the value, so the items
          line up in one column however long the slot words are. */}
      <dl className="readout player-equipment">
        {record.equipment.map((worn) => (
          <Fragment key={`${worn.slot}:${worn.name}`}>
            <dt>{worn.slot}</dt>
            <dd>
              {inspect === undefined ? (
                worn.name
              ) : (
                <button
                  className="lookup"
                  onClick={(event) => inspect(worn.name, event.currentTarget)}
                  onMouseDown={keepFocus}
                  title={t('cards.room.itemLookupTooltip')}
                  type="button"
                >
                  {worn.name}
                </button>
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
}

/**
 * Everything this person could actually ask for right now.
 *
 * The union `judgeRemote` computes, evaluated over the whole vocabulary rather
 * than re-derived here: their own allows, plus what the gang grants when they
 * are in it and what the party grants when they have joined it, minus anything
 * denied by name. Both facts are threaded in rather than assumed, and `inGang`
 * of `null` — nobody has said — deliberately grants nothing, which is the same
 * reading the engine applies.
 */
function effective(
  remotes: RemotesConfig,
  name: string,
  inGang: boolean | null,
  inParty: boolean
): readonly RemoteName[] {
  return ACTIONABLE_REMOTES.filter(
    (remote) => judgeRemote(name, remote, remotes, { inGang, inParty }).allowed
  );
}

/**
 * Whether this person's `@` commands are answered, which ones, and why.
 *
 * **It states the live picture rather than the setting**, and the two differ
 * often enough to matter: somebody granted through the gang is answered *while
 * the roster says they are in it*, and the same row reads differently an hour
 * later. A screen that showed only the list this person is named on would leave
 * somebody unable to tell whether the person in front of them is getting
 * through.
 *
 * The three facts, in the order somebody reads them: whether the feature is on
 * at all, what is getting through now, and where it comes from — then the grid
 * that changes it.
 */
function PlayerAccess({
  record,
  remotes,
  gang,
  inGang,
  inParty,
  onGrant,
  returnFocus
}: {
  record: PlayerRecord;
  remotes: RemotesConfig;
  /** This character's own gang, for the row that names it. Null while unsaid. */
  gang: string | null;
  /** Whether they share it, read once by the panel and shared with the badge. */
  inGang: boolean | null;
  /**
   * Whether they have **joined** this character's party — the engine's own
   * reading (`joinedTheParty`), not `record.inParty`, which counts an
   * outstanding invitation because the Player face draws an offer as a party
   * chip. A permission must not.
   */
  inParty: boolean;
  onGrant(name: string, grant: RemoteGrant): void;
  returnFocus(): void;
}) {
  const grant = grantFor(remotes, record.name);
  const allowed = effective(remotes, record.name, inGang, inParty);

  const set = useCallback((next: RemoteGrant) => onGrant(record.name, next), [record, onGrant]);

  return (
    <div className="player-access">
      <dl className="readout">
        {/*
          Whose access this is. The heading is `Player · Access` and the badge
          is the count, so without this the face states a decision with the
          name it applies to on the *other* face — and this is the face that
          writes to the options file.
        */}
        <dt>{t('cards.realm.column.name')}</dt>
        <dd>{record.name}</dd>

        <dt>{t('cards.player.access.answering')}</dt>
        {/*
          The count, and the names only as the title.

          Twenty-two `@` names set as a run of text is four wrapped lines at the
          top of a 280px panel, and it pushed the three rows that answer the
          actual question — is this person getting through, and from where —
          below the fold. It is also the wrong shape for what it states: the
          list is *already* on the grid underneath, row by row, with the control
          that changes each one beside it, so the sentence was a second,
          unclickable copy of the thing it sits above.

          The number is what a heading owes the reader; the names stay reachable
          on hover, which is the one thing the grid below cannot do at a glance.
        */}
        <dd>
          {!remotes.enabled ? (
            <span className="chip off">{t('cards.player.access.off')}</span>
          ) : allowed.length === 0 ? (
            <span className="quiet-note">{t('cards.player.access.nothingAllowed')}</span>
          ) : (
            <span className="chip on" title={allowed.map((remote) => `@${remote}`).join(', ')}>
              {t('cards.player.access.allowedValue', {
                granted: allowed.length,
                total: ACTIONABLE_REMOTES.length
              })}
            </span>
          )}
        </dd>

        {/*
          Where an unset remote lands for this person. Three states, said as
          three different sentences: the gang answers, the gang does not apply
          to them, or nothing has said yet — and only the last is a thing the
          reader can act on by typing `who`.
        */}
        <dt>{t('cards.player.access.gang')}</dt>
        <dd>
          {remotes.gang.length === 0 ? (
            <span className="quiet-note">{t('cards.player.access.gangGrantsNothing')}</span>
          ) : inGang === null ? (
            <span className="quiet-note">{t('cards.player.access.gangUnknown')}</span>
          ) : inGang ? (
            /*
              The count in the Answering row's own words — `1 of 22` — because
              the two rows state the same kind of fact and said two different
              ways they read as two different measures. The gang's name is
              already on the Gang card and on this person's Player face; a chip
              that restates it spends the row's width on the half the reader
              did not come to this row for.
            */
            <span
              className="chip on"
              title={t('cards.player.access.gangShareTooltip', { gang: gang ?? '' })}
            >
              {t('cards.player.access.allowedValue', {
                granted: remotes.gang.length,
                total: ACTIONABLE_REMOTES.length
              })}
            </span>
          ) : (
            <span className="quiet-note">
              {t('cards.player.access.gangNotShared', { gang: gang ?? '' })}
            </span>
          )}
        </dd>

        {/*
          And the same row for the party, because the party grants too and a
          face that named one of the two grounds would have somebody reading
          "the gang does not apply to them" as the whole answer. Two states
          rather than the gang's three: the party roster is this client's own
          listing, so there is no *nobody has said* to report.
        */}
        <dt>{t('cards.player.access.party')}</dt>
        <dd>
          {remotes.party.length === 0 ? (
            <span className="quiet-note">{t('cards.player.access.partyGrantsNothing')}</span>
          ) : inParty ? (
            <span className="chip on" title={t('cards.player.access.partyShareTooltip')}>
              {t('cards.player.access.allowedValue', {
                granted: remotes.party.length,
                total: ACTIONABLE_REMOTES.length
              })}
            </span>
          ) : (
            <span className="quiet-note">{t('cards.player.access.partyNotShared')}</span>
          )}
        </dd>

        {record.commandsSent === 0 ? null : (
          <>
            <dt>{t('cards.player.access.tried')}</dt>
            <dd>
              {record.commandsSent === 1
                ? t('cards.player.access.triedValue.one', {
                    commandsSent: record.commandsSent,
                    lastCommand: record.lastCommand ?? ''
                  })
                : t('cards.player.access.triedValue.many', {
                    commandsSent: record.commandsSent,
                    lastCommand: record.lastCommand ?? ''
                  })}
            </dd>
          </>
        )}
      </dl>

      {/*
        A grid that cannot take effect says so rather than appearing to. Nothing
        below is answered while the feature is off for this character, and
        somebody who granted `@health` and watched nothing happen would
        reasonably call the gate broken.
      */}
      {remotes.enabled ? null : (
        <p className="settings-warn">{t('cards.player.access.offWarning')}</p>
      )}

      <div
        aria-label={t('cards.player.access.stanceGroupAria', { name: record.name })}
        role="group"
      >
        <RemoteList
          allow={grant.allow}
          deny={grant.deny}
          fromGang={inGang === true ? remotes.gang : []}
          fromParty={inParty ? remotes.party : []}
          mode="player"
          onSet={(remote, stance) =>
            set({
              allow:
                stance === 'allow'
                  ? [...grant.allow, remote]
                  : grant.allow.filter((entry) => entry !== remote),
              deny:
                stance === 'deny'
                  ? [...grant.deny, remote]
                  : grant.deny.filter((entry) => entry !== remote)
            })
          }
          onSetAll={(stance) =>
            // Clear takes the denies with it: a "clear all" that left half the
            // state behind is a mode, and this grid has no room for one.
            set(
              stance === 'allow'
                ? { allow: [...ACTIONABLE_REMOTES], deny: [] }
                : { allow: [], deny: [] }
            )
          }
          returnFocus={returnFocus}
          subject={record.name}
        />
      </div>
    </div>
  );
}
