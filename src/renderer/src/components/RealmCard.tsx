import { memo, useMemo } from 'react';

import { t } from '../lib/i18n';
import { PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import type { Facet } from './ListTools';
import Dot from './viz/Dot';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import type { VizTone } from './viz/tones';
import { isHostile, type Adventurer } from '@shared/character';
import { playerKey } from '@shared/players';
import type { SessionId } from '@shared/ipc';

/*
 * The three slices the card reads, never the character: a status line replaces
 * the character, and the roster would be sorted and its table redrawn for it
 * (todo 744). `online` holds still between equal listings (`keepRoster`).
 */
export interface RealmCardProps extends CardChrome {
  /** The roster, as the realm listed it. */
  online: readonly Adventurer[];
  /** This character's own name, whose row is not a control. */
  self: string | null;
  /** Whether the character is in the realm, which decides what an empty roster says. */
  inGame: boolean;
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
/** The four groups, in the bar's order: worst first, unknown next to it. */
const STANDING_IDS = ['hostile', 'unknown', 'neutral', 'lawful'] as const;
type Standing = (typeof STANDING_IDS)[number];

const STANDING_LABEL: Record<Standing, string> = {
  hostile: t('cards.realm.facet.hostile'),
  neutral: t('cards.realm.facet.neutral'),
  lawful: t('cards.realm.facet.lawful'),
  unknown: t('cards.realm.facet.unknown')
};

const STANDINGS: readonly Facet[] = [
  { id: 'hostile', label: STANDING_LABEL.hostile, level: 'critical' },
  { id: 'neutral', label: STANDING_LABEL.neutral },
  { id: 'lawful', label: STANDING_LABEL.lawful },
  { id: 'unknown', label: STANDING_LABEL.unknown, level: 'warning' }
];

/*
 * Each group's hue on the dot and the bar: the danger hue for hostile, the
 * pending hue for unknown (neither safe nor an alarm), quiet for neutral.
 */
const TONE: Record<Standing, VizTone> = {
  hostile: 'bad',
  unknown: 'warn',
  neutral: 'quiet',
  lawful: 'ok'
};

/** What a name with no title yet says in the Title column, in one place. */
const JUST_ARRIVED = t('cards.realm.justArrived');

function standing(entry: Adventurer): Standing {
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

/** The roster cut into the four groups, as the bar over the table draws it. */
function standingParts(roster: readonly Adventurer[]): SplitPart[] {
  const counts = new Map<Standing, number>();
  for (const entry of roster) counts.set(standing(entry), (counts.get(standing(entry)) ?? 0) + 1);
  return STANDING_IDS.map((id) => ({
    key: id,
    label: STANDING_LABEL[id],
    value: counts.get(id) ?? 0,
    tone: TONE[id]
  }));
}

interface GangCount {
  gang: string;
  count: number;
  /** Whether anybody listed in it is hostile, which tints its chip. */
  hostile: boolean;
}

/** The gangs the roster names, the largest first. */
function gangsOf(roster: readonly Adventurer[]): GangCount[] {
  const gangs = new Map<string, GangCount>();
  for (const entry of roster) {
    if (entry.gang === null) continue;
    const known = gangs.get(entry.gang) ?? { gang: entry.gang, count: 0, hostile: false };
    gangs.set(entry.gang, {
      ...known,
      count: known.count + 1,
      hostile: known.hostile || isHostile(entry.alignment)
    });
  }
  return [...gangs.values()].sort((a, b) => b.count - a.count || a.gang.localeCompare(b.gang));
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
function RealmCard({
  online,
  self: name,
  inGame,
  session,
  subject,
  onSelect,
  ...chrome
}: RealmCardProps) {
  const roster = useMemo(() => [...online].sort(order), [online]);
  const hostile = roster.filter((entry) => isHostile(entry.alignment)).length;
  const parts = useMemo(() => standingParts(roster), [roster]);
  const gangs = useMemo(() => gangsOf(roster), [roster]);
  /* The `who` listing includes the character reading it. See the name column. */
  const self = name === null ? null : playerKey(name);

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
      cell: (entry) => {
        /* The standing is a word, never only a hue: §6, and this is the card
           where that matters most. A narrow card draws the dot and keeps the
           word for hover and for anything reading aloud. */
        const word = entry.alignment ?? t('cards.realm.facet.unknown');
        return (
          <span className="realm-align">
            <Dot label={word} tone={TONE[standing(entry)]} />
            <span className="realm-align-word">{word}</span>
          </span>
        );
      }
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
    },
    {
      id: 'gang',
      label: t('cards.realm.column.gang'),
      from: 'large',
      value: (entry) => entry.gang,
      cell: (entry) =>
        entry.gang === null ? null : <span className="realm-gang">{entry.gang}</span>
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
        The standings as one bar, worst first, over the table: how much of the
        realm is hostile before a single row is read. Large adds what each
        colour is and the gangs present, sized by how many of each are on.
      */}
      {roster.length === 0 ? null : (
        <div className="realm-summary">
          <SplitBar label={t('cards.realm.summaryLabel')} parts={parts} />
          {gangs.length === 0 ? null : (
            <ul aria-label={t('cards.realm.gangsLabel')} className="realm-gangs from-large">
              {gangs.map((entry) => (
                <li
                  className="chip"
                  data-hostile={entry.hostile ? 'true' : undefined}
                  key={entry.gang}
                >
                  {entry.gang}
                  <b>{entry.count}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/*
        A busy realm lists forty people and the one being asked about is a name
        somebody has just been told over telepath. Finding it by eye down a
        scrolling list is the thing this card was worst at.
      */}
      <CardTable
        caption={t('cards.realm.caption')}
        className="realm-list"
        columns={columns}
        empty={inGame ? t('cards.realm.emptyInGame') : t('cards.realm.emptyOffline')}
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
