import { memo, useEffect, useState } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import Icon, { type IconName } from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { CharacterState } from '@shared/character';
import type { LoopProgress } from '@shared/loops';
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
  onStopWalk(): void;
  onStartLoop(name: string): void;
  onPauseLoop(): void;
  onResumeLoop(): void;
  onStopLoop(): void;
  onSkipLoop(): void;
  onReverseLoop(): void;
}

/**
 * Where the character is going, in the two ways it can be going anywhere.
 *
 * **Walking and looping are one card with two faces**, and were two cards until
 * 2026-08-31. They are the same subject asked twice — *where is this character
 * headed* — and they are mutually exclusive in practice: a loop's legs are
 * walks the loop owns, so while one runs the other's card is describing the
 * loop's own footwork rather than anything the player asked for. Two cards
 * meant the rail carried both at once, each half-repeating the other: the Route
 * card grew `Loop`, `Stop` and `Stop looping` rows, and the Loop card grew a
 * stop counter the Route card was already drawing as a bar.
 *
 * So: `ROUTE` and `LOOP`, and **the face follows what is actually happening**.
 * Start a loop and the card shows the loop; walk a route and it shows the
 * route. The other face is one click away and stays where it is put until the
 * activity itself changes — the console printing is not news in the chrome, and
 * a face that snapped back on every step would be exactly that.
 *
 * The order is fixed whether or not either is running, so a face never moves
 * out from under the pointer, and each face carries its own badge and its own
 * copy text: copying a lap count while the route is on screen would put
 * something the reader cannot see on the clipboard.
 */
function NavigationCard({
  walk,
  loop,
  character,
  loops,
  onChoose,
  onStopWalk,
  onStartLoop,
  onPauseLoop,
  onResumeLoop,
  onStopLoop,
  onSkipLoop,
  onReverseLoop,
  ...chrome
}: NavigationCardProps) {
  const running = loop.status === 'running';
  const paused = loop.status === 'paused';
  const live = running || paused;

  /*
   * A one-second tick, only while there is something to count: how long the
   * loop has run moves on its own, and a card that showed it frozen at the
   * last push would be a card lying about the time.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), tuning().clockTickMs);
    return () => window.clearInterval(id);
  }, [live]);

  /*
   * Which face the activity asks for, and which is on screen.
   *
   * A **running or paused loop owns the card**, because its legs are walks it
   * owns: while one runs, the route face is describing the loop's own footwork
   * rather than anything the player asked for. Otherwise a walk with something
   * to say gets it. An idle character lands on the loop face, because that is
   * the one with a control on it — the picker and its play button; landing on
   * an empty route readout would be a card offering nothing to somebody who
   * has a dozen loops written down.
   */
  const wants = live || walk.status === 'idle' ? 'loop' : 'route';

  /*
   * And *when* the card is allowed to move itself, which is the harder half.
   *
   * Not on every push: a loop pushes twice a stop and a walk once a step, and
   * a card that re-picked its face on each would take the face back from
   * somebody who had just clicked the other one — the console printing is not
   * news in the chrome, and this is the same rule read through a face.
   *
   * Not on `wants` alone either, which was the first attempt and was wrong in
   * one exact place: `wants` does not move between one loop run and the next,
   * so a player who had clicked Route mid-run stayed on Route through
   * stopping that loop and starting a *different* one — a fresh decision the
   * card ignored. The smoke run caught it.
   *
   * So: the identity of the thing being done. A loop run is its `startedAt`,
   * which moves once per run; a route is its destination, which moves once per
   * plan. Constant for every push within one activity, different the moment
   * there is a new one to look at.
   */
  const activity = live ? `loop:${loop.startedAt ?? ''}` : `route:${walk.destination ?? ''}`;
  const [face, setFace] = useState(wants);
  useEffect(() => setFace(wants), [activity]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The picker's choice, by name; the first loop until somebody chooses. */
  const [picked, setPicked] = useState('');
  const choice =
    loops?.some((entry) => entry.name === picked) === true ? picked : (loops?.[0]?.name ?? '');
  const canPick = !live && loops !== null && loops.length > 0;

  const ranFor = loop.startedAt !== null && live ? now - loop.startedAt : null;
  const made =
    loop.expAtStart !== null && character.progress.exp !== null && live
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
   * The route, on its own: where the walk is going and how far through it is.
   *
   * The reason matters more than the bar. A walk ends on a shut door, a room
   * the route did not predict, a fight, or the player taking the wheel — and
   * "it stopped and I do not know why" is exactly the state
   * docs/legacy-assessment.md §6 argues a decision trace exists to prevent. So
   * the reason is shown in full, and it stays on screen after the walk ends
   * rather than the face going blank with the answer.
   *
   * Nothing here says a word about loops any more. A loop's legs are its own
   * business, and `Stop looping` on this face was a control for something the
   * face beside it drives.
   */
  const routeFace = (
    <>
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

      {walking && (
        <button
          className="quiet walk-stop"
          onClick={onStopWalk}
          onMouseDown={keepFocus}
          type="button"
        >
          {t('cards.navigation.route.stopButton')}
        </button>
      )}
    </>
  );

  const controls: Array<{ id: string; label: string; icon: IconName; run(): void }> = [];
  if (running) {
    controls.push({
      id: 'pause',
      label: t('cards.navigation.loop.actions.pause'),
      icon: 'pause',
      run: onPauseLoop
    });
  } else if (paused) {
    controls.push({
      id: 'resume',
      label: t('cards.navigation.loop.actions.resume'),
      icon: 'play',
      run: onResumeLoop
    });
  } else if (canPick) {
    controls.push({
      id: 'play',
      label: t('cards.navigation.loop.actions.play'),
      icon: 'play',
      run: () => onStartLoop(choice)
    });
  }
  if (live) {
    controls.push({
      id: 'stop',
      label: t('cards.navigation.loop.actions.stop'),
      icon: 'stop',
      run: onStopLoop
    });
    controls.push({
      id: 'skip',
      label: t('cards.navigation.loop.actions.skip'),
      icon: 'skip',
      run: onSkipLoop
    });
    // Only a bounce loop has a direction; a control that does nothing is worse
    // than none, so a plain loop is not offered one.
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
      {controls.length > 0 && (
        <div className="loop-controls" role="toolbar" aria-label={t('cards.navigation.loop.title')}>
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
      )}

      <div className="walk-destination">
        {/*
          The picker carries no `keepFocus`, and it is the one control in the
          rail that must not: on a `<select>` the default that `keepFocus`
          prevents *is* the popup opening, so this looked like a control that
          did nothing — every loop was in the list and clicking it showed none
          of them. The caret is handed back on `change` instead, which is the
          same promise kept a moment later. See `lib/focus.ts`.
        */}
        {canPick ? (
          <select
            aria-label={t('cards.navigation.loop.pickerLabel')}
            className="loop-card-picker"
            onChange={(event) => {
              setPicked(event.target.value);
              chrome.returnFocus?.();
            }}
            value={choice}
          >
            {loops.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : (
          (loop.name ?? '—')
        )}
      </div>

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

        {live && (
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

  const tabs: CardTab[] = [
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
    },
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
  ];

  return (
    <BentoCard
      {...chrome}
      active={face}
      badge={face === 'loop' ? loopChip(loop) : walkChip(walk)}
      className="navigation-card"
      onActive={setFace}
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
  if (walk.status === 'walking' && walk.hold === 'health') {
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
 * `resting` and `fighting` are the two *holds* a running loop can be in, and
 * both are holds the client imposed rather than ones the player asked for —
 * which is what `paused` means. `resting` wears the accent rather than `warn`
 * so the two cannot be read as one. Since the dwell countdown went, this chip
 * is the only place a hold is stated, which is where it belonged: the row that
 * used to carry it said `Leaving in — fighting here first` beside a chip
 * already reading `FIGHTING`.
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
  if (loop.status === 'running') {
    return <span className="chip on">{t('cards.navigation.loop.statusRunning')}</span>;
  }
  if (loop.status === 'paused') {
    return <span className="chip warn">{t('cards.navigation.loop.statusPaused')}</span>;
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
