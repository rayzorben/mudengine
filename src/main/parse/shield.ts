/**
 * Whether a damage line on this character is the damage shield of the monster
 * it just hit (todo 56): decided once per block, before the reducer, like a
 * weapon proc (`proc.ts`).
 *
 * GreaterMUD source, `ActionFigure.HitCheckShockShield`: inside `Mob.Hit`, so
 * in the same write as this character's blow and before the blow's hit spell
 * is rolled (`PlayerAttackType.cs:269`, `:288`). The attacker reads the
 * `ShockMsg` (137) row's second line, else `You take %d damage!`; neither
 * names the monster. What binds the line to it is the blow just landed and
 * the realm saying that monster carries a shield.
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { SHOCK_MESSAGE_ABILITY } from '../../shared/abilities';
import { shieldsOf } from '../../shared/damageShield';
import { mobKey } from '../../shared/world';
import type { FightTracker } from './combat';

/**
 * A line that hurts this character and names nobody: `You are shocked for 3
 * damage!` and `The armour spikes stabs you for 2 damage!` by their frame,
 * and a message row with no `for <n> damage!` (`A counterstrike at you does
 * 5 damage!`) only where it is the struck monster's own `ShockMsg` row.
 */
function namelessHarm(block: Block, shockMessage: number | undefined): boolean {
  const g = block.groups ?? {};
  switch (block.type) {
    case 'user-takes-damage':
      return true;
    case 'mob-hits':
      return g['attacker'] === undefined;
    case 'realm-message':
      return (
        g['role'] === '2' && shockMessage !== undefined && g['message'] === String(shockMessage)
      );
    default:
      return false;
  }
}

/** The monster whose shield this line is, as the room lists it; null where it is not one. */
export function readsAsShield(
  block: Block,
  state: CharacterState,
  fight: Pick<FightTracker, 'struckJustNow'>
): string | null {
  const key = fight.struckJustNow(block.at);
  if (key === null) return null;
  const mob = state.room.occupants.find((who) => mobKey(who.name) === key);
  const abilities = mob?.mob?.abilities;
  if (mob === undefined || shieldsOf(abilities).length === 0) return null;
  const shockMessage = abilities?.find(([id]) => id === SHOCK_MESSAGE_ABILITY)?.[1];
  return namelessHarm(block, shockMessage) ? mob.name : null;
}
