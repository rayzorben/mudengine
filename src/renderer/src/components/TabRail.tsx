import { Fragment, memo, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import Icon from './Icon';
import { reordered } from '../lib/reorder';

import { ratio, vitalLevel, type CharacterState, type VitalThresholds } from '@shared/character';
import type { VitalsUiConfig } from '@shared/config';
import type { SessionId, SessionSummary } from '@shared/ipc';
import type { WalkProgress } from '@shared/walk';
import type { LoopProgress } from '@shared/loops';
import { keepFocus } from '../lib/focus';
import { useTabDrag } from '../hooks/useTabDrag';
import { t } from '../lib/i18n';
import type { ConnectionState } from '@shared/types';

export type RailSide = 'top' | 'left';

/** What the rail needs to know about a character it is not showing. */
export interface RailView {
  state: ConnectionState;
  character: CharacterState;
  walk: WalkProgress;
  /** The loop it is running, if any — the rail says `looping` off this. */
  loop: LoopProgress;
  /**
   * Alerts raised while nobody was looking at this character.
   *
   * The point of running four characters is that three of them are unattended,
   * and the point of this rail is that it reports on the ones whose terminal is
   * not on screen. Vitals and walk state already reached it; alerts did not.
   */
  unseen: { critical: number; warning: number; latest: string | null };
}

export interface TabRailProps {
  sessions: SessionSummary[];
  views: Record<SessionId, RailView>;
  active: SessionId;
  side: RailSide;
  thresholds: VitalsUiConfig;
  /**
   * The ceiling each character rests to — `automation.health.restTo`, resolved
   * for that character, as a fraction. 0 is the single sit-down at the floor.
   *
   * A function rather than a value because the rail draws every character at
   * once and each resolves its own: the whole point of the rail is the three
   * characters nobody is looking at, so one figure for all four would be the
   * shown character's answer printed on somebody else's tab.
   */
  restToFor(session: SessionId): number;
  /**
   * The characters that have a file behind them.
   *
   * A session whose file was deleted while it was connected stays until it is
   * idle, and has nothing for "Edit" to open — and a menu entry that does
   * nothing is worse than one that is not offered.
   */
  editable: readonly SessionId[];
  onSelect(session: SessionId): void;
  onClose(session: SessionId): void;
  /**
   * The rail, dragged into a new order.
   *
   * Handed the whole order rather than a move: main writes down a list, and
   * deriving that list from a move in two places is two chances to disagree
   * about where a tab landed. Ordering is a property of *this window's* rail —
   * a popped-out character is not in this list at all — which is the same
   * scoping the roster itself already has.
   */
  onReorder(order: SessionId[]): void;
  /** Make a character. The way in, beside the characters it makes. */
  onNew(): void;
  /**
   * The client's own settings — everything a character inherits.
   *
   * Beside the `+` because that is where somebody already is when they want to
   * change something about the client rather than about one character, and to
   * its *left* because it is the more general of the two: a gear then a plus
   * reads as "the client, and one more of these".
   */
  onEditGlobal(): void;
  /** Open this character's own settings. */
  onEdit(session: SessionId): void;
  /**
   * Dial this character, or hang it up — whichever its phase calls for.
   *
   * Addressed, and deliberately not the window's own connect command: the rail
   * reports on the characters nobody is looking at, so the one being dialled is
   * usually not the one on screen. A control here that acted on the *shown*
   * character would disconnect the wrong one, which on this realm is not free
   * (docs/greatermud/combat.md).
   */
  onToggleConnection(session: SessionId): void;
}

function alertLabel(count: number): string {
  return count === 1 ? t('tabs.tab.alertSingular') : t('tabs.tab.alertPlural', { count });
}

/**
 * Whether somebody the roster lists as a person is among the attackers.
 *
 * The alert channel's own rule (`pvpNotice`): a name with no listing behind it
 * is as likely to be a quest NPC as a person, and crying wolf here is how the
 * mark stops being read. The chip covers the blows themselves — `attackers`
 * empties at `*Combat Off*` and on a move — not the five-minute hang-up
 * window a player's blow opens, which outlives it and is `HangUpWatch`'s to
 * judge.
 */
function underPlayerAttack(character: CharacterState): boolean {
  return character.combat.attackers.some((name) => {
    const key = name.toLowerCase();
    return character.online.some((entry) => entry.name.toLowerCase() === key);
  });
}

/**
 * The tab's one chip: trouble first, then what the character is doing.
 *
 * Deliberately one word (`offline`, `fighting`, `resting`, `meditating`,
 * `recovering`, `walking`, `looping`, `stopped`) plus the marks that want a
 * person's eye — an alert raised while
 * nobody was looking, a vital in the red, a person attacking. Chat is not on
 * the list: a tab that lights up for every gossip line is a tab nobody reads.
 *
 * Trouble outranks activity, and among the activities a fight outranks the
 * rest it interrupted, which outranks the walk that was holding for it, which
 * outranks the loop that planned it -- each is the more specific answer to
 * *what is this character doing* than the one below it. A walk's own holds sit
 * with it rather than under `walking`, for the reason the loop's do: a tab
 * reading `walking` for a character standing still says the opposite of what
 * is happening. Returned as a word as well as a level, because §6 of the
 * design language forbids stating a condition by colour alone — and `info` is
 * the quiet register, for a status that is not a condition.
 */
function attention(
  view: RailView | undefined,
  hpThresholds: VitalThresholds,
  restTo: number
): { level: 'critical' | 'warn' | 'info'; label: string; detail?: string } | null {
  if (!view) return null;

  /*
   * Something was raised while nobody was looking. Above the connection and
   * vital checks deliberately: those describe a *standing* condition that is
   * still true and can be read off the tab at any time, and this describes
   * something that happened once and will otherwise be missed.
   */
  if (view.unseen.critical > 0) {
    return {
      level: 'critical',
      label: alertLabel(view.unseen.critical),
      ...(view.unseen.latest !== null ? { detail: view.unseen.latest } : {})
    };
  }

  if (view.state.phase === 'error') return { level: 'critical', label: t('tabs.tab.markError') };
  // Only after it had been up: a character nobody has connected yet is idle,
  // not in trouble.
  if (view.state.phase === 'closed') return { level: 'warn', label: t('tabs.tab.markOffline') };

  // A person's blow, above the number it moves: the window it opens is the
  // thing nothing else on screen shows.
  if (underPlayerAttack(view.character)) {
    return { level: 'critical', label: t('tabs.tab.markPvp') };
  }

  const hp = vitalLevel(view.character.vitals.hp, view.character.vitals.hpMax, hpThresholds);
  if (hp === 'critical') return { level: 'critical', label: t('tabs.tab.markHurt') };

  if (view.character.inCombat) return { level: 'info', label: t('tabs.tab.markFighting') };

  /*
   * Sitting down, and what it is sitting down *to*.
   *
   * The rail reported `fighting`, `walking`, `looping` and `stopped` and had
   * no word for the state an unattended character spends most of its evening
   * in: the recovery between two fights. A character resting looked exactly
   * like one standing idle in a corridor, so the one thing worth knowing about
   * a tab nobody is watching -- whether it is getting better or merely stuck --
   * was the one thing the rail would not say.
   *
   * Above the walk and the loop because it is the more specific fact: a loop
   * holding for health is *resting*, and `looping` there describes the lap
   * rather than the thing the lap is waiting for. Below the fight, because a
   * fight interrupts a rest rather than the other way round, and below `hurt`,
   * because a character resting at 12% is still in trouble.
   *
   * `resting` and `meditating` are the server's own flag, read off the status
   * line -- never a guess from a threshold, which would report a rest the
   * client wanted and the server never granted.
   */
  const vitals = view.character.vitals;
  if (vitals.resting) return { level: 'info', label: restingLabel(restTo) };
  if (vitals.meditating) return { level: 'info', label: t('tabs.tab.markMeditating') };

  /*
   * The beat after running away, and the hold that carries it.
   *
   * `retreated` and `health` are the two holds a *running* loop can be in with the
   * character on its feet -- the escape has landed, the fight is over and the lap
   * is waiting for the health to come back before it plans a leg that may lead
   * straight back in. Drawn as `recovering` rather than `looping`: the lap is
   * not marching, and a tab reading `looping` for a character standing still
   * is the tab saying the opposite of what is happening. `fight` is not here
   * because `inCombat` above has already claimed it.
   */
  if (
    view.loop.status === 'running' &&
    (view.loop.hold === 'retreated' || view.loop.hold === 'health')
  ) {
    return { level: 'info', label: t('tabs.tab.markRecovering') };
  }

  /*
   * Off buying supplies. Its own word rather than `recovering`: nothing is
   * wrong with the character, it is walking to a shop — and `looping` would be
   * the tab saying the lap is marching when it is held.
   */
  if (view.loop.status === 'running' && view.loop.hold === 'errand') {
    return { level: 'info', label: t('tabs.tab.markShopping') };
  }

  /*
   * The lap a lost connection is carrying, with the socket back up and the
   * character not yet back in the realm and placed — the login screens, and
   * the line before the entry probe answers. The closed socket itself is the
   * `offline` above; this is the same word in the quiet register, because
   * `looping` here would be the tab saying the lap is marching through a
   * login prompt.
   */
  if (view.loop.status === 'running' && view.loop.hold === 'offline') {
    return { level: 'info', label: t('tabs.tab.markOffline') };
  }

  /*
   * A route's own two holds, in the words the loop's already earned. A held
   * walk is still `walking`, so without this a tab read `walking` for a
   * character standing still — for minutes under `restBelow`, and for the
   * whole of a fight whose flag has not arrived yet, since `Walker` also holds
   * on a blow the tracker filed a round before `*Combat Engaged*`.
   */
  if (view.walk.status === 'walking' && view.walk.hold === 'fight') {
    // `info`, the same register `inCombat` above wears: a fight is what this
    // character is doing, not a condition somebody has to come and look at.
    return { level: 'info', label: t('tabs.tab.markFighting') };
  }
  if (view.walk.status === 'walking' && view.walk.hold === 'health') {
    return { level: 'info', label: t('tabs.tab.markRecovering') };
  }
  if (view.walk.status === 'walking') return { level: 'info', label: t('tabs.tab.markWalking') };
  if (view.loop.status === 'running') return { level: 'info', label: t('tabs.tab.markLooping') };

  if (view.walk.status === 'stopped' || view.loop.status === 'stopped') {
    return { level: 'warn', label: t('tabs.tab.markStopped') };
  }

  // Warnings come last: a failed command on an unattended character is worth
  // knowing about, and worth knowing about less than a red health bar.
  if (view.unseen.warning > 0) {
    return {
      level: 'warn',
      label: alertLabel(view.unseen.warning),
      ...(view.unseen.latest !== null ? { detail: view.unseen.latest } : {})
    };
  }
  return null;
}

/**
 * What a rest is resting *to*, in the ceiling's own words.
 *
 * `restTo` is the fraction a stretch of resting is carried on to, and the
 * whole reason it is worth printing on a tab is that it answers "will this be
 * a moment or four minutes" without switching to the character. 0 is no
 * ceiling -- a single sit-down at the floor -- and claims nothing beyond the
 * flag itself; a full one is said in the word people use for it rather than as
 * `resting to 100%`.
 */
function restingLabel(restTo: number): string {
  if (restTo <= 0) return t('tabs.tab.markResting');
  if (restTo >= 1) return t('tabs.tab.markRestingToFull');
  return t('tabs.tab.markRestingTo', { percent: Math.round(restTo * 100) });
}

/** One line for what this character is doing, or nothing when it is just playing. */
function activity(view: RailView | undefined): string | null {
  if (!view) return null;
  if (view.walk.status === 'walking') {
    return t('tabs.tab.activityWalking', { done: view.walk.done, total: view.walk.total });
  }
  if (view.state.phase === 'connecting') return t('tabs.tab.activityConnecting');
  if (view.state.phase === 'closed') return t('tabs.tab.activityDisconnected');
  return null;
}

/**
 * The characters this window holds, and which one it is showing.
 *
 * Not merely a switcher. The reason to look at a second character is almost
 * never to read its scrollback — it is to see that it is at 20% health, or that
 * its walk stopped. So the rail carries that, and the two orientations are not
 * one control at two angles: `left` costs horizontal space, which is the
 * expensive axis, and buys room for vitals in numbers, the room name and the
 * current action. `top` costs rows, which are cheap, and collapses to a name, a
 * state dot and a vitals bar. See docs/ui-design.md §3.8.
 */
function TabRail({
  sessions,
  views,
  active,
  side,
  thresholds,
  restToFor,
  editable,
  onSelect,
  onClose,
  onReorder,
  onNew,
  onEditGlobal,
  onEdit,
  onToggleConnection
}: TabRailProps) {
  /*
   * The rail is the player's arrangement of their characters, exactly as the
   * card rail is their arrangement of what they watch — so it is dragged, and
   * the order is remembered. Before this it was whatever order the profile
   * directory sorted in, which is alphabetical by filename and has nothing to
   * do with which character somebody plays.
   *
   * The ids in drawn order, so the hook commits against the list on screen.
   * Ids and not summaries: two characters can share a display name.
   */
  const drag = useTabDrag(
    sessions.map((entry) => entry.id),
    onReorder
  );
  /*
   * Where the tab would land, as a gap its own size — and not where the drop
   * would change nothing, because there the dimmed tab is already the gap.
   * `reordered` is what the drop commits with, so the two cannot disagree.
   */
  const order = sessions.map((entry) => entry.id);
  const dropAt =
    drag.session !== null &&
    drag.index !== null &&
    reordered(order, drag.session, drag.index) !== order
      ? drag.index
      : null;
  const slot =
    dropAt !== null && drag.ghost !== null ? (
      <div
        className="rail-slot"
        style={
          {
            '--slot-w': `${drag.ghost.w}px`,
            '--slot-h': `${drag.ghost.h}px`
          } as CSSProperties
        }
      />
    ) : null;
  /*
   * The dragged tab's ghost: the tab's own shape, held where the pointer took
   * it, carrying the name — so the tab is felt to move rather than a line
   * to appear. Through a portal, because a fixed box inside the rail would
   * be positioned against whatever ancestor happens to establish a
   * containing block.
   */
  const held = drag.session === null ? null : sessions.find((entry) => entry.id === drag.session);
  const ghost =
    drag.ghost !== null && held !== undefined && held !== null
      ? createPortal(
          <div
            className="drag-ghost tab-ghost"
            style={{
              left: drag.ghost.x,
              top: drag.ghost.y,
              width: drag.ghost.w,
              height: drag.ghost.h
            }}
          >
            {held.name}
          </div>,
          document.body
        )
      : null;

  if (sessions.length === 0) return null;

  return (
    <div className="tab-rail" data-side={side} role="tablist">
      {ghost}
      {/*
        Making a character, beside the characters.

        At the *head* of the rail rather than trailing the last tab as a
        browser's does. A trailing button moves every time somebody is added or
        removed, and this rail scrolls — on a left rail with four characters the
        trailing position is the one that scrolls out of sight, which is the
        same failure as burying it twenty-sixth in the palette. The head does
        not move.

        One row regardless of the rail's own orientation: the gear is the
        quieter, icon-only control, and "New character" keeps its label and
        takes whatever width the gear leaves it.
      */}
      <div className="rail-head">
        <button
          aria-label={t('tabs.head.settingsAria')}
          className="new-character rail-settings"
          onClick={onEditGlobal}
          onMouseDown={keepFocus}
          title={t('tabs.head.settingsTooltip')}
          type="button"
        >
          <Icon name="settings" />
        </button>

        <button
          aria-label={t('tabs.head.newCharacterAria')}
          className="new-character"
          onClick={onNew}
          // The settings screen takes the caret itself; the button must not fight
          // it for one on the way there.
          onMouseDown={keepFocus}
          title={t('tabs.head.newCharacterTooltip')}
          type="button"
        >
          <Icon name="plus" />
          {side === 'left' && <span className="what">{t('tabs.head.newCharacterAria')}</span>}
        </button>
      </div>

      {/*
        The tabs scroll; the button above does not. One scroller, so the head
        stays put however many characters are loaded.
      */}
      <div className="tabs">
        {sessions.map((session, at) => {
          const view = views[session.id];
          const vitals = view?.character.vitals;
          const hp = ratio(vitals?.hp ?? null, vitals?.hpMax ?? null);
          const hpLevel = vitalLevel(vitals?.hp ?? null, vitals?.hpMax ?? null, thresholds.hp);
          const mark = attention(view, thresholds.hp, restToFor(session.id));
          const doing = activity(view);
          const room = view?.character.room.name ?? null;
          const isActive = session.id === active;
          const phase = view?.state.phase ?? 'idle';
          // A dial takes up to fifteen seconds and a close is not instant
          // either. A button that stays pressable through either reads as one
          // that did nothing, and main refuses the second attempt anyway.
          const busy = phase === 'connecting' || phase === 'closing';
          /*
           * A retry pending reads as *dialling*, because it is.
           *
           * The phase during a ladder's wait is `closed`, so a dial that
           * branched on the phase alone offered **Connect** while a reconnect
           * ran — and there was then no control anywhere in the client that
           * meant *stop trying*. See `SessionSummary.retrying`.
           */
          const retrying = session.retrying;
          // One string for the dial's aria-label and its title, so the two
          // cannot drift; the busy tooltips layer on top of it below.
          const dialLabel =
            phase === 'connected'
              ? t('tabs.tab.dialDisconnectAria', { characterName: session.name })
              : retrying
                ? t('tabs.tab.dialStopRetryingAria', { characterName: session.name })
                : t('tabs.tab.dialConnectAria', { characterName: session.name });

          return (
            <Fragment key={session.id}>
              {/*
                Where the tab would land.

                A gap *between* tabs and never a highlight on one — the same
                `.rail-slot` the card rail opens, because the question mid-drag
                is "before or after this one" and highlighting a tab answers
                neither. Drawn continuously as the pointer moves, so releasing
                never does something the player was not already looking at.
              */}
              {dropAt === at && slot}
              <div
                aria-selected={isActive}
                className="tab"
                data-accent={session.accent}
                data-active={isActive ? 'true' : 'false'}
                data-dragging={drag.session === session.id ? 'true' : undefined}
                // Two characters can share a display name — the realm names them,
                // and one account's alts often differ only by slot — so anything
                // identifying a tab has to key on the id.
                data-session={session.id}
                data-phase={phase}
                onClick={() => onSelect(session.id)}
                // The caret goes to the terminal of the character being shown, not
                // to the tab that was clicked.
                onMouseDown={keepFocus}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(session.id);
                  }
                }}
                role="tab"
                tabIndex={0}
              >
                {/*
                The one standing mark that says a tab can be moved.

                Always drawn, never only on hover — the card grip's rule, and
                the same six dots, so the affordance is learned once and then
                recognised on both rails. On the left, where the character's own
                name starts, because that is the edge a row is dragged by
                everywhere else in this client.

                Its own element rather than the whole tab: a tab is a control
                that selects a character, and a press anywhere on it that turned
                into a drag would make switching characters a gamble on how
                still somebody's hand is.
              */}
                <span
                  aria-hidden="true"
                  className="tab-grip"
                  onPointerDown={(event) => drag.begin(session.id, event)}
                  title={t('tabs.tab.dragHint')}
                />

                <span
                  className="who"
                  title={t('tabs.tab.whoTooltip', {
                    characterName: session.name,
                    realmName: session.server
                  })}
                >
                  <span className="name">{session.name}</span>
                  {/*
                Then the two right-aligned facts, in this order: what the
                character is doing, and which realm it is doing it on.

                The realm is the **rightmost** thing on the row and the status
                sits against it, because the two are read differently. The
                realm is an *address* — it is the same word on every tab of the
                same realm, so it makes a column the eye runs down and finds
                nothing in, which is exactly what a right edge is for. The
                status is what changes, and it belongs where a change is
                noticed: beside the edge rather than on it, next to the one
                thing on the row that never moves.

                They were the other way round, with the status on the edge and
                the realm between it and the name — which put the *most*
                variable thing in the column position and the least variable
                thing where it had to be re-read. The name grows into whatever
                is left (`.tab .name`, `flex: 1 1 auto`), so both hug the right
                without either needing an offset of its own.
              */}
                  {mark && (
                    // The newest alert as the tooltip: the count says how much and
                    // this says what, without the tab growing to hold a sentence.
                    <span className="mark" data-level={mark.level} title={mark.detail}>
                      {mark.label}
                    </span>
                  )}
                  {/*
                Which realm, because a character name alone stops identifying
                anyone the moment two of them are logged in — and a player with
                one character on each of two realms is exactly who tabs are for.
              */}
                  {session.server && <span className="on">{session.server}</span>}
                </span>

                {/*
              The controls row, one shape on every tab so the columns line up
              across the rail: the dial, the health bar, the pencil, the close.
              A real row rather than buttons absolutely positioned over the
              padding, because alignment between tabs is the point and four
              `right:` offsets are four chances to disagree with the bar they
              sit beside.
            */}
                <span className="tab-controls">
                  {/*
                Dial or hang up, from the tab that says who it is.

                Until this existed the only way to reconnect a character was
                `Ctrl/Cmd K` and a command whose label names *the character on
                screen* — and the rail exists precisely because three of four
                characters are not on screen. A player watching one tab go
                `offline` had to switch to it, connect, and switch back.

                It states the *action*, not the state: a play triangle where
                the character is disconnected, a stop square where it is in
                the realm. The phase is already on the tab in words and
                colour, so a button repeating it would be a third statement of
                the same fact and no way to act on it.
              */}
                  <button
                    aria-label={dialLabel}
                    className="dial"
                    data-phase={phase}
                    disabled={busy}
                    onClick={(event) => {
                      // The tab underneath would otherwise select the character
                      // being dialled, which is a switch nobody asked for — and on
                      // a hang-up it would put the character being disconnected on
                      // screen, which is the opposite of what was asked.
                      event.stopPropagation();
                      onToggleConnection(session.id);
                    }}
                    // Clicked, never typed into: the caret stays in the game.
                    onMouseDown={keepFocus}
                    title={
                      busy
                        ? phase === 'connecting'
                          ? t('tabs.tab.dialConnectingTooltip')
                          : t('tabs.tab.dialClosingTooltip')
                        : dialLabel
                    }
                    type="button"
                  >
                    <Icon name={phase === 'connected' || retrying ? 'stop' : 'play'} />
                  </button>

                  {/*
                A null fraction renders as an empty track rather than a full or
                a zero bar. An unknown maximum is absence, and a bar painted
                red for want of a number that has not arrived is the lie that
                makes a player run from a fight they were winning.
              */}
                  <span className="hp" data-level={hpLevel}>
                    <span className="track">
                      <span className="fill" style={{ width: hp === null ? 0 : `${hp * 100}%` }} />
                    </span>
                    {side === 'left' && (
                      <span className="figures">
                        {vitals?.hp ?? '—'}
                        {vitals?.hpMax === null || vitals?.hpMax === undefined
                          ? ''
                          : `/${vitals.hpMax}`}
                      </span>
                    )}
                  </span>

                  {/*
                The character's own settings, one press instead of a menu.

                It replaced a kebab whose menu held exactly this and Close —
                two entries a button each can say directly, and a menu is a
                second surface to dismiss. Always drawn, quiet until pointed
                at, the card-grip rule: it is the way to a character's settings
                and an affordance found only by hovering is one most people
                never find. Only for a character that has a file — a session
                whose file was deleted has nothing to open, and a button that
                does nothing is worse than none.
              */}
                  {editable.includes(session.id) && (
                    <button
                      aria-label={t('tabs.tab.editAria', { characterName: session.name })}
                      className="edit"
                      onClick={(event) => {
                        // The tab underneath would otherwise select the character
                        // being edited, which is a switch nobody asked for.
                        event.stopPropagation();
                        onEdit(session.id);
                      }}
                      // The settings screen takes the caret itself; the button
                      // must not fight it for one on the way there.
                      onMouseDown={keepFocus}
                      title={t('tabs.tab.editAria', { characterName: session.name })}
                      type="button"
                    >
                      <Icon name="edit" />
                    </button>
                  )}

                  <button
                    aria-label={t('tabs.tab.closeAria', { characterName: session.name })}
                    className="close"
                    onClick={(event) => {
                      // The tab underneath would otherwise select the character being
                      // closed, which is a switch nobody asked for.
                      event.stopPropagation();
                      onClose(session.id);
                    }}
                    onMouseDown={keepFocus}
                    title={t('tabs.tab.closeAria', { characterName: session.name })}
                    type="button"
                  >
                    <Icon name="close" />
                  </button>
                </span>

                {side === 'left' && (room || doing) && (
                  <span className="where">{doing ?? room}</span>
                )}
              </div>
            </Fragment>
          );
        })}
        {/* The gap past the last tab: dropping below the rail means the end. */}
        {dropAt === sessions.length && slot}
      </div>
    </div>
  );
}

/*
 * Memoised, because the window's root re-renders for things that are not the
 * rail's business — a flyout opening, the palette closing — and the rail draws
 * a tab per character with a grip, a dial and a chip each. `views` changes
 * whenever any character's state moves, and that is exactly when it redraws.
 */
export default memo(TabRail);
