import { memo, useEffect, useState } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import Icon, { type IconName } from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { CharacterState } from '@shared/character';
import type { LoopProgress } from '@shared/loops';
import { movementOf } from '@shared/movement';
import type { WalkProgress } from '@shared/walk';
import { tuning } from '../lib/tuning';

export interface NavigationCardProps extends CardChrome {
  walk: WalkProgress;
  loop: LoopProgress;
  character: CharacterState;
  /**
   * The character's own loops, to pick one to run. Null on a pinned float,
   * whose list belongs to the shown character: with nothing to pick from the
   * card offers no picker, and its controls still address its own character.
   */
  loops: ReadonlyArray<{ name: string; stops: number }> | null;
  /**
   * Opens the route panel on a room the walk names — the map's own control.
   * Null on a pinned float, whose route panel belongs to the shown character:
   * with nothing to open, the names stay text rather than becoming a control
   * bound to nowhere.
   */
  onChoose: ((map: number, room: number) => void) | null;
  /**
   * Play. The argument is what the picker says: a lap by name, or null for the
   * resume entry, which means *pick back up whatever is stopped*. Main decides
   * which of the two that is; see `SessionManager.startMoving`.
   */
  onStart(loop: string | null): void;
  /** Stop, whichever of the two is running. The place is kept. */
  onStop(): void;
  onSkipLoop(): void;
  onReverseLoop(): void;
}

/**
 * Where the character is going — **one face, because it is doing one thing**.
 *
 * Two cards until 2026-08-31, then one card with two faces, and one face since
 * 2026-09-11. The faces were the last of the old shape: `ROUTE` and `LOOP` were
 * both drawn whatever the character was doing, each with transport controls of
 * its own, so *stop* meant one thing on one crumb and another on the other and
 * the card never said plainly which of them was happening.
 *
 * A player has three words for this and the card now uses them: **routing**,
 * **looping**, **stopped**. `movementOf` (`src/shared/movement.ts`) answers
 * which, and the card draws that one and no other — looping hides the route,
 * routing hides the lap, and neither says *Not currently moving*. A loop's legs
 * are routes, but that is the mechanism rather than the thing happening, and a
 * card that reported the mechanism was reporting the client's own footwork.
 *
 * The transport is the movement's, not the lap's: **play and stop**, with skip
 * and reverse beside them where there is a lap for them to mean anything.
 * There is no pause — a stop keeps its place, and pressing play picks it back
 * up from wherever the character has got to.
 *
 * The picker is **what play will move** — whatever is stopped, then the laps —
 * so there is one control and one meaning wherever the card is, and a lap is
 * still one press away from a route that ended at a shut door.
 */
function NavigationCard({
  walk,
  loop,
  character,
  loops,
  onChoose,
  onStart,
  onStop,
  onSkipLoop,
  onReverseLoop,
  ...chrome
}: NavigationCardProps) {
  const movement = movementOf(walk, loop);
  const running = loop.status === 'running';
  const live = movement.kind === 'loop';

  /*
   * A one-second tick, only while there is something to count: how long the
   * loop has run moves on its own, and a card that showed it frozen at the
   * last push would be a card lying about the time.
   *
   * Keyed on `running` rather than on the lap being the movement, because a
   * stopped lap is not running for anything — a clock still counting under a
   * character standing still is the same lie the other way round.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), tuning().clockTickMs);
    return () => window.clearInterval(id);
  }, [running]);

  /*
   * **The picker is what play will move**, which is one control and one
   * meaning: whatever is stopped first, then every lap this character has
   * written down.
   *
   * The resume entry carries an empty value rather than a name, so *pick it
   * back up* never has to be told apart from *start the lap that happens to be
   * called that* — main is asked with `null` and answers from what it actually
   * stopped (`SessionManager.startMoving`). It is also what keeps a lap
   * reachable from a stopped route: without it, a route that ended at a shut
   * door left the card with no way to start anything, and a lap only reachable
   * from the palette is a lap somebody stops using.
   *
   * Shown only while nothing is moving — it is what play would start, and
   * while something is moving play is not offered.
   */
  const resumeLabel = !movement.resumable
    ? null
    : movement.kind === 'loop'
      ? t('cards.navigation.resumeLoopOption', { loopName: loop.name ?? '—' })
      : t('cards.navigation.resumeRouteOption', { destination: walk.destination ?? '—' });
  const options: Array<{ value: string; label: string }> = [
    ...(resumeLabel === null ? [] : [{ value: '', label: resumeLabel }]),
    ...(loops ?? []).map((entry) => ({ value: entry.name, label: entry.name }))
  ];
  const [picked, setPicked] = useState('');
  const choice = options.some((option) => option.value === picked)
    ? picked
    : (options[0]?.value ?? '');
  /*
   * `loops === null` is a pinned float, whose list belongs to the character on
   * screen rather than to this one — so it offers no picker at all, not a
   * one-entry one. `options.length > 0` alone drew exactly that: the resume
   * entry with nothing to choose between, a control that could only ever do
   * what the play button beside it already does.
   */
  const canPick = !movement.moving && loops !== null && options.length > 0;

  /*
   * The two figures a lap earns, and both are only true **while it runs**: a
   * stopped lap has not been running for another minute, and experience the
   * character won fighting by hand afterwards is not experience the lap made.
   */
  const ranFor = loop.startedAt !== null && running ? now - loop.startedAt : null;
  const made =
    loop.expAtStart !== null && character.progress.exp !== null && running
      ? character.progress.exp - loop.expAtStart
      : null;

  /*
   * A room the character is not in is a control, not text: the destination
   * and the step's room both open in the route panel, where the realm's facts
   * about a room elsewhere are stated. `button.lookup`, the same control a
   * name in a row is, so it reads as clickable without becoming a chip. Two
   * things keep a name as text, both because a control bound to nowhere is
   * worse than none: a room whose id did not parse, and a card on a pinned
   * float, whose route panel is the shown character's.
   */
  const place = (name: string, room: { map: number; room: number } | null) => {
    if (room === null || onChoose === null) return name;
    const label = t('cards.navigation.route.roomTooltip', { roomName: name });
    return (
      <button
        aria-label={label}
        className="lookup"
        onClick={() => onChoose(room.map, room.room)}
        onMouseDown={keepFocus}
        title={label}
        type="button"
      >
        {name}
      </button>
    );
  };

  const walking = walk.status === 'walking';

  /*
   * The transport, which is the movement's and not the lap's.
   *
   * **Play or stop, never both** — a character is going or it is not, and a row
   * carrying one live control and one dead one spends a slot saying what the
   * live one already says. There is no pause: stopping keeps the lap's place
   * and the route's destination, so play is the resume, and a third word for
   * the same state was a distinction the player had to hold and the client
   * could not keep.
   *
   * Skip and reverse are the lap's own and are drawn only where there is a lap
   * for them to mean anything — reverse only on a bounce loop, since a plain
   * one runs its list one way and `nextStop` ignores the direction.
   */
  const controls: Array<{ id: string; label: string; icon: IconName; run(): void }> = [];
  if (movement.moving) {
    controls.push({
      id: 'stop',
      label: t('cards.navigation.actions.stop'),
      icon: 'stop',
      run: onStop
    });
  } else if (movement.resumable || canPick) {
    controls.push({
      id: 'play',
      label:
        choice === '' ? t('cards.navigation.actions.resume') : t('cards.navigation.actions.play'),
      icon: 'play',
      // The empty value is the resume entry: main is asked with `null` and
      // answers from what it actually stopped.
      run: () => onStart(choice === '' ? null : choice)
    });
  }
  if (live) {
    controls.push({
      id: 'skip',
      label: t('cards.navigation.loop.actions.skip'),
      icon: 'skip',
      run: onSkipLoop
    });
    if (loop.bounce) {
      controls.push({
        id: 'reverse',
        label: t('cards.navigation.loop.actions.reverse'),
        icon: 'reverse',
        run: onReverseLoop
      });
    }
  }

  /*
   * One transport row, drawn at the head of whichever face is on screen — the
   * controls belong to the card rather than to a face, and a row that moved or
   * vanished with the movement's kind would be a control changing place under
   * the pointer for a reason the player did not cause.
   */
  const transport = controls.length > 0 && (
    <div className="loop-controls" role="toolbar" aria-label={t('cards.navigation.title')}>
      {controls.map((control) => (
        <button
          aria-label={control.label}
          className="quiet loop-control"
          data-action={control.id}
          key={control.id}
          onClick={control.run}
          // Chrome is read, not typed into: the caret stays in the game.
          onMouseDown={keepFocus}
          title={control.label}
          type="button"
        >
          <Icon name={control.icon} />
        </button>
      ))}
    </div>
  );

  const picker = (
    <div className="walk-destination">
      {/*
        The picker carries no `keepFocus`, and it is the one control in the
        rail that must not: on a `<select>` the default that `keepFocus`
        prevents *is* the popup opening, so this looked like a control that
        did nothing — every loop was in the list and clicking it showed none
        of them. The caret is handed back on `change` instead, which is the
        same promise kept a moment later. See `lib/focus.ts`.
      */}
      {
        <select
          aria-label={t('cards.navigation.loop.pickerLabel')}
          className="loop-card-picker"
          onChange={(event) => {
            setPicked(event.target.value);
            chrome.returnFocus?.();
          }}
          value={choice}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      }
    </div>
  );

  /*
   * The route, on its own: where the walk is going and how far through it is.
   *
   * The reason matters more than the bar. A walk ends on a shut door, a room
   * the route did not predict, a fight, or the player taking the wheel — and
   * "it stopped and I do not know why" is exactly the state
   * docs/legacy-assessment.md §6 argues a decision trace exists to prevent. So
   * the reason is shown in full, and it stays on screen after the walk ends
   * rather than the face going blank with the answer.
   *
   * Nothing here says a word about loops, and nothing here stops anything: the
   * transport row above is the movement's one play and one stop, and a `Stop`
   * button of this face's own was half of why *stop* meant two things.
   */
  const routeFace = (
    <>
      {transport}
      {canPick && picker}
      <div className="walk-destination">
        {walk.destination === null ? '—' : place(walk.destination, walk.destinationRoom)}
      </div>

      {/* Steps confirmed, not steps sent: the difference is the whole design.
          A bar that filled on send would show progress through a route the
          character may not be walking. */}
      <div className="meter walk-meter" data-level={walking ? 'ok' : 'unknown'}>
        <div
          className="fill"
          style={{ width: `${walk.total === 0 ? 0 : (walk.done / walk.total) * 100}%` }}
        />
        <span className="meter-label">
          {t('cards.navigation.route.meterLabel', { done: walk.done, total: walk.total })}
        </span>
      </div>

      {/*
        And what is left, which is the half this face never showed.
        
        A bar says how far along and the row below says what is happening now;
        between them they answer *what have I done* and *what am I doing*,
        leaving *what is left* — the one a player actually acts on. Drawn as the
        shared progression grammar (`.progression`), so a lap's stops and a
        quest's steps read the same way as this.
      */}
      {walking && walk.ahead.length > 0 && (
        <div className="progression-scroller">
          <ol className="progression">
            {walk.ahead.map((name, index) => (
              <li data-progress={index === 0 ? 'now' : 'left'} key={`${name}-${index}`}>
                <span className="step-name">{name}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {walking && walk.step && (
        <dl className="readout">
          <dt>{t('cards.navigation.route.sendingLabel')}</dt>
          <dd>
            <span className="step-command">{walk.step.command}</span>
          </dd>
          <dt>{t('cards.navigation.route.towardLabel')}</dt>
          <dd>{place(walk.step.name, walk.step.to)}</dd>
          {walk.step.note !== null && (
            <>
              <dt>{t('cards.navigation.route.gatedLabel')}</dt>
              <dd className="inert">{walk.step.note}</dd>
            </>
          )}
        </dl>
      )}

      {/* A reason only ever exists on a walk that has *stopped* — `start`
          clears it and an arrival sets it to null — so it is labelled as the
          outcome it is. Drawn bare it read as a live condition, and
          `you are in combat` sat under a Combat card saying the opposite for
          as long as the card was open. Not a `<dl>` row: the readout above is
          this card's one grid, and a second would be two label columns of
          different widths inside one card. */}
      {walk.reason !== null && (
        <div className="walk-reason">
          {t('cards.navigation.route.endedReason', { reason: walk.reason })}
        </div>
      )}
    </>
  );

  /*
   * The loop: which one, how far round it, and what it has bought.
   *
   * Laid out as the route face is — the name, then a bar, then the figures —
   * because they answer the same question and reading one should not be a
   * different gesture from reading the other. The bar replaced `Stop: 1/2 ·
   * Newhaven, Arena` as a row of text, which was a fraction rendered as words
   * beside a card that was already drawing the identical fraction as a bar.
   *
   * `stop` is the stop the loop is *at or heading for*, so the bar reads full
   * on the last one and starts again at the next lap. Deliberately not
   * `(stop - 1) / stops`, which is the more literal reading of "progress
   * round the lap" and would draw an empty bar under a label saying `1/2`.
   *
   * Every figure is a difference between two numbers the client has, and none
   * is a `0` standing in for "unknown": experience made is claimed only when
   * the count was known when the loop started.
   */
  const loopFace = (
    <>
      {transport}
      {canPick ? picker : <div className="walk-destination">{loop.name ?? '—'}</div>}

      {loop.stops > 0 && (
        <div className="meter walk-meter" data-level={running ? 'ok' : 'unknown'}>
          <div className="fill" style={{ width: `${(loop.stop / loop.stops) * 100}%` }} />
          <span className="meter-label">
            {t('cards.navigation.loop.meterLabel', {
              stop: loop.stop,
              stops: loop.stops,
              stopName: loop.stopName ?? '—'
            })}
          </span>
        </div>
      )}

      {/*
        The lap, all of it: the stops behind, the one being walked to, and the
        ones still owed. `stop` is one-based and names the stop it is *at or
        heading for*, so it is the `now` row and everything before it is done.
        Every stop the player wrote, including the ones no room could be found
        for — the lap they wrote is the lap they want to read.
      */}
      {loop.stopNames.length > 0 && (
        <div className="progression-scroller">
          <ol className="progression">
            {loop.stopNames.map((name, index) => (
              <li
                data-progress={
                  !live || loop.stop === 0
                    ? 'left'
                    : index < loop.stop - 1
                      ? 'done'
                      : index === loop.stop - 1
                        ? 'now'
                        : 'left'
                }
                key={`${name}-${index}`}
              >
                <span className="step-name">{name}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <dl className="readout">
        {loop.bounce && live && (
          <>
            <dt>{t('cards.navigation.loop.directionLabel')}</dt>
            <dd>
              {loop.forward
                ? t('cards.navigation.loop.directionForward')
                : t('cards.navigation.loop.directionBackward')}
            </dd>
          </>
        )}

        {loop.status !== 'idle' && (
          <>
            <dt>{t('cards.navigation.loop.lapsLabel')}</dt>
            <dd>{loop.laps}</dd>
          </>
        )}

        {ranFor !== null && (
          <>
            <dt>{t('cards.navigation.loop.runningForLabel')}</dt>
            <dd>{duration(ranFor)}</dd>
          </>
        )}

        {running && (
          <>
            <dt>{t('cards.navigation.loop.madeLabel')}</dt>
            <dd>{made === null ? '—' : made.toLocaleString()}</dd>
          </>
        )}

        {loop.status === 'stopped' && loop.reason !== null && (
          <>
            <dt>{t('cards.navigation.loop.endedLabel')}</dt>
            <dd className="inert">{loop.reason}</dd>
          </>
        )}
      </dl>
    </>
  );

  /*
   * Nothing is being walked and nothing is remembered, which is a state worth
   * saying out loud rather than an empty card: *Not currently moving.* The
   * picker and its play button are here too, because this is exactly the
   * moment somebody with a dozen laps written down wants one.
   */
  const idleFace = (
    <>
      {transport}
      {canPick && picker}
      <div className="walk-reason">{t('cards.navigation.idle.nothing')}</div>
    </>
  );

  /*
   * **One face, named for what is happening.** The label is the card's own
   * title where nothing is, which is the rule every card whose first face is
   * the card follows.
   */
  const tabs: CardTab[] =
    movement.kind === 'route'
      ? [
          {
            id: 'route',
            label: t('cards.navigation.route.title'),
            content: routeFace,
            copyText: () =>
              [
                walk.destination ?? '—',
                t('cards.navigation.route.meterLabel', { done: walk.done, total: walk.total }),
                // The same words the face shows: copying a card must never put
                // something the reader cannot see on the clipboard.
                walk.reason === null
                  ? ''
                  : t('cards.navigation.route.endedReason', { reason: walk.reason })
              ]
                .filter((line) => line.length > 0)
                .join('\n')
          }
        ]
      : movement.kind === 'loop'
        ? [
            {
              id: 'loop',
              label: t('cards.navigation.loop.title'),
              content: loopFace,
              copyText: () =>
                [
                  loop.name ?? '',
                  loop.stops > 0
                    ? t('cards.navigation.loop.meterLabel', {
                        stop: loop.stop,
                        stops: loop.stops,
                        stopName: loop.stopName ?? ''
                      })
                    : '',
                  `${t('cards.navigation.loop.lapsLabel')}: ${loop.laps}`
                ]
                  .filter((line) => line.length > 0)
                  .join('\n')
            }
          ]
        : [
            {
              id: 'idle',
              label: t('cards.navigation.title'),
              content: idleFace,
              copyText: () => t('cards.navigation.idle.nothing')
            }
          ];

  return (
    <BentoCard
      {...chrome}
      badge={
        movement.kind === 'loop'
          ? loopChip(loop)
          : movement.kind === 'route'
            ? walkChip(walk)
            : null
      }
      className="navigation-card"
      tabs={tabs}
      title={t('cards.navigation.title')}
    />
  );
}

/** How far through the route, or how it ended. */
function walkChip(walk: WalkProgress) {
  /*
   * A hold outranks the step count, for the reason the loop's chip already
   * records: a route standing still at `3/29` reads as a walk in progress that
   * has stopped making progress, which is what a broken client looks like.
   * `info` and not `warn`, and the same word the loop uses for the same state
   * — this is the client waiting for the character to be fit to travel, not
   * something the player asked for or anything having gone wrong.
   */
  if (walk.status === 'walking' && (walk.hold === 'health' || walk.hold === 'trap')) {
    return <span className="chip info">{t('cards.navigation.loop.statusResting')}</span>;
  }
  /*
   * And the same for a fight, in the same words the loop uses — a route waits
   * one out and walks on rather than ending (`Walker.holdForFight`), and this
   * chip is the *only* place it is stated: the console is deliberately silent
   * about it, because a line per wandering monster is the chrome talking over
   * the `*Combat Engaged*` the server has already printed in the room.
   */
  if (walk.status === 'walking' && walk.hold === 'fight') {
    return <span className="chip bad">{t('cards.navigation.loop.statusFighting')}</span>;
  }
  /*
   * Waiting out what the server said is on the character. `warn`, unlike the
   * two holds above: a condition is something somebody may want to come and
   * cure, where resting and fighting are the lap going as planned.
   */
  if (walk.status === 'walking' && walk.hold === 'blind') {
    return <span className="chip warn">{t('cards.navigation.loop.statusBlind')}</span>;
  }
  if (walk.status === 'walking' && walk.hold === 'held') {
    return <span className="chip warn">{t('cards.navigation.loop.statusHeld')}</span>;
  }
  if (walk.status === 'walking' && walk.hold === 'poisoned') {
    return <span className="chip warn">{t('cards.navigation.loop.statusPoisoned')}</span>;
  }
  /*
   * A shut door the ladder could not get past this round. `warn`, with the
   * afflictions rather than with resting and fighting: the walk is waiting for
   * something nothing in this client is working on, and whether to go round it
   * is a decision only the person can make.
   */
  if (walk.status === 'walking' && walk.hold === 'barrier') {
    return <span className="chip warn">{t('cards.navigation.route.badgeBlocked')}</span>;
  }
  /*
   * Looking for a hidden exit the realm says is there. `info` rather than
   * `warn` — the client *is* working on this one, and it has no ceiling, so a
   * warning that could stand for an hour would stop meaning anything.
   */
  if (walk.status === 'walking' && walk.hold === 'searching') {
    return <span className="chip info">{t('cards.navigation.route.badgeSearching')}</span>;
  }
  if (walk.status === 'walking') {
    return (
      <span className="chip">
        {walk.done}/{walk.total}
      </span>
    );
  }
  if (walk.status === 'arrived') {
    return <span className="chip ok">{t('cards.navigation.route.badgeArrived')}</span>;
  }
  if (walk.status === 'stopped') {
    return <span className="chip warn">{t('cards.navigation.route.badgeStopped')}</span>;
  }
  // Idle: nothing has been walked, and a chip saying so is chrome.
  return null;
}

/**
 * The loop's status as a tonal chip, in words as well as hue.
 *
 * Each branch is a literal `t()` call rather than a key built from the status
 * word, because the coverage test reads the literal after `t(` and a dynamic
 * key is one it cannot see.
 *
 * `resting` and `fighting` are *holds* a running loop can be in — the client
 * waiting for the character to be fit to walk on, rather than anything the
 * player asked for, which is what `stopped` means. Since the dwell countdown
 * went, this chip is the only place a hold is stated, which is where it
 * belonged: the row that used to carry it said `Leaving in — fighting here
 * first` beside a chip already reading `FIGHTING`.
 */
function loopChip(loop: LoopProgress) {
  // The connection went under the lap and the character is not yet back in
  // the realm and placed. `info` like the other holds the client imposes, and
  // the same word the tab wears for the closed socket, because it is the same
  // fact: a green `running` chip on a lap whose character is offline is the
  // thing every hold on this card exists to prevent.
  if (loop.status === 'running' && loop.hold === 'offline') {
    return <span className="chip info">{t('cards.navigation.loop.statusOffline')}</span>;
  }
  if (loop.status === 'running' && loop.hold === 'fight') {
    return <span className="chip bad">{t('cards.navigation.loop.statusFighting')}</span>;
  }
  if (loop.status === 'running' && loop.hold === 'health') {
    return <span className="chip info">{t('cards.navigation.loop.statusResting')}</span>;
  }
  // Ran away and standing still until the fight is over and the health is
  // back. `info` like `resting`, because it is the same kind of hold — the
  // client waiting for the character to be fit to walk on — and not `warn`,
  // which is what `paused` wears and means the player asked.
  if (loop.status === 'running' && loop.hold === 'retreated') {
    return <span className="chip info">{t('cards.navigation.loop.statusRetreated')}</span>;
  }
  // Standing still while the character goes shopping. `info` like the two
  // above and for their reason: the lap is held by the client, not by the
  // player, and a green `running` chip on a lap that is not moving is the
  // thing every hold on this card exists to prevent.
  if (loop.status === 'running' && loop.hold === 'errand') {
    return <span className="chip info">{t('cards.navigation.loop.statusErrand')}</span>;
  }
  // Waiting out a stated affliction before the next leg; `warn` for the
  // reason the walk's own chip gives — a condition may want curing.
  if (loop.status === 'running' && loop.hold === 'blind') {
    return <span className="chip warn">{t('cards.navigation.loop.statusBlind')}</span>;
  }
  if (loop.status === 'running' && loop.hold === 'held') {
    return <span className="chip warn">{t('cards.navigation.loop.statusHeld')}</span>;
  }
  if (loop.status === 'running' && loop.hold === 'poisoned') {
    return <span className="chip warn">{t('cards.navigation.loop.statusPoisoned')}</span>;
  }
  if (loop.status === 'running') {
    return <span className="chip on">{t('cards.navigation.loop.statusRunning')}</span>;
  }
  if (loop.status === 'stopped') {
    return <span className="chip">{t('cards.navigation.loop.statusStopped')}</span>;
  }
  return null;
}

/** `1h 02m` past an hour, `5m 12s` under it. Digits, so it stays in code. */
function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export default memo(NavigationCard);
