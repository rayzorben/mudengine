import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Wards, type WardSources } from '../Wards';
import { CommandQueue } from '../CommandQueue';
import { tuning } from '../../app/tuning';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig, type HealthConfig } from '../../../shared/config';
import { wireItem } from '../../../shared/entities';
import type { SpellHazard, WorldItem, WorldSpell } from '../../../shared/world';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

/* The switch lives with the potion rules it is the realm's half of (todo 02). */
const health = (over: Partial<HealthConfig> = {}): HealthConfig => ({
  ...DEFAULT_CONFIG.automation.health,
  useWards: true,
  ...over
});

/*
 * The desert, verbatim in shape: room spell 683 is stopped by the wristband
 * (1180) outright or by spell 711 *waterskin*, which using a waterskin (283,
 * three uses, six hundred ticks) casts.
 */
const DESERT: WorldSpell = { id: 683, name: 'desert spell' };
const DESERT_HAZARD: SpellHazard = { avoidedBy: [1180], avoidedBySpell: [711] };
const WATERSKIN_SPELL: WorldSpell = { id: 711, name: 'waterskin', duration: 600 };
const WATERSKIN: WorldItem = { id: 283, name: 'waterskin', uses: 3, abilities: [[43, 711]] };

const carried = (name: string): CarriedItem => ({ ...wireItem(name) });

function standing(items: CarriedItem[], rows: number[] = [], over: Partial<CharacterState> = {}) {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game' as const,
    inventory: { ...base.inventory, items, rows, listedAt: 1_000 },
    ...over
  };
}

let sent: string[];
let notices: string[];
let queue: CommandQueue;
let stated: number[];
let clock: number;

const sources = (over: Partial<WardSources> = {}): WardSources => ({
  hazardAt: (room) => (room === '12/300' ? { spell: DESERT, hazard: DESERT_HAZARD } : null),
  itemsCasting: (spell) => (spell === 711 ? [WATERSKIN] : []),
  spellById: (id) => (id === 711 ? WATERSKIN_SPELL : id === 683 ? DESERT : null),
  spellsUp: () => stated,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  stated = [];
  clock = Date.now();
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = health(), over: Partial<WardSources> = {}): Wards =>
  new Wards(config, true, queue, sources(over), { notice: (m) => notices.push(m) }, () => clock);

describe('keeping a room’s ward up', () => {
  it('uses the carried item before the step into a room its spell would stop', () => {
    make().beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual(['use waterskin']);
    expect(notices.join('\n')).toContain('waterskin');
  });

  it('does nothing for a room that casts nothing it would stop, or with the switch off', () => {
    make().beforeStep('12/301', standing([carried('waterskin')]));
    make(health({ useWards: false })).beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual([]);
  });

  /* A quest run that bought the skins lends the switch, and says so both ways, once. */
  it('acts for a quest run though the switch is off, until the run gives it back', () => {
    const wards = make(health({ useWards: false }));
    wards.lend(true);
    wards.lend(true);
    wards.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual(['use waterskin']);
    expect(notices.filter((line) => line.includes('is off in the settings'))).toHaveLength(1);
    wards.lend(false);
    wards.lend(false);
    expect(notices.filter((line) => line.includes('off again'))).toHaveLength(1);
    clock += 2000 * 1000;
    wards.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual(['use waterskin']);
  });

  /* The player's own edit wins over the lend, as it wins over a combat lease. */
  it('ends the lend when the switch is turned off by hand, and says so', () => {
    const wards = make(health({ useWards: true }));
    wards.lend(true);
    wards.configure(health({ useWards: false }), true);
    expect(notices.some((line) => line.includes('goes on without wards'))).toBe(true);
    wards.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual([]);
    // A reload that leaves the switch where it was is not an edit of it.
    const lent = make(health({ useWards: false }));
    lent.lend(true);
    lent.configure(health({ useWards: false }), true);
    lent.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual(['use waterskin']);
  });

  it('wants no ward while the pack stops the spell outright', () => {
    make().beforeStep('12/300', standing([carried('wristband')], [1180]));
    expect(sent).toEqual([]);
  });

  it('holds off while the server states the spell up, and while its own clock does', () => {
    stated = [711];
    make().beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual([]);

    stated = [];
    const wards = make();
    wards.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual(['use waterskin']);
    // Inside the six hundred ticks — three seconds each — nothing more, per
    // step or standing still.
    clock += 900 * 1000;
    wards.beforeStep('12/300', standing([carried('waterskin')]));
    wards.onCharacter(standing([carried('waterskin')]), '12/300');
    expect(sent).toEqual(['use waterskin']);
    // Past them: used again.
    clock += 901 * 1000;
    wards.onCharacter(standing([carried('waterskin')]), '12/300');
    expect(sent).toEqual(['use waterskin', 'use waterskin']);
  });

  /* logs/2026-09-23_17-08-46_festus: a use at 18:04, a death at 18:08, the heat at 18:15. */
  it('takes a death as the end of every ward it used', () => {
    const wards = make();
    wards.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual(['use waterskin']);
    clock += 600 * 1000;
    wards.died();
    wards.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual(['use waterskin', 'use waterskin']);
  });

  it('says once that nothing carried casts the ward, and asks again no sooner than the retry floor', () => {
    const wards = make();
    wards.beforeStep('12/300', standing([carried('torch')]));
    wards.beforeStep('12/300', standing([carried('torch')]));
    expect(sent).toEqual([]);
    expect(notices.filter((line) => line.includes('nothing whose use'))).toHaveLength(1);

    // A use the server swallowed: the clock was never armed, and the floor holds.
    const swallowed = new Wards(
      health(),
      true,
      new CommandQueue(automation, { send: () => {} }),
      sources(),
      {},
      () => clock
    );
    swallowed.beforeStep('12/300', standing([carried('waterskin')]));
    clock += tuning().spells.blessRetryMs - 1;
    swallowed.beforeStep('12/300', standing([carried('waterskin')]));
    expect(sent).toEqual([]);
  });
});
