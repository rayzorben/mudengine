/**
 * What stands in the way, said in words a player can act on.
 *
 * Composed here rather than in a card because naming a key means looking it
 * up: `Key: 1124` is not something anyone can do anything with, and *needs
 * angular key — dropped by gate guard* is. It lived inside `localMap.ts` and
 * moved out for one reason — **the route steps needed the same sentences**.
 * A route panel that said `toll` where the map said `Toll to pass` and neither
 * said *5 gold* was two surfaces disagreeing about one fact and a third fact
 * that was in the data all along.
 *
 * Three lengths per obstacle; see `MapObstacle` for what each is for.
 */
import type { MapObstacle, Requirement } from '../../shared/world';
import { t } from '../app/i18n';
import type { WorldGraph } from './WorldGraph';

/**
 * A copper figure in the realm's own coin words.
 *
 * The same job `coinWords` does for `describeBlock` in `src/shared/world.ts`,
 * and deliberately a second small copy rather than an export across the
 * boundary: that one is `src/shared`, which is dependency-free by rule and
 * cannot read the dictionary, so its sentence is in English in the file. This
 * one goes through `t()` like everything else the chrome shows.
 *
 * Whole gold where it divides evenly — which every toll in the shipped realm
 * does — and copper otherwise, never a fraction of a coin nobody can hold.
 */
function coins(copper: number): string {
  if (copper % COPPER_PER_GOLD === 0) {
    return t('map.obstacle.gold', { amount: (copper / COPPER_PER_GOLD).toLocaleString() });
  }
  return t('map.obstacle.copper', { amount: copper.toLocaleString() });
}

/** The rung `coins` reads against. `src/shared/coins.ts` owns the ladder. */
const COPPER_PER_GOLD = 100;

/**
 * What the realm accepts *instead* of the key, when it accepts anything.
 *
 * Two shapes and they are not the same fact: `[301 picklocks/strength]` takes
 * either skill and `[or 157 picklocks]` takes only the lock-pick — 89 exits in
 * the shipped realm are the second kind. So a bracket with no strength figure
 * says picklocks and does not offer to bash, because a player who leans on
 * that door will simply be refused.
 */
function forcing(requirement: Requirement): string | null {
  const { pickDifficulty, bashDifficulty } = requirement;
  if (pickDifficulty === undefined) return null;
  return bashDifficulty === undefined
    ? t('map.obstacle.pickOnly', { difficulty: pickDifficulty })
    : t('map.obstacle.pickOrBash', { difficulty: pickDifficulty });
}

/** The level window, as the realm states it — one end, the other, or both. */
function levels(requirement: Requirement): string | null {
  const { minLevel, maxLevel } = requirement;
  if (minLevel !== undefined && maxLevel !== undefined) {
    return t('map.obstacle.levelRange', { minLevel, maxLevel });
  }
  if (minLevel !== undefined) return t('map.obstacle.levelMinimum', { minLevel });
  if (maxLevel !== undefined) return t('map.obstacle.levelMaximum', { maxLevel });
  return null;
}

export function describeObstacle(requirement: Requirement, graph: WorldGraph): MapObstacle {
  const kind = requirement.kind;
  const force = forcing(requirement);
  const window = levels(requirement);

  /*
   * The chip. Short enough to sit beside a room name on a route step, and
   * carrying the *number* — which is the whole of what a player acts on, and
   * exactly what `toll` on its own withheld.
   */
  const label = ((): string => {
    switch (kind) {
      case 'key': {
        const item = requirement.keyId === undefined ? undefined : graph.item(requirement.keyId);
        const name =
          item?.name ?? t('map.obstacle.keyFallbackName', { keyId: requirement.keyId ?? '?' });
        return force === null
          ? t('map.obstacle.keyLabel', { itemName: name })
          : t('map.obstacle.keyLabelForced', { itemName: name, forcing: force });
      }
      case 'door':
        return force === null
          ? t('map.obstacle.door')
          : t('map.obstacle.doorLabel', { forcing: force });
      case 'toll':
        return requirement.tollCopper === undefined
          ? t('map.obstacle.toll')
          : t('map.obstacle.tollLabel', { price: coins(requirement.tollCopper) });
      case 'level':
        return window ?? t('map.obstacle.levelRestricted');
      case 'trap':
        return requirement.damage === undefined
          ? t('map.obstacle.trapped')
          : t('map.obstacle.trapDamage', { damage: requirement.damage });
      case 'text': {
        const command = requirement.commands?.[0];
        return command === undefined
          ? t('map.obstacle.needsPhrase')
          : t('map.obstacle.sayCommand', { command });
      }
      case 'hidden':
        return requirement.searchable
          ? t('map.obstacle.hiddenSearchable')
          : t('map.obstacle.hidden');
      case 'item': {
        const item = requirement.keyId === undefined ? undefined : graph.item(requirement.keyId);
        return t('map.obstacle.needsItem', {
          itemName:
            item?.name ??
            (requirement.keyId === undefined
              ? t('map.obstacle.itemUnknown')
              : t('map.obstacle.itemNumberFallback', { itemId: requirement.keyId }))
        });
      }
      default:
        /*
         * Class, race, alignment, ability, cast, spell, timed and unknown. The
         * realm's own instruction is the only thing said about them, because
         * nothing here models what they want and a word invented for a chip
         * would be a claim the data does not make.
         */
        return requirement.raw;
    }
  })();

  /*
   * The full line. Everything the chip says, plus what the chip has no room
   * for — where a key is found, which is the half somebody acts on when the
   * answer is "go and get it".
   */
  const detail = ((): string => {
    switch (kind) {
      case 'key': {
        const item = requirement.keyId === undefined ? undefined : graph.item(requirement.keyId);
        const name =
          item?.name || t('map.obstacle.keyFallbackName', { keyId: requirement.keyId ?? '?' });
        const source = item?.mobs?.length
          ? t('map.obstacle.droppedBySuffix', { mobs: item.mobs.slice(0, 3).join(', ') })
          : item?.shops?.length
            ? t('map.obstacle.soldAtSuffix', { shops: item.shops.slice(0, 3).join(', ') })
            : '';
        const pick = force === null ? '' : t('map.obstacle.orForcedSuffix', { forcing: force });
        return t('map.obstacle.locked', { itemName: name, source, pickClause: pick });
      }
      case 'door':
        return force === null
          ? t('map.obstacle.door')
          : t('map.obstacle.doorDifficulty', { forcing: force });
      case 'toll':
        return requirement.tollCopper === undefined
          ? t('map.obstacle.toll')
          : t('map.obstacle.tollDetail', { price: coins(requirement.tollCopper) });
      case 'level':
        return window === null
          ? t('map.obstacle.levelRestricted')
          : t('map.obstacle.levelDetail', { window });
      default:
        // Everything else says the same thing at both lengths — there is no
        // second half to add, and a longer sentence padding the same fact is
        // the terminal again.
        return label;
    }
  })();

  return { kind, label, detail, raw: requirement.raw };
}
