import { describe, expect, it } from 'vitest';

import {
  isPinned,
  readDeviations,
  resolvePins,
  shippedPins,
  withPin,
  type PinDeviations
} from '../pins';

const COMMANDS = [
  { id: 'settings', group: 'character' },
  { id: 'route', group: 'navigate' },
  { id: 'loop:Sewer loop', group: 'navigate' },
  { id: 'search', group: 'navigate' },
  { id: 'hud', group: 'view' },
  { id: 'pane:smoke', group: 'layout' },
  { id: 'focus' }
];

const SHELF = {
  character: ['settings'],
  navigate: ['route', 'loop:*'],
  layout: ['pane:*']
};

describe('shippedPins', () => {
  it('names commands exactly and by prefix', () => {
    const shipped = shippedPins(SHELF, COMMANDS);
    expect([...shipped].sort()).toEqual(['loop:Sewer loop', 'pane:smoke', 'route', 'settings']);
  });

  it('ignores a pattern filed under a group the command is not in', () => {
    // `search` is a navigate command; listing it under view names nothing,
    // which is exactly how it went unpinned while looking pinned.
    expect(shippedPins({ view: ['search'] }, COMMANDS).has('search')).toBe(false);
  });

  it('never pins an ungrouped command from the file', () => {
    expect(shippedPins({ '': ['focus'] }, COMMANDS).has('focus')).toBe(false);
  });
});

describe('a deviation for a command that is not on the list', () => {
  /*
   * Kept, not collected -- and the reason is that the two live at different
   * scopes. Deviations are per *client*, in `localStorage`; the command list is
   * per *character*, because a loop is resolved from the character's own
   * directory, then its realm's, then the global one. So the commands absent
   * right now are mostly the ones belonging to whoever is not on screen, and
   * pruning against the current list would spend one character's pins on
   * another character's absence -- pin a loop on Vaelor, switch to Soul, and
   * Vaelor's pin is gone.
   *
   * The residue is invisible in the meantime: `resolvePins` walks the commands,
   * never the deviations, so an id with nothing behind it emits nothing. And a
   * loop re-added under the same name inheriting its old pin is right rather
   * than merely tolerable -- a name *is* a loop's address everywhere else in
   * this client (the palette starts one by name, `loopNamed` finds one by name,
   * a profile lists them by name, the picker ticks them by name).
   */
  const gone: PinDeviations = { 'loop:Deleted loop': { pinned: true, against: false } };

  it('is not offered, because the shelf is built from the commands there are', () => {
    expect(resolvePins(SHELF, COMMANDS, gone).has('loop:Deleted loop')).toBe(false);
  });

  it('survives, so switching character does not spend the other one’s pins', () => {
    // The command list for a character without that loop resolves without it,
    // and the stored deviation is untouched by having done so.
    expect(Object.keys(gone)).toEqual(['loop:Deleted loop']);
    expect(readDeviations(JSON.stringify(gone))).toEqual(gone);
  });

  it('applies again when a loop comes back under the same name', () => {
    const back = [...COMMANDS, { id: 'loop:Deleted loop', group: 'navigate' }];
    // `against: false` and the shelf still says false, so the click stands.
    expect(resolvePins({ character: ['settings'] }, back, gone).has('loop:Deleted loop')).toBe(
      true
    );
  });
});

describe('readDeviations', () => {
  it('is empty with nothing stored', () => {
    expect(readDeviations(null)).toEqual({});
  });

  it('survives anything a hand edit or an older build could leave', () => {
    expect(readDeviations('not json')).toEqual({});
    expect(readDeviations('["route"]')).toEqual({});
    expect(readDeviations('null')).toEqual({});
  });

  it('drops only the malformed rows, keeping the rest of the shelf', () => {
    const stored = JSON.stringify({
      route: { pinned: false, against: true },
      hud: 'yes',
      jump: { pinned: true }
    });
    expect(readDeviations(stored)).toEqual({ route: { pinned: false, against: true } });
  });
});

describe('isPinned', () => {
  it('falls back to the file when nothing was clicked', () => {
    expect(isPinned('route', true, {})).toBe(true);
    expect(isPinned('hud', false, {})).toBe(false);
  });

  it('lets a click outrank the file it deviated from', () => {
    const deviations: PinDeviations = { route: { pinned: false, against: true } };
    expect(isPinned('route', true, deviations)).toBe(false);
  });

  it('spends the click once the file changes its mind', () => {
    // The click said "not this one" about a file that pinned it. The file now
    // agrees it is off the shelf, and putting it back is an edit, not a stale
    // preference to be overruled by.
    const deviations: PinDeviations = { route: { pinned: false, against: true } };
    expect(isPinned('route', false, deviations)).toBe(false);
    const other: PinDeviations = { hud: { pinned: true, against: false } };
    expect(isPinned('hud', true, other)).toBe(true);
  });
});

describe('withPin', () => {
  it('records a pin against what the file said', () => {
    expect(withPin({}, 'hud', false, true)).toEqual({ hud: { pinned: true, against: false } });
  });

  it('records an unpin the same way', () => {
    expect(withPin({}, 'route', true, false)).toEqual({ route: { pinned: false, against: true } });
  });

  it('forgets a choice that agrees with the file again', () => {
    const pinned = withPin({}, 'hud', false, true);
    expect(withPin(pinned, 'hud', false, false)).toEqual({});
  });

  it('leaves every other row alone', () => {
    const first = withPin({}, 'hud', false, true);
    const both = withPin(first, 'route', true, false);
    expect(Object.keys(both).sort()).toEqual(['hud', 'route']);
  });
});

describe('resolvePins', () => {
  it('is the shipped shelf when nothing has been clicked', () => {
    expect([...resolvePins(SHELF, COMMANDS, {})].sort()).toEqual([
      'loop:Sewer loop',
      'pane:smoke',
      'route',
      'settings'
    ]);
  });

  it('takes one off and puts another on', () => {
    const deviations: PinDeviations = {
      route: { pinned: false, against: true },
      hud: { pinned: true, against: false }
    };
    const pinned = resolvePins(SHELF, COMMANDS, deviations);
    expect(pinned.has('route')).toBe(false);
    expect(pinned.has('hud')).toBe(true);
  });

  it('can hold a command that has no group at all', () => {
    const pinned = resolvePins(SHELF, COMMANDS, { focus: { pinned: true, against: false } });
    expect(pinned.has('focus')).toBe(true);
  });
});
