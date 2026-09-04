import { memo, useMemo } from 'react';

import { t } from '../lib/i18n';
import { PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column, type Facet } from './CardTable';
import { isHostile, type Adventurer, type CharacterState } from '@shared/character';
import { playerKey } from '@shared/players';
import type { SessionId } from '@shared/ipc';

export interface RealmCardProps extends CardChrome {
  character: CharacterState;
  /** Which character's roster this is, so its filters and its sort are remembered per character. */
  session: SessionId;
  /** The name the Player flyout is about, lower-cased, so this row can say so. */
  subject: string | null;
  /** A name clicked, and where: the Player flyout slides out beside this card. */
  onSelect(name: string, anchor: PopoverAnchor): void;
}

/**
 * Worst first.
 *
 * The card is read at a glance and usually only the top of it: whoever the
 * realm thinks least of belongs where the eye lands. Within a rank, by name, so
 * the order is stable between listings and somebody does not appear to move
 * because a title changed.
 */
const RANK: Record<string, number> = {
  FIEND: 0,
  Villain: 1,
  Criminal: 2,
  Outlaw: 3,
  Seedy: 4,
  Neutral: 5,
  Lawful: 6,
  Good: 7,
  Saint: 8
};

/**
 * The four groups the roster can be cut into.
 *
 * Not the nine standings: a chip per standing would be nine controls on a card
 * 260px wide, and eight of them answer a question nobody asks. The question
 * this card exists for is who is dangerous, and these are its answers — with
 * `unknown` a group of its own because somebody who has walked in since the
 * last listing is a name and nothing else, and that is neither safe nor
 * hostile.
 *
 * The standing itself stays in the first column, in the realm's own word, so
 * grouping them costs no detail.
 */
const STANDINGS: readonly Facet[] = [
  { id: 'hostile', label: t('cards.realm.facet.hostile'), level: 'critical' },
  { id: 'neutral', label: t('cards.realm.facet.neutral') },
  { id: 'lawful', label: t('cards.realm.facet.lawful') },
  { id: 'unknown', label: t('cards.realm.facet.unknown'), level: 'warning' }
];

/** What a name with no title yet says in the Title column, in one place. */
const JUST_ARRIVED = t('cards.realm.justArrived');

function standing(entry: Adventurer): string {
  if (entry.alignment === null) return 'unknown';
  if (isHostile(entry.alignment)) return 'hostile';
  return entry.alignment === 'Lawful' || entry.alignment === 'Good' || entry.alignment === 'Saint'
    ? 'lawful'
    : 'neutral';
}

// Unknown sits between the hostile and the harmless: it is not a reason to
// relax, and not a reason to sound an alarm either. Stated once so the card's
// own order and the sortable Standing column cannot drift apart.
function rankOf(alignment: Adventurer['alignment']): number {
  return alignment === null ? 4.5 : (RANK[alignment] ?? 4.5);
}

function order(a: Adventurer, b: Adventurer): number {
  const difference = rankOf(a.alignment) - rankOf(b.alignment);
  return difference !== 0 ? difference : a.name.localeCompare(b.name);
}

/**
 * Who else is in the realm.
 *
 * The `who` listing was parsed into `CharacterState` three phases ago and
 * nothing ever showed it — and what it kept was only the names, which is the
 * wrong half. On a PvP realm the fact that matters about somebody is what the
 * realm thinks of them, and the listing states it.
 *
 * Nothing here asks the server for anything. A listing seeds the roster and the
 * arrival and departure broadcasts maintain it, which cost nothing because the
 * server volunteers them; re-asking would spend from the same command budget
 * that walking and fighting spend from.
 *
 * **Unknown is not safe.** Somebody who has walked in since the last listing is
 * a name and nothing else, and this says so rather than filling in a guess —
 * the guess that gets somebody killed here is the reassuring one. It used to
 * add a line asking the player to type `who`; the client asks for itself now
 * — Routines.onRosterUnknown queues one for the next idle tick, coalescing a
 * whole room's worth of arrivals into the single `who` that resolves all of
 * them — so a hint that duplicated what was about to happen on its own was one
 * more thing to read.
 *
 * The listing itself is maintained for free: `player-enters` appends,
 * `player-exits` and `player-disconnects` remove (`CharacterTracker`), and a
 * `who` replaces the lot. A name is a control — clicking one opens the Player
 * card on that person, which is where anything beyond the three columns here
 * lives.
 */
function RealmCard({ character, session, subject, onSelect, ...chrome }: RealmCardProps) {
  const roster = useMemo(() => [...character.online].sort(order), [character.online]);
  const hostile = roster.filter((entry) => isHostile(entry.alignment)).length;
  /* The `who` listing includes the character reading it. See the name column. */
  const self = character.name === null ? null : playerKey(character.name);

  /*
   * The badge reports the actionable number, not the total. "Two hostile" is
   * something a person does something about; "eleven online" is trivia.
   */
  const badge =
    hostile > 0 ? (
      <span className="chip bad">{t('cards.realm.badge.hostile', { hostile })}</span>
    ) : (
      <span className="chip off">{t('cards.realm.badge.online', { count: roster.length })}</span>
    );

  /**
   * Standing first, because that is what the card is for.
   *
   * The rows arrive worst-first and stay that way until somebody points a
   * column somewhere else — a table that could only be sorted would have
   * quietly thrown that order away, and it is the order this card was built
   * around.
   */
  const columns: Column<Adventurer>[] = [
    {
      id: 'standing',
      label: t('cards.realm.column.standing'),
      // Sorted by the realm's own ranking rather than alphabetically: `FIEND`
      // before `Good` is the order that means something here, and A-to-Z would
      // put `Criminal` next to `Good` and call it a sort.
      value: (entry) => rankOf(entry.alignment),
      cell: (entry) => (
        /* The standing is a word, never only a hue: §6, and this is the card
           where that matters most. */
        <span className="realm-align">{entry.alignment ?? t('cards.realm.facet.unknown')}</span>
      )
    },
    {
      id: 'name',
      label: t('cards.realm.column.name'),
      wide: true,
      value: (entry) => entry.name,
      /*
       * The name is the control that opens the Player flyout on somebody — what
       * this client has accumulated about them, and whether their `@` commands
       * are answered. Every *other* name has a record behind it, because the
       * registry folds the roster whole (`trackPlayers`), so a click here
       * cannot land on nothing.
       *
       * **This character's own row is not a control**, and the same rule is
       * why: `trackPlayers` files everyone the roster lists *except* self, so
       * the Player flyout has nothing to say about the person playing — and a
       * name that looks clickable and opens a card saying "click a name" is
       * worse than one that never offered. The row stays, because the listing
       * is what the server said and leaving a line out of it would be the
       * client editing the roster. The cell itself is the shared `PlayerName`,
       * so this listing and the Players card's cannot drift apart.
       */
      cell: (entry) => (
        <PlayerName
          className="realm-name"
          name={entry.name}
          onSelect={onSelect}
          self={playerKey(entry.name) === self}
        />
      )
    },
    {
      id: 'title',
      label: t('cards.realm.column.title'),
      value: (entry) => entry.title ?? (entry.provisional ? JUST_ARRIVED : null),
      cell: (entry) => (
        <span className="realm-title">
          {entry.title ?? (entry.provisional ? JUST_ARRIVED : '')}
        </span>
      )
    }
  ];

  return (
    <BentoCard
      {...chrome}
      badge={badge}
      className="realm-card"
      paned
      title={t('cards.realm.title')}
    >
      {/*
        A busy realm lists forty people and the one being asked about is a name
        somebody has just been told over telepath. Finding it by eye down a
        scrolling list is the thing this card was worst at.
      */}
      <CardTable
        caption={t('cards.realm.caption')}
        className="realm-list"
        columns={columns}
        empty={
          character.phase === 'in-game'
            ? t('cards.realm.emptyInGame')
            : t('cards.realm.emptyOffline')
        }
        facetOf={standing}
        facets={STANDINGS}
        find={t('cards.realm.findPlaceholder')}
        keyOf={(entry) => entry.name}
        name="realm"
        returnFocus={chrome.returnFocus}
        rowAttrs={(entry) => ({
          'data-hostile': isHostile(entry.alignment) ? 'true' : undefined,
          'data-unknown': entry.alignment === null ? 'true' : undefined,
          'data-selected': playerKey(entry.name) === subject ? 'true' : undefined
        })}
        rows={roster}
        session={session}
      />
    </BentoCard>
  );
}

export default memo(RealmCard);
