/**
 * An exit's instruction as the gates it states (`src/shared/gates.ts`), so the
 * router prices and blocks it through the one judge. Kept per requirement:
 * the A* inner loop asks for every edge it relaxes, and the requirement is
 * finished (levers, use gates) before the first route is planned.
 */
import type { Gate } from '../../../shared/gates';
import type { Requirement } from '../../../shared/world';

const kept = new WeakMap<Requirement, readonly Gate[] | null>();

/**
 * The gates an exit states: empty for an exit that states none, null for one
 * whose instruction names a gate it gives no figure for (`Class:` with no
 * number, `Alignment:` with no word), which is priced as unread.
 */
export function exitGates(requirement: Requirement): readonly Gate[] | null {
  const held = kept.get(requirement);
  if (held !== undefined) return held;
  const gates = read(requirement);
  kept.set(requirement, gates);
  return gates;
}

function read(requirement: Requirement): readonly Gate[] | null {
  switch (requirement.kind) {
    case 'level':
      return [
        {
          kind: 'level',
          ...(requirement.minLevel === undefined ? {} : { min: requirement.minLevel }),
          ...(requirement.maxLevel === undefined ? {} : { max: requirement.maxLevel })
        }
      ];
    case 'class':
    case 'race': {
      const ok = requirement.kind === 'class' ? requirement.classOk : requirement.raceOk;
      const no = requirement.kind === 'class' ? requirement.classNo : requirement.raceNo;
      const gates: Gate[] = [];
      if (ok !== undefined) gates.push({ kind: requirement.kind, id: ok, is: true });
      if (no !== undefined) gates.push({ kind: requirement.kind, id: no, is: false });
      return gates.length > 0 ? gates : null;
    }
    case 'alignment': {
      const low = requirement.minAlignment;
      if (low === undefined) return null;
      return [{ kind: 'standing', low, high: requirement.maxAlignment ?? low }];
    }
    case 'ability': {
      // `Ability: 0` is the realm's empty slot, a plain exit.
      if (requirement.abilityId === undefined) return [];
      const abilities = requirement.abilities ?? [];
      return abilities.length > 0 ? abilities.map((gate) => ({ kind: 'ability', ...gate })) : null;
    }
    case 'toll':
      // A toll whose price the realm did not record still wants some money.
      return [{ kind: 'copper', copper: requirement.tollCopper ?? 1 }];
    case 'item':
      return requirement.keyId === undefined ? [] : [{ kind: 'carry', item: requirement.keyId }];
    case 'hidden':
      // Every lever's item, wherever the lever is pulled.
      return (requirement.actions ?? []).flatMap((act): Gate[] =>
        act.item === undefined ? [] : [{ kind: 'carry', item: act.item }]
      );
    case 'text':
      // A room script's conditions (`linkPortals`); a `Text:` exit has none.
      return requirement.gates ?? [];
    case 'key':
    case 'door':
    case 'cast':
    case 'spell':
    case 'trap':
    case 'timed':
    case 'unknown':
      return [];
    default: {
      const never: never = requirement.kind;
      return never;
    }
  }
}

/**
 * A gate as the exit-table instruction that states it, for a way a room
 * script walls: the route's block reads the same fields off either. `base` is
 * the way's own requirement, for its command and words.
 */
export function gateRequirement(gate: Gate, base: Requirement): Requirement {
  const { raw, commands } = base;
  const said = { raw, ...(commands === undefined ? {} : { commands }) };
  switch (gate.kind) {
    case 'level':
      return {
        ...said,
        kind: 'level',
        ...(gate.min === undefined ? {} : { minLevel: gate.min }),
        ...(gate.max === undefined ? {} : { maxLevel: gate.max })
      };
    case 'class':
      return { ...said, kind: 'class', ...(gate.is ? { classOk: gate.id } : { classNo: gate.id }) };
    case 'race':
      return { ...said, kind: 'race', ...(gate.is ? { raceOk: gate.id } : { raceNo: gate.id }) };
    case 'standing':
      return { ...said, kind: 'alignment', minAlignment: gate.low, maxAlignment: gate.high };
    case 'ability': {
      const { kind: _kind, name: _name, ...bounds } = gate;
      return { ...said, kind: 'ability', abilityId: gate.id, abilities: [bounds] };
    }
    case 'copper':
      return { ...said, kind: 'toll', tollCopper: gate.copper };
    case 'carry':
      return { ...said, kind: 'item', keyId: gate.item };
    case 'alignment':
    case 'lack':
    case 'floor':
    case 'spell-off':
    case 'lives':
    case 'roll':
    case 'empty-room':
    case 'monster-here':
    case 'occupied':
      return base;
    default: {
      const never: never = gate;
      return never;
    }
  }
}
