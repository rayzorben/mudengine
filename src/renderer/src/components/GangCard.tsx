import { memo, useMemo } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import RemoteList from './RemoteList';
import { t } from '../lib/i18n';
import { membersOf, type Member } from '../lib/gangs';
import { PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { ownGang, type CharacterState } from '@shared/character';
import { playerKey } from '@shared/players';
import type { RemotesConfig } from '@shared/config';
import type { SessionId } from '@shared/ipc';
import { ACTIONABLE_REMOTES, type RemoteName, type RemoteStance } from '@shared/remotes';

export interface GangCardProps extends CardChrome {
  character: CharacterState;
  /** Which character's table this is, so its sort is remembered per character. */
  session: SessionId;
  /** This character's resolved `automation.remotes`. */
  remotes: RemotesConfig;
  /**
   * The gang's whole list, written to the character's own options file.
   *
   * The whole list rather than one remote at a time, because *Allow all* is one
   * press: twenty writes would be twenty rewrites of the same YAML racing each
   * other, and the last to land would win.
   */
  onSetGangRemotes(remotes: RemoteName[]): void;
  /** Whether the gangpath is answered on at all. */
  onSetGangpath(on: boolean): void;
  /** A member's name clicked: the Player flyout on them, beside the row. */
  onSelect?(name: string, anchor: PopoverAnchor): void;
  /** Whoever the flyout is about, as `playerKey` files them, so the row is marked. */
  subject?: string | null;
  /**
   * Sends a command as though typed. Only `bg`, and only from the button — see
   * the listing note on the card for why this is asked for rather than polled.
   */
  ask?(command: string): void;
}

/**
 * The gang, and what anybody in it may ask this character for.
 *
 * ## Why a card and not a settings page
 *
 * The gang list is the one permission whose *subject* the client learns from
 * the wire rather than from a form. Which gang this character is in comes off
 * the `who` listing; who else is in it comes off the same listing; and both
 * change while somebody is playing. A screen you have to leave the game to open
 * cannot state any of that, and the list would read as an abstract set of
 * checkboxes with nothing saying who it currently applies to.
 *
 * So the card carries three things that belong together: **which gang**, **who
 * is in it right now**, and **what they may ask for**. The same list is also on
 * the settings screen, through the same component, for a character that is not
 * connected — a permission reachable only while logged in is one you cannot set
 * up in advance.
 *
 * ## Two faces: who they are, then what they may do
 *
 * The permission grid used to sit under the member list on one face, which put
 * fifty-seven rows of controls between the reader and the question the card is
 * usually opened for — *who is in my gang, and are they on*. They are two
 * questions asked at different times: membership is watched while playing, and
 * permissions are set once and revisited rarely. So `MEMBERS` is the card and
 * `REMOTES` is the second face, which is also the order the card is read in.
 *
 * ## Where the members come from, and why there is a button
 *
 * **`who` cannot answer this.** Its row carries a name, a *rank title*, an
 * alignment and a gang — no level, no race, no class — and the rank title is
 * not the class: one capture has a character whose `who` row reads `Monk` and
 * whose description reads `Mystic`, and `Monk` is not a class the realm data
 * contains at all. `who` also lists who is *logged in*, so a gang member who is
 * not has no row in it and there is no absence to notice.
 *
 * `bg` with no argument answers all of it — the whole membership, each row
 * marked online or not, with a level, a race, a class and the leader's mark.
 * That is the listing this card is built on.
 *
 * It is **asked for, never polled.** A gang's membership changes on the scale
 * of days, so a poll would spend from the command budget walking and fighting
 * spend from to re-learn something that has not changed. And the command is
 * sharp: `bg <anything>` broadcasts that text to the entire gang, so the bare
 * form is the one this client sends and it sends it only when somebody presses
 * the button.
 *
 * Until it is pressed the table falls back to the roster, which knows who is
 * *online* and in this gang and nothing else — so the level, race and class
 * columns are honestly blank rather than absent, and the card says which of the
 * two it is showing.
 *
 * ## One list, and the consequence is said out loud
 *
 * `automation.remotes.gang` is a single list meaning *whichever gang this
 * character is in*, not a map keyed by gang name. A character is in one gang at
 * a time and this card shows that gang, so a second key would be a distinction
 * the surface cannot make. The cost is real and is therefore printed on the
 * card rather than buried: leave this gang for another and the new one inherits
 * the list.
 *
 * ## Unknown is not "no gang"
 *
 * `ownGang` returns `undefined` while nothing has said, `null` for a row a
 * listing wrote in full with no gang on it, and a name otherwise. The card
 * states all three differently, because they need different actions from the
 * reader: type `who`, there is nothing to configure, or here is the list. A
 * card that drew an unknown gang as "no gang" would be telling somebody their
 * grant is inert when it may be live the moment a listing arrives.
 */
function GangCard({
  character,
  session,
  remotes,
  onSetGangRemotes,
  onSetGangpath,
  onSelect,
  subject,
  ask,
  ...chrome
}: GangCardProps) {
  const gang = ownGang(character);

  /*
   * Everybody in this gang. The assembly is `lib/gangs.ts` rather than here,
   * because the same question is asked of *another* gang the moment one is
   * clicked in the console — and two copies of it would have the card and the
   * flyout disagreeing about who is in a gang.
   */
  const members = useMemo<Member[]>(
    () => (gang === undefined || gang === null ? [] : membersOf(character, gang)),
    [character, gang]
  );

  /* Whether anything here came from a `bg` listing, which is what the level,
     race and class columns are filled from. Drives the note under the table. */
  const listed = members.some((row) => !row.rosterOnly);
  const online = members.filter((row) => row.online).length;

  const granted = remotes.gang.length;
  const badge =
    granted > 0 ? (
      <span className="chip on">{t('cards.gang.badge.allowed', { count: granted })}</span>
    ) : (
      <span className="chip off">{t('cards.gang.badge.none')}</span>
    );

  const columns: ReadonlyArray<Column<Member>> = [
    {
      id: 'name',
      label: t('cards.realm.column.name'),
      wide: true,
      value: (row) => row.name,
      cell: (row) => (
        <>
          {/* The leader's mark, before the name, so the column still starts in
              one place: a star drawn after a name of variable length is a mark
              nobody can scan down. Titled, because a glyph states nothing on
              its own — §6 forbids saying anything by appearance alone. */}
          {row.rank === null ? null : (
            <span className="gang-rank" title={t('cards.gang.rankTooltip', { rank: row.rank })}>
              {row.rank === 'Leader' ? '★' : '☆'}
            </span>
          )}
          {/* This character's own name stays text: its card is the rail, and a
              flyout about yourself would open on an empty registry entry — the
              listings' own rule, applied here now that the row is drawn. */}
          {onSelect && !row.self ? (
            <PlayerName className="name" name={row.name} onSelect={onSelect} self={false} />
          ) : (
            row.name
          )}
        </>
      )
    },
    {
      id: 'level',
      label: t('cards.gang.column.level'),
      numeric: true,
      value: (row) => row.level,
      cell: (row) => (row.level === null ? <span className="quiet-note">—</span> : row.level)
    },
    {
      id: 'race',
      label: t('cards.gang.column.race'),
      value: (row) => row.race,
      cell: (row) => row.race ?? <span className="quiet-note">—</span>
    },
    {
      id: 'class',
      label: t('cards.gang.column.class'),
      value: (row) => row.className,
      cell: (row) => row.className ?? <span className="quiet-note">—</span>
    },
    {
      id: 'online',
      label: t('cards.gang.column.online'),
      /* Sorted by the word, so pointing the column puts one group together
         rather than interleaving them; the card's own order already leads with
         the online half. */
      value: (row) => (row.online ? t('cards.gang.online') : t('cards.gang.offline')),
      cell: (row) =>
        row.online ? (
          <span className="chip on">{t('cards.gang.online')}</span>
        ) : (
          <span className="chip off">{t('cards.gang.offline')}</span>
        )
    }
  ];

  const membersFace = (
    <>
      <dl className="readout gang-head">
        <dt>{t('cards.gang.title')}</dt>
        <dd>{gang === undefined ? <span className="quiet-note">—</span> : (gang ?? '—')}</dd>
      </dl>

      {/*
        Said before the list, in the order somebody reads: whether anything the
        other face grants can take effect at all, then whether this character is
        in a gang for any of it to apply to.
      */}
      {!remotes.enabled ? <p className="settings-warn">{t('cards.gang.offWarning')}</p> : null}
      {gang === undefined ? (
        <p className="settings-warn">{t('cards.gang.unknownGang')}</p>
      ) : gang === null ? (
        <p className="settings-warn">{t('cards.gang.noGang')}</p>
      ) : null}

      {/*
        Which listing the table is drawn from, because the two answer different
        questions and the columns look identical either way. Without the button
        pressed this is who is *online* in the gang; with it, the membership.
      */}
      {gang === undefined || gang === null ? null : (
        <p className="settings-note">
          {listed
            ? t('cards.gang.fromListing', { online, total: members.length })
            : t('cards.gang.fromRoster')}
        </p>
      )}

      {/*
        A listing that lost a row says so. The server's own count and the rows
        it printed are the same number by construction, so a gap is a row this
        client could not read — and a table quietly one member short is the
        silent shrink the party roster already has scar tissue from. Said out
        loud rather than swallowed, which is what this project asks of anything
        that declines.
      */}
      {character.gangListing?.short == null ? null : (
        <p className="settings-warn">
          {t('cards.gang.shortListing', {
            expected: character.gangListing.short,
            read: character.gangListing.expected
          })}
        </p>
      )}

      <CardTable
        caption={t('cards.gang.tableCaption')}
        className="gang-table"
        columns={columns}
        find={t('cards.gang.find')}
        empty={
          gang === undefined || gang === null
            ? t('cards.gang.noGangMembers')
            : t('cards.gang.noMembers', { gang })
        }
        keyOf={(row) => playerKey(row.name)}
        name="gang"
        returnFocus={chrome.returnFocus}
        /* The selection marks the **row**, in the listings' own recipe
           (`tr[data-selected]`), never the name — the rule the Realm and
           Players cards already keep. Set on a span it matched no rule at all,
           so clicking a name opened the flyout and marked nothing. */
        rowAttrs={(row) => ({
          'data-offline': row.online ? undefined : 'true',
          'data-selected': playerKey(row.name) === subject ? 'true' : undefined
        })}
        rows={members}
        session={session}
      />
    </>
  );

  const remotesFace = (
    <>
      {/*
        The switch, above the list it governs. A gang grant that nobody can use
        from the gang's own channel is the "setting somebody changes and then
        waits to see work" failure, so the two are on one face and in that
        order.
      */}
      <label className="gang-gangpath">
        <input
          checked={remotes.gangpath}
          onChange={(event) => onSetGangpath(event.target.checked)}
          type="checkbox"
        />
        <span>{t('cards.gang.gangpathLabel')}</span>
      </label>
      <p className="settings-note">{t('cards.gang.gangpathHint')}</p>

      {!remotes.enabled ? <p className="settings-warn">{t('cards.gang.offWarning')}</p> : null}
      {gang === undefined ? (
        <p className="settings-warn">{t('cards.gang.unknownGang')}</p>
      ) : gang === null ? (
        <p className="settings-warn">{t('cards.gang.noGang')}</p>
      ) : (
        <p className="settings-note">{t('cards.gang.switchWarning', { gang })}</p>
      )}

      <div className="scroller">
        <h4 className="gang-legend">
          {gang === undefined || gang === null
            ? t('cards.gang.legendUnknown')
            : t('cards.gang.legend', { gang })}
        </h4>
        <RemoteList
          allow={remotes.gang}
          mode="gang"
          onSet={(remote: RemoteName, stance: RemoteStance) =>
            onSetGangRemotes(
              stance === 'allow'
                ? [...remotes.gang, remote]
                : remotes.gang.filter((entry) => entry !== remote)
            )
          }
          onSetAll={(stance) => onSetGangRemotes(stance === 'allow' ? [...ACTIONABLE_REMOTES] : [])}
          returnFocus={chrome.returnFocus}
          subject={gang ?? t('cards.gang.legendUnknown')}
        />
      </div>
    </>
  );

  /* Each face copies what it shows: the members, or the grant. Copying the
     grant while the table is on screen would put something the reader cannot
     see on the clipboard, which is the one thing the copy rule forbids. */
  const tabs: CardTab[] = [
    {
      id: 'members',
      label: t('cards.gang.title'),
      content: membersFace,
      paned: true,
      copyText: () =>
        members.length === 0
          ? '—'
          : members
              .map((row) =>
                [
                  row.rank === null ? '' : `[${row.rank}] `,
                  row.name,
                  row.level === null ? '' : ` ${row.level}`,
                  row.race === null ? '' : ` ${row.race}`,
                  row.className === null ? '' : ` ${row.className}`,
                  row.online ? ` — ${t('cards.gang.online')}` : ` — ${t('cards.gang.offline')}`
                ].join('')
              )
              .join('\n')
    },
    {
      id: 'remotes',
      label: t('cards.gang.tabRemotes'),
      content: remotesFace,
      paned: true,
      copyText: () =>
        `${gang === undefined ? '?' : (gang ?? '—')}: ${
          remotes.gang.map((name) => `@${name}`).join(', ') || '—'
        }`
    }
  ];

  return (
    <BentoCard
      {...chrome}
      actions={
        /*
         * Only while in-game and only while there is a gang to ask about:
         * `bg` is refused outright by the server for a gangless character, so
         * offering it would be a button whose only outcome is a refusal.
         */
        ask && character.phase === 'in-game' && gang !== undefined && gang !== null
          ? [
              {
                id: 'bg',
                label: t('cards.gang.actions.askMembersTooltip'),
                icon: 'users',
                run: () => ask('bg')
              }
            ]
          : undefined
      }
      badge={badge}
      tabs={tabs}
      title={t('cards.gang.title')}
    />
  );
}

/** What a `bg` listing established about somebody, as a row. */

export default memo(GangCard);
