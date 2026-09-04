import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react';

import Icon from './Icon';
import { useListNavigation } from '../hooks/useListNavigation';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  groupLoops,
  LOOP_DESTINATIONS,
  type LoopChoice,
  type LoopDestination,
  type LoopGroup,
  type LoopHere,
  type LoopRow
} from '../lib/loops';

export interface LoopsModalProps {
  open: boolean;
  /** Every loop there is: the shipped shelf and the character's own, merged. */
  loops: LoopRow[];
  /** Whether the shelf has arrived yet. */
  loading: boolean;
  /** The character a loop would be filed under, for the destination's label. */
  characterName: string;
  /**
   * The realm it plays on, for the other destination's label.
   *
   * Empty when the client does not know it — no character yet, or before the
   * first roster push. The realm chip is then **not drawn**: `To ` with
   * nothing after it is a control naming nowhere, and choosing it would be
   * refused by main with a message spoken into a console that does not exist.
   */
  realmName: string;
  /**
   * Where this character is, for the sections above the areas.
   *
   * The loop it last ran, the room it is standing in and the coordinates the
   * client resolved for that room — each independently absent, and an absent
   * one removes its section rather than filling it with a guess.
   */
  here: LoopHere;
  /**
   * Run what this row names, and file it where the destination says.
   *
   * One callback rather than two, because choosing a row is one act: the loop
   * starts and it is kept, or it starts and it is not. Two would let a client
   * file a loop it then failed to run. The `choice` says which of the two
   * shapes the row is — a loop to file, or a name already on disk.
   */
  onChoose(choice: LoopChoice, destination: LoopDestination): void;
  onClose(): void;
}

/**
 * Where a chosen loop goes when nobody says otherwise: nowhere.
 *
 * It was the character, on the reasoning that a picked loop almost always
 * belongs to whoever picked it. What actually happens with a shelf of four
 * hundred and twenty is that most of them are *tried* — and a default that
 * files silently turns an evening of trying loops into a character directory
 * nobody can clean up, one file at a time, with nothing having asked. Keeping
 * it is the deliberate act now, which is the right way round: the chips are on
 * screen and one click away, and the cost of the wrong default is asymmetric.
 * The loop still runs either way; only whether it is written down changes.
 */
const DEFAULT_DESTINATION: LoopDestination = 'none';

/**
 * Every loop the client knows, grouped by area, from anywhere in the game.
 *
 * The Navigation card's Loop face drives the loop that is *running*; this is
 * where one is found.
 * They are different questions and they were being answered by the same
 * control — a `<select>` on a card that only exists while the character has
 * loops already, listing only that character's own. Four hundred and twenty
 * ship with the client and there was no way to reach one without opening the
 * settings screen, finding the Movement tab and adding it to a character
 * first: the same failure the palette's own ordering had, which is that a
 * command nobody can find does not exist.
 *
 * Six decisions worth stating, because none is the obvious one:
 *
 * - **The answer comes before the map.** Three sections above the areas — the
 *   loop this character last ran, the loops that *start* in this room, then
 *   the ones that pass through it — and they are open where the areas are
 *   shut, because they hold the row somebody came for and an area heading is
 *   a place to go looking. A section with nothing in it is not drawn at all,
 *   which is deliberately unlike the areas: `Starts here` over no rows is the
 *   client answering a question nobody asked, in most rooms, for ever.
 * - **A hoisted row is moved, not copied.** The palette's own pin rule: the
 *   same loop in two places is two rows to compare with nothing to tell them
 *   apart. A row takes the first section it qualifies for and leaves its area.
 * - **Areas collapsed by default, and every heading is drawn.** Fifty-seven
 *   areas with 420 loops under them is a wall; fifty-seven headings is a map.
 *   The headings are all present whether or not they are open, so the shape of
 *   what the realm holds is visible from the first glance — the same rule the
 *   palette's own groups follow, and the map's legend.
 * - **Typing searches everything and opens what it finds.** A collapsed group
 *   hiding a match would be a search that lies. A query auto-expands exactly
 *   the groups with something in them and leaves the rest shut.
 * - **Where it goes is chosen before the row is clicked, not after.** A dialog
 *   that asked afterwards would be a second decision between the player and
 *   the thing they came to do. The destination sits at the foot and remembers
 *   nothing between openings.
 * - **`Don't Add` is a real answer, and it is the default.** Trying a loop
 *   once is the commonest thing somebody does with a shelf of 420, and a
 *   client that filed all 420 into a character's directory on the way past
 *   would be one nobody could clean up — which is what the old default of
 *   *the character* was quietly doing. See {@link DEFAULT_DESTINATION}.
 *
 * A filtered list, so it uses `useListNavigation` like every other one — type
 * to narrow, arrow to choose, Enter to take it, Escape to leave. It holds the
 * caret while it is open and hands it back on every exit.
 */
export default function LoopsModal({
  open,
  loops,
  loading,
  characterName,
  realmName,
  here,
  onChoose,
  onClose
}: LoopsModalProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [destination, setDestination] = useState<LoopDestination>(DEFAULT_DESTINATION);
  const fieldRef = useRef<HTMLInputElement>(null);

  /*
   * Opening is the gesture; what was typed last time is not part of it. A
   * query is a question being asked right now — the rule the card tables
   * already state for their find fields — and a modal that reopened narrowed
   * to `sewer` would be answering a question nobody had asked yet. The
   * destination is reset with it, because a loop quietly filed somewhere
   * chosen a fortnight ago is the one outcome this must never produce.
   *
   * `expanded` resets to nothing rather than to the sections, because a
   * priority section is open by *rule* rather than by state — see
   * {@link isOpen}. Storing them here would make "open unless closed" and
   * "closed unless opened" two spellings of the same set, and only one of them
   * survives the room changing under a modal that is already open.
   */
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setExpanded(new Set());
    setDestination(DEFAULT_DESTINATION);
    fieldRef.current?.focus();
  }, [open]);

  const groups = useMemo(() => groupLoops(loops, query, here), [loops, query, here]);

  /*
   * A destination the client cannot name is not offered. `To ` with nothing
   * after it is a control bound to nowhere, which this client draws as absent
   * rather than as present-and-broken — the rule the pinned float's own
   * toolbar already follows.
   */
  const destinations = useMemo(
    () => LOOP_DESTINATIONS.filter((option) => option !== 'server' || realmName.length > 0),
    [realmName]
  );
  const searching = query.trim().length > 0;

  /**
   * Whether a group's rows are drawn.
   *
   * One rule, used by the flattening and by the drawing, so the arrows and the
   * list agree by construction rather than through a second condition kept in
   * step by hand — a highlight that could land on a row nobody can see is a
   * cursor that vanishes.
   *
   * A priority section is open unless it has been shut; an area is shut unless
   * it has been opened. The three sections hold the answer somebody came for,
   * and a heading they have to click to see it under is one more keystroke on
   * the case this whole change exists to shorten. While searching, everything
   * with a match in it is open — a collapsed group hiding a match is a search
   * that lies.
   */
  const isOpen = useCallback(
    (group: LoopGroup): boolean => {
      if (searching) return true;
      const deviates = expanded.has(group.id);
      return group.section === 'area' ? deviates : !deviates;
    },
    [expanded, searching]
  );

  const visible = useMemo(
    () => groups.flatMap((group) => (isOpen(group) ? group.loops : [])),
    [groups, isOpen]
  );

  const choose = (row: LoopRow): void => {
    onChoose(row.choice, destination);
    onClose();
  };

  const nav = useListNavigation<LoopRow>({
    items: visible,
    onChoose: choose,
    onCancel: onClose
  });

  /**
   * The set is the *deviation*, not the state.
   *
   * An area is closed until it is in the set and a priority section is open
   * until it is — so a section somebody shut stays shut, and the fifty-seven
   * areas still cost one entry each only once opened. One set rather than two,
   * because two would have to be kept in step by hand at exactly the moment a
   * group changes kind: walking into a room hoists a loop out of its area, and
   * an area's open flag is not an answer to whether `Starts here` is open.
   */
  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /*
   * Escape belongs to whatever holds the caret, and while this is open that is
   * this field — so it closes the modal and nothing else, rather than putting
   * away the route panel or the diagnostics rail underneath it as well.
   *
   * **The half that does that work is in `App.tsx`, not here.** `useHotkeys`
   * listens at the window in the *capture* phase, so a window binding sees
   * Escape before this bubble-phase handler ever runs, and no
   * `stopPropagation` here could prevent one firing. What keeps this modal's
   * Escape to itself is `!loopsOpen` on each of those bindings, beside the
   * `!paletteOpen` and `!settingsOpen` already there. This `stopPropagation`
   * only stops handlers *between* the field and the window, which is what
   * keeps a surface that wraps this one from also acting — the same shape the
   * settings dialog gave `LoopPicker`.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') event.stopPropagation();
    nav.onKeyDown(event);
  };

  if (!open) return null;

  const index = new Map(visible.map((row, at) => [row.key, at]));

  return (
    <div className="palette-scrim" onMouseDown={onClose} role="presentation">
      <div
        aria-label={t('loops.dialogLabel')}
        aria-modal="true"
        className="surface palette loops-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        {/*
          The find field sits *inside* the surface rather than bleeding into
          its edges. Full width against a `--r-card` corner with `overflow:
          hidden` over it, the field's own square top corners are clipped by
          the surface's round ones, and a control whose corners are sliced off
          reads as one that has been cut off rather than as one that was drawn
          that way. Inset by the same padding the rows below it carry, so the
          field, the headings and the names all start on one left edge.
        */}
        <div className="loops-find">
          <input
            aria-label={t('loops.filterLabel')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              // A count is asserted only once it has actually been read.
              loading ? t('loops.filterPlaceholderLoading') : t('loops.filterPlaceholder')
            }
            ref={fieldRef}
            spellCheck={false}
            value={query}
          />
        </div>

        {loading ? (
          <div className="empty">{t('loops.loading')}</div>
        ) : groups.length === 0 ? (
          <div className="empty">{searching ? t('loops.noMatches') : t('loops.noLoops')}</div>
        ) : (
          <ul ref={nav.listRef} role="listbox">
            {groups.map((group) => {
              const open_ = isOpen(group);
              return (
                <Fragment key={group.id}>
                  <li
                    aria-hidden="true"
                    className="palette-group-label"
                    data-section={group.section}
                    role="presentation"
                  >
                    <button
                      className="palette-group-toggle"
                      onClick={() => toggle(group.id)}
                      onMouseDown={keepFocus}
                      tabIndex={-1}
                      type="button"
                    >
                      <Icon name={open_ ? 'chevronDown' : 'chevronRight'} />
                      <span className="loops-group-name">{groupLabel(group)}</span>
                      <span className="hint">
                        {group.loops.length === 1
                          ? t('loops.groupCount.one', { count: group.loops.length })
                          : t('loops.groupCount.many', { count: group.loops.length })}
                      </span>
                    </button>
                  </li>
                  {open_ &&
                    group.loops.map((row) => {
                      const at = index.get(row.key) ?? -1;
                      return (
                        <li
                          aria-selected={nav.isActive(at)}
                          data-active={nav.isActive(at) ? 'true' : 'false'}
                          data-grouped="true"
                          key={row.key}
                          onClick={() => choose(row)}
                          onMouseEnter={() => nav.point(at)}
                          role="option"
                        >
                          <Icon name="route" />
                          <span className="loop-row-name">{row.shortName}</span>
                          {/* Where it already lives, when it does. A loop the
                              character walks is not a loop being added, and
                              the row saying so is what stops somebody filing
                              a second copy of one they already have. */}
                          {row.held && <span className="chip on">{t('loops.held')}</span>}
                          <span className="hint">
                            {row.stops === 1
                              ? t('loops.stopsCount.one', { count: row.stops })
                              : t('loops.stopsCount.many', { count: row.stops })}
                          </span>
                        </li>
                      );
                    })}
                </Fragment>
              );
            })}
          </ul>
        )}

        {/*
          Where the chosen loop is kept, in the shape the permission grid uses
          for allow beside deny — and in its colours: `--ok` for the two that
          keep the loop, `--danger` for the one that refuses to. The refusal
          was styled neutral at first, on the reasoning that it is the absence
          of a destination rather than a third one; that made it the one chip
          in the client that says no without looking like it. `Don't keep it`
          is a real answer with a real consequence — the loop is gone when the
          run ends — so it ranks like every other refusal here.

          Ranked only while held, which is the grid's own rule: an unpressed
          chip is struck through and states nothing by colour, because a red
          chip with a line through it reads as a denial rather than as the
          absence of one. Nothing is said by hue alone — each chip names its
          destination in words and `aria-pressed` says which is held.
        */}
        <div aria-label={t('loops.destinationLabel')} className="loops-destination" role="group">
          <span className="loops-destination-label">{t('loops.destinationLabel')}</span>
          {destinations.map((option) => (
            <button
              aria-pressed={destination === option}
              className="chip toggle"
              data-destination={option}
              data-level={option === 'none' ? 'critical' : 'ok'}
              data-on={destination === option ? 'true' : 'false'}
              key={option}
              onClick={() => setDestination(option)}
              onMouseDown={keepFocus}
              type="button"
            >
              {destinationLabel(option, characterName, realmName)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * What a group's heading says.
 *
 * An area states its own name — the realm's word, so it stays out of the
 * dictionary like every other realm word. The three priority sections are the
 * client's own sentences about where the character is, so they are keys, and
 * each branch is a literal `t()` call rather than one built from the section
 * word: the coverage test reads the literal after `t(` and a key assembled
 * from a union member is one it cannot see.
 */
function groupLabel(group: LoopGroup): string {
  switch (group.section) {
    case 'recent':
      return t('loops.section.recent');
    case 'start':
      return t('loops.section.start');
    case 'waypoint':
      return t('loops.section.waypoint');
    case 'area':
      return group.category;
    default: {
      /* A heading with no words is a group nobody can read. */
      const unreachable: never = group.section;
      return unreachable;
    }
  }
}

/**
 * What each destination is called, naming the thing it would write to.
 *
 * *To Vaelor* rather than *To character*: the client holds four at once, and
 * the one being written to is the fact worth stating. Each branch is a literal
 * `t()` call rather than a key built from the destination word, because the
 * coverage test reads the literal after `t(` and a dynamic key is one it
 * cannot see.
 */
function destinationLabel(
  destination: LoopDestination,
  characterName: string,
  realmName: string
): string {
  switch (destination) {
    case 'profile':
      return t('loops.destination.character', { name: characterName });
    case 'server':
      return t('loops.destination.realm', { name: realmName });
    case 'none':
      return t('loops.destination.none');
    default: {
      /* A destination with no label is a control nobody can read. */
      const unreachable: never = destination;
      return unreachable;
    }
  }
}
