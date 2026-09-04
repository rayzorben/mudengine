import type { SupplyList } from './SupplyControls';
import { memo, useEffect, useMemo, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import ReferenceDetail, {
  entryFigure,
  entryKey,
  entryWord,
  flattenLookup,
  type ReferenceEntry
} from './ReferenceDetail';
import { useListNavigation } from '../hooks/useListNavigation';
import type { RealmFamily } from '@shared/character';
import { t } from '../lib/i18n';
import type { WorldLookup } from '@shared/world';

export interface ReferenceCardProps extends CardChrome {
  /** Asks the character's own realm. Two characters may be on two realms. */
  lookup(query: string): Promise<WorldLookup>;
  /** What the realm says this character can do, for the "can I cast it" mark. */
  level: number | null;
  /**
   * Which engine the character is on. Three ability ids mean different things
   * on GreaterMUD and stock, and the ids above 187 exist on one of them only —
   * see `src/shared/abilities.ts`.
   */
  realm?: RealmFamily | null;
  /**
   * Open the route panel on a room, for a shop in an item's `Sold by` row.
   *
   * Null for a character that is not shown — the route panel is the shown
   * one's — which leaves the shops as text rather than as controls that would
   * act on somebody else's character.
   */
  onRoom?: ((map: number, room: number) => void) | null;
  /**
   * Open the realm's answer about a name beside the element clicked — the
   * monsters in an item's `Dropped by` row. Null leaves them as text.
   */
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  /** This character's supplies list and the write. See `ReferenceDetailProps`. */
  supplies?: SupplyList | null;
}

/**
 * What the realm data knows about a name — any name, typed.
 *
 * The reference a player used to keep on paper: health and temper for a
 * monster, damage for a weapon, what armour stops, cost and level for a spell.
 * All of it is in the database the client already ships, and none of it costs
 * a command — the same argument the Shop card makes, one card further.
 *
 * This replaced a Spells card that listed every spell in the realm: a list of
 * two thousand spells answers no question anybody standing in a room has,
 * where "what is this thing in front of me" is the question they are already
 * asking. A name *clicked* on another card no longer lands here — it opens a
 * slide-out beside the name (`ReferencePopover`) and goes away when read; this
 * card is for the name you do not have in front of you. Both draw
 * `ReferenceDetail`, so they cannot disagree.
 *
 * **It reads; it does not act.** Nothing here sends a command: the one
 * control in this client that sends what you did not type is the arbiter,
 * where a decision can be reviewed and cancelled.
 */
function ReferenceCard({
  lookup,
  level,
  realm = null,
  onRoom = null,
  onName = null,
  supplies = null,
  ...chrome
}: ReferenceCardProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<WorldLookup>({
    mobs: [],
    items: [],
    spells: [],
    races: [],
    classes: [],
    classNames: {}
  });
  const [chosen, setChosen] = useState<ReferenceEntry | null>(null);

  /*
   * Debounced, and cancelled on the way out: typing `regenerate` is nine
   * queries otherwise, and a reply that arrives after a later one would put
   * stale rows under a newer query.
   */
  useEffect(() => {
    let live = true;
    const id = window.setTimeout(() => {
      void lookup(query)
        .then((answer) => {
          if (!live) return;
          setFound(answer);
        })
        .catch((error: unknown) => {
          if (!live) return;
          // A failed ask must not leave the previous answer standing: stale
          // rows under a newer query read as the realm's reply to it.
          setFound({ mobs: [], items: [], spells: [], races: [], classes: [], classNames: {} });
          console.error(`[reference] lookup for '${query}' failed:`, error);
        });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [query, lookup]);

  const entries = useMemo(() => flattenLookup(found), [found]);

  const list = useListNavigation({
    items: entries,
    onChoose: (entry) => setChosen(entry),
    // Nowhere to go: the card is not a dialog and does not hold the window.
    // Clearing the query is the useful thing Escape can mean here.
    onCancel: () => {
      setQuery('');
      setChosen(null);
    }
  });

  const empty =
    query.trim().length === 0
      ? t('cards.reference.emptyPrompt')
      : entries.length === 0
        ? t('cards.reference.notFound')
        : null;

  return (
    <BentoCard {...chrome} className="reference-card" paned title={t('cards.reference.title')}>
      <input
        aria-label={t('cards.reference.searchAriaLabel')}
        onChange={(event) => {
          setQuery(event.target.value);
          setChosen(null);
        }}
        onKeyDown={list.onKeyDown}
        placeholder={t('cards.reference.searchPlaceholder')}
        value={query}
      />

      <div className="scroller">
        {chosen !== null && (
          <ReferenceDetail
            classNames={found.classNames}
            entry={chosen}
            level={level}
            onName={onName}
            onRoom={onRoom}
            realm={realm}
            shopPlaces={found.shopPlaces ?? {}}
            supplies={supplies}
          />
        )}

        {empty !== null ? (
          <div className="empty">{empty}</div>
        ) : (
          <ul
            className="reference"
            ref={list.listRef as React.RefObject<HTMLUListElement>}
            role="listbox"
          >
            {entries.map((entry, index) => {
              const figure = entryFigure(entry);
              return (
                <li
                  aria-selected={list.isActive(index)}
                  data-active={list.isActive(index) ? 'true' : 'false'}
                  key={entryKey(entry, index)}
                  onClick={() => setChosen(entry)}
                  onMouseEnter={() => list.point(index)}
                  role="option"
                >
                  <span className="what">{entry.name}</span>
                  <span className="kind">{entryWord(entry)}</span>
                  {/* One figure per row — the one that says how big it is. */}
                  {figure !== null && <span className="fig">{figure}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BentoCard>
  );
}

export default memo(ReferenceCard);
