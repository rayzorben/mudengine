/**
 * The ways each effect of a room's spell reaches a character, put together as
 * `spellHazard.ts` walks the chain (`HazardReach`, format 76).
 *
 * Two chains either of which may run reach a character where either does, so
 * their ways are joined. A step's ways sit behind the `failitem`s and the
 * spell checks ahead of it on its line, since either fails its own line and
 * the server tries the next.
 */
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
  `${way.band?.min ?? ''}|${way.band?.max ?? ''}|${(way.fails ?? []).join(',')}|${(way.wards ?? []).join(',')}`;

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

/** A step's ways, behind the items (`fails`) and spells (`wards`) ahead of it on its line. */
export function behind(
  fails: readonly number[],
  wards: readonly number[],
  step: HazardReachMap
): HazardReachMap {
  if (fails.length === 0 && wards.length === 0) return step;
  const both = (
    ahead: readonly number[],
    own: readonly number[] | undefined
  ): number[] | undefined =>
    ahead.length === 0 && own === undefined ? undefined : [...new Set([...ahead, ...(own ?? [])])];
  const out: HazardReachMap = {};
  for (const [effect, ways] of Object.entries(step) as Array<[HazardEffect, HazardReach[]]>) {
    out[effect] = ways.map((way) => {
      const failsOn = both(fails, way.fails);
      const wardedBy = both(wards, way.wards);
      return {
        ...(way.band === undefined ? {} : { band: way.band }),
        ...(failsOn === undefined ? {} : { fails: failsOn }),
        ...(wardedBy === undefined ? {} : { wards: wardedBy })
      };
    });
  }
  return out;
}
