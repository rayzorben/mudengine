import { describe, expect, it } from 'vitest';

import { lairCopyText } from '../LairList';
import { clockText, regenClockText } from '../../lib/clockText';
import type { WorldLair, WorldMob } from '@shared/world';
import { t } from '../../lib/i18n';

/**
 * How often a lair pays, said in a reading a player recognises.
 *
 * The client could price what a lair *costs* — how much health one pass
 * through it takes — and never what it pays, because `Rooms.Delay` reached
 * only the Hunting card's own detail readout. A lair that fills every two
 * minutes and one that fills every two hours are the same face otherwise.
 *
 * The clock itself is resolved in main (`WorldGraph.lair`), family offset and
 * all; what is asserted here is the half the renderer owns — the reading, and
 * that a copy carries what the face draws.
 */
describe('a lair says how often it fills', () => {
  /*
   * Minutes and hours are what the realm states and what a reader recognises,
   * but the offset is what makes a *rounded* reading a lie: GreaterMUD credits
   * thirty seconds before it compares (`RegenSlot.cs:33`), so a two-minute
   * lair is back in ninety seconds there. `2m` would round away the half of
   * the clock the player is standing about waiting for.
   */
  it('keeps the half-minute the family offset leaves behind', () => {
    expect(clockText(30)).toBe('30s');
    expect(clockText(60)).toBe('1m');
    expect(clockText(90)).toBe('1m 30s');
    expect(clockText(120)).toBe('2m');
    expect(clockText(300)).toBe('5m');
  });

  /*
   * And a row's own clock, which is a boss's: `Monsters.RegenTime` is stated
   * in whole hours and runs to a day. Hours, because 86,400s is not a figure
   * anybody waits by.
   */
  it('says a row’s own clock in hours', () => {
    expect(clockText(3600)).toBe('1h');
    expect(clockText(5400)).toBe('1h 30m');
    expect(clockText(86_400)).toBe('24h');
  });

  /*
   * Whether a monster has a clock of its own is decided once, for the Room
   * card's lair chip and the monster card's regen row alike: Daeron Darksong
   * states 3 hours (pmud row 2307); a kobold thief states none and comes back
   * with its room, so it gets no clock and no row.
   */
  it('reads a monster’s own clock, and none where it comes back with the room', () => {
    expect(regenClockText({ regenHours: 3 })).toBe('3h');
    expect(regenClockText({ regenHours: 0 })).toBeNull();
    expect(regenClockText({})).toBeNull();
  });

  /*
   * The card copies the face on screen. The clock is drawn on it beside the
   * slots, so a paste that carried only the slots would be the card copying
   * something other than what was read — the rule the entity numbers in the
   * same paste were added under.
   */
  const mob = (name: string, hp: number): WorldMob =>
    ({ name, hp, disposition: 'hostile' }) as WorldMob;

  it('pastes the clock beside the slots, because the face draws both', () => {
    const lair: WorldLair = { max: 2, respawnSeconds: 90, mobs: [mob('gnoll', 40)] };
    const [head] = lairCopyText(lair).split('\n');
    expect(head).toContain(t('cards.room.lair.upTo.many', { max: 2 }));
    expect(head).toContain('1m 30s');
  });

  it('and claims no clock for a lair whose data states none', () => {
    const lair: WorldLair = { max: null, respawnSeconds: null, mobs: [mob('gnoll', 40)] };
    const [head] = lairCopyText(lair).split('\n');
    expect(head).toBe(t('cards.room.tabs.lair'));
  });
});
