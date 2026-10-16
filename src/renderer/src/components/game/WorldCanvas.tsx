/**
 * The game view's world (todo 140): one floor of the plane on a canvas behind
 * the HUD (todo 151), with the room you stand in as the arena. The camera
 * follows you until the map is dragged, a stair's mark or the floor strip
 * shows another floor; then the arena docks to the right with a thread back to
 * the room, a click on a room walks there, and Esc, ◎ or a move brings it back.
 * Pointing at a stair's mark opens its peek window.
 *
 * It draws only when something changed or an animation is running: a moving
 * camera, the arena docking, a blow in flight. Nothing runs on a clock, and a
 * hidden page draws nothing, since the browser holds animation frames there.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type PointerEvent,
  type WheelEvent
} from 'react';

import type { CharacterState } from '@shared/character';
import { MOTIF_PALETTES, teleportsOf, type GameCell, type MapArea } from '@shared/gameMap';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { Direction, RoomId } from '@shared/world';
import {
  arenaExitsOf,
  arenaNames,
  arenaTokensOf,
  placeLabel,
  type ArenaToken
} from '../../lib/gameArena';
import { blowOf } from '../../lib/gameBlows';
import type { RoundAnchor } from '../../lib/gameRounds';
import { placeTone } from '../../lib/gameIcons';
import { t } from '../../lib/i18n';
import type { GameMap } from '../../hooks/useGameMap';
import { usePeek } from '../../hooks/usePeek';
import { floorsReached, inBox, placePeek, type Box } from '../../lib/gameFloors';
import {
  drawFlights,
  drawExits,
  drawFloor,
  drawTokens,
  EXIT_RADIUS,
  FLIGHT_MS,
  standings,
  type Disc,
  type ExitSpot,
  type Flight
} from './drawArena';
import {
  cellPx,
  drawGround,
  drawVignette,
  drawWorld,
  PATHS,
  readGamePalette,
  roomAt,
  tileSize,
  toScreen,
  ZOOM,
  type Camera,
  type GamePalette,
  type FoundWay,
  type Scene,
  type View
} from './drawWorld';
import { drawPeek, PEEK_SIZE } from './drawPeek';
import { drawStairs, type StairSpot } from './drawStairs';
import FloorStrip from './FloorStrip';
import RoundRing, { RING_EXTENT, RING_STROKE_PX } from './RoundRing';

export interface WorldCanvasHandle {
  zoom(by: number): void;
  /** Back to following the character, as Esc, ◎ and any move do. */
  follow(): void;
}

export interface WorldCanvasProps {
  api: Pick<IpcApi, 'onBlock' | 'gameMap'>;
  session: SessionId;
  character: CharacterState;
  map: GameMap;
  here: RoomId | null;
  candidates: readonly RoomId[];
  trail: readonly RoomId[];
  stops: ReadonlySet<RoomId>;
  finds: ReadonlySet<RoomId>;
  found: readonly FoundWay[];
  players: Scene['players'];
  picked: string | null;
  /** The room's beat, drawn as the ring round the arena (todo 154); null for no ring. */
  rounds: RoundAnchor | null;
  onFoe(name: string): void;
  onExit(direction: Direction): void;
  onWalk(cell: GameCell): void;
  onDetached(detached: boolean): void;
}

type Hover =
  | { kind: 'room'; cell: GameCell; x: number; y: number }
  | { kind: 'exit'; direction: Direction; x: number; y: number }
  | { kind: 'foe'; token: ArenaToken; x: number; y: number }
  | { kind: 'stair'; spot: StairSpot; x: number; y: number }
  | null;

/** The arena's colours while the room is not known: the guess for a town, unnamed. */
const LOST_AREA: MapArea = {
  id: 'lost',
  name: '',
  motif: 'town',
  palette: MOTIF_PALETTES.town,
  named: false
};

const arenaRadius = (width: number, height: number): number =>
  Math.max(92, Math.min(124, Math.min(width, height) * 0.13));

/** How far an eased value moves toward its goal each frame. */
const EASE = 0.16;
const SETTLED = 0.002;

function WorldCanvas(props: WorldCanvasProps, ref: ForwardedRef<WorldCanvasHandle>) {
  const { api, session, character, map, here, onDetached } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, z: 1 });
  const follow = useRef(true);
  const disc = useRef<Disc & { dock: number }>({ x: 0, y: 0, r: 0, dock: 0 });
  const size = useRef({ width: 0, height: 0, ratio: 1 });
  const flights = useRef<Flight[]>([]);
  const exits = useRef<ExitSpot[]>([]);
  const stairs = useRef<StairSpot[]>([]);
  /** Where the hovered stair's peek window was drawn, so the pointer can move onto it. */
  const peekBox = useRef<Box | null>(null);
  /** The room a stair or the strip showed, for the camera to go to once its window arrives. */
  const focus = useRef<RoomId | null>(null);
  const frame = useRef<number | null>(null);
  const palette = useRef<GamePalette | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(
    null
  );
  const ring = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover>(null);
  const hoverRef = useRef<Hover>(null);
  hoverRef.current = hover;
  const peek = usePeek(api, session, hover?.kind === 'stair' ? hover.spot.stair.to : null);

  const tokens = useMemo(() => arenaTokensOf(character, props.picked), [character, props.picked]);
  const hereCell = here === null ? undefined : map.byId.get(here);
  const arenaExits = useMemo(
    () =>
      arenaExitsOf(character, (direction) => {
        const to = hereCell?.to[direction];
        return to === undefined ? null : (map.byId.get(to)?.name ?? null);
      }),
    [character, hereCell, map.byId]
  );

  // Everything the frame reads, kept current without re-subscribing anything.
  const latest = useRef({ props, tokens, arenaExits, hereCell, peek });
  latest.current = { props, tokens, arenaExits, hereCell, peek };

  const draw = useCallback((): void => {
    frame.current = null;
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const pal = (palette.current ??= readGamePalette(element));
    const { width, height, ratio } = size.current;
    const { props: p, tokens: list, arenaExits: rim, hereCell: cell, peek: shown } = latest.current;
    const now = performance.now();
    let moving = false;

    const target = follow.current
      ? cell
      : focus.current === null
        ? undefined
        : p.map.byId.get(focus.current);
    if (target) {
      const dx = target.gx - cam.current.x;
      const dy = target.gy - cam.current.y;
      if (Math.abs(dx) > SETTLED || Math.abs(dy) > SETTLED) {
        cam.current.x += dx * EASE * 1.4;
        cam.current.y += dy * EASE * 1.4;
        moving = true;
      } else {
        cam.current.x = target.gx;
        cam.current.y = target.gy;
        if (!follow.current) focus.current = null;
      }
    }
    const view: View = { width, height, cam: cam.current };
    const radius = arenaRadius(width, height);
    const d = disc.current;
    /*
     * Lost, the arena stands in the middle of the screen: the fight is drawn
     * wherever the room is. A known room outside the window (◎ after a long
     * drag, todo 151) is not lost: the arena holds still until its square comes.
     */
    const goal = !follow.current
      ? { x: width - radius * 0.82 - 44, y: height * 0.54, r: radius * 0.82, dock: 1 }
      : cell
        ? { ...toScreen(view, cell.gx, cell.gy), r: radius, dock: 0 }
        : p.here === null || d.r === 0
          ? { x: width / 2, y: height / 2, r: radius, dock: 0 }
          : { x: d.x, y: d.y, r: d.r, dock: 0 };
    if (d.r === 0) Object.assign(d, goal);
    else
      for (const key of ['x', 'y', 'r', 'dock'] as const) {
        const gap = goal[key] - d[key];
        if (Math.abs(gap) > SETTLED * (key === 'dock' ? 1 : 100)) {
          d[key] += gap * EASE;
          moving = true;
        } else d[key] = goal[key];
      }

    const scene: Scene = {
      win: p.map.win,
      at: p.map.at,
      byId: p.map.byId,
      here: p.here,
      candidates: p.candidates,
      trail: p.trail,
      stops: p.stops,
      finds: p.finds,
      found: p.found,
      players: p.players,
      hover: hoverRef.current?.kind === 'room' ? hoverRef.current.cell.id : null,
      now: Date.now()
    };
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawGround(ctx, view, pal);
    drawWorld(ctx, view, scene, pal, d);
    const pointed = hoverRef.current?.kind === 'stair' ? hoverRef.current.spot : null;
    stairs.current = drawStairs(ctx, view, scene, pal, pointed);

    {
      const area = (cell === undefined ? undefined : p.map.win.areas[cell.area]) ?? LOST_AREA;
      const place = cell?.icon
        ? {
            label: placeLabel(cell.icon),
            colour: pal.places[placeTone(cell.icon)],
            path: PATHS.places[cell.icon]
          }
        : null;
      const facts = [
        p.character.combat.engaged ? t('game.status.combat') : null,
        p.character.room.light,
        cell === undefined ? t('game.arena.lost') : null,
        cell?.lair === true ? t('game.arena.lair') : null
      ]
        .filter((one): one is string => one !== null)
        .join('  ·  ');
      drawFloor(ctx, pal, d, {
        name: p.character.room.name ?? cell?.name ?? t('game.arena.unknownRoom'),
        facts,
        place,
        area,
        dark: cell?.dark === true,
        engaged: p.character.combat.engaged,
        docked: d.dock > 0.5,
        detached: d.dock > 0.5 ? t('game.arena.detached') : null
      });
      if (d.dock > 0.05 && cell) {
        const room = toScreen(view, cell.gx, cell.gy);
        const angle = Math.atan2(room.y - d.y, room.x - d.x);
        ctx.globalAlpha = d.dock * 0.8;
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.moveTo(d.x + Math.cos(angle) * d.r, d.y + Math.sin(angle) * d.r);
        ctx.lineTo(room.x, room.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      const hovered = hoverRef.current?.kind === 'exit' ? hoverRef.current.direction : null;
      exits.current = drawExits(ctx, pal, d, rim, hovered);
      placeRing(ring.current, d);
      const at = standings(d, list);
      const { live, struck } = drawFlights(ctx, pal, flights.current, at, now);
      flights.current = live;
      drawTokens(ctx, pal, d, list, at, struck);
      if (live.length > 0) moving = true;
      if (p.character.room.cash !== null && p.character.room.cash.totalCopper > 0) {
        ctx.fillStyle = pal.accent;
        ctx.save();
        ctx.translate(d.x, d.y + d.r * 0.52);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-4, -4, 8, 8);
        ctx.restore();
      }
    }
    drawVignette(ctx, view, pal);
    peekBox.current = null;
    if (pointed !== null) {
      const box = placePeek(
        pointed,
        pointed.stair.direction,
        PEEK_SIZE,
        tileSize(cam.current),
        size.current,
        d
      );
      if (box !== null) {
        drawPeek(ctx, pal, pointed, box, shown, p.map.win.floor);
        peekBox.current = box;
      }
    }
    if (moving) frame.current = window.requestAnimationFrame(draw);
  }, []);

  const redraw = useCallback(() => {
    if (frame.current === null) frame.current = window.requestAnimationFrame(draw);
  }, [draw]);

  // Anything the picture is made of moved, or the ring was just shown and needs placing.
  useEffect(redraw, [redraw, props, tokens, arenaExits, hover, peek]);

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    },
    []
  );

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const fit = (): void => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = element.clientWidth;
      const height = element.clientHeight;
      size.current = { width, height, ratio };
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      redraw();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [redraw]);

  // The blows, as they arrive: a line in flight, drawn and gone.
  useEffect(
    () =>
      api.onBlock(({ session: from, payload }) => {
        if (from !== session) return;
        const blow = blowOf(payload, arenaNames(latest.current.tokens));
        if (blow === null) return;
        const kept = flights.current.filter((one) => performance.now() - one.at < FLIGHT_MS);
        flights.current = [...kept, { ...blow, at: performance.now() }];
        redraw();
      }),
    [api, session, redraw]
  );

  const setFollow = useCallback(
    (on: boolean) => {
      if (follow.current === on) return;
      follow.current = on;
      onDetached(!on);
      redraw();
    },
    [onDetached, redraw]
  );

  const { show: showRoom } = map;
  /** Shows the floor a stair or the strip reaches, around that room, detached as a drag is. */
  const show = useCallback(
    (room: RoomId) => {
      focus.current = room;
      setFollow(false);
      setHover(null);
      showRoom(room);
    },
    [setFollow, showRoom]
  );

  useImperativeHandle(
    ref,
    () => ({
      zoom: (by) => {
        cam.current.z = Math.max(ZOOM.min, Math.min(ZOOM.max, cam.current.z * by));
        redraw();
      },
      follow: () => {
        focus.current = null;
        setFollow(true);
      }
    }),
    [redraw, setFollow]
  );

  // Nearest to where the window looks: its room, else its middle.
  const shownWindow = map.win;
  const floors = useMemo(() => {
    const near = shownWindow.centre ?? {
      gx: (shownWindow.box.x0 + shownWindow.box.x1) / 2,
      gy: (shownWindow.box.y0 + shownWindow.box.y1) / 2
    };
    return floorsReached(shownWindow, near);
  }, [shownWindow]);

  const viewNow = (): View => ({
    width: size.current.width,
    height: size.current.height,
    cam: cam.current
  });

  const pick = (x: number, y: number): Hover => {
    for (const spot of exits.current)
      if (Math.hypot(spot.x - x, spot.y - y) < 17 || inBox(spot.box, x, y))
        return { kind: 'exit', direction: spot.direction, x, y };
    const at = standings(disc.current, latest.current.tokens);
    for (const token of latest.current.tokens) {
      const spot = at.get(token.key);
      if (token.side === 'foe' && spot && Math.hypot(spot.x - x, spot.y - y) < 24)
        return { kind: 'foe', token, x, y };
    }
    const held = hoverRef.current;
    if (held?.kind === 'stair' && peekBox.current !== null && inBox(peekBox.current, x, y))
      return held;
    const d = disc.current;
    if (Math.hypot(d.x - x, d.y - y) < d.r) return null;
    for (const spot of stairs.current)
      if (inBox(spot.area, x, y)) return { kind: 'stair', spot, x: spot.x, y: spot.y };
    const scene = { win: map.win, at: map.at, byId: map.byId } as Scene;
    const cell = roomAt(viewNow(), scene, x, y);
    return cell && cell.id !== here ? { kind: 'room', cell, x, y } : null;
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>): void => {
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      cx: cam.current.x,
      cy: cam.current.y,
      moved: false
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    const held = drag.current;
    if (held) {
      const dx = event.clientX - held.x;
      const dy = event.clientY - held.y;
      if (!held.moved && Math.hypot(dx, dy) > 6) {
        held.moved = true;
        focus.current = null;
        setFollow(false);
      }
      if (held.moved) {
        const k = cellPx(cam.current);
        cam.current.x = held.cx - dx / k;
        cam.current.y = held.cy - dy / k;
        setHover(null);
        redraw();
        return;
      }
    }
    const found = pick(event.clientX, event.clientY);
    const same =
      found?.kind === hoverRef.current?.kind &&
      (found === null ||
        (found.kind === 'room' &&
          hoverRef.current?.kind === 'room' &&
          found.cell.id === hoverRef.current.cell.id) ||
        (found.kind === 'exit' &&
          hoverRef.current?.kind === 'exit' &&
          found.direction === hoverRef.current.direction) ||
        (found.kind === 'foe' &&
          hoverRef.current?.kind === 'foe' &&
          found.token.key === hoverRef.current.token.key) ||
        (found.kind === 'stair' &&
          hoverRef.current?.kind === 'stair' &&
          found.spot.cell.id === hoverRef.current.spot.cell.id &&
          found.spot.stair.direction === hoverRef.current.spot.stair.direction));
    if (!same) setHover(found);
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>): void => {
    const held = drag.current;
    drag.current = null;
    if (held?.moved) {
      map.lookAt(cam.current.x, cam.current.y);
      return;
    }
    const found = pick(event.clientX, event.clientY);
    const d = disc.current;
    if (found?.kind === 'stair') show(found.spot.stair.to);
    else if (found?.kind === 'exit') props.onExit(found.direction);
    else if (found?.kind === 'foe') props.onFoe(found.token.name);
    else if (found?.kind === 'room') props.onWalk(found.cell);
    else if (!follow.current && Math.hypot(d.x - event.clientX, d.y - event.clientY) < d.r)
      setFollow(true);
  };
  const onWheel = (event: WheelEvent<HTMLCanvasElement>): void => {
    cam.current.z = Math.max(
      ZOOM.min,
      Math.min(ZOOM.max, cam.current.z * Math.exp(-event.deltaY * 0.0012))
    );
    redraw();
  };

  return (
    <>
      <FloorStrip floors={floors} home={map.homeFloor} onShow={show} />
      <canvas
        aria-label={t('game.map.aria')}
        className="gv-world"
        data-pointer={hover === null ? 'grab' : 'pointer'}
        onPointerDown={onPointerDown}
        onPointerLeave={() => setHover(null)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        ref={canvas}
      />
      <RoundRing anchor={props.rounds} ref={ring} />
      {hover !== null && hover.kind !== 'stair' && (
        <MapTip hover={hover} map={map} pal={palette.current} />
      )}
    </>
  );
}

/**
 * The ring's radius past the arena's rim, px: the compass exits' discs are centred on the rim, so
 * the ring's stroke sits half its width outside them. Up and down sit further out and are crossed.
 */
const RING_GAP_PX = EXIT_RADIUS + RING_STROKE_PX;

function placeRing(element: SVGSVGElement | null, disc: Disc): void {
  if (element === null) return;
  const half = (disc.r + RING_GAP_PX) * RING_EXTENT;
  element.style.width = `${2 * half}px`;
  element.style.height = `${2 * half}px`;
  element.style.transform = `translate(${disc.x - half}px, ${disc.y - half}px)`;
}

/** What the pointer is over, said beside it. */
function MapTip({
  hover,
  map,
  pal
}: {
  hover: Exclude<Hover, null | { kind: 'stair' }>;
  map: GameMap;
  pal: GamePalette | null;
}) {
  const style = { left: hover.x + 16, top: hover.y + 18 };
  if (hover.kind === 'room') {
    const area = map.win.areas[hover.cell.area];
    return (
      <div className="gv-tip" style={style}>
        <b>{hover.cell.name}</b>
        {area?.named === true && <div className="gv-tip-quiet">{area.name}</div>}
        {hover.cell.icon && (
          <div style={pal ? { color: pal.places[placeTone(hover.cell.icon)] } : undefined}>
            {placeLabel(hover.cell.icon)}
          </div>
        )}
        {hover.cell.lair && <div className="gv-tip-quiet">{t('game.arena.lair')}</div>}
        {teleportsOf(hover.cell).map((way) => (
          <div key={`${way.command}:${way.to}`}>
            {t('game.map.teleport', { command: way.command, roomName: way.name })}
          </div>
        ))}
        {Object.entries(hover.cell.otherMap ?? {}).map(([direction, other]) => (
          <div key={direction}>{t('game.map.otherMap', { direction, map: other })}</div>
        ))}
        <div className="gv-tip-act">{t('game.map.clickToWalk')}</div>
      </div>
    );
  }
  if (hover.kind === 'exit')
    return (
      <div className="gv-tip" style={style}>
        <b>{hover.direction}</b>
        <div className="gv-tip-act">{t('game.map.clickToGo')}</div>
      </div>
    );
  return (
    <div className="gv-tip" style={style}>
      <b style={pal && hover.token.hostile ? { color: pal.hp } : undefined}>{hover.token.name}</b>
      {hover.token.hostile && <div className="gv-tip-quiet">{t('game.arena.hostile')}</div>}
      <div className="gv-tip-quiet">
        {hover.token.band === null ? t('game.arena.healthUnknown') : t('game.arena.healthKnown')}
      </div>
      <div className="gv-tip-act">
        {hover.token.target ? t('game.map.clickToAttack') : t('game.map.clickToTarget')}
      </div>
    </div>
  );
}

export default memo(forwardRef(WorldCanvas));
