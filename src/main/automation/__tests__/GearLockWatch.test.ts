import { describe, expect, it } from 'vitest';
import { GearLockWatch } from '../GearLockWatch';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Loadout } from '../../../shared/gear';

const HOUR = 3_600_000;
const NOW = 1_000_000_000;

/** One slot locked at a death with no play on the clock, and `fought` ms fought since. */
function state(fought: number): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  const loadout: Loadout = [
    { slot: 'Head', item: 'padded helm', at: 1, locked: { at: 5, played: 0 } },
    { slot: 'Torso', item: 'padded vest', at: 1, locked: null }
  ];
  return { ...base, loadout, tally: { ...base.tally, engagedMs: fought } };
}

function watch(hours = 3) {
  const released: string[][] = [];
  const notices: string[] = [];
  const movement = { ...DEFAULT_CONFIG.automation.movement, gearLockHours: hours };
  const module = new GearLockWatch(
    movement,
    (slots) => {
      released.push([...slots]);
      return true;
    },
    { notice: (message) => notices.push(message) },
    () => NOW
  );
  return { module, released, notices };
}

describe('GearLockWatch', () => {
  it('says the hold once per death and releases nothing inside the allowance', () => {
    const { module, released, notices } = watch();
    module.onCharacter(state(HOUR));
    module.onCharacter(state(2 * HOUR));
    expect(notices).toHaveLength(1);
    expect(released).toEqual([]);
  });

  it('releases the slot and says so when the play allowance runs out', () => {
    const { module, released, notices } = watch();
    module.onCharacter(state(3 * HOUR));
    expect(released).toEqual([['Head']]);
    expect(notices).toHaveLength(1);
  });

  it('holds nothing at 0 hours, without a word', () => {
    const { module, released, notices } = watch(0);
    module.onCharacter(state(0));
    expect(released).toEqual([['Head']]);
    expect(notices).toEqual([]);
  });
});
