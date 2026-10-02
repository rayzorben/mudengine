/**
 * One gate (`@shared/gates`) in words, the one place the chrome turns a gate
 * into words. The realm's own numbers; nothing is rounded or ranked.
 */
import type { Gate } from '@shared/gates';
import { t } from './i18n';

export function gateWords(gate: Gate): string {
  switch (gate.kind) {
    case 'ability': {
      const name = gate.name ?? String(gate.id);
      if (gate.absent === true) return t('gates.abilityAbsent', { name });
      // The pair that means *exactly* is one sentence, not two bounds.
      if (gate.atLeast !== undefined && gate.atLeast === gate.atMost) {
        return t('gates.abilityExact', { name, rank: gate.atLeast });
      }
      if (gate.atMost !== undefined) return t('gates.abilityAtMost', { name, rank: gate.atMost });
      // `>= -1` is the server's spelling of *has it at all*.
      if (gate.atLeast !== undefined && gate.atLeast >= 0) {
        return t('gates.abilityAtLeast', { name, rank: gate.atLeast });
      }
      return t('gates.abilityAny', { name });
    }
    case 'carry':
      return t('gates.carry', { name: named(gate.name, gate.item) });
    case 'lack':
      return t('gates.lack', { name: named(gate.name, gate.item) });
    case 'floor':
      return gate.lying
        ? t('gates.floor', { name: named(gate.name, gate.item) })
        : t('gates.floorAbsent', { name: named(gate.name, gate.item) });
    case 'spell-off':
      return t('gates.spellOff', { name: named(gate.name, gate.spell) });
    case 'class':
    case 'race':
      return gate.is
        ? t('gates.only', { name: named(gate.name, gate.id) })
        : t('gates.not', { name: named(gate.name, gate.id) });
    case 'level':
      if (gate.min !== undefined && gate.max !== undefined) {
        return t('gates.levelBetween', { min: gate.min, max: gate.max });
      }
      if (gate.max !== undefined) return t('gates.levelAtMost', { level: gate.max });
      return t('gates.levelAtLeast', { level: gate.min ?? 0 });
    case 'standing':
      return t('gates.standing', { low: gate.low, high: gate.high });
    case 'alignment':
      // Lower is better on this lineage. Both bounds is a band: stating only
      // the upper drew `NeutralQuest`'s 48 gates as one a paladin satisfies.
      if (gate.atMost !== undefined && gate.atLeast !== undefined) {
        return t('gates.alignmentBetween', { low: gate.atLeast, high: gate.atMost });
      }
      if (gate.atMost !== undefined) return t('gates.alignmentGood', { value: gate.atMost });
      return t('gates.alignmentEvil', { value: gate.atLeast ?? 0 });
    case 'lives':
      return t('gates.livesBelow', { count: gate.below });
    case 'copper':
      return t('gates.price', { amount: gate.copper.toLocaleString() });
    case 'roll':
      // The stat less the value is the chance in percent.
      return t('gates.roll', { stat: gate.stat, value: gate.value });
    case 'empty-room':
      return t('gates.emptyRoom');
    case 'monster-here':
      return t('gates.monsterHere', { name: named(gate.name, gate.monster) });
    case 'occupied':
      return t('gates.occupied');
    default: {
      const never: never = gate;
      return never;
    }
  }
}

/** A row's name, or its number where the realm gave none. */
function named(name: string | undefined, id: number): string {
  return name ?? `#${id}`;
}
