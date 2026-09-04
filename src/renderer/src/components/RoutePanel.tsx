import { useEffect, useRef, useState, type FormEvent } from 'react';

import MapPlan from './MapPlan';
import { useListNavigation } from '../hooks/useListNavigation';
import { t } from '../lib/i18n';
import { EMPTY_MAP, type LocalMap } from '@shared/map';
import { errorMessage } from '@shared/values';
import {
  asRoomReference,
  describeBlock,
  DIRECTION_NAME,
  roomId,
  type Direction,
  type Route,
  type WorldRoom
} from '@shared/world';
import { tuning } from '../lib/tuning';

export interface RoutePanelProps {
  open: boolean;
  onClose(): void;
  onSearch(query: string): Promise<WorldRoom[]>;
  onRoute(room: WorldRoom): Promise<Route>;
  /** Walks the route that is on screen. Resolves to why it could not start. */
  onWalk(route: Route): Promise<string | null>;
  /**
   * A destination chosen elsewhere — clicking the map — to plan on opening.
   *
   * The plan still has to be read and walked deliberately. This skips the
   * *search*, not the review.
   */
  destination?: WorldRoom | null;
  /**
   * A name to open the panel already searching for, when the *room* could not
   * be settled — a room name clicked in the console that several rooms share.
   *
   * The realm has 3,779 distinct names over 55,806 rooms, so a click on `Town
   * Gates` names thirteen places and choosing one would be a guess with a walk
   * at the end of it. Seeding the search puts the ambiguity in front of the
   * reader as the list it is, which is the panel's own answer to this question
   * when the name is typed.
   */
  search?: string | null;
  /**
   * The realm around a room, for the picture of where the route ends.
   *
   * The same call the Map card makes, addressed at the same character —
   * `localMap` is a query about the realm, not about where anybody is
   * standing, so centring it on the destination is the whole change.
   */
  onLoadMap(map: number, room: number): Promise<LocalMap>;
}

/**
 * Find a room, show the way there, and walk it.
 *
 * The steps are shown *before* anything can be walked, and that ordering is the
 * feature: a route is a plan to send commands to a live game, and a person gets
 * to read it first. Walking is a separate, deliberate action on a route already
 * on screen — never a side effect of choosing a destination.
 *
 * Execution itself belongs to the arbiter that owns the command queue
 * (docs/legacy-assessment.md §6); this only asks.
 *
 * A dialog that takes typed input, so it honours the focus policy: it takes the
 * caret while open and hands it back to the terminal on close.
 *
 * **Floating over the console, on the palette's own surface** — not the strip
 * docked under the terminal it used to be. Two reasons, and the second is the
 * one that matters: a docked strip appearing and disappearing takes rows from
 * the console, which resizes the terminal and goes out over NAWS; and this is
 * the palette's interaction throughout — a field that takes the caret on open,
 * a filtered list under it, `useListNavigation` through the rows, Escape and
 * click-away to leave. Two dialogs doing the same thing in two places is two
 * shapes to learn. `LoopsModal` made the same move for the same reason.
 */
export default function RoutePanel({
  open,
  onClose,
  onSearch,
  onRoute,
  onWalk,
  destination = null,
  search = null,
  onLoadMap
}: RoutePanelProps) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<WorldRoom[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [target, setTarget] = useState<WorldRoom | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /**
   * The realm around the destination, drawn from its own point of view.
   *
   * A route is 329 lines of direction and room name and answers *how to get
   * there* completely; what it says nothing about is **what the place is
   * like** — whether the destination is a dead end off a corridor or the middle
   * of a junction with four ways out, and what is shut between them. That is
   * the question somebody asks before deciding to walk for five minutes, and
   * the client already had the answer and drew it only for where the character
   * was standing.
   */
  const [there, setThere] = useState<LocalMap>(EMPTY_MAP);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * Whether what is typed names a room by its numbers rather than by its name.
   *
   * Read here as well as in main, off the same parser, for one reason: what to
   * say when nothing comes back. Main answers a reference from the index and
   * returns no room when the realm has none — and "No room by that name" is the
   * wrong sentence for `1/99999`, which is not a name and was never searched
   * for as one. Blaming the wrong thing is how somebody retypes a reference
   * that was never going to work.
   */
  const reference = asRoomReference(query);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.select());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // A destination handed in from outside is planned straight away, so opening
  // the panel from a map click shows the steps rather than an empty search.
  useEffect(() => {
    if (!open || destination === null) return;
    setTarget(destination);
    setRefused(null);
    void onRoute(destination)
      .then(setRoute)
      .catch((error) => setRefused(errorMessage(error)));
  }, [open, destination, onRoute]);

  /*
   * A name handed in with no room settled: type it into the field for the
   * reader, so the matches list is what they see rather than an empty panel.
   * Keyed on the name itself, so clicking the same ambiguous name twice
   * re-seeds it after they have typed over it.
   */
  useEffect(() => {
    if (!open || search === null) return;
    setQuery(search);
  }, [open, search]);

  useEffect(() => {
    if (!open) {
      setRoute(null);
      setTarget(null);
      setRefused(null);
      setThere(EMPTY_MAP);
    }
  }, [open]);

  /*
   * The destination's own neighbourhood, fetched when the destination changes.
   *
   * Cleared *before* the fetch rather than left standing, and guarded against a
   * late answer landing after the target has moved on — the Map card's rule and
   * for the same reason: a stale map with the loud ring on it is a picture
   * claiming a place is somewhere it is not, which is worse than no picture.
   * The realm having nothing for the room is an empty map, not an error; the
   * head above already names the room either way.
   */
  useEffect(() => {
    if (!open || target === null) {
      setThere(EMPTY_MAP);
      return;
    }
    let live = true;
    setThere(EMPTY_MAP);
    void onLoadMap(target.map, target.room)
      .then((next) => {
        if (live) setThere(next);
      })
      .catch((error) => {
        console.error(`[route] map around ${target.map}/${target.room}: ${errorMessage(error)}`);
        if (live) setThere(EMPTY_MAP);
      });
    return () => {
      live = false;
    };
  }, [open, target, onLoadMap]);

  useEffect(() => {
    if (query.trim().length < tuning().roomSearchMinChars) {
      setMatches([]);
      return;
    }
    let live = true;
    // Debounced: the realm has 55,806 rooms and a two-letter query matches a
    // lot of them. The figures come out of `internal.yaml`, shared with the
    // palette, which searches the same index — two surfaces answering the same
    // typing at different speeds is two behaviours to explain.
    const timer = window.setTimeout(() => {
      void onSearch(query)
        .then((found) => {
          if (live) setMatches(found);
        })
        .catch((error) => {
          // A search that died must not leave the previous query's matches
          // standing as though they were the answer.
          if (!live) return;
          setMatches([]);
          setRefused(errorMessage(error));
        });
    }, tuning().roomSearchDebounceMs);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, onSearch]);

  const choose = (room: WorldRoom): void => {
    setTarget(room);
    setRefused(null);
    void onRoute(room)
      .then(setRoute)
      .catch((error) => setRefused(errorMessage(error)));
  };

  /*
   * The same navigation the command palette uses, from the same hook.
   *
   * It used to be different here: Enter took `matches[0]` whatever was under
   * the pointer, and the arrows did nothing at all. Two filtered lists, two
   * states of completeness, because each surface hand-rolled its own keys.
   * Sharing the behaviour is what stops that recurring.
   */
  const list = useListNavigation({
    // Only while the list is what is on screen: once a route is planned the
    // panel is showing steps, and the arrows have nothing to point at.
    items: route ? [] : matches,
    onChoose: choose,
    onCancel: onClose
  });

  if (!open) return null;

  /** True when there is a plan on screen that could actually be walked. */
  const walkable = route !== null && !route.blocked && route.steps.length > 0;

  const walk = (plan: Route): void => {
    void onWalk(plan)
      .then((reason) => {
        setRefused(reason);
        // Closing on success puts the caret back in the terminal, which is where
        // it belongs while something is walking you around: the walk stops the
        // moment you type, and you need to be able to.
        if (reason === null) onClose();
      })
      .catch((error) => setRefused(errorMessage(error)));
  };

  return (
    // The palette's scrim, whole: one dismissal rule for every dialog that
    // floats over the console, rather than a second one that drifts from it.
    <div className="palette-scrim" onMouseDown={onClose} role="presentation">
      <form
        aria-label={t('cards.route.dialogLabel')}
        aria-modal="true"
        className="surface route-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          /*
           * Enter means "the obvious next thing", and what that is depends on
           * what is on screen: a list of rooms, and it is the highlighted one; a
           * plan, and it is walking it. Ctrl-K, route, Enter, a name, Enter,
           * Enter — and the character is moving, without the hand leaving the
           * keyboard.
           *
           * This does not skip the review the panel exists for. The plan is
           * already drawn when the second Enter is pressed; walking is still a
           * separate, deliberate keystroke on a route the player can see, which
           * is the rule — never a side effect of choosing a destination.
           */
          if (walkable) {
            walk(route);
            return;
          }
          // Whatever is highlighted, not whatever happens to be first.
          if (list.active) choose(list.active);
        }}
      >
        <div className="route-search">
          <input
            aria-label={t('cards.route.searchAria')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              /*
               * Enter means "the obvious next thing", and what that is depends on
               * what is on screen: a list of rooms, and it is the highlighted
               * one; a plan, and it is walking it. Ctrl-K, route, Enter, a name,
               * Enter, Enter — and the character is moving without a hand leaving
               * the keyboard.
               *
               * Handled here rather than left to the form's implicit submission,
               * which is a browser default that is easy to lose: the list hook
               * already claims Enter when it has something to choose, so the two
               * meanings belong in one place where the order between them is
               * visible.
               *
               * It does not skip the review this panel exists for. The plan is
               * already drawn when this fires — walking stays a separate,
               * deliberate keystroke on a route the player can see, never a side
               * effect of choosing a destination.
               */
              if (event.key === 'Enter' && walkable) {
                event.preventDefault();
                walk(route);
                return;
              }
              list.onKeyDown(event);
            }}
            /* Says the second thing the field accepts, because nothing else
             does: the Room card's badge shows `1/2150` and somebody who
             typed it here used to get a name search that found nothing.
             A feature nobody can find is one that was never built. */
            placeholder={t('cards.route.searchPlaceholder')}
            ref={inputRef}
            value={query}
          />
          <button
            aria-label={t('cards.route.closeAria')}
            className="quiet"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        {/*
        Everything under the field scrolls as one, the way the palette's own
        list does: the panel is a fixed box over the console, so the plan and
        the matches share the room left under the field rather than each
        growing the dialog.
      */}
        <div className="route-body">
          {/* Refusals and failures share this one line, under the search box
            rather than inside any single branch: a route or search that failed
            outright has no result area of its own to say so in. */}
          {refused && <div className="route-refused">{refused}</div>}

          {route ? (
            <div className="route-result">
              <div className="route-head">
                <strong>{target?.name}</strong>
                <span className="chip off">
                  {target?.map}/{target?.room}
                </span>
                {/*
              What the realm data says about the room being planned to, so a
              room clicked on the map or picked from the search says what it
              is before anybody walks there -- a shop, a lair, and which ways
              lead out of it. A room elsewhere has no card; this is the place
              its facts were missing from.
            */}
                {target?.shop !== undefined && (
                  <span className="chip quiet">{t('cards.route.destination.shopChip')}</span>
                )}
                {target?.lair !== undefined && (
                  <span className="chip warn">{t('cards.route.destination.lairChip')}</span>
                )}
                {target !== null && target.exits.length > 0 && (
                  <span className="quiet">
                    {t('cards.route.destination.exits', {
                      exitList: target.exits
                        .map(
                          (exit) => DIRECTION_NAME[exit.direction as Direction] ?? exit.direction
                        )
                        .join(', ')
                    })}
                  </span>
                )}
              </div>

              {/*
               * What the place is like, from its own point of view.
               *
               * Under the head rather than beside the steps, and drawn for a
               * blocked route as well as a walkable one — for a blocked route
               * it is often the *answer*, because the door that stopped it is
               * drawn on the corridor it is on.
               *
               * **Not a chooser.** The rooms are pictures here, with no
               * `onChoose`: this panel exists so a route is read before it is
               * walked, and a click that quietly re-planned to the room next
               * door would swap the steps under a `Walk it` button somebody is
               * already reaching for. Changing the destination is what the
               * field at the top is for.
               *
               * Not offered when the realm has nothing for the room — an empty
               * frame under the head is a picture saying the place has no
               * neighbours, which is a different claim from not knowing.
               */}
              {there.cells.length > 0 && (
                <div className="route-map">
                  <MapPlan focus="destination" map={there} />
                </div>
              )}

              {route.blocked ? (
                /*
                 * What stood in the way, one condition per line — every one of
                 * them, not the first. A route can be stopped by a level gate *and*
                 * a locked door, and naming one has somebody clear it and be
                 * refused again by a condition that was there all along.
                 *
                 * `reason` is the same answer as a sentence and is what older
                 * surfaces read; this uses the facts because it has room to.
                 */
                <ul className="route-blocked">
                  {(route.blocks ?? []).length > 0 ? (
                    route.blocks!.map((block, index) => (
                      <li key={`${block.kind}-${index}`}>{describeBlock(block)}</li>
                    ))
                  ) : (
                    <li>{route.reason ?? t('cards.route.noRouteFallback')}</li>
                  )}
                </ul>
              ) : route.steps.length === 0 ? (
                <div className="empty">{t('cards.route.alreadyHere')}</div>
              ) : (
                <>
                  <div className="route-summary">
                    <span>
                      {t('cards.route.routeSummary', {
                        stepCount: route.steps.length,
                        cost: route.cost
                      })}
                    </span>
                    {/* The one filled control in this panel, per §3.3: walking is
                    the action, everything else here is reading. */}
                    {/* Also the form's default action, so Enter walks it. */}
                    <button className="primary" title={t('cards.route.walkTooltip')} type="submit">
                      {t('cards.route.walkButton')}
                    </button>
                  </div>
                  <ol className="route-steps">
                    {route.steps.map((step, index) => (
                      <li key={`${step.to}-${index}`}>
                        <span className="step-command">{step.command}</span>
                        <span className="step-name" title={step.name}>
                          {step.name}
                        </span>
                        {/* A gated step is shown, not hidden: the player decides
                        whether a door or a trap is acceptable — and decides it on
                        the *number*. The chip said `toll` for a phase, with the
                        price the gate charges sitting unread in the same object;
                        `obstacle.label` carries it, and the realm's own words are
                        still the tooltip. */}
                        {step.requirement && (
                          <span
                            className="chip warn"
                            title={step.obstacle?.detail ?? step.requirement.raw}
                          >
                            {step.obstacle?.label ?? step.requirement.kind}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          ) : (
            <ul className="route-matches" ref={list.listRef}>
              {matches.length === 0 ? (
                <li className="empty">
                  {reference !== null
                    ? t('cards.route.noRoomByReference', {
                        roomRef: roomId(reference.map, reference.room)
                      })
                    : query.trim().length < tuning().roomSearchMinChars
                      ? t('cards.route.typeMoreChars')
                      : t('cards.route.noRoomByName')}
                </li>
              ) : (
                matches.map((room, index) => (
                  <li
                    data-active={list.isActive(index) ? 'true' : 'false'}
                    key={`${room.map}/${room.room}`}
                    onMouseEnter={() => list.point(index)}
                  >
                    <button
                      onClick={() => choose(room)}
                      // The list is driven from the field, which keeps the caret:
                      // clicking a room must not move focus out of it.
                      onMouseDown={(event) => event.preventDefault()}
                      type="button"
                    >
                      <span>{room.name}</span>
                      <span className="hint">
                        {room.map}/{room.room}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      </form>
    </div>
  );
}
