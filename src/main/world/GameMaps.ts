/**
 * The game view's map window (todo 140): a square of one map's plane, with
 * each room's cell, area and icon, and the labels that fall in it.
 *
 * Areas come from the theme pack where it claims a room, else from the motif
 * the room's name suggests. Labels are worked out once per map: one per area
 * per island, one per stretch of rooms sharing a name (unless the area's name
 * already says it), and the pack's landmarks. A room whose name no
 * neighbouring room shares is labelled on its own, when the view is close.
 */
import {
  cellKey,
  EMPTY_GAME_MAP,
  guessMotif,
  MOTIF_PALETTES,
  type GameCell,
  type GameMapAsk,
  type GameMapWindow,
  type MapArea,
  type MapLabel,
  type MapLabelKind,
  type Motif
} from '../../shared/gameMap';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';
import { tuning } from '../app/tuning';
import { mapCellOf, type LairLevel, type MapCellGraph } from './localMap';
import { leapSteps, planeSteps } from './planeSteps';
import { RealmLayouts, type PlaneLayout } from './realmLayout';
import type { ThemePack } from './themePack';
import type { WorldGraph } from './WorldGraph';

/** An area by where it came from: the pack's index, or a guessed motif. */
type AreaKey = number | Motif;

/** Rooms of one area on one island before it earns a label of its own. */
export const AREA_LABEL_ROOMS = 4;

interface PlaneLabel {
  kind: MapLabelKind;
  text: string;
  gx: number;
  gy: number;
  area: AreaKey;
}

interface PlaneFacts {
  labels: PlaneLabel[];
  /** Rooms labelled on their own. */
  named: ReadonlySet<RoomId>;
}

const isDark = (room: WorldRoom): boolean => (room.light ?? 0) < 0;

export class GameMaps {
  private readonly layouts: RealmLayouts;
  private readonly facts = new Map<number, PlaneFacts>();

  constructor(
    private readonly graph: MapCellGraph & Pick<WorldGraph, 'everyRoom'>,
    private readonly pack: ThemePack
  ) {
    this.layouts = new RealmLayouts(graph);
  }

  private areaKeyOf(room: WorldRoom): AreaKey {
    return this.pack.areaOf(room) ?? guessMotif(room.name);
  }

  private factsOf(plane: PlaneLayout): PlaneFacts {
    const kept = this.facts.get(plane.map);
    if (kept) return kept;
    const rooms = this.layouts.roomsOf(plane.map);
    const labels: PlaneLabel[] = [];
    const named = new Set<RoomId>();
    const place = (ids: readonly RoomId[]) => {
      const cells = ids.map((id) => plane.at.get(id)!);
      const mx = cells.reduce((sum, cell) => sum + cell.gx, 0) / cells.length;
      const my = cells.reduce((sum, cell) => sum + cell.gy, 0) / cells.length;
      return cells.reduce((best, cell) =>
        Math.hypot(cell.gx - mx, cell.gy - my) < Math.hypot(best.gx - mx, best.gy - my)
          ? cell
          : best
      );
    };

    const pieces = new Map<string, { area: number; ids: RoomId[] }>();
    for (const room of rooms) {
      const id = roomId(room.map, room.room);
      const area = this.pack.areaOf(room);
      if (area === null) continue;
      const key = `${area}:${plane.island.get(id)}`;
      const piece = pieces.get(key);
      if (piece) piece.ids.push(id);
      else pieces.set(key, { area, ids: [id] });
    }
    for (const { area, ids } of pieces.values()) {
      if (ids.length < AREA_LABEL_ROOMS) continue;
      labels.push({ kind: 'area', text: this.pack.areas[area]!.name, ...place(ids), area });
    }

    // Stretches: rooms joined on one island that share a name.
    const seen = new Set<RoomId>();
    for (const room of rooms) {
      const start = roomId(room.map, room.room);
      if (seen.has(start)) continue;
      seen.add(start);
      const stretch = [start];
      const queue = [room];
      for (let head = 0; head < queue.length; head += 1) {
        for (const { to, destination } of planeSteps(this.graph, queue[head]!)) {
          if (seen.has(to) || destination.name !== room.name) continue;
          if (plane.island.get(to) !== plane.island.get(start)) continue;
          seen.add(to);
          stretch.push(to);
          queue.push(destination);
        }
      }
      const area = this.areaKeyOf(room);
      if (stretch.length === 1) named.add(start);
      else if (
        typeof area !== 'number' ||
        this.pack.areas[area]!.name.toLowerCase() !== room.name.toLowerCase()
      )
        labels.push({ kind: 'stretch', text: room.name, ...place(stretch), area });
      const landmark = this.pack.landmarkOf(room);
      if (landmark !== null) {
        const at = plane.at.get(start)!;
        labels.push({ kind: 'landmark', text: landmark, gx: at.gx, gy: at.gy, area });
        named.delete(start);
      }
    }
    const made = { labels, named };
    this.facts.set(plane.map, made);
    return made;
  }

  window(ask: GameMapAsk, lairLevel: LairLevel): GameMapWindow {
    const plane = this.layouts.of(ask.map);
    const half = Math.max(1, Math.min(tuning().view.gameMapHalf, Math.round(ask.half)));
    let centre: GameMapWindow['centre'] = null;
    let cx: number;
    let cy: number;
    if (ask.kind === 'room') {
      const id = roomId(ask.map, ask.room);
      const at = plane.at.get(id);
      if (!at) return { ...EMPTY_GAME_MAP, map: ask.map };
      centre = { room: id, gx: at.gx, gy: at.gy };
      cx = at.gx;
      cy = at.gy;
    } else {
      cx = Math.round(ask.gx);
      cy = Math.round(ask.gy);
    }
    const box = { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
    const facts = this.factsOf(plane);

    const areas: MapArea[] = [];
    const indexOf = new Map<AreaKey, number>();
    const areaIndex = (key: AreaKey): number => {
      const known = indexOf.get(key);
      if (known !== undefined) return known;
      areas.push(
        typeof key === 'number'
          ? this.pack.areas[key]!
          : { id: `guess-${key}`, name: '', motif: key, palette: MOTIF_PALETTES[key], named: false }
      );
      indexOf.set(key, areas.length - 1);
      return areas.length - 1;
    };

    const cells: GameCell[] = [];
    for (let gy = box.y0; gy <= box.y1; gy += 1) {
      for (let gx = box.x0; gx <= box.x1; gx += 1) {
        const id = plane.cells.get(cellKey(gx, gy));
        if (id === undefined) continue;
        const room = this.graph.byId(id)!;
        const to: GameCell['to'] = {};
        const otherMap: NonNullable<GameCell['otherMap']> = {};
        // The ways the plane follows, so a cast that scatters draws no line.
        for (const { exit, to: there, destination } of planeSteps(this.graph, room)) {
          to[exit.direction] = there;
          if (destination.map !== room.map) otherMap[exit.direction] = destination.map;
        }
        for (const { way } of leapSteps(this.graph, room))
          if (way.kind !== 'teleport') to[way.exit.direction] = way.to;
        const icon = room.shop === undefined ? null : this.pack.iconOf(room.shop);
        cells.push({
          ...mapCellOf(this.graph, room, gx, gy, lairLevel),
          area: areaIndex(this.areaKeyOf(room)),
          to,
          ...(icon === null ? {} : { icon }),
          ...(isDark(room) ? { dark: true as const } : {}),
          ...(facts.named.has(id) ? { named: true as const } : {}),
          ...(Object.keys(otherMap).length === 0 ? {} : { otherMap })
        });
      }
    }
    const inBox = (label: PlaneLabel) =>
      label.gx >= box.x0 && label.gx <= box.x1 && label.gy >= box.y0 && label.gy <= box.y1;
    const labels: MapLabel[] = facts.labels
      .filter(inBox)
      .map((label) => ({ ...label, area: areaIndex(label.area) }));
    return { map: ask.map, centre, box, cells, areas, labels };
  }
}
