import { useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';

import PopupMenu from './PopupMenu';
import PopoverHead, { PopoverSizer } from './PopoverHead';
import { useCopyMenu } from '../hooks/useCopyMenu';
import { usePopoverFrame } from '../hooks/usePopoverFrame';
import { membersOf, type Member } from '../lib/gangs';
import { t } from '../lib/i18n';
import { PlayerName } from '../lib/players';
import { type PopoverAnchor } from '../lib/popover';
import { ownGang, type CharacterState } from '@shared/character';
import type { SessionId } from '@shared/ipc';
import { playerKey } from '@shared/players';

/**
 * A gang somebody clicked, whose character's console or listing it was, and
 * where on screen the click landed.
 *
 * Built fresh per click, like `PlayerAsked` and for the same reason: effects
 * key on the object, so the same gang clicked twice still re-opens where a bare
 * string would compare equal.
 */
export interface GangAsked {
  session: SessionId;
  name: string;
  anchor: PopoverAnchor;
}

export interface GangFlyoutProps {
  asked: GangAsked;
  /** The character whose console or listing was clicked — not necessarily the shown one. */
  character: CharacterState;
  /** A member's name clicked: the Player flyout on them, replacing this. */
  onSelectPlayer(session: SessionId, name: string, anchor: PopoverAnchor): void;
  onDismiss(): void;
  /** Hands the caret back to the game after a menu that took it. */
  returnFocus(): void;
}

/**
 * One gang, and who is known to be in it.
 *
 * ## An entity, like a person and an item
 *
 * A `who` listing prints a gang in its own column, and it was the one
 * recognisable thing on that line that could not be clicked: the item, the
 * monster, the spell and the person beside it all opened something. This is
 * that gap closed, and it is a **flyout** rather than a card for the reason
 * `PlayerFlyout` is one — the rail is the player's arrangement of what they
 * watch, and a clicked name is a question asked right now. It shares the
 * placement, the dismissal and the whole `.popover` frame with the two panels
 * that were already there, so a third slide-out cannot come out a different
 * shape from the first two.
 *
 * ## An entity carries through
 *
 * A gang is made of people, and every one of them is an entity too — so each
 * member's name is a `PlayerName`, and clicking it opens the Player flyout on
 * them, exactly as clicking a name in the Realm listing does. One panel at a
 * time, so this one goes as that one arrives: two panels hanging off two names
 * is two things to put away and no way to say which Escape means.
 *
 * ## The Gang card is not this, and the difference is whose gang it is
 *
 * `GangCard` is **this character's own** gang, and it carries the thing that
 * only makes sense for that one: the permission grid, because
 * `automation.remotes.gang` means *whichever gang this character is in*. A gang
 * somebody clicked in a listing is usually not that gang, and it has no grant
 * to show — so this states what is known about it and says, where they are the
 * same gang, that the card is where the permissions live. The membership
 * itself comes from `lib/gangs.ts`, which both read, so the card and the panel
 * cannot disagree about who is in a gang.
 *
 * ## What it does not do
 *
 * It asks the server for nothing. `bg` with an argument **broadcasts that text
 * to the whole gang**, and there is no command that lists another gang's
 * membership at all — so everything here arrived on a `who` row or a look this
 * character made anyway, and the panel says which of the two it is showing
 * rather than implying a listing it could never have.
 */
export default function GangFlyout({
  asked,
  character,
  onSelectPlayer,
  onDismiss,
  returnFocus
}: GangFlyoutProps) {
  const copy = useCopyMenu();

  const members = useMemo(() => membersOf(character, asked.name), [character, asked.name]);
  const online = members.filter((row) => row.online).length;
  /* Whether any of it came from a `bg` listing rather than from `who` alone. */
  const listed = members.some((row) => !row.rosterOnly);

  /*
   * Whether this is the character's own gang.
   *
   * Three answers, not two, exactly as the Player flyout's `inGang` is:
   * `undefined` means nothing has said yet, and an unknown membership must
   * never draw as "not this one" — the reader's next action differs.
   */
  const own = ownGang(character);
  const isOwn =
    own === undefined ? null : own !== null && own.toLowerCase() === asked.name.toLowerCase();

  /*
   * Where it sits, how wide it is, and everything it does to itself. One hook,
   * shared with the Player flyout and the Reference popover, because the three
   * are one panel drawing three things — and had already grown three copies of
   * this that differed in two places.
   *
   * Escape hands the caret back here and a click-away does not, because a
   * click has already put it somewhere.
   */
  const escape = useCallback(() => {
    onDismiss();
    returnFocus();
  }, [onDismiss, returnFocus]);
  const frame = usePopoverFrame({
    anchor: asked.anchor,
    measure: [members],
    menuOpen: copy.menu !== null,
    onDismiss,
    onEscape: escape
  });

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

  return createPortal(
    <div
      aria-label={t('cards.gangDetail.ariaLabel', { gang: asked.name })}
      className="surface popover gang-flyout"
      onContextMenu={copy.onContextMenu}
      role="dialog"
      {...frame.props}
    >
      <PopoverHead
        onClose={onDismiss}
        onGrab={frame.onGrab}
        onPin={frame.togglePin}
        pinned={frame.pinned}
      >
        <span className="crumbs">
          <span className="crumb" data-active="true">
            {t('cards.gangDetail.title')}
          </span>
        </span>
      </PopoverHead>

      {/* The heading stays put; everything under it is what scrolls. */}
      <div className="popover-body">
        <dl className="readout gang-detail">
          <dt>{t('cards.gangDetail.name')}</dt>
          <dd>
            {asked.name}
            {isOwn === true ? (
              <span className="chip on">{t('cards.gangDetail.chip.own')}</span>
            ) : null}
          </dd>

          <dt>{t('cards.gangDetail.known')}</dt>
          <dd>
            {members.length === 0
              ? t('cards.gangDetail.noneKnown')
              : t('cards.gangDetail.count', { count: members.length, online })}
          </dd>
        </dl>

        {members.length === 0 ? (
          /*
           * Nothing known is not "nobody in it". No command lists another gang's
           * membership, so an empty panel is this client's own ignorance and says
           * so — drawn as an empty gang it would be a claim the wire never made.
           */
          <p className="empty">{t('cards.gangDetail.emptyHint', { gang: asked.name })}</p>
        ) : (
          <ul className="gang-members">
            {members.map((row) => (
              <li key={playerKey(row.name)} data-online={row.online ? 'true' : 'false'}>
                <MemberRow
                  onSelect={(name, anchor) => onSelectPlayer(asked.session, name, anchor)}
                  row={row}
                />
              </li>
            ))}
          </ul>
        )}

        {/*
        Where the facts came from. `who` knows who is *online* and in a gang and
        nothing else; `bg` — which only ever answers for this character's own
        gang — carries the level, the race, the class and the members who are
        not logged in. A panel that did not say which it was showing would read
        as a complete membership either way.
      */}
        <p className="quiet-note gang-source">
          {listed ? t('cards.gangDetail.fromListing') : t('cards.gangDetail.fromRoster')}
        </p>

        {isOwn === true && <p className="quiet-note">{t('cards.gangDetail.ownHint')}</p>}
      </div>

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
      <PopoverSizer onReset={frame.onSizeReset} onSize={frame.onSize} />
    </div>,
    document.body
  );
}

/**
 * One member: the leader's mark, the name as a control, and what is known.
 *
 * This character's own name stays text — the listings' rule, because its card
 * is the rail and a flyout about yourself opens on an empty registry entry.
 */
function MemberRow({
  row,
  onSelect
}: {
  row: Member;
  onSelect(name: string, anchor: PopoverAnchor): void;
}) {
  const detail = [
    row.level === null ? null : t('cards.gang.levelShort', { level: row.level }),
    row.race,
    row.className
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');

  return (
    <>
      {row.rank === null ? null : (
        <span className="gang-rank" title={t('cards.gang.rankTooltip', { rank: row.rank })}>
          {row.rank === 'Leader' ? '★' : '☆'}
        </span>
      )}
      {row.self ? (
        <span className="name">{row.name}</span>
      ) : (
        <PlayerName
          className="name"
          name={row.name}
          offline={!row.online}
          onSelect={onSelect}
          self={false}
        />
      )}
      {detail.length > 0 && <span className="quiet-note gang-member-detail">{detail}</span>}
      {row.online ? null : <span className="chip off">{t('cards.gang.offline')}</span>}
    </>
  );
}
