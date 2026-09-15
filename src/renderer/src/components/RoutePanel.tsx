import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import MapView from './MapView';
import ClearField from './ClearField';
import Icon from './Icon';
import { commandsOf, runsOf, stepSignature } from '../lib/route';
import { useListNavigation } from '../hooks/useListNavigation';
import { t } from '../lib/i18n';
import { type LocalMap } from '@shared/map';
import { errorMessage } from '@shared/values';
import {
  asRoomReference,
  describeBlock,
  DIRECTION_NAME,
  itemWanted,
  lairsAlong,
  roomId,
  trapsAlong,
  type Direction,
  type RoomId,
  type Route,
  type RouteBlock,
  type RouteStep,
  type WorldRoom
} from '@shared/world';
import { keepFocus } from '../lib/focus';
import { tuning } from '../lib/tuning';
import type { Replanned, WalkStart } from '@shared/movement';

/**
 * Whether an alternative steps over none of the walls the plan crosses — the
 * test for *there is no other way*, which is said only when every route main
 * planned beside the plan walks through the same door.
 */
function avoidsWalls(other: Route, walls: readonly RouteBlock[]): boolean {
  return walls.every(
    (wall) =>
      wall.kind === 'unreachable' ||
      !other.steps.some((step) => step.from === wall.at && step.to === wall.to)
  );
}

export interface RoutePanelProps {
  open: boolean;
  onClose(): void;
  onSearch(query: string): Promise<WorldRoom[]>;
  onRoute(room: WorldRoom): Promise<Route>;
  /**
   * Walks the route that is on screen.
   *
   * Resolves to what happened: walking, why it could not, or **the plan drawn
   * again** — the character moved between the drawing and the press, and the
   * way from where it now stands comes back to be read and pressed again.
   */
  onWalk(route: Route): Promise<WalkStart>;
  /**
   * Collects what the way needs first, then walks it (todo 07).
   *
   * Offered on whichever way is on screen, where it names an item to go and
   * get — a door it crosses, or a spell its rooms cast (`itemWanted`).
   */
  onCollectThenWalk(item: { id: number; name: string }, route: Route): Promise<string | null>;
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
   * standing, so centring it on the destination is the whole change. The
   * radius is the window's own, measured from its laid-out box, which is why
   * the fetch belongs to `MapView` and not to this panel.
   */
  onLoadMap(map: number, room: number, radius: number): Promise<LocalMap>;
  /** The rooms this realm's find log names, marked with a dot. */
  finds: readonly RoomId[];
  /**
   * A room on the plan pointed at or clicked, and the pointer leaving it:
   * open the realm's answer about that room beside whatever named it — a row
   * of the list, or a room on the panel's own map.
   *
   * *Four lairs on the way, one is expected to kill you* is a summary, and
   * what the reader needs before walking it is what is actually in each — the
   * same panel the map opens, from the same query. `walkHere` is *walk here*
   * where the room is a step of the plan: the plan is on screen and stopping
   * short at a room is already what picking a step means. Null for a room on
   * the map the plan does not pass through, where the caller offers the map's
   * own action instead. `settled` is a click rather than a hover, the map's
   * rule: a click nails the panel down.
   *
   * Null where there is nothing to open, like `chooseOnMap` beside it.
   */
  onPeek:
    ((room: RoomId, at: Element, settled: boolean, walkHere: (() => void) | null) => void) | null;
  onPeekEnd: (() => void) | null;
}

/**
 * The chips a step wears after its name: the gate, the room's own spell, the
 * lair. Written once because a folded run's row wears its first step's, and
 * the two rows must never disagree about what a room costs.
 */
function chips(step: RouteStep) {
  return (
    <>
      {/* A gated step is shown, not hidden: the player decides whether a door
      or a trap is acceptable — and decides it on the *number*. The chip said
      `toll` for a phase, with the price the gate charges sitting unread in
      the same object; `obstacle.label` carries it, and the realm's own words
      are still the tooltip. A trap wears the danger chip and everything else
      the pending one: a door is opened and a toll is paid, and a trap is
      walked through and taken — the same split the map draws as a bar
      against a hazard triangle. */}
      {step.requirement && (
        <span
          className={step.requirement.kind === 'trap' ? 'chip bad' : 'chip warn'}
          title={step.obstacle?.detail ?? step.requirement.raw}
        >
          {step.obstacle?.label ?? step.requirement.kind}
        </span>
      )}
      {/* And what the room itself does to whoever stands in it. A chip
      rather than a figure per step: on a route that crosses eight hundred of
      them the number is the same eight hundred times, and the figure that
      decides is at the head. A discouragement — a chain nobody could read,
      a summons — is the word, never the share it was priced at: `2%` beside
      a room whose spell is unread was read as a lair figure. */}
      {step.hazard !== undefined && (
        <span className={step.hazardKind === undefined ? 'chip bad' : 'chip warn'}>
          {step.hazardKind === 'unread'
            ? t('cards.route.stepUnread')
            : step.hazardKind === 'summons'
              ? t('cards.route.stepSummons')
              : step.hazard * 100 < 1
                ? t('cards.route.stepSlight')
                : t('cards.route.stepHazard', { percent: Math.round(step.hazard * 100) })}
        </span>
      )}
      {/* And the lair the router priced this step by. The head says how many
      and names the worst; **this is where the reader finds out which rooms
      they are**, which is the half that was missing — a count at the top of
      a hundred-step plan is a number with nowhere to look. */}
      {step.danger !== undefined && (
        <span className={step.deadly === true ? 'chip bad' : 'chip warn'}>
          {step.deadly === true
            ? t('cards.route.stepDeadly')
            : t('cards.route.stepLair', {
                percent: Math.max(1, Math.round(step.danger * 100))
              })}
        </span>
      )}
    </>
  );
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
  onCollectThenWalk,
  destination = null,
  search = null,
  onLoadMap,
  finds,
  onPeek,
  onPeekEnd
}: RoutePanelProps) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<WorldRoom[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [target, setTarget] = useState<WorldRoom | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /**
   * The plan main drew again, and which plan it was drawn to replace.
   *
   * Held with the route it describes rather than cleared by an effect, because
   * the answer *is* a `setRoute` and an effect keyed on the route would put the
   * sentence away in the same commit that put the plan on screen. Drawn only
   * while the plan on screen is still the one that came back; anything else
   * planned since makes it stale, which is exactly when it should go.
   */
  const [redrawn, setRedrawn] = useState<{ route: Route; was: Replanned } | null>(null);
  /**
   * Which step of the plan on screen the reader has picked out, if any.
   *
   * A route is planned to the room that was searched for, and the room somebody
   * actually wants is often on the way to it — the bank two rooms before the
   * guild, the corner where the corridor turns. The plan already lists every
   * one of them, so picking one costs nothing to compute: the prefix of a
   * route is a route.
   */
  const [picked, setPicked] = useState<number | null>(null);
  /**
   * Which of the plan's routes is on screen: the plan itself, the way round
   * the worst of it (`Route.otherWay`), or the way with the right items
   * (`Route.carrying`). A choice among routes main already planned, never a
   * re-plan: the panel is a reader, and *Show it* swaps what is read.
   */
  const [chosen, setChosen] = useState<'plan' | 'round' | 'carrying'>('plan');
  /**
   * Whether to go and get what the way needs before walking it (todo 07).
   *
   * About **the way on screen**, whichever that is: it used to be drawn only
   * on the *carrying* alternative, so a plan that itself crossed a keyed door
   * with no alternative to offer — which is every route to a room behind a
   * lock only one key opens — named the key and offered nothing to do about
   * it.
   *
   * A tick is about *this way through this door*, so anything that changes
   * which way is on screen drops it: both the plan and the choice among its
   * alternatives, in the two effects below. It was guarded by holding the
   * route it was made on and comparing by identity, which left the box drawn
   * ticked over a fresh plan while quietly deciding nothing — a control
   * stating the opposite of what it would do.
   */
  const [collectFirst, setCollectFirst] = useState(false);
  /**
   * Whether to stop in the room before the destination rather than enter it.
   *
   * Walking to a boss is walking to the doorway: the reader wants to be at the
   * keyboard, or to have a party with them, before the last step is taken —
   * and the last step is the one that starts the fight. The plan already lists
   * the room before, so the whole of this is *do not send that last command*.
   *
   * **It belongs to the destination, not to the way**, which is the one thing
   * it does differently from the tick beside it. *Collect it first* names an
   * item on a particular route, so another route drops it; this says only
   * *do not enter the room at the end*, which is as true of the way round as
   * of the plan, and as true of a plan main redrew from where the character
   * has wandered to. So it survives both of those and goes when the reader
   * searches for somewhere else — a tick cleared by a redraw would have put
   * the character in the boss room on the very press that redrew the plan.
   */
  const [stopShort, setStopShort] = useState(false);
  /** Whether the alternatives are unfolded under the head. */
  const [offering, setOffering] = useState(false);
  /** Folded runs of same-reading rooms that have been opened, by first step. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const shown: Route | null =
    route === null
      ? null
      : chosen === 'round'
        ? (route.otherWay ?? route)
        : chosen === 'carrying'
          ? (route.carrying ?? route)
          : route;
  /**
   * How large a room is drawn in the picture of where the route ends.
   *
   * Opened at the dense end and clamped up from there by the window itself
   * (`zoomFloor`), which is the builder's rule: *as many rooms as this box can
   * be filled with*. The strip under the head is short and wide, so that is a
   * neighbourhood a few rooms deep and a long way across, and the wheel and
   * the hand reach the rest.
   */
  const [zoom, setZoom] = useState(() => tuning().mapRoomPixelsDense);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Which plan the panel is waiting for, so a stale one can be disowned.
   *
   * A ref rather than state: nothing on screen changes when it moves, and it
   * has to be readable from inside a promise that closed over an older render.
   */
  const planning = useRef(0);

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

  /*
   * A destination handed in from outside is planned straight away, so opening
   * the panel from a map click shows the steps rather than an empty search.
   *
   * **Guarded against a late answer, like the map fetch below.** A route
   * across the realm is an A* over 57,511 rooms and takes long enough to
   * outlive the panel: closing before it landed left the plan set on a closed
   * panel, and the *next* opening — from the palette, with no destination at
   * all — drew that stale route in place of its own search field. The clearing
   * effect had already run by then, so nothing further put it away.
   */
  useEffect(() => {
    if (!open || destination === null) return;
    let live = true;
    setTarget(destination);
    setRefused(null);
    void onRoute(destination)
      .then((plan) => {
        if (live) setRoute(plan);
      })
      .catch((error) => {
        if (live) setRefused(errorMessage(error));
      });
    return () => {
      live = false;
    };
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
      // And any plan still being computed is disowned, or it lands on the
      // panel after this has cleared it — see the destination effect above.
      planning.current += 1;
      setRoute(null);
      setTarget(null);
      setRefused(null);
    }
  }, [open]);

  /*
   * A pick belongs to the plan it was made on, so a new plan drops it.
   *
   * Keyed on the route *object*, which is replaced by every `setRoute` — the
   * four places that plan one, and the close that nulls it. Clearing it at
   * each of those instead would be wiring that has to be remembered at five
   * sites, which is the shape this codebase has twice found missing at half of
   * them; here the cost would be a `Walk here` button offering to walk to the
   * thirtieth step of a route that is no longer on screen.
   */
  useEffect(() => {
    setPicked(null);
    setChosen('plan');
    setOffering(false);
    setUnfolded(new Set());
    setCollectFirst(false);
  }, [route]);
  // A pick belongs to the list it was made on, and so does an opened run — and
  // a tick belongs to the door the way on screen goes through, which another
  // way need not.
  useEffect(() => {
    setPicked(null);
    setUnfolded(new Set());
    setCollectFirst(false);
  }, [chosen]);
  /*
   * And the tick that says *do not enter the room at the end* belongs to that
   * room, so it goes when the reader chooses another one — and with it when
   * the panel closes, which nulls the target. Keyed on the destination rather
   * than on the route, because every replan to the same room is still a walk
   * into the same boss.
   */
  useEffect(() => {
    setStopShort(false);
  }, [target]);

  /*
   * The destination's own neighbourhood: which room the window is centred on.
   *
   * The fetch itself — its radius, its late answers, the empty map a realm
   * with nothing for the room comes back with — is `MapView`'s, as it is for
   * every other map. This panel says only *look here*.
   */
  const centre = useMemo(
    () => (target === null ? null : roomId(target.map, target.room)),
    [target]
  );
  /* One element for as long as the reason holds, so the view's memo holds too. */
  const empty = useMemo(() => <div className="empty">{t('cards.map.emptyNoWorldData')}</div>, []);

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

  /*
   * A room chosen from the list, planned. Stamped with the request it belongs
   * to for the destination effect's reason: closing the panel — or choosing a
   * second room — while an A* over 57,511 rooms is still running would
   * otherwise land the abandoned plan on top of whatever replaced it.
   */
  const choose = (room: WorldRoom): void => {
    planning.current += 1;
    const mine = planning.current;
    setTarget(room);
    setRefused(null);
    void onRoute(room)
      .then((plan) => {
        if (planning.current === mine) setRoute(plan);
      })
      .catch((error) => {
        if (planning.current === mine) setRefused(errorMessage(error));
      });
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

  const walk = useCallback(
    (plan: Route): void => {
      /*
       * *Collect it first* is a different press: main goes and gets the item
       * and walks the way that wanted it when the pack holds it. The item is
       * the first that way asks for — the panel names them all in the sentence
       * above, and the errand refuses out loud if it cannot reach that one.
       *
       * **Only about the whole way on screen**, which is what the tick was
       * drawn from. A prefix is built by slicing the steps (`peek`, and a
       * picked row), and a shallow copy carries the whole route's `walls` and
       * `hazards` onto a walk that stops three rooms along — so *Walk here*
       * would leave to go shopping for a key for a door it never reaches.
       */
      const needed = collectFirst && plan === shown ? itemWanted(plan) : null;
      /*
       * *Stop before entering* drops the last step, by the same rule: about
       * the whole way on screen, never a prefix, because *Walk here* has
       * already named the room it stops at and stopping one short of that is
       * not what was asked for.
       *
       * The item is still read off the **untruncated** plan, deliberately.
       * The key for the boss's door is wanted exactly as much by somebody
       * waiting in the doorway for a party as by somebody walking straight
       * in — the whole point of stopping there is to go in afterwards — so
       * the two ticks compose rather than cancelling each other.
       *
       * A one-step plan is already standing in the room before, so there is
       * nothing to walk and the press says so rather than sending an empty
       * route. Only reachable this way: every other caller passes a prefix,
       * which is not `shown`.
       */
      const trimmed = stopShort && plan === shown ? plan.steps.slice(0, -1) : null;
      if (trimmed !== null && trimmed.length === 0) {
        setRefused(t('cards.route.alreadyBefore', { roomName: plan.steps[0]!.name }));
        return;
      }
      const walked: Route = trimmed === null ? plan : { ...plan, steps: trimmed };
      /*
       * The errand answers in the older shape: it walks to a shop and plans the
       * way on from there itself, so a plan handed to it cannot be stale and
       * there is nothing for it to redraw.
       */
      const started: Promise<WalkStart> =
        needed === null
          ? onWalk(walked)
          : onCollectThenWalk(needed, walked).then((reason) =>
              reason === null ? { started: true } : { refused: reason }
            );
      void started
        .then((answer) => {
          if ('replanned' in answer) {
            // The new plan replaces what is on screen, and the sentence above it
            // says what changed. The press that walks it is the next one, which
            // is measured afresh — agreeing to a journey is agreeing to that one.
            setRefused(null);
            setRoute(answer.replanned.route);
            setRedrawn({ route: answer.replanned.route, was: answer.replanned });
            return;
          }
          setRedrawn(null);
          setRefused('refused' in answer ? answer.refused : null);
          // Closing on success puts the caret back in the terminal, which is where
          // it belongs while something is walking you around: the walk stops the
          // moment you type, and you need to be able to.
          if ('started' in answer) onClose();
        })
        .catch((error) => setRefused(errorMessage(error)));
    },
    [collectFirst, stopShort, onCollectThenWalk, onWalk, onClose, shown]
  );

  /**
   * Open the realm's answer about a room on the plan, beside whatever named
   * it: a row of the list, or a room on the map under the head.
   *
   * The walk it offers is *this far and no further* — the prefix of a route is
   * a route, which is the same fact the picked row's own button rests on. A
   * room the plan does not pass through — the map draws the destination's
   * neighbours too — offers no prefix; the caller offers the map's own action
   * for it, rather than a button that walks somewhere arbitrary.
   *
   * `useCallback` because `MapView` is memoised and takes this as a prop: an
   * arrow built per render would redraw the picture on every keystroke in
   * the field above it.
   */
  const peek = useCallback(
    (room: RoomId, at: Element, settled: boolean): void => {
      if (onPeek === null || shown === null) return;
      const index = shown.steps.findIndex((step) => step.to === room);
      onPeek(
        room,
        at,
        settled,
        index >= 0 ? () => walk({ ...shown, steps: shown.steps.slice(0, index + 1) }) : null
      );
    },
    [onPeek, shown, walk]
  );

  if (!open) return null;

  /** True when there is a plan on screen that could actually be walked. */
  const walkable = shown !== null && !shown.blocked && shown.steps.length > 0;

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
          if (walkable && shown !== null) {
            walk(shown);
            return;
          }
          // Whatever is highlighted, not whatever happens to be first.
          if (list.active) choose(list.active);
        }}
      >
        <div className="route-search">
          <ClearField
            label={t('cards.route.searchAria')}
            onClear={() => setQuery('')}
            query={query}
          >
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
                if (event.key === 'Enter' && walkable && shown !== null) {
                  event.preventDefault();
                  walk(shown);
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
          </ClearField>
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

          {/* The plan was drawn again from here, and this is what changed about
            it. Drawn only while the plan on screen is still that one: anything
            planned since makes the sentence a claim about a route nobody is
            looking at. Both halves are said where both are true — a character
            that has wandered and a way that now wants a key are two different
            reasons to look, and naming one hides the other. */}
          {redrawn !== null && redrawn.route === route && (
            <div className="route-redrawn">
              <div>{t('cards.route.redrawn')}</div>
              <div className="route-redrawn-why">
                {redrawn.was.wandered === null
                  ? t('cards.route.redrawnUnmeasured')
                  : redrawn.was.wandered === 1
                    ? t('cards.route.redrawnWandered.one')
                    : t('cards.route.redrawnWandered.many', { steps: redrawn.was.wandered })}
                {redrawn.was.demands.length > 0 &&
                  ` ${t('cards.route.redrawnNeeds', { needList: redrawn.was.demands.join(', ') })}`}
              </div>
            </div>
          )}

          {route !== null && shown !== null ? (
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
               * **The same map as the Map card, in every respect**: the same
               * window (`MapView`), so the wheel zooms it, the hand pans it
               * and the legend under it keys what is drawn; the same quick
               * view, so a room pointed at or clicked answers for itself
               * beside the picture, with the walk a button on that panel.
               *
               * Never a chooser: this panel exists so a route is read before
               * it is walked, and a click that quietly re-planned to the room
               * next door would swap the steps under a `Walk it` button
               * somebody is already reaching for — so no `onChoose`, and the
               * click settles the panel as it does on the card. A room on the
               * plan offers *walk here*, the list's action; a neighbour the
               * plan does not pass through offers *walk to*, which re-plans in
               * the open, by name.
               *
               * Drawn as soon as there is a room to centre on. The realm
               * having nothing for it says so inside the frame, which is a
               * different claim from a picture of a place with no neighbours.
               *
               * No `you` ring: the loud ring here is the destination's, which
               * is what this picture is of. `MapPlan` spends exactly one on a
               * map, and a second saying *and here is where you are standing*
               * would be two answers to the one question it is asked under
               * pressure.
               */}
              {centre !== null && (
                <div className="route-map">
                  <MapView
                    centre={centre}
                    empty={empty}
                    finds={finds}
                    focus="destination"
                    load={onLoadMap}
                    name="route"
                    onPeek={onPeek === null ? undefined : peek}
                    onPeekEnd={onPeekEnd ?? undefined}
                    onZoom={setZoom}
                    zoom={zoom}
                  />
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
                        stepCount: shown.steps.length,
                        cost: shown.cost
                      })}
                    </span>
                    {/* Which route this is, when it is not the plan: the reader
                    chose it from the list below, and the list closes behind
                    the choice. */}
                    {chosen !== 'plan' && (
                      <span className="chip off">
                        {chosen === 'round'
                          ? t('cards.route.showing.round')
                          : t('cards.route.showing.carrying')}
                      </span>
                    )}
                    {/* The traps, counted at the head of the list where the
                    reader is. Each trapped step wears its own chip below, and
                    on a forty-step route that chip sits under the fold while
                    the `Walk it` button does not — a route that hurts should
                    say so beside the button that walks it. The worst damage is
                    the number that decides; nothing is said about damage when
                    no trap states one, because *up to 0* is a figure the data
                    never gave. */}
                    {(() => {
                      const traps = trapsAlong(shown.steps);
                      if (traps.count === 0) return null;
                      const count =
                        traps.count === 1
                          ? t('cards.route.traps.one')
                          : t('cards.route.traps.many', { trapCount: traps.count });
                      return (
                        <span className="chip bad" data-traps={traps.count}>
                          {traps.worst === null
                            ? count
                            : `${count} · ${t('cards.route.trapDamage', { damage: traps.worst })}`}
                        </span>
                      );
                    })()}
                    {/* And the draw, where the way ends in one. Beside the
                    button rather than only on its step, because it changes
                    what pressing the button means: the plan stops at the
                    scatter, the client carries on from wherever the realm
                    puts the character, and the figure is how much walking
                    that is expected to take. */}
                    {(() => {
                      const drawn = shown.steps.at(-1)?.scatter;
                      if (drawn === undefined) return null;
                      return (
                        <span className="chip warn">
                          {t('cards.route.scatter', {
                            spellName: drawn.landing.name,
                            roomCount: drawn.rooms,
                            moves: Math.round(drawn.moves)
                          })}
                        </span>
                      );
                    })()}
                    {/* And the lairs, by the same rule: what the router priced
                    the walk by, said where the button is. The worst share of
                    the health bar is the number that decides; a deadly one
                    says so, because the router walks it only when there is no
                    other way, and that is the one fact the reader needs. */}
                    {(() => {
                      const lairs = lairsAlong(shown.steps);
                      if (lairs.count === 0 && lairs.deadly === null) return null;
                      // A room deadly by its own spell is named with no lair
                      // counted: the count is the lairs', the death is either's.
                      const count =
                        lairs.count === 0
                          ? null
                          : lairs.count === 1
                            ? t('cards.route.lairs.one')
                            : t('cards.route.lairs.many', { lairCount: lairs.count });
                      const worst =
                        lairs.worst === null
                          ? null
                          : t('cards.route.lairWorst', { percent: Math.round(lairs.worst * 100) });
                      /*
                       * **Which room**, not merely that there is one. On a
                       * hundred-and-four-step route *one is expected to kill
                       * you* left the reader to scroll for a chip; the room is
                       * named here and is the control that opens its quick
                       * view, so what is in it is one point away.
                       *
                       * And *there is no other way* is said only where the
                       * router looked and found none — none of the routes it
                       * planned beside this one avoids the room. It used to be
                       * asserted off the price of a single search, which is
                       * an absolute drawn from a relative result.
                       */
                      const deadly = lairs.deadly;
                      const avoided =
                        deadly !== null &&
                        [route.otherWay, route.carrying].some(
                          (other) =>
                            other !== undefined &&
                            other !== shown &&
                            !other.steps.some((step) => step.to === deadly.room)
                        );
                      return (
                        <span
                          className={deadly !== null ? 'chip bad' : 'chip warn'}
                          data-lairs={lairs.count}
                        >
                          {count}
                          {deadly === null ? (
                            worst === null ? null : (
                              ` · ${worst}`
                            )
                          ) : (
                            <>
                              {count === null ? null : ' · '}
                              {t('cards.route.lairDeadlyAt')}{' '}
                              <button
                                className="lookup"
                                onClick={(event) => peek(deadly.room, event.currentTarget, true)}
                                onMouseDown={keepFocus}
                                type="button"
                              >
                                {deadly.name}
                              </button>
                              {avoided ? '' : `, ${t('cards.route.lairDeadly')}`}
                            </>
                          )}
                        </span>
                      );
                    })()}
                    {/* What the rooms on the way do to whoever walks through
                    them, and — the half that decides what to do — what would
                    stop it. A hundred rooms of the Silver River are a corridor
                    if you fetch a log raft first and a wall of damage if you
                    do not, and the client has known which items those are all
                    along and never said. */}
                    {(shown.hazards ?? []).map((hazard) => (
                      <span
                        className={hazard.unread || hazard.summons ? 'chip warn' : 'chip bad'}
                        key={hazard.spell}
                        title={
                          hazard.needsSpell.length > 0
                            ? t('cards.route.hazardSpell', {
                                spellList: hazard.needsSpell.join(', ')
                              })
                            : undefined
                        }
                      >
                        {[
                          hazard.rooms === 1
                            ? t('cards.route.hazardRooms.one', { spellName: hazard.spell })
                            : t('cards.route.hazardRooms.many', {
                                spellName: hazard.spell,
                                roomCount: hazard.rooms
                              }),
                          hazard.unread
                            ? t('cards.route.hazardUnread')
                            : hazard.summons && hazard.share === null
                              ? t('cards.route.hazardSummons')
                              : hazard.share === null
                                ? null
                                : // Under a percent is said as *under a percent*:
                                  // rounding it up to one is a figure the data
                                  // did not give, and rounding it to zero is a
                                  // reassurance it did not give either.
                                  hazard.share * 100 < 1
                                  ? t('cards.route.hazardSlight')
                                  : t('cards.route.hazardShare', {
                                      percent: Math.round(hazard.share * 100)
                                    })
                        ]
                          .filter((part) => part !== null)
                          .join(' · ')}
                      </span>
                    ))}
                    {/* And the offer to go and get what this way asks for,
                    beside the press it changes (todo 07). Wherever the need is
                    stated — a door this plan crosses or a spell its rooms cast
                    — because the reader's question is the same one either way,
                    and the alternative it used to hang off is absent exactly
                    when the plan itself is the way through the locked door.
                    The item is named here: the sentence that names it sits
                    below this row, and a tick that says only *it* is a tick
                    about something the reader has to go and look for. */}
                    {(() => {
                      const wanted = itemWanted(shown);
                      if (wanted === null) return null;
                      return (
                        <label className="route-collect">
                          <input
                            checked={collectFirst}
                            onChange={(event) => setCollectFirst(event.currentTarget.checked)}
                            onMouseDown={keepFocus}
                            type="checkbox"
                          />
                          {t('cards.route.collectFirst', { itemName: wanted.name })}
                        </label>
                      );
                    })()}
                    {/* And the toggle that says *walk up to it, not into it*.
                    Beside the press it changes, by the same rule as the tick
                    above: walking to a boss is walking to the doorway, and
                    the reader wants to be at the keyboard — or to have a
                    party standing with them — before the step that starts
                    the fight goes out. The destination is named because the
                    row it governs is a row about this journey, and the room
                    it will actually stop in is the tooltip: the reader can
                    see it two rows from the bottom of the list, and a label
                    carrying both names is a label nobody finishes reading.
                    Offered on any walkable plan, one step included — there
                    the answer is *you are already in the room before*, which
                    is a fact worth having and not nothing. */}
                    {(() => {
                      const into = shown.steps.at(-1);
                      if (into === undefined) return null;
                      const before = shown.steps.at(-2);
                      return (
                        <label
                          className="route-stop"
                          title={
                            before === undefined
                              ? undefined
                              : t('cards.route.stopShortTooltip', { roomName: before.name })
                          }
                        >
                          <input
                            checked={stopShort}
                            onChange={(event) => setStopShort(event.currentTarget.checked)}
                            onMouseDown={keepFocus}
                            type="checkbox"
                          />
                          {t('cards.route.stopShort', { roomName: into.name })}
                        </label>
                      );
                    })()}
                    {/* The one filled control in this panel, per §3.3: walking is
                    the action, everything else here is reading. */}
                    {/* Also the form's default action, so Enter walks it. */}
                    <button className="primary" title={t('cards.route.walkTooltip')} type="submit">
                      {t('cards.route.walkButton')}
                    </button>
                  </div>
                  {/* What this way itself crosses that the character cannot
                  pass: a door below both skills, walked because nothing else
                  leads there. Said at the head, because the walker will stop
                  at that door and somebody about to walk eighty steps to it
                  should know first; and *there is no other way* only where
                  the router looked and none of the routes it planned beside
                  this one avoids the door. */}
                  {(shown.walls ?? []).length > 0 && (
                    <div className="route-needs">
                      <span>{t('cards.route.crossesWalls')}</span>
                      <ul className="route-blocked">
                        {shown.walls!.map((block, index) => (
                          <li key={`${block.kind}-${index}`}>{describeBlock(block)}</li>
                        ))}
                      </ul>
                      {shown === route &&
                        ![route.otherWay, route.carrying].some(
                          (other) => other !== undefined && avoidsWalls(other, route.walls!)
                        ) && <span>{t('cards.route.noOtherWay')}</span>}
                    </div>
                  )}
                  {/* A walkable route that crosses a wall carries what the
                  cheaper way needed. Said before the steps, one condition per
                  line as the refusal says them, because the reader deciding
                  between four hundred steps through doors that will not open
                  and fetching a talisman needs the second half of that choice. */}
                  {(shown.blocks ?? []).length > 0 && (
                    <div className="route-needs">
                      <span>{t('cards.route.shorterNeeds')}</span>
                      <ul className="route-blocked">
                        {shown.blocks!.map((block, index) => (
                          <li key={`${block.kind}-${index}`}>{describeBlock(block)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* What to carry so the rooms on the way stop hurting. At
                  the top, where the decision is made: a route that says *carry
                  a log raft* before its first step is a route somebody walks
                  once, and the same route without the sentence is one they
                  walk and then rest for ten minutes. Only what the pack does
                  not already hold — the router has already stopped pricing
                  what it does. */}
                  {(() => {
                    const needs = new Map<number, string>();
                    for (const hazard of shown.hazards ?? []) {
                      for (const item of hazard.needs) needs.set(item.id, item.name);
                    }
                    if (needs.size === 0) return null;
                    return (
                      <div className="route-needs">
                        <span>{t('cards.route.hazardCarry')}</span>
                        <ul className="route-blocked">
                          {[...needs].map(([id, name]) => (
                            <li key={id}>{name}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                  {/* And the other routes main planned beside this one, where
                  it found any: the way round the worst of it, and the way
                  with the right items. Offered rather than substituted —
                  which to walk is a judgement about the character's own state
                  that this panel cannot make, and the whole reason they are
                  here is that the client used to make it silently and then
                  say there was no choice. Folded under one line until asked
                  for, and the plan itself joins the list once something else
                  is on screen, so there is always a way back. */}
                  {(() => {
                    const items: Array<{
                      key: 'plan' | 'round' | 'carrying';
                      sentence: string;
                    }> = [];
                    if (chosen !== 'plan') {
                      items.push({
                        key: 'plan',
                        sentence: t('cards.route.alternative.plan', {
                          stepCount: route.steps.length
                        })
                      });
                    }
                    if (route.otherWay !== undefined && chosen !== 'round') {
                      items.push({
                        key: 'round',
                        sentence: t('cards.route.alternative.round', {
                          stepCount: route.otherWay.steps.length
                        })
                      });
                    }
                    if (route.carrying !== undefined && chosen !== 'carrying') {
                      const named = new Map<number, string>();
                      for (const hazard of route.carrying.hazards ?? []) {
                        for (const item of hazard.needs) named.set(item.id, item.name);
                      }
                      items.push({
                        key: 'carrying',
                        sentence: t('cards.route.alternative.carrying', {
                          itemList: [...named.values()].join(', '),
                          stepCount: route.carrying.steps.length
                        })
                      });
                    }
                    if (items.length === 0) return null;
                    return (
                      <div className="route-alternatives">
                        <button
                          aria-expanded={offering}
                          className="quiet"
                          onClick={() => setOffering((open) => !open)}
                          onMouseDown={keepFocus}
                          type="button"
                        >
                          <Icon name={offering ? 'chevronUp' : 'chevronDown'} />
                          {items.length === 1
                            ? t('cards.route.alternatives.one')
                            : t('cards.route.alternatives.many', { count: items.length })}
                        </button>
                        {offering && (
                          <ul>
                            {items.map((item) => (
                              <li key={item.key}>
                                <span>{item.sentence}</span>
                                <button
                                  className="quiet"
                                  onClick={() => {
                                    setChosen(item.key);
                                    setOffering(false);
                                  }}
                                  onMouseDown={keepFocus}
                                  title={t('cards.route.otherWayTooltip')}
                                  type="button"
                                >
                                  {t('cards.route.otherWayButton')}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })()}
                  {/*
                   * The steps — with a run of rooms that read the same folded
                   * into one row wearing the count (`runsOf`). *Slum Street*
                   * three times is one row saying ×3 until its chevron is
                   * pressed; a room with a chip of its own keeps its own line,
                   * because a chip folded into a neighbour's row is one the
                   * reader never sees.
                   */}
                  <ol className="route-steps">
                    {(() => {
                      const steps = shown.steps;
                      /*
                       * The step *Stop before entering* drops is drawn as its
                       * own row, never folded into a run of rooms that will be
                       * walked: a head saying ×3 cannot also say that one of
                       * the three is skipped. The tick is at the top of a list
                       * that scrolls, so by the time the reader is down here it
                       * is off the screen — and a list that draws the last step
                       * exactly like the others is a list stating the opposite
                       * of what the press will do.
                       */
                      const skipped = stopShort && steps.length > 0 ? steps.length - 1 : -1;
                      const signatures = steps.map(stepSignature);
                      const runs =
                        skipped < 0
                          ? runsOf(signatures)
                          : [...runsOf(signatures.slice(0, -1)), { start: skipped, count: 1 }];
                      const row = (
                        step: (typeof steps)[number],
                        index: number,
                        folded: boolean
                      ) => (
                        <li
                          className="step"
                          data-folded={folded ? 'true' : undefined}
                          data-picked={picked === index ? 'true' : 'false'}
                          data-skipped={index === skipped ? 'true' : undefined}
                          key={`${step.to}-${index}`}
                        >
                          <span className="step-command">{step.command}</span>
                          {/*
                            The room, and the way to stop short at it.

                            `button.lookup` rather than a control of its own: a
                            name in a row of text is text that happens to be
                            clickable and takes the row's height, which is the
                            rule that keeps this list from turning into a column
                            of 32px controls holding 12px of text.

                            Picking toggles, so the same click undoes it — there
                            is no other way back from a pick, and a selection you
                            cannot clear is a mode.
                          */}
                          <button
                            aria-pressed={picked === index}
                            className="lookup step-name"
                            onClick={() => setPicked(picked === index ? null : index)}
                            /*
                             * Pointing at a room on the list opens the realm's
                             * answer about it — the same panel the map opens, so
                             * *four lairs on the way* can be read one room at a
                             * time rather than walked into. The dwell and the
                             * linger are the window's, like the map's.
                             */
                            onPointerEnter={(event) => peek(step.to, event.currentTarget, false)}
                            onPointerLeave={onPeekEnd ?? undefined}
                            title={step.name}
                            type="button"
                          >
                            {step.name}
                          </button>
                          {picked === index && (
                            /*
                              On the row rather than beside `Walk it`, because
                              `.route-body` scrolls as one: on a forty-seven-step
                              route the summary is off the top of the panel by
                              the time somebody has clicked a room near the
                              bottom, and a button they cannot see is a button
                              that is not there. `type="button"` because the form
                              already submits as `Walk it`, and the whole point of
                              this one is that it walks somewhere else.
                            */
                            <button
                              className="step-walk"
                              onClick={() => walk({ ...shown, steps: steps.slice(0, index + 1) })}
                              title={t('cards.route.walkHereTooltip', { roomName: step.name })}
                              type="button"
                            >
                              {t('cards.route.walkHereButton')}
                            </button>
                          )}
                          {index === skipped && (
                            <span className="chip quiet">{t('cards.route.stepSkipped')}</span>
                          )}
                          {chips(step)}
                        </li>
                      );
                      return runs.flatMap(({ start, count }) => {
                        if (count === 1) return [row(steps[start]!, start, false)];
                        const first = steps[start]!;
                        const open = unfolded.has(start);
                        const members = steps.slice(start, start + count);
                        const head = (
                          <li
                            className="group"
                            data-open={open ? 'true' : 'false'}
                            key={`run-${start}`}
                          >
                            <span
                              className="step-command"
                              title={members.map((step) => step.command).join(' ')}
                            >
                              {commandsOf(members)}
                            </span>
                            <button
                              aria-expanded={open}
                              className="lookup step-fold"
                              onClick={() =>
                                setUnfolded((current) => {
                                  const next = new Set(current);
                                  if (next.has(start)) next.delete(start);
                                  else next.add(start);
                                  return next;
                                })
                              }
                              onMouseDown={keepFocus}
                              title={
                                open
                                  ? t('cards.route.unfoldTooltip')
                                  : t('cards.route.foldTooltip', { count })
                              }
                              type="button"
                            >
                              <span className="fold-name">{first.name}</span>
                              <span className="chip quiet">
                                {t('cards.route.foldCount', { count })}
                              </span>
                              <Icon name={open ? 'chevronUp' : 'chevronDown'} />
                            </button>
                            {chips(first)}
                          </li>
                        );
                        return open
                          ? [
                              head,
                              ...members.map((step, offset) => row(step, start + offset, true))
                            ]
                          : [head];
                      });
                    })()}
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
