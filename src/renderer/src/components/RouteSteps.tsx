/**
 * The route panel's list of steps: a run of rooms that read the same folded
 * into one row wearing the count (`runsOf`), a picked room offering *Walk
 * here* and *Run here*, and the chips each room wears. Drawn whole by the
 * panel's old list and a leg at a time by the Legs view, so a room reads the
 * same in both. See `mudengine-ui` › `parts/map.md`.
 */
import Icon from './Icon';
import { commandsOf, gateWord, runsOf, stepDanger, stepSignature } from '../lib/route';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { RoomId, RouteStep } from '@shared/world';

export interface RouteStepsProps {
  /** The whole way on screen; the indexes below are into it. */
  steps: readonly RouteStep[];
  /** The stretch drawn, both ends included: a leg, or the whole way. */
  from: number;
  to: number;
  /** The step *Stop before entering* drops, drawn as its own row; −1 for none. */
  skipped: number;
  picked: number | null;
  onPick(index: number | null): void;
  unfolded: ReadonlySet<number>;
  onToggleRun(start: number): void;
  /** Walk, or run, only as far as a step. Null `run` where there is no *Run it* (a loop's leg). */
  walkHere(index: number): void;
  runHere: ((index: number) => void) | null;
  disabled: boolean;
  onPeek(room: RoomId, at: Element): void;
  onPeekEnd: (() => void) | undefined;
}

/**
 * The chips a step wears after its name: the gate, the room's own spell, the
 * lair. Written once because a folded run's row wears its first step's, and
 * the two rows must never disagree about what a room costs.
 */
export function StepChips({ step }: { step: RouteStep }) {
  const gate = gateWord(step);
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
      {step.requirement && step.invoke === undefined && (
        <span
          className={step.requirement.kind === 'trap' ? 'chip bad' : 'chip warn'}
          title={step.obstacle?.detail ?? step.requirement.raw}
        >
          {gate}
        </span>
      )}
      {/* And what the step **spends**, where it uses an item rather than
      making a move. This is the one thing on a plan that is not undone by
      walking back: a corridor costs nothing to re-walk and a potion is gone,
      so the count the realm states is on the row beside the command that
      spends it. It replaces the gate chip rather than sitting beside it —
      that requirement is the item itself (`edgePenalty`'s `item` rung is what
      prices the pack), so both drawn would say *needs potion of levitation*
      next to *single use* about one thing. */}
      {step.invoke !== undefined && (
        <span className="chip warn" title={step.invoke.command}>
          {step.invoke.uses === null
            ? t('cards.route.spendsForever')
            : step.invoke.uses === 1
              ? t('cards.route.spendsOnce')
              : t('cards.route.spendsUses', { useCount: step.invoke.uses })}
        </span>
      )}
      {/* And what the room itself does to whoever stands in it. A chip
      rather than a figure per step: on a route that crosses eight hundred of
      them the number is the same eight hundred times, and the figure that
      decides is at the head. A discouragement — a chain nobody could read,
      a summons — is the word, never the share it was priced at: `2%` beside
      a room whose spell is unread was read as a lair figure. */}
      {step.hazard !== undefined && (
        <span
          className={step.hazardKind === undefined ? 'chip bad' : 'chip warn'}
          /* The two words that are a *discouragement* rather than a figure say
             so on hover: neither is a reading that the room is dangerous, and
             `unread` in particular is the absence of a reading — which is not
             what the word says on its own (todo 01). */
          title={
            step.hazardKind === 'unread'
              ? t('cards.route.stepUnreadTitle')
              : step.hazardKind === 'summons'
                ? t('cards.route.stepSummonsTitle')
                : undefined
          }
        >
          {step.hazardKind === 'unread'
            ? t('cards.route.stepUnread')
            : step.hazardKind === 'summons'
              ? t('cards.route.stepSummons')
              : step.hazard * 100 < 1
                ? t('cards.route.stepSlight')
                : t('cards.route.stepHazard', { percent: Math.round(step.hazard * 100) })}
        </span>
      )}
      {/* And a way or place the player keeps out of (todo 806), named by the
      word on their list, so the reader sees where the way through goes. */}
      {step.keptOut !== undefined && (
        <span className="chip bad" title={t('cards.route.stepKeptOutTitle')}>
          {t('cards.route.stepKeptOut', { word: step.keptOut })}
        </span>
      )}
      {/* And the lair the router priced this step by. The head says how many
      and names the worst; **this is where the reader finds out which rooms
      they are**, which is the half that was missing — a count at the top of
      a hundred-step plan is a number with nowhere to look. */}
      {(() => {
        const danger = stepDanger(step);
        if (danger === null) return null;
        return (
          <span className={danger.kind === 'deadly' ? 'chip bad' : 'chip warn'}>
            {danger.kind === 'deadly'
              ? t('cards.route.stepDeadly')
              : danger.kind === 'lair'
                ? t('cards.route.stepLair', { percent: danger.percent })
                : t('cards.route.stepRoad', { percent: danger.percent })}
          </span>
        );
      })()}
    </>
  );
}

export default function RouteSteps({
  steps,
  from,
  to,
  skipped,
  picked,
  onPick,
  unfolded,
  onToggleRun,
  walkHere,
  runHere,
  disabled,
  onPeek,
  onPeekEnd
}: RouteStepsProps) {
  /*
   * The step *Stop before entering* drops is drawn as its own row, never
   * folded into a run of rooms that will be walked: a head saying ×3 cannot
   * also say that one of the three is skipped. The tick is at the top of a
   * list that scrolls, so by the time the reader is down here it is off the
   * screen — and a list that draws the last step exactly like the others is
   * a list stating the opposite of what the press will do.
   */
  const signatures = steps.slice(from, to + 1).map(stepSignature);
  const local = skipped >= from && skipped <= to ? skipped - from : -1;
  const runs = (
    local < 0
      ? runsOf(signatures)
      : [
          ...runsOf(signatures.slice(0, local)),
          { start: local, count: 1 },
          ...runsOf(signatures.slice(local + 1)).map((run) => ({
            ...run,
            start: run.start + local + 1
          }))
        ]
  ).map((run) => ({ ...run, start: run.start + from }));
  const row = (step: RouteStep, index: number, folded: boolean) => (
    <li
      className="step"
      data-folded={folded ? 'true' : undefined}
      data-picked={picked === index ? 'true' : 'false'}
      data-skipped={index === skipped ? 'true' : undefined}
      key={`${step.to}-${index}`}
    >
      <span className="step-command">{step.command}</span>
      {/* **Where a teleport is used**, which is the room the character is
      standing in. Every other row reads *direction, then the room it
      reaches*, so its origin is the row above and needs no saying; a teleport
      has no row above, so the destination sat at the top of the plan and the
      whole thing read as though it began in a room the reader was not in.
      Drawn before the destination, in the order the step happens. */}
      {step.invoke !== undefined && (
        <span className="step-here">
          {t('cards.route.usedHere', { roomName: step.invoke.at.name })}
        </span>
      )}
      {/*
        The room, and the way to stop short at it.

        `button.lookup` rather than a control of its own: a name in a row of
        text is text that happens to be clickable and takes the row's height,
        which is the rule that keeps this list from turning into a column of
        32px controls holding 12px of text.

        Picking toggles, so the same click undoes it — there is no other way
        back from a pick, and a selection you cannot clear is a mode.
      */}
      <button
        aria-pressed={picked === index}
        className="lookup step-name"
        onClick={() => onPick(picked === index ? null : index)}
        /*
         * Pointing at a room on the list opens the realm's answer about it —
         * the same panel the map opens, so *four lairs on the way* can be read
         * one room at a time rather than walked into. The dwell and the
         * linger are the window's, like the map's.
         */
        onPointerEnter={(event) => onPeek(step.to, event.currentTarget)}
        onPointerLeave={onPeekEnd}
        title={step.name}
        type="button"
      >
        {step.name}
      </button>
      {picked === index && (
        /*
          On the row rather than beside `Walk it`, because `.route-body`
          scrolls as one: on a forty-seven-step route the summary is off the
          top of the panel by the time somebody has clicked a room near the
          bottom, and a button they cannot see is a button that is not there.
          `type="button"` because the form already submits as `Walk it`, and
          the whole point of this one is that it walks somewhere else.
        */
        <>
          {runHere !== null && (
            <button
              className="step-walk"
              disabled={disabled}
              onClick={() => runHere(index)}
              title={t('cards.route.runHereTooltip', { roomName: step.name })}
              type="button"
            >
              {t('cards.route.runHereButton')}
            </button>
          )}
          <button
            className="step-walk"
            disabled={disabled}
            onClick={() => walkHere(index)}
            title={t('cards.route.walkHereTooltip', { roomName: step.name })}
            type="button"
          >
            {t('cards.route.walkHereButton')}
          </button>
        </>
      )}
      {index === skipped && <span className="chip quiet">{t('cards.route.stepSkipped')}</span>}
      <StepChips step={step} />
    </li>
  );
  return (
    <ol className="route-steps">
      {runs.flatMap(({ start, count }) => {
        if (count === 1) return [row(steps[start]!, start, false)];
        const first = steps[start]!;
        const open = unfolded.has(start);
        const members = steps.slice(start, start + count);
        const head = (
          <li className="group" data-open={open ? 'true' : 'false'} key={`run-${start}`}>
            <span className="step-command" title={members.map((step) => step.command).join(' ')}>
              {commandsOf(members)}
            </span>
            <button
              aria-expanded={open}
              className="lookup step-fold"
              onClick={() => onToggleRun(start)}
              onMouseDown={keepFocus}
              title={
                open ? t('cards.route.unfoldTooltip') : t('cards.route.foldTooltip', { count })
              }
              type="button"
            >
              <span className="fold-name">{first.name}</span>
              <span className="chip quiet">{t('cards.route.foldCount', { count })}</span>
              <Icon name={open ? 'chevronUp' : 'chevronDown'} />
            </button>
            <StepChips step={first} />
          </li>
        );
        return open
          ? [head, ...members.map((step, offset) => row(step, start + offset, true))]
          : [head];
      })}
    </ol>
  );
}
