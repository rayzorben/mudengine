import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLOAT,
  docked,
  floatAlphas,
  lifted,
  normalizeLayout,
  placed,
  raised
} from '../useCardLayout';
import {
  CARDS,
  hidesWhenEmpty,
  HIDES_WHEN_EMPTY,
  LEAST_CARD,
  shippedSize,
  type CardId,
  type CardLayout
} from '../../lib/cards';
import type { GridBox } from '../../lib/railGrid';

const ALL: CardId[] = CARDS.map((card) => card.id);

/** Every card is somewhere, and no card is in two places. */
function accountsForEveryCard(layout: ReturnType<typeof normalizeLayout>): void {
  const seen = [
    ...layout.rail,
    ...layout.above,
    ...layout.below,
    ...layout.floats.map((float) => float.id),
    ...layout.away
  ];
  expect([...seen].sort()).toEqual([...ALL].sort());
  expect(new Set(seen).size).toBe(seen.length);
}

describe('a rail that has never been arranged', () => {
  it('shows everything except the opt-in cards', () => {
    const layout = normalizeLayout({});
    accountsForEveryCard(layout);
    expect(layout.away).toEqual([
      'builder',
      'gang',
      'inventory',
      'banks',
      'shops',
      'quests',
      'hunting',
      'conversation',
      'stats',
      'extension'
    ]);
    expect(layout.floats).toEqual([]);
  });

  /* The two readouts a decision gets made off under pressure, adjacent. */
  it('holds them in the order they ship in', () => {
    expect(normalizeLayout({}).rail.slice(0, 5)).toEqual([
      'self',
      'vitals',
      'combat',
      'room',
      'map'
    ]);
  });
});

describe('a rail someone has arranged', () => {
  it('keeps the order they put it in', () => {
    const layout = normalizeLayout({ rail: ['map', 'vitals'], away: ['room'] });
    expect(layout.rail.slice(0, 2)).toEqual(['map', 'vitals']);
    expect(layout.away).toContain('room');
  });

  /*
   * The failure this is guarding against is the one CLAUDE.md records about the
   * options template: a setting nobody can see is a setting nobody uses. A card
   * added by a later build has to turn up somewhere.
   */
  it('finds room for a card the stored layout has never heard of', () => {
    const layout = normalizeLayout({ rail: ['vitals'], away: ['room', 'map'] });
    accountsForEveryCard(layout);
    expect(layout.rail).toContain('navigation');
    // Behind what was actually arranged, not in front of it.
    expect(layout.rail.indexOf('vitals')).toBeLessThan(layout.rail.indexOf('navigation'));
  });

  it('drops a card this build no longer has', () => {
    const layout = normalizeLayout({ rail: ['vitals', 'traffic' as CardId] });
    accountsForEveryCard(layout);
    expect(layout.rail).not.toContain('traffic');
  });

  it('never leaves a card in two places at once', () => {
    accountsForEveryCard(
      normalizeLayout({
        rail: ['vitals', 'map'],
        floats: [{ id: 'vitals', x: 0.5, y: 0.5, w: 0.3, h: 0.3, solidity: 0.8 }],
        away: ['map', 'vitals']
      })
    );
  });
});

describe('a float read back off disk', () => {
  it('keeps a sane geometry', () => {
    const layout = normalizeLayout({
      floats: [{ id: 'map', x: 0.25, y: 0.4, w: 0.3, h: 0.35, solidity: 0.6 }]
    });
    expect(layout.floats[0]).toEqual({
      id: 'map',
      x: 0.25,
      y: 0.4,
      w: 0.3,
      h: 0.35,
      solidity: 0.6
    });
  });

  /*
   * A layout written by a differently-shaped window, or by an older build, must
   * not put a card somewhere it cannot be dragged back from.
   */
  it('pulls an off-screen float back where it can be reached', () => {
    const layout = normalizeLayout({
      floats: [{ id: 'map', x: 4, y: -2, w: 9, h: 0, solidity: 12 }]
    });
    const float = layout.floats[0]!;
    expect(float.x).toBeLessThanOrEqual(0.98);
    expect(float.y).toBeGreaterThanOrEqual(0);
    expect(float.w).toBeLessThanOrEqual(1);
    expect(float.h).toBeGreaterThan(0);
    expect(float.solidity).toBeLessThanOrEqual(1);
  });

  it('discards a float with nonsense in it rather than failing the whole layout', () => {
    const layout = normalizeLayout({
      floats: [
        { id: 'nope' } as never,
        { id: 'map', x: 0.5, y: 0.5, w: 0.3, h: 0.3, solidity: 0.8 }
      ]
    });
    accountsForEveryCard(layout);
    expect(layout.floats.map((float) => float.id)).toEqual(['map']);
  });

  /*
   * An arrangement made before the fill alpha became one slider driving two is
   * not thrown away. The project is unreleased, but silently resetting somebody
   * back to the shipped layout is still the wrong way to change a format.
   */
  it('reads a float stored under the old field name', () => {
    const layout = normalizeLayout({
      floats: [{ id: 'map', x: 0.5, y: 0.5, w: 0.3, h: 0.3, opacity: 0.4 } as never]
    });
    expect(layout.floats[0]!.solidity).toBeCloseTo(0.4);
  });
});

describe('how solid a floating card is drawn', () => {
  /*
   * The ceiling is the player's to remove and is gone (todo 04). It was 60%,
   * then 90%, each time on the argument that a card hiding the game completely
   * is one somebody would close rather than move — which is a reason to ship
   * the slider low, not a reason to withhold the end of it.
   */
  it('lets the panel be made solid at the top of the slider', () => {
    expect(floatAlphas(1).fill).toBeCloseTo(1);
  });

  /*
   * But a card dropped over the console does not *start* there. With a ceiling
   * of 90% the top of the slider and the shipped fill were the same place;
   * with no ceiling, shipping at the top would make every new float opaque and
   * quietly undo the thing the slider exists to offer.
   */
  it('ships a new float below the top, still showing the game through it', () => {
    const { fill, text } = floatAlphas(DEFAULT_FLOAT.solidity);
    expect(fill).toBeCloseTo(0.9);
    expect(fill).toBeLessThan(1);
    expect(text).toBeGreaterThan(fill);
  });

  /* The text may reach full strength: a number is what the card is *for*. */
  it('lets the readout itself reach full strength', () => {
    expect(floatAlphas(1).text).toBeCloseTo(1);
  });

  /* A card you can see through is useful; a *readout* you can see through is
     not — so wherever the console shows through at all, the text is ahead of
     the fill. At the top the two meet, because there is nothing to show. */
  it('keeps the text ahead of the fill wherever the game shows through', () => {
    for (const solidity of [0, 0.25, 0.5, 0.75]) {
      const { fill, text } = floatAlphas(solidity);
      expect(text).toBeGreaterThan(fill);
    }
    const solid = floatAlphas(1);
    expect(solid.text).toBeGreaterThanOrEqual(solid.fill);
  });

  it('never lets a card disappear, because an invisible one cannot be dragged back', () => {
    expect(floatAlphas(0).fill).toBeCloseTo(0.25);
    expect(floatAlphas(0).text).toBeCloseTo(0.6);
  });

  it('clamps a value from outside the range rather than extrapolating', () => {
    expect(floatAlphas(-5).fill).toBeCloseTo(floatAlphas(0).fill);
    expect(floatAlphas(9).text).toBeCloseTo(floatAlphas(1).text);
  });
});

/*
 * Docked to the console rather than beside it — the placement a floating card
 * cannot give, because it does not cover the game.
 */
describe('a card docked above or below the console', () => {
  it('stays where it was put', () => {
    const layout = normalizeLayout({ below: ['conversation'], rail: ['vitals'] });
    accountsForEveryCard(layout);
    expect(layout.below).toEqual(['conversation']);
    expect(layout.rail).not.toContain('conversation');
  });

  it('holds several, in order', () => {
    const layout = normalizeLayout({ above: ['notifications', 'conversation'] });
    // The toolbar's shipped home is this strip, so it joins the two the stored
    // layout named rather than being dropped or landing on the rail.
    expect(layout.above).toEqual(['notifications', 'conversation', 'toolbar']);
  });

  it('never leaves a card in a strip and on the rail at once', () => {
    accountsForEveryCard(
      normalizeLayout({ rail: ['conversation'], below: ['conversation'], above: ['conversation'] })
    );
  });

  it('drops a card a later build no longer has', () => {
    const layout = normalizeLayout({ below: ['traffic' as CardId, 'conversation'] });
    accountsForEveryCard(layout);
    expect(layout.below).toEqual(['conversation']);
  });

  /* A layout from before the strips existed still resolves, with everything on
     the rail where it was — and the toolbar in the strip it ships in. */
  it('reads a layout written before strips existed', () => {
    const layout = normalizeLayout({ rail: ['vitals', 'room'], away: ['map'] });
    accountsForEveryCard(layout);
    expect(layout.above).toEqual(['toolbar']);
    expect(layout.below).toEqual([]);
  });

  /*
   * A card nobody can find is a card that was never built, and the toolbar is
   * the first card whose shipped home is a *strip* rather than the rail: a row
   * of glyphs down a column is a list. A stored layout that has never heard of
   * it must therefore put it in the strip, not on the rail with everything
   * else the layout does not mention.
   */
  it('docks the toolbar above the console for a rail that has never seen it', () => {
    const layout = normalizeLayout({ rail: ['vitals'] });
    expect(layout.above).toContain('toolbar');
    expect(layout.rail).not.toContain('toolbar');
    expect(layout.away).not.toContain('toolbar');
  });

  /* And a player who moved it somewhere else keeps it there. */
  it('leaves the toolbar wherever it was put', () => {
    expect(normalizeLayout({ rail: ['toolbar', 'vitals'] }).above).toEqual([]);
    expect(normalizeLayout({ away: ['toolbar'] }).above).toEqual([]);
  });
});

/*
 * Paint order is list order, so the last float is the one on top. A click on
 * the visible corner of the one underneath has to bring it forward, or it
 * cannot be dragged until the one covering it is moved away.
 */
describe('raising a floating card', () => {
  const floats = normalizeLayout({
    floats: [
      { id: 'map', x: 0.1, y: 0.1, w: 0.3, h: 0.3, solidity: 1 },
      { id: 'vitals', x: 0.2, y: 0.2, w: 0.3, h: 0.3, solidity: 1 }
    ]
  }).floats;

  it('moves the card to the end of the paint order', () => {
    expect(raised(floats, 'map').map((float) => float.id)).toEqual(['vitals', 'map']);
  });

  it('returns the same list when the card is already on top', () => {
    expect(raised(floats, 'vitals')).toBe(floats);
  });

  it('returns the same list for a card that is not floating', () => {
    expect(raised(floats, 'room')).toBe(floats);
  });
});

/*
 * A card lifted over the console — off a lane, or from where it was already
 * floating, which is what a snap does (todo 02).
 */
describe('lifting a card over the console', () => {
  const where = { x: 0.4, y: 0.2 };

  it('takes the size it is given, and what it had before that', () => {
    expect(lifted('map', undefined, where)).toEqual({
      id: 'map',
      ...where,
      w: DEFAULT_FLOAT.w,
      h: DEFAULT_FLOAT.h,
      solidity: DEFAULT_FLOAT.solidity
    });
    const before = { id: 'map', x: 0, y: 0, w: 0.5, h: 0.5, solidity: 0.4 } as const;
    expect(lifted('map', before, where)).toMatchObject({ w: 0.5, h: 0.5, solidity: 0.4 });
    expect(lifted('map', before, where, { w: 0.2, h: 0.9 })).toMatchObject({ w: 0.2, h: 0.9 });
  });

  /*
   * Nothing lifted an already-floating card until snapping did, so the pin had
   * never had to survive one — and losing it would take a card out of view on
   * the next character switch because somebody lined it up with a neighbour.
   */
  it('keeps a pin across a lift, and invents one for nothing', () => {
    const pinned = { id: 'map', x: 0, y: 0, w: 0.5, h: 0.5, solidity: 1, pinned: true } as const;
    expect(lifted('map', pinned, where).pinned).toBe(true);
    expect(lifted('map', { ...pinned, pinned: undefined }, where).pinned).toBeUndefined();
    expect(lifted('map', undefined, where).pinned).toBeUndefined();
  });

  it('clamps a card into the workspace and off its floor', () => {
    expect(lifted('map', undefined, { x: -1, y: 4 })).toMatchObject({ x: 0, y: 0.98 });
    expect(lifted('map', undefined, where, { w: 0.001, h: 9 })).toMatchObject({ w: 0.12, h: 1 });
  });
});

describe('pinning a float', () => {
  it('reads a pinned float back, and refuses the flag on anything but true', () => {
    const stored = normalizeLayout({
      floats: [
        { id: 'conversation', x: 0.1, y: 0.1, w: 0.3, h: 0.3, solidity: 1, pinned: true },
        { id: 'map', x: 0.1, y: 0.1, w: 0.3, h: 0.3, solidity: 1, pinned: 'yes' }
      ]
    } as unknown as Parameters<typeof normalizeLayout>[0]);
    expect(stored.floats.find((f) => f.id === 'conversation')?.pinned).toBe(true);
    expect(stored.floats.find((f) => f.id === 'map')?.pinned).toBeUndefined();
  });
});

/*
 * What a player has set on one card, kept beside where the card is but
 * deliberately not part of it: rearranging a rail must not undo a preference.
 */
describe('what is set on a card', () => {
  it('is empty for a rail nobody has touched', () => {
    expect(normalizeLayout({}).settings).toEqual({});
  });

  it('survives the card being moved, floated and put away', () => {
    const layout = normalizeLayout({
      away: ['combat'],
      settings: { combat: { autoHide: true } }
    });
    expect(layout.settings.combat?.autoHide).toBe(true);
  });

  it('drops a block naming a card this build no longer has', () => {
    const layout = normalizeLayout({
      settings: { traffic: { autoHide: true }, combat: { autoHide: true } } as never
    });
    expect(Object.keys(layout.settings)).toEqual(['combat']);
  });

  /*
   * An empty block is the same statement as no block, and keeping it would put
   * a card in the stored settings for ever after one setting was turned back
   * off — which is how a default that changes in a later build stops reaching
   * anybody.
   */
  it('keeps no block for a card with nothing set on it', () => {
    expect(normalizeLayout({ settings: { combat: {} } }).settings).toEqual({});
  });
});

/*
 * The five cards that can be empty, and the one switch that decides whether
 * each holds its place while it is. The defaults are what each card did before
 * the switch existed, so turning the feature on moved nothing on anybody's rail.
 */
describe('a card with nothing to say', () => {
  it('keeps what each card did before it was a setting', () => {
    expect(hidesWhenEmpty({}, 'combat')).toBe(false);
    expect(hidesWhenEmpty({}, 'party')).toBe(true);
    expect(hidesWhenEmpty({}, 'navigation')).toBe(true);
    expect(hidesWhenEmpty({}, 'gang')).toBe(false);
    expect(hidesWhenEmpty({}, 'banks')).toBe(false);
  });

  /* A card that always has something true to say offers no such control, so
     nothing may accidentally hide one by storing the key against it. */
  it('holds a card the table does not name, whatever is stored', () => {
    expect(hidesWhenEmpty({}, 'room')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(HIDES_WHEN_EMPTY, 'room')).toBe(false);
  });

  it('lets a stored answer outrank the default, either way round', () => {
    expect(hidesWhenEmpty({ autoHide: true }, 'combat')).toBe(true);
    expect(hidesWhenEmpty({ autoHide: false }, 'party')).toBe(false);
  });
});

/*
 * A palette for one card, remembered per client appearance, so switching the
 * client between light and dark brings back what the card wore that way round.
 */
describe("a card's own palette", () => {
  it('reads both halves back', () => {
    const layout = normalizeLayout({
      settings: { combat: { theme: { dark: 'nord', light: 'github-light' } } }
    });
    expect(layout.settings.combat?.theme).toEqual({ dark: 'nord', light: 'github-light' });
  });

  /* An id this build no longer registers falls back to following the client,
     which is the answer that is never wrong — a retained unknown would be a
     setting somebody chose and then watched do nothing. */
  it('drops a half naming a theme this build does not have', () => {
    const layout = normalizeLayout({
      settings: { combat: { theme: { dark: 'nord', light: 'sunburst' } } as never }
    });
    expect(layout.settings.combat?.theme).toEqual({ dark: 'nord' });
  });

  it('keeps no block at all when neither half survives', () => {
    const layout = normalizeLayout({
      settings: { combat: { theme: { dark: 'sunburst' } } as never }
    });
    expect(layout.settings).toEqual({});
  });
});

/*
 * A rail card's size and spot are whole grid cells (todo 09). A figure under
 * the least a card may be is raised to it, so no card can be stored at a size
 * it cannot be dragged back from, and a spot for a card not on the rail is
 * dropped: a card that leaves the rail gives its spot up.
 */
describe('a card sized and placed on the rail', () => {
  it('keeps its size in whole cells, never under the least', () => {
    const layout = normalizeLayout({
      sizes: { room: { w: 20.4, h: 9 }, vitals: { w: 1, h: 1 } }
    });
    expect(layout.sizes).toEqual({ room: { w: 20, h: 9 }, vitals: LEAST_CARD });
  });

  it('keeps no entry for a size that is the shipped one, or one it cannot read', () => {
    const stored = {
      room: shippedSize('room'),
      map: { w: 'wide' },
      ghost: { w: 9, h: 9 }
    } as unknown as CardLayout['sizes'];
    expect(normalizeLayout({ sizes: stored }).sizes).toEqual({});
  });

  it('keeps the spots of the cards on the rail, and only those', () => {
    const layout = normalizeLayout({
      rail: ['room'],
      away: ['map'],
      spots: { room: { x: 3, y: 40 }, map: { x: 0, y: 0 }, vitals: { x: -2, y: 'top' } } as never
    });
    expect(layout.spots).toEqual({ room: { x: 3, y: 40 } });
  });
});

/*
 * Placing a card on the grid writes down every rail card where it is drawn,
 * so what was on screen is what is kept and the card in hand lands where the
 * landing box said.
 */
describe('placing a card on the rail', () => {
  const layout = normalizeLayout({ rail: ['vitals', 'room'], away: ['map'] });
  const drawn = new Map<CardId, GridBox>([
    ['vitals', { x: 0, y: 0, w: 17, h: 13 }],
    ['room', { x: 17, y: 0, w: 17, h: 14 }]
  ]);

  it('stands it in its cells and freezes the rest where they are drawn', () => {
    const next = placed(layout, 'room', { x: 0, y: 13, w: 17, h: 14 }, drawn);
    expect(next.spots).toMatchObject({ vitals: { x: 0, y: 0 }, room: { x: 0, y: 13 } });
    expect(next.sizes).toEqual({});
  });

  it('keeps a size that is not the shipped one', () => {
    const next = placed(layout, 'room', { x: 17, y: 0, w: 10, h: 6 }, drawn);
    expect(next.sizes).toEqual({ room: { w: 10, h: 6 } });
  });

  it('brings a card from elsewhere onto the rail', () => {
    const next = placed(layout, 'map', { x: 0, y: 14, w: 17, h: 25 }, drawn);
    expect(next.rail).toContain('map');
    expect(next.away).not.toContain('map');
    expect(next.spots['map']).toEqual({ x: 0, y: 14 });
  });

  it('writes nothing when nothing moved', () => {
    const settled = placed(layout, 'room', { x: 17, y: 0, w: 17, h: 14 }, drawn);
    expect(placed(settled, 'room', { x: 17, y: 0, w: 17, h: 14 }, drawn)).toBe(settled);
  });

  it('gives the spot up when the card leaves the rail', () => {
    const settled = placed(layout, 'room', { x: 0, y: 13, w: 17, h: 14 }, drawn);
    expect(docked(settled, 'room', 'below', 0).spots['room']).toBeUndefined();
  });
});

/*
 * A card rolled up to its heading. Placement, not preference: it rides beside
 * the dragged heights rather than in `CardSettings`, so it survives every move
 * and goes back with the arrangement when `reset` is reached for.
 */
describe('a card rolled up to its heading', () => {
  it('reads the cards a stored layout says are rolled', () => {
    expect(normalizeLayout({ rolled: ['room', 'map'] }).rolled).toEqual(['room', 'map']);
  });

  it('drops a name this build no longer has, and holds a repeat once', () => {
    const stored = ['room', 'ghost', 'room'] as unknown as CardId[];
    // A duplicate would leave a copy behind when the card was rolled down,
    // which reads as a toggle that did nothing.
    expect(normalizeLayout({ rolled: stored }).rolled).toEqual(['room']);
  });

  it('reads a layout written before rolling existed as none rolled', () => {
    expect(normalizeLayout({ rail: ['room'] }).rolled).toEqual([]);
    expect(normalizeLayout({ rolled: 'room' as unknown as CardId[] }).rolled).toEqual([]);
  });

  /*
   * The card is still accounted for exactly once. Rolling is not a placement of
   * its own -- a rolled card is on the rail, in a strip or over the console
   * like any other, and drawn shorter.
   */
  it('leaves the card wherever it actually is', () => {
    const layout = normalizeLayout({ rail: ['room', 'map'], rolled: ['room'] });
    accountsForEveryCard(layout);
    expect(layout.rail.slice(0, 2)).toEqual(['room', 'map']);
  });

  it('survives the card being moved between lanes', () => {
    const layout = normalizeLayout({ rail: ['room', 'map'], rolled: ['room'] });
    expect(docked(layout, 'room', 'below', 0).rolled).toEqual(['room']);
  });

  /*
   * `reset` is reached for by somebody untangling a rail they have dragged into
   * a corner, and a rail rolled flat is that. The heights go the same way; what
   * is *set* on each card stays, because throwing a theme away with the mess
   * would make this a control nobody dares press.
   */
  it('comes back open when the arrangement is reset', () => {
    expect(normalizeLayout({ settings: { room: { autoHide: true } } }).rolled).toEqual([]);
  });
});

/*
 * The gap is counted among the strip's cards as drawn, the dragged one
 * included, so a card moved along its own strip lands where the gap was
 * drawn and not one slot further. It did land one further, for as long as
 * the rail could be dragged; the smoke run only ever dragged a card up.
 */
describe('docking a card at a gap', () => {
  const layout = normalizeLayout({ below: ['self', 'vitals', 'combat', 'room'] });

  it('lands a card dragged along its own strip where the gap was drawn', () => {
    // The gap between vitals and combat is gap 2 of the list as drawn.
    expect(docked(layout, 'self', 'below', 2).below).toEqual(['vitals', 'self', 'combat', 'room']);
  });

  it('lands a card dragged back along its own strip at the gap', () => {
    expect(docked(layout, 'room', 'below', 0).below).toEqual(['room', 'self', 'vitals', 'combat']);
  });

  it('changes nothing for a drop into either of the card’s own gaps', () => {
    expect(docked(layout, 'vitals', 'below', 1)).toBe(layout);
    expect(docked(layout, 'vitals', 'below', 2)).toBe(layout);
  });

  it('puts a card from elsewhere at the raw gap', () => {
    const away = normalizeLayout({ below: ['self', 'vitals'], away: ['room'] });
    expect(docked(away, 'room', 'below', 1).below).toEqual(['self', 'room', 'vitals']);
    expect(docked(away, 'room', 'below', 1).away).not.toContain('room');
  });
});
