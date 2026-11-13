/**
 * The ways each effect of a room's spell reaches a character, put together as
 * `spellHazard.ts` walks the chain (`HazardReach`, format 81).
 *
 * Two chains either of which may run reach a character where either does, so
 * their ways are joined. A step's ways sit behind the `failitem`s, the spell
 * checks and the gates on who the character is ahead of it on its line, since
 * any of them fails its own line and the server tries the next.
 */
import type { Gate } from '../../shared/gates';
import type { HazardEffect, HazardReach, HazardReachMap } from '../../shared/world';
import type { BuiltSpellHazard } from './buildRealm';

/** An effect's key on disk. */
type BuiltKey = keyof NonNullable<BuiltSpellHazard['r']>;

/** Each effect's key on disk, as `BuiltSpellHazard` writes it. */
const BUILT_EFFECTS: Record<HazardEffect, BuiltKey> = {
  damage: 'd',
  relocates: 'tp',
  summons: 'sm',
  unread: 'u'
};

/** Every effect with its key on disk. */
export function builtEffects(): Array<[HazardEffect, BuiltKey]> {
  return Object.entries(BUILT_EFFECTS) as Array<[HazardEffect, BuiltKey]>;
}

const wayKey = (way: HazardReach): string =>
  `${way.band?.min ?? ''}|${way.band?.max ?? ''}|${(way.fails ?? []).join(',')}|${(way.wards ?? []).join(',')}|${JSON.stringify(way.gates ?? [])}`;

/** Every way of both, each once. */
export function joinReach(a: HazardReachMap, b: HazardReachMap): HazardReachMap {
  const out: HazardReachMap = { ...a };
  for (const [effect, ways] of Object.entries(b) as Array<[HazardEffect, HazardReach[]]>) {
    const held = out[effect] ?? [];
    const seen = new Set(held.map(wayKey));
    out[effect] = [...held, ...ways.filter((way) => !seen.has(wayKey(way)))];
  }
  return out;
}

/** What stands ahead of a step on its line: the items and spells it fails on, and the gates. */
export interface Ahead {
  fails: readonly number[];
  wards: readonly number[];
  gates: readonly Gate[];
}

/** A step's ways, behind what stands ahead of it on its line. */
export function behind(ahead: Ahead, step: HazardReachMap): HazardReachMap {
  const { fails, wards, gates } = ahead;
  if (fails.length === 0 && wards.length === 0 && gates.length === 0) return step;
  const both = <T>(before: readonly T[], own: readonly T[] | undefined): T[] | undefined => {
    if (before.length === 0 && own === undefined) return undefined;
    const seen = new Map<string, T>();
    for (const one of [...before, ...(own ?? [])]) seen.set(JSON.stringify(one), one);
    return [...seen.values()];
  };
  const out: HazardReachMap = {};
  for (const [effect, ways] of Object.entries(step) as Array<[HazardEffect, HazardReach[]]>) {
    out[effect] = ways.map((way) => {
      const failsOn = both(fails, way.fails);
      const wardedBy = both(wards, way.wards);
      const gatedBy = both(gates, way.gates);
      return {
        ...(way.band === undefined ? {} : { band: way.band }),
        ...(failsOn === undefined ? {} : { fails: failsOn }),
        ...(wardedBy === undefined ? {} : { wards: wardedBy }),
        ...(gatedBy === undefined ? {} : { gates: gatedBy })
      };
    });
  }
  return out;
}
