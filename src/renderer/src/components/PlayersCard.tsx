import { memo, useMemo } from 'react';

import { t } from '../lib/i18n';
import { ago, place, PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column, type Facet } from './CardTable';
import type { CharacterState } from '@shared/character';
import { knownPlayers, playerKey, type PlayerRecord } from '@shared/players';
import type { SessionId } from '@shared/ipc';

export interface PlayersCardProps extends CardChrome {
  character: CharacterState;
  /** Which character's knowledge this is, so its filters and sort are remembered per character. */
  session: SessionId;
  /** The name the Player flyout is about, lower-cased, so this row can say so. */
  subject: string | null;
  /** A name clicked, and where: the Player flyout slides out beside this card. */
  onSelect(name: string, anchor: PopoverAnchor): void;
}

/**
 * The four groups the listing can be cut into, and they are about **reach, not
 * standing**.
 *
 * The Realm card already cuts by alignment; repeating that here would be the
 * same question asked twice, and the rule is one filtering dimension per table.
 * The question this card exists for is different — *who can talk to this
 * character, and who has been trying* — so the chips answer that.
 */
const GROUPS: readonly Facet[] = [
  { id: 'here', label: t('cards.players.facet.here') },
  { id: 'party', label: t('cards.player.chip.party') },
  { id: 'asking', label: t('cards.players.facet.asking'), level: 'warning' },
  { id: 'gone', label: t('cards.players.facet.gone') }
];

/*
 * `gone` is labelled *offline* — not in the realm now — rather than a claim
 * that they left: the registry is seeded from the realm's book, so somebody in
 * it may never have crossed this character's path at all.
 */
function groupOf(record: PlayerRecord): string {
  if (record.commandsSent > 0) return 'asking';
  if (record.inParty) return 'party';
  return record.online ? 'here' : 'gone';
}

/**
 * Everyone any character on this realm has seen, and who is here now.
 *
 * The sibling of the Realm card, and the difference between them is the
 * *question*, not the population. Realm is the listing the server maintains,
 * cut by what the realm thinks of somebody — who is dangerous. This is what
 * every character on the realm has accumulated — kept after somebody walks
 * out, shared between characters and across restarts (`PlayerBook`) — cut by
 * reach: who can talk to this character, and who has been trying. Two cards
 * rather than two faces of one because a table takes one filtering dimension,
 * and because both are read at once by somebody deciding whether to stay.
 *
 * ## What it does not do
 *
 * It asks the server for nothing. Every fact here arrived on a broadcast, a
 * listing or a room some character on this realm was in anyway; a card that
 * sent `who` to fill itself in would spend from the budget walking and
 * fighting spend from, once per glance.
 *
 * ## A name is a control
 *
 * Clicking one slides the Player flyout out on that person, which is where the
 * numbers, the last sighting and the `@` gate live. The listing carries no
 * detail of its own beyond the three columns, deliberately: this card answers
 * *who*, and the card it opens answers *what about them*.
 */
function PlayersCard({ character, session, subject, onSelect, ...chrome }: PlayersCardProps) {
  const players = useMemo(() => knownPlayers(character.players), [character.players]);
  const now = character.updatedAt ?? 0;
  const asking = players.filter((record) => record.commandsSent > 0).length;

  /*
   * The badge reports the actionable number. Somebody trying to drive this
   * character is worth a glance; a count of everybody ever seen is trivia, and
   * the table's own `12 of 40` line already states the total when it matters.
   */
  const badge =
    asking > 0 ? (
      <span className="chip warn">{t('cards.players.badge.asking', { asking })}</span>
    ) : (
      <span className="chip off">{t('cards.players.badge.known', { count: players.length })}</span>
    );

  const columns: Column<PlayerRecord>[] = [
    {
      id: 'name',
      label: t('cards.realm.column.name'),
      wide: true,
      value: (record) => record.name,
      /*
       * The name is the control that selects somebody, following the Room and
       * Carrying cards — the shared `PlayerName` cell, so this listing and the
       * Realm card's cannot drift apart.
       */
      cell: (record) => (
        <PlayerName
          className="player-name"
          name={record.name}
          offline={!record.online}
          onSelect={onSelect}
        />
      )
    },
    {
      id: 'where',
      label: t('cards.player.detail.where'),
      value: (record) => record.lastRoomName ?? record.lastRoom,
      cell: (record) => <span className="player-where">{place(record)}</span>
    },
    {
      id: 'seen',
      /*
       * When they were last seen **in a room**, which is what the column
       * beside it is the answer to — not `lastSeen`, which moves for a
       * telepath, a `who` and a party listing alike.
       *
       * The two were the same column for a while and the pairing was a lie a
       * reader acts on: `Rand — not seen in a room — 1m ago` says in one row
       * that this client has never placed him and that it placed him a minute
       * ago. The flyout has always kept the two apart (`Last online` over
       * `Last seen`); this is the listing catching up with it.
       *
       * Sorted by the timestamp and shown as the phrase: sorting by "just now"
       * alphabetically would put an hour ago above a second ago. A record with
       * no room sighting at all sorts as the oldest thing there is rather than
       * as the newest, which is what a bare `?? 0` would do only by luck — it
       * is said here on purpose.
       */
      label: t('cards.players.column.seen'),
      value: (record) => record.lastRoomAt ?? 0,
      cell: (record) =>
        record.lastRoomAt === null ? (
          <span className="player-seen quiet-note">{t('cards.player.neverInRoom')}</span>
        ) : (
          <span className="player-seen">{ago(record.lastRoomAt, now)}</span>
        )
    }
  ];

  return (
    <BentoCard
      {...chrome}
      badge={badge}
      className="players-card"
      paned
      title={t('cards.players.title')}
    >
      <CardTable
        caption={t('cards.players.caption')}
        className="player-list"
        columns={columns}
        empty={
          character.phase === 'in-game'
            ? t('cards.players.emptyInGame')
            : t('cards.realm.emptyOffline')
        }
        facetOf={groupOf}
        facets={GROUPS}
        find={t('cards.realm.findPlaceholder')}
        keyOf={(record) => record.name}
        name="players"
        returnFocus={chrome.returnFocus}
        rowAttrs={(record) => ({
          'data-selected': playerKey(record.name) === subject ? 'true' : undefined,
          'data-offline': record.online ? undefined : 'true'
        })}
        rows={players}
        session={session}
      />
    </BentoCard>
  );
}

export default memo(PlayersCard);
