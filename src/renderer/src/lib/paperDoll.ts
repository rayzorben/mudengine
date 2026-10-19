/**
 * The character panel's paper doll (todo 20261018-2032-01): where each worn
 * slot's square sits round the body and where its line lands on it. Every
 * slot belongs to a region, which colours the body part, the line and the
 * square. A column keeps its slots in the order their landing points run down
 * the body, and each square sits level with its point as far as spacing
 * allows, so no two lines cross (the user, 2026-10-18). With the art
 * server's drawing in the body's place the squares stay and the lines run
 * dotted to the same places on it (the user, 2026-10-19). Pure; `WornSlots`
 * draws it.
 */
import { placesIn, WORN_SLOT } from '@shared/items';

export type DollRegion = 'head' | 'torso' | 'arms' | 'held' | 'lower';
export const DOLL_REGIONS: readonly DollRegion[] = ['head', 'torso', 'arms', 'held', 'lower'];

type Side = 'left' | 'right' | 'below';

interface Mount {
  region: DollRegion;
  side: Side;
  /** Where the line lands, in the figure's own 200 x 400 box (`FIGURE`). */
  at: readonly [number, number];
}

/**
 * Every `WORN_SLOT` code, and a second entry where the slot holds two
 * (`placesIn`): the left hand's ring and wrist, then the right's.
 */
const MOUNTS: Readonly<Record<number, readonly Mount[]>> = {
  1: [{ region: 'held', side: 'right', at: [184, 230] }],
  2: [{ region: 'head', side: 'left', at: [86, 16] }],
  3: [{ region: 'arms', side: 'right', at: [170, 236] }],
  4: [
    { region: 'arms', side: 'left', at: [30, 242] },
    { region: 'arms', side: 'right', at: [167, 247] }
  ],
  5: [{ region: 'lower', side: 'below', at: [116, 388] }],
  6: [{ region: 'arms', side: 'left', at: [44, 142] }],
  7: [{ region: 'torso', side: 'right', at: [124, 132] }],
  8: [{ region: 'torso', side: 'right', at: [110, 80] }],
  9: [{ region: 'lower', side: 'below', at: [80, 300] }],
  10: [{ region: 'lower', side: 'below', at: [132, 210] }],
  11: [{ region: 'torso', side: 'left', at: [60, 98] }],
  12: [{ region: 'held', side: 'left', at: [26, 228] }],
  14: [
    { region: 'arms', side: 'left', at: [32, 196] },
    { region: 'arms', side: 'right', at: [168, 196] }
  ],
  15: [{ region: 'head', side: 'left', at: [71, 44] }],
  16: [{ region: 'torso', side: 'left', at: [84, 122] }],
  17: [{ region: 'held', side: 'below', at: [150, 214] }],
  19: [{ region: 'head', side: 'right', at: [114, 46] }]
};

export interface DollSlot {
  /** `code/place`: the slot and which of its places, `4/1` the second ring. */
  id: string;
  code: number;
  place: number;
  /** The server's word for the slot. */
  word: string;
  region: DollRegion;
}

/** Every square the doll draws, in `WORN_SLOT` order. */
export const DOLL_SLOTS: readonly DollSlot[] = Object.entries(WORN_SLOT).flatMap(([raw, word]) => {
  const code = Number(raw);
  return Array.from({ length: placesIn(code) }, (_, place) => ({
    id: `${code}/${place}`,
    code,
    place,
    word,
    region: MOUNTS[code]![place]!.region
  }));
});

export interface DollGeometry {
  /** The figure's top-left and scale, in the panel's pixels. */
  figure: { x: number; y: number; scale: number };
  size: number;
  gap: number;
  /** The left and right columns' x, and the span they share. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The row under the feet: its y and the span it shares. */
  below: { y: number; from: number; to: number };
}

/** The doll's box, in pixels, as the accepted prototype measured it (2026-10-18). */
export const DOLL_BOX = { width: 500, height: 480 } as const;

/** Where the panel lays the doll out inside `DOLL_BOX`. */
export const DOLL_GEOMETRY: DollGeometry = {
  figure: { x: 196, y: 16, scale: 0.96 },
  size: 48,
  gap: 8,
  left: 44,
  right: 438,
  top: 12,
  bottom: 478,
  below: { y: 432, from: 120, to: 420 }
};

/**
 * The art server's drawing (todo 20261019-0931-01), 832 x 1216, and where its
 * body runs in it, measured on three drawings: from about 9% down (a crown
 * 6%, a Gnome's bald head 13.5%) to 96%, centred 53% across. It is drawn
 * mirrored: the server puts the weapon in the character's right hand, the
 * viewer's left, and the doll has the weapon hand on the viewer's right.
 */
const DRAWING = {
  width: 832,
  height: 1216,
  bodyTop: 0.09,
  bodyBottom: 0.96,
  /** The body's centre across, mirrored: 1 - 0.53. */
  bodyAcross: 0.47
} as const;

/** The figure box's size, which a mount's `at` is measured in. */
const FIGURE = { width: 200, height: 400 } as const;

/** The doll's own body centre across, where the drawing's is put. */
const DOLL_CENTRE = DOLL_GEOMETRY.figure.x + (FIGURE.width / 2) * DOLL_GEOMETRY.figure.scale;

/** The drawing's height in `DOLL_BOX`: its feet end above the row under them. */
const DRAWN_HEIGHT = 420;
const DRAWN_TOP = 4;
const DRAWN_WIDTH = (DRAWN_HEIGHT * DRAWING.width) / DRAWING.height;

/** Where the drawing sits in `DOLL_BOX`. */
export const DRAWING_BOX = {
  left: DOLL_CENTRE - DRAWING.bodyAcross * DRAWN_WIDTH,
  top: DRAWN_TOP,
  height: DRAWN_HEIGHT
} as const;

const DRAWN_SCALE = ((DRAWING.bodyBottom - DRAWING.bodyTop) * DRAWN_HEIGHT) / FIGURE.height;

/** The doll's squares, with the figure box laid over the drawing's body. */
export const DRAWING_GEOMETRY: DollGeometry = {
  ...DOLL_GEOMETRY,
  figure: {
    x: DOLL_CENTRE - (FIGURE.width / 2) * DRAWN_SCALE,
    y: DRAWN_TOP + DRAWING.bodyTop * DRAWN_HEIGHT,
    scale: DRAWN_SCALE
  }
};

export interface PlacedSlot extends DollSlot {
  x: number;
  y: number;
  /** The line from the square's edge to the body. */
  line: readonly [readonly [number, number], readonly [number, number]];
}

/**
 * Positions along one axis, each as near its wish as the gap allows, inside
 * [from, to]: forward pushes down past the one before, backward pulls up from
 * the end. The order of `wish` is kept, which is what keeps lines from crossing.
 */
export function packColumn(
  wish: readonly number[],
  size: number,
  gap: number,
  from: number,
  to: number
): number[] {
  const out: number[] = [];
  wish.forEach((want, i) => (out[i] = Math.max(want, i === 0 ? from : out[i - 1]! + size + gap)));
  for (let i = out.length - 1; i >= 0; i--)
    out[i] = Math.min(out[i]!, i === out.length - 1 ? to - size : out[i + 1]! - size - gap);
  return out;
}

const cross = (a: readonly number[], b: readonly number[], c: readonly number[]): number =>
  (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);

/** How many pairs of lines cross each other. */
export function crossings(lines: readonly PlacedSlot['line'][]): number {
  let count = 0;
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const [p1, p2] = lines[i]!;
      const [p3, p4] = lines[j]!;
      if (
        cross(p3, p4, p1) > 0 !== cross(p3, p4, p2) > 0 &&
        cross(p1, p2, p3) > 0 !== cross(p1, p2, p4) > 0
      )
        count++;
    }
  return count;
}

/** Every square placed, with its line. */
export function layoutDoll(g: DollGeometry): PlacedSlot[] {
  const landing = (slot: DollSlot): [number, number] => {
    const [x, y] = MOUNTS[slot.code]![slot.place]!.at;
    return [g.figure.x + x * g.figure.scale, g.figure.y + y * g.figure.scale];
  };
  const sideOf = (slot: DollSlot): Side => MOUNTS[slot.code]![slot.place]!.side;
  const half = g.size / 2;
  const out: PlacedSlot[] = [];
  for (const side of ['left', 'right', 'below'] as const) {
    const axis = side === 'below' ? 0 : 1;
    const column = DOLL_SLOTS.filter((slot) => sideOf(slot) === side).sort(
      (a, b) => landing(a)[axis] - landing(b)[axis]
    );
    const wish = column.map((slot) => landing(slot)[axis] - half);
    const at =
      side === 'below'
        ? packColumn(wish, g.size, g.gap, g.below.from, g.below.to)
        : packColumn(wish, g.size, g.gap, g.top, g.bottom);
    column.forEach((slot, i) => {
      const end = landing(slot);
      const x = side === 'left' ? g.left : side === 'right' ? g.right : at[i]!;
      const y = side === 'below' ? g.below.y : at[i]!;
      const start: [number, number] =
        side === 'below' ? [x + half, y] : [side === 'left' ? x + g.size : x, y + half];
      out.push({ ...slot, x, y, line: [start, end] });
    });
  }
  return out;
}
