/**
 * The gates a run of text block steps puts on whoever runs it, in the one
 * vocabulary (`src/shared/gates.ts`): the conditions of a quest step and of a
 * room's command alike. `testability N V` beside `checkability N V` asks for
 * rank exactly V, which is how every chained quest is written, so each
 * ability's bounds fold into one gate, as do a level's and an alignment's, and
 * a condition stated twice is said once.
 */
import { ABILITY } from '../../../shared/abilities';
import type { Gate } from '../../../shared/gates';
import type { RealmSource } from '../RealmSource';
import { number, text } from '../values';
import type { TbStep } from './textblock';

export function gatesOf(steps: readonly TbStep[]): Gate[] {
  const gates: Gate[] = [];
  const abilities = new Map<number, { atLeast?: number; atMost?: number }>();
  const bounds = (id: number): { atLeast?: number; atMost?: number } => {
    const held = abilities.get(id) ?? {};
    abilities.set(id, held);
    return held;
  };
  let level: { min?: number; max?: number } | null = null;
  let alignment: { atMost?: number; atLeast?: number } | null = null;

  for (const step of steps) {
    switch (step.verb) {
      case 'checkability':
        bounds(step.ability).atLeast = step.value;
        break;
      case 'testability':
        bounds(step.ability).atMost = step.value;
        break;
      case 'checkabilityexact': {
        const held = bounds(step.ability);
        held.atLeast = step.value;
        held.atMost = step.value;
        break;
      }
      case 'failability':
        gates.push({ kind: 'ability', id: step.ability, absent: true });
        break;
      case 'checkitem':
      case 'takeitem':
        gates.push({ kind: 'carry', item: step.item });
        break;
      case 'failitem':
        gates.push({ kind: 'lack', item: step.item });
        break;
      // Both fail while the spell is on the character (`TextBlockPart.cs:471`).
      case 'checkspell':
      case 'failspell':
        gates.push({ kind: 'spell-off', spell: step.spell });
        break;
      case 'class':
        gates.push({ kind: 'class', id: step.classId, is: true });
        break;
      case 'race':
        gates.push({ kind: 'race', id: step.raceId, is: true });
        break;
      case 'roomitem':
      case 'failroomitem':
        gates.push({ kind: 'floor', item: step.item, lying: step.verb === 'roomitem' });
        break;
      case 'nomonsters':
        gates.push({ kind: 'empty-room' });
        break;
      case 'needmonster':
        gates.push({ kind: 'monster-here', monster: step.monster });
        break;
      case 'monsters':
        gates.push({ kind: 'occupied' });
        break;
      case 'minlevel':
        level = { ...(level ?? {}), min: step.level };
        break;
      case 'maxlevel':
        level = { ...(level ?? {}), max: step.level };
        break;
      case 'goodaligned':
        alignment = { ...(alignment ?? {}), atMost: step.value };
        break;
      case 'evilaligned':
        alignment = { ...(alignment ?? {}), atLeast: step.value };
        break;
      case 'checklives':
        // Fails at nine lives or more (`TextBlockPart.cs:268`); its argument is a message.
        gates.push({ kind: 'lives', below: CHECKLIVES_BELOW });
        break;
      case 'price':
        if (step.copper !== null) gates.push({ kind: 'copper', copper: step.copper });
        break;
      case 'testskill':
        gates.push({ kind: 'roll', stat: step.stat, value: step.value });
        break;
      // What a step does, and the flow between steps: no condition on anybody.
      case 'nothing':
      case 'message':
      case 'show':
      case 'delay':
      case 'random':
      case 'cast':
      case 'learnspell':
      case 'giveitem':
      case 'droproomitem':
      case 'clearitem':
      case 'addexp':
      case 'addevil':
      case 'addlife':
      case 'giveability':
      case 'setability':
      case 'addability':
      case 'removeability':
      case 'givecoins':
      case 'remoteaction':
      case 'summon':
      case 'teleport':
      case 'unknown':
        break;
      default: {
        const never: never = step;
        return never;
      }
    }
  }

  for (const [id, held] of abilities) gates.push({ kind: 'ability', id, ...held });
  if (level !== null) gates.push({ kind: 'level', ...level });
  if (alignment !== null) gates.push({ kind: 'alignment', ...alignment });
  // A condition stated twice is one condition: `checkitem X` then `takeitem
  // X`, or a throne's script asking `nomonsters` before and after its check.
  const seen = new Set<string>();
  return gates.filter((gate) => {
    const key = JSON.stringify(gate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `checklives` fails at this many lives. */
const CHECKLIVES_BELOW = 9;

/** The names a gate's rows are said by, from the realm's own tables. */
export interface GateNames {
  item(id: number): string | undefined;
  spell(id: number): string | undefined;
  klass(id: number): string | undefined;
  race(id: number): string | undefined;
  ability(id: number): string | undefined;
  monster(id: number): string | undefined;
}

/** Each row's name by id, from the realm's tables and the indexes built from them. */
export function gateNames(
  source: RealmSource,
  indexes: {
    classes: ReadonlyArray<{ id: number; n: string }>;
    races: ReadonlyArray<{ id: number; n: string }>;
    spells: ReadonlyArray<{ id: number; n: string }>;
  }
): GateNames {
  const byId = (table: string): Map<number, string> => {
    const names = new Map<number, string>();
    for (const row of source.table(table)?.rows ?? []) {
      const id = number(row['Number']);
      const name = text(row['Name']).trim();
      if (id !== null && name.length > 0) names.set(id, name);
    }
    return names;
  };
  const items = byId('Items');
  const monsters = byId('Monsters');
  const spells = new Map(indexes.spells.map((entry) => [entry.id, entry.n]));
  const classes = new Map(indexes.classes.map((entry) => [entry.id, entry.n]));
  const races = new Map(indexes.races.map((entry) => [entry.id, entry.n]));
  return {
    item: (id) => items.get(id),
    spell: (id) => spells.get(id),
    klass: (id) => classes.get(id),
    race: (id) => races.get(id),
    ability: (id) => ABILITY[id]?.name,
    monster: (id) => monsters.get(id)
  };
}

/** A gate with the name of the row it is about, where the realm names one. */
export function nameGate(gate: Gate, names: GateNames): Gate {
  switch (gate.kind) {
    case 'carry':
    case 'lack':
    case 'floor':
      return withName(gate, names.item(gate.item));
    case 'monster-here':
      return withName(gate, names.monster(gate.monster));
    case 'ability':
      return withName(gate, names.ability(gate.id));
    case 'spell-off':
      return withName(gate, names.spell(gate.spell));
    case 'class':
    case 'race':
      return withName(gate, (gate.kind === 'class' ? names.klass : names.race)(gate.id));
    case 'level':
    case 'standing':
    case 'alignment':
    case 'lives':
    case 'copper':
    case 'roll':
    case 'empty-room':
    case 'occupied':
      return gate;
    default: {
      const never: never = gate;
      return never;
    }
  }
}

function withName<G extends Gate>(gate: G, name: string | undefined): G {
  return name === undefined ? gate : { ...gate, name };
}
