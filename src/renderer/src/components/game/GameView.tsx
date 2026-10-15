/**
 * The game view (todo 140): the world fills the screen, the room you stand in
 * is the arena, and the HUD sits at the edges. One interface or the other:
 * `App` shows this instead of the classic workspace, and the consoles stay
 * mounted under it (`useGameView`). Every chord keeps working, because they
 * listen in capture above this layer.
 *
 * Command mode is this element's own key layer: a letter acts at once; `n` or
 * `s` waits for `e` or `w` only in a room with a diagonal starting with it;
 * `i` or Enter opens the console; Esc brings a dragged map back.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';

import type { AutomationSwitch } from '@shared/config';
import type { HudThreshold } from '@shared/gameViewConfig';
import type { GameCell } from '@shared/gameMap';
import type { IpcApi, ProfileSummary, SessionId } from '@shared/ipc';
import type { KeyBindings } from '@shared/keys';
import {
  asDirection,
  asRoomReference,
  roomAddress,
  type Direction,
  type RoomId,
  type WorldRoom
} from '@shared/world';
import { roomsWithFinds } from '@shared/finds';
import type { GameViewState } from '../../hooks/useGameView';
import { useGameMap } from '../../hooks/useGameMap';
import type { SessionView } from '../../hooks/useSessionViews';
import { candidatesOf } from '../../lib/gameArena';
import {
  commandFor,
  diagonalOf,
  diagonalWaits,
  gameCommands,
  monstersHere,
  moveKey,
  targetOf,
  type GameCommand
} from '../../lib/gameCommands';
import { PLACE_PATHS, LAIR_PATH, PLAYER_PATH, placeTone } from '../../lib/gameIcons';
import { placeLabel } from '../../lib/gameArena';
import { feedOf, unreadFor } from '../../lib/gameTalk';
import { t } from '../../lib/i18n';
import { tuning } from '../../lib/tuning';
import { walkTo } from '../../lib/walkTo';
import AutoBar from './AutoBar';
import CharacterSheet from './CharacterSheet';
import CommandBar from './CommandBar';
import ConsoleBar from './ConsoleBar';
import PartyFrames from './PartyFrames';
import PlayerBar from './PlayerBar';
import TalkFeed from './TalkFeed';
import TargetCard from './TargetCard';
import WorldCanvas, { type WorldCanvasHandle } from './WorldCanvas';

export interface GameViewProps {
  game: GameViewState;
  api: Pick<
    IpcApi,
    | 'gameMap'
    | 'onBlock'
    | 'input'
    | 'routeTo'
    | 'walkRoute'
    | 'setAutomationSwitch'
    | 'setThreshold'
  >;
  session: SessionId;
  view: SessionView;
  profile: ProfileSummary | null;
  keys: KeyBindings;
  openRouteOn(room: WorldRoom, search: null): void;
  stepBack(session: SessionId, confirmed: number | null): void;
  /** A refusal, said in this character's console. */
  say(session: SessionId, message: string): void;
  /** The Talk card, drawn for the panel `t` opens, with its own close. */
  renderTalk(onClose: () => void): ReactNode;
}

/** The legend: each kind of place the map marks, the lair and a player. */
const LEGEND = ['bank', 'goods', 'temple', 'tavern', 'trainer'] as const;

function GameView({
  game,
  api,
  session,
  view,
  profile,
  keys,
  openRouteOn,
  stepBack,
  say,
  renderTalk
}: GameViewProps) {
  const { character } = view;
  const here = roomAddress(character.room);
  const map = useGameMap(api, session, character.room.map, character.room.number);
  const canvas = useRef<WorldCanvasHandle>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [detached, setDetached] = useState(false);
  const [fired, setFired] = useState<{ key: string; at: number } | null>(null);
  const pending = useRef<{ first: Direction; timer: number } | null>(null);
  const [talking, setTalking] = useState(false);
  const newest = view.talk[view.talk.length - 1]?.seq ?? 0;
  // The newest line seen with the panel open: the feed shows what came after.
  const [seen, setSeen] = useState(newest);
  const self = character.name ?? profile?.name ?? null;
  const [since] = useState(() => Date.now());
  const start = useMemo(() => ({ seen, since }), [seen, since]);
  const unread = useMemo(() => unreadFor(view.talk, start, self), [view.talk, start, self]);
  const feed = useMemo(
    () => (talking ? [] : feedOf(view.talk, start)),
    [view.talk, start, talking]
  );
  const setTalk = useCallback(
    (open: boolean) => {
      setTalking(open);
      setSeen(newest);
      if (open)
        window.requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>('.gv-talk-panel input, .gv-talk-panel textarea')
            ?.focus()
        );
      else game.home.current?.focus();
    },
    [newest, game.home]
  );
  const closeTalk = useCallback(() => setTalk(false), [setTalk]);
  // Read while open: nothing said meanwhile is left unread.
  useEffect(() => {
    if (talking) setSeen(newest);
  }, [talking, newest]);

  const hereCell = here === null ? undefined : map.byId.get(here);
  const commands = useMemo(
    () => gameCommands({ character, picked, place: hereCell?.icon ?? null, unread }),
    [character, picked, hereCell, unread]
  );
  const target = targetOf(character, picked);

  // A target picked in another room is no target here.
  useEffect(() => setPicked(null), [here]);

  const send = useCallback((line: string) => void api.input(session, `${line}\r`), [api, session]);
  const move = useCallback(
    (direction: Direction) => {
      canvas.current?.follow();
      send(direction);
    },
    [send]
  );

  const run = useCallback(
    (command: GameCommand) => {
      setFired({ key: command.key, at: Date.now() });
      if (command.line !== undefined) {
        send(command.line);
        return;
      }
      switch (command.action) {
        case 'nextTarget': {
          const list = monstersHere(character);
          const at = target === null ? -1 : list.indexOf(target);
          setPicked(list[(at + 1) % list.length] ?? null);
          return;
        }
        case 'run':
          stepBack(session, null);
          return;
        case 'party':
          send('party');
          return;
        case 'character':
          setSheet((open) => !open);
          return;
        case 'talk':
          setTalk(!talking);
          return;
        case 'type':
          game.openConsole();
          return;
        case undefined:
          return;
        default: {
          const never: never = command.action;
          return never;
        }
      }
    },
    [character, target, send, stepBack, session, game, setTalk, talking]
  );

  const flush = useCallback(() => {
    const held = pending.current;
    if (held === null) return;
    window.clearTimeout(held.timer);
    pending.current = null;
    move(held.first);
  }, [move]);
  useEffect(() => () => flush(), [flush]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // The Talk panel's composer types; its Escape goes back to the map.
    if (event.target instanceof Element && event.target.closest('.gv-talk-panel')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTalk();
      }
      return;
    }
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const exits = commands.exits.map((exit) => exit.direction);
    const step = moveKey(key);
    const held = pending.current;
    if (held !== null) {
      const diagonal = step === null ? null : diagonalOf(held.first, step);
      if (diagonal !== null && exits.includes(diagonal)) {
        window.clearTimeout(held.timer);
        pending.current = null;
        event.preventDefault();
        move(diagonal);
        return;
      }
      flush();
    }
    if (key === 'Escape') {
      if (sheet) setSheet(false);
      else canvas.current?.follow();
      event.preventDefault();
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      game.openConsole();
      return;
    }
    if (step !== null) {
      event.preventDefault();
      if (diagonalWaits(step, exits)) {
        pending.current = {
          first: step,
          timer: window.setTimeout(() => {
            pending.current = null;
            move(step);
          }, tuning().gameDiagonalMs)
        };
        return;
      }
      move(step);
      return;
    }
    const command = commandFor(commands, key);
    if (command === null) return;
    event.preventDefault();
    run(command);
  };

  const onFoe = useCallback(
    (name: string) => {
      if (picked === name || character.combat.engaged) send(`a ${name}`);
      else setPicked(name);
    },
    [picked, character.combat.engaged, send]
  );
  const onWalk = useCallback(
    (cell: GameCell) => {
      const at = asRoomReference(cell.id);
      if (at !== null)
        walkTo(
          { map: at.map, room: at.room, name: cell.name, exits: [] },
          { api, session, openRouteOn }
        );
    },
    [api, session, openRouteOn]
  );
  const onSwitch = useCallback(
    (name: AutomationSwitch, on: boolean) =>
      void api.setAutomationSwitch(session, name, on).then((refused) => {
        if (refused !== null) say(session, refused);
      }),
    [api, session, say]
  );
  const onThreshold = useCallback(
    (which: HudThreshold, value: number) =>
      void api.setThreshold(session, which, value).then((refused) => {
        if (refused !== null) say(session, refused);
      }),
    [api, session, say]
  );

  const stops = useMemo(() => new Set(view.loop.remainingStops), [view.loop.remainingStops]);
  const finds = useMemo(() => roomsWithFinds(view.finds), [view.finds]);
  const found = useMemo(
    () =>
      view.learned
        .filter((one): one is typeof one & { to: RoomId } => one.to !== null)
        .map((one) => [one.from, one.to] as const),
    [view.learned]
  );
  const players = useMemo(
    () =>
      Object.values(view.players).flatMap((record) =>
        record.lastRoom === null || record.lastRoomAt === null
          ? []
          : [{ name: record.name, room: record.lastRoom, at: record.lastRoomAt }]
      ),
    [view.players]
  );
  const candidates = useMemo(() => candidatesOf(character), [character]);
  const bound = useMemo(() => {
    const out: Partial<Record<Direction, string>> = {};
    for (const [chord, line] of Object.entries(keys)) {
      const direction = asDirection(line);
      if (direction !== null) out[direction] ??= chord;
    }
    return out;
  }, [keys]);

  return (
    <div
      aria-label={t('game.aria')}
      className="gv-root"
      data-console={game.open ? 'open' : 'shut'}
      data-talk={talking ? 'open' : undefined}
      data-owns-enter="true"
      onKeyDown={onKeyDown}
      onPointerDownCapture={(event) => {
        // A press on the map goes back to command mode; the console's own bar keeps it open.
        if (
          game.open &&
          !(event.target instanceof Element && event.target.closest('.gv-console-bar'))
        )
          game.shutConsole();
      }}
      ref={game.home}
      tabIndex={-1}
    >
      <WorldCanvas
        api={api}
        candidates={candidates}
        character={character}
        finds={finds}
        found={found}
        here={here}
        map={map}
        onDetached={setDetached}
        onExit={move}
        onFoe={onFoe}
        onWalk={onWalk}
        picked={picked}
        players={players}
        ref={canvas}
        session={session}
        stops={stops}
        trail={view.walk.path}
      />
      <PlayerBar
        character={character}
        profileName={profile?.name ?? null}
        restBelow={profile?.restBelow ?? null}
        runBelow={profile?.runBelow ?? null}
        statsBase={view.statsBase}
      />
      <div className="gv-hud gv-legend" aria-hidden="true">
        {LEGEND.map((icon) => (
          <span key={icon}>
            <svg data-tone={placeTone(icon)} viewBox="0 0 24 24">
              <path d={PLACE_PATHS[icon]} fillRule="evenodd" />
            </svg>
            {icon === 'goods' ? t('game.legend.shops') : placeLabel(icon)}
          </span>
        ))}
        <span>
          <svg data-tone="lair" viewBox="0 0 24 24">
            <path d={LAIR_PATH} fillRule="evenodd" />
          </svg>
          {t('game.legend.lair')}
        </span>
        <span>
          <svg data-tone="player" viewBox="0 0 24 24">
            <path d={PLAYER_PATH} fillRule="evenodd" />
          </svg>
          {t('game.legend.player')}
        </span>
      </div>
      <AutoBar
        onSwitch={onSwitch}
        onThreshold={onThreshold}
        restBelow={profile?.restBelow ?? null}
        runBelow={profile?.runBelow ?? null}
        switches={profile?.switches ?? null}
      />
      <TargetCard character={character} target={target} />
      <PartyFrames character={character} />
      <CommandBar
        bound={bound}
        commands={commands}
        fired={fired === null ? null : `${fired.key}`}
        key={fired?.at ?? 0}
        onCommand={run}
        onMove={move}
      />
      <div className="gv-hud gv-glass gv-zoom">
        <button
          aria-label={t('game.map.zoomIn')}
          onClick={() => canvas.current?.zoom(1.25)}
          type="button"
        >
          +
        </button>
        <button
          aria-label={t('game.map.zoomOut')}
          onClick={() => canvas.current?.zoom(1 / 1.25)}
          type="button"
        >
          −
        </button>
        <button
          aria-label={t('game.map.home')}
          data-on={detached ? 'true' : undefined}
          onClick={() => canvas.current?.follow()}
          type="button"
        >
          ◎
        </button>
      </div>
      {sheet && <CharacterSheet character={character} onClose={() => setSheet(false)} />}
      <TalkFeed lines={feed} self={self} unread={unread} />
      {talking && (
        <div className="gv-hud gv-talk-panel" data-owns-keys="true">
          {renderTalk(closeTalk)}
        </div>
      )}
      <ConsoleBar
        dock={game.dock}
        open={game.open}
        opacity={game.opacity}
        setDock={game.setDock}
        setOpacity={game.setOpacity}
      />
    </div>
  );
}

export default memo(GameView);
