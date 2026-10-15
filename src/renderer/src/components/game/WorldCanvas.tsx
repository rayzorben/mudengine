/**
 * The game view's world (todo 140): the whole plane on a canvas behind the HUD,
 * with the room you stand in as the arena. The camera follows you until the
 * map is dragged; then the arena docks to the right with a thread back to the
 * room, a click on a room walks there, and Esc, ◎ or a move brings it back.
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
import { MOTIF_PALETTES, type GameCell, type MapArea } from '@shared/gameMap';
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
import { placeTone } from '../../lib/gameIcons';
import { t } from '../../lib/i18n';
import type { GameMap } from '../../hooks/useGameMap';
import {
  drawFlights,
  drawExits,
  drawFloor,
  drawTokens,
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
  toScreen,
  ZOOM,
  type Camera,
  type GamePalette,
  type Scene,
  type View
} from './drawWorld';

export interface WorldCanvasHandle {
  zoom(by: number): void;
  /** Back to following the character, as Esc, ◎ and any move do. */
  follow(): void;
}

export interface WorldCanvasProps {
  api: Pick<IpcApi, 'onBlock'>;
  session: SessionId;
  character: CharacterState;
  map: GameMap;
  here: RoomId | null;
  candidates: readonly RoomId[];
  trail: readonly RoomId[];
  stops: ReadonlySet<RoomId>;
  finds: ReadonlySet<RoomId>;
  found: ReadonlyArray<readonly [RoomId, RoomId]>;
  players: Scene['players'];
  picked: string | null;
  onFoe(name: string): void;
  onExit(direction: Direction): void;
  onWalk(cell: GameCell): void;
  onDetached(detached: boolean): void;
}

type Hover =
  | { kind: 'room'; cell: GameCell; x: number; y: number }
  | { kind: 'exit'; direction: Direction; x: number; y: number }
  | { kind: 'foe'; token: ArenaToken; x: number; y: number }
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
  const frame = useRef<number | null>(null);
  const palette = useRef<GamePalette | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(
    null
  );
  const [hover, setHover] = useState<Hover>(null);
  const hoverRef = useRef<Hover>(null);
  hoverRef.current = hover;

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
  const latest = useRef({ props, tokens, arenaExits, hereCell });
  latest.current = { props, tokens, arenaExits, hereCell };

  const draw = useCallback((): void => {
    frame.current = null;
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const pal = (palette.current ??= readGamePalette(element));
    const { width, height, ratio } = size.current;
    const { props: p, tokens: list, arenaExits: rim, hereCell: cell } = latest.current;
    const now = performance.now();
    let moving = false;

    if (follow.current && cell) {
      const dx = cell.gx - cam.current.x;
      const dy = cell.gy - cam.current.y;
      if (Math.abs(dx) > SETTLED || Math.abs(dy) > SETTLED) {
        cam.current.x += dx * EASE * 1.4;
        cam.current.y += dy * EASE * 1.4;
        moving = true;
      } else {
        cam.current.x = cell.gx;
        cam.current.y = cell.gy;
      }
    }
    const view: View = { width, height, cam: cam.current };
    const radius = arenaRadius(width, height);
    // Lost, the arena stands in the middle of the screen: the fight is drawn wherever the room is.
    const goal = !follow.current
      ? { x: width - radius * 0.82 - 44, y: height * 0.54, r: radius * 0.82, dock: 1 }
      : cell
        ? { ...toScreen(view, cell.gx, cell.gy), r: radius, dock: 0 }
        : { x: width / 2, y: height / 2, r: radius, dock: 0 };
    const d = disc.current;
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
    if (moving) frame.current = window.requestAnimationFrame(draw);
  }, []);

  const redraw = useCallback(() => {
    if (frame.current === null) frame.current = window.requestAnimationFrame(draw);
  }, [draw]);

  // Anything the picture is made of moved.
  useEffect(redraw, [redraw, props, tokens, arenaExits, hover]);

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

  useImperativeHandle(
    ref,
    () => ({
      zoom: (by) => {
        cam.current.z = Math.max(ZOOM.min, Math.min(ZOOM.max, cam.current.z * by));
        redraw();
      },
      follow: () => setFollow(true)
    }),
    [redraw, setFollow]
  );

  const viewNow = (): View => ({
    width: size.current.width,
    height: size.current.height,
    cam: cam.current
  });

  const pick = (x: number, y: number): Hover => {
    for (const spot of exits.current) {
      const inBox =
        x >= spot.box.x &&
        x <= spot.box.x + spot.box.w &&
        y >= spot.box.y &&
        y <= spot.box.y + spot.box.h;
      if (Math.hypot(spot.x - x, spot.y - y) < 17 || inBox)
        return { kind: 'exit', direction: spot.direction, x, y };
    }
    const at = standings(disc.current, latest.current.tokens);
    for (const token of latest.current.tokens) {
      const spot = at.get(token.key);
      if (token.side === 'foe' && spot && Math.hypot(spot.x - x, spot.y - y) < 24)
        return { kind: 'foe', token, x, y };
    }
    const d = disc.current;
    if (Math.hypot(d.x - x, d.y - y) < d.r) return null;
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
          found.token.key === hoverRef.current.token.key));
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
    if (found?.kind === 'exit') props.onExit(found.direction);
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
      {hover !== null && <MapTip hover={hover} map={map} pal={palette.current} />}
    </>
  );
}

/** What the pointer is over, said beside it. */
function MapTip({
  hover,
  map,
  pal
}: {
  hover: NonNullable<Hover>;
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
