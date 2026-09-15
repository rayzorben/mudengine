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
import {
  openableHere,
  roomId,
  scatters,
  type MapObstacle,
  type RemoteLever,
  type Requirement
} from '../../shared/world';
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

/**
 * The word that opens a barrier where it stands, where the realm names one.
 *
 * A door's lever is never on its own requirement — `buildRealm` writes
 * `Requirement.actions` only for an exit that states `Needs N Actions`, and a
 * `Door` states nothing of the kind — so `WorldGraph.leversHere` is the only
 * join and the caller makes it. 28 exits in Paradigm and 27 in stock are
 * priced past every character's reach and open to a phrase; without this the
 * plan reads `Door, pick/bash 1000` and sends a player after a skill nobody in
 * the realm has, which is the half-read the `key` case already refuses.
 *
 * The item is the half that decides whether to walk it, exactly as it is for a
 * hidden exit's lever: the phrase alone reads as a free lever, and the server
 * answers `You don't have crowbar to use!` without one.
 */
function leverSays(levers: readonly RemoteLever[], graph: WorldGraph): string | null {
  const lever = levers[0];
  if (lever === undefined) return null;
  /*
   * Its own words rather than `hiddenLever`'s, which lead with *Hidden* — a
   * door is not hidden, it is shut, and a chip reading `Hidden — "use crowbar"
   * here` about the Slum Street warehouse door names the wrong thing before it
   * names the right one.
   */
  if (lever.item === undefined) return t('map.obstacle.leverSay', { phrase: lever.say });
  return t('map.obstacle.leverSayItem', {
    phrase: lever.say,
    itemName: graph.item(lever.item)?.name ?? t('map.obstacle.itemUnknown')
  });
}

export function describeObstacle(
  requirement: Requirement,
  graph: WorldGraph,
  /**
   * The levers that open this step without leaving the room
   * (`WorldGraph.leversHere`), for the callers that know which step this is.
   * Empty for the map's own cells and anything else asking about a
   * requirement rather than about a move.
   */
  here: readonly RemoteLever[] = []
): MapObstacle {
  const kind = requirement.kind;
  const force = forcing(requirement);
  const window = levels(requirement);
  const opens = kind === 'door' || kind === 'key' ? leverSays(here, graph) : null;

  /*
   * The chip. Short enough to sit beside a room name on a route step, and
   * carrying the *number* — which is the whole of what a player acts on, and
   * exactly what `toll` on its own withheld.
   */
  const label = ((): string => {
    switch (kind) {
      case 'key': {
        if (opens !== null) return opens;
        const item = requirement.keyId === undefined ? undefined : graph.item(requirement.keyId);
        const name =
          item?.name ?? t('map.obstacle.keyFallbackName', { keyId: requirement.keyId ?? '?' });
        return force === null
          ? t('map.obstacle.keyLabel', { itemName: name })
          : t('map.obstacle.keyLabelForced', { itemName: name, forcing: force });
      }
      case 'door':
        // A word that opens it is the answer, and the difficulty is then only
        // what the other way in would cost.
        if (opens !== null) return opens;
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
        if (requirement.searchable) return t('map.obstacle.hiddenSearchable');
        /*
         * A lever the character can reach is the number the chip exists to
         * carry — `hidden` alone says there is a way and not what opens it,
         * which is the complaint `toll` on its own already answered.
         */
        if (openableHere(requirement)) {
          const act = requirement.actions![0]!;
          // The item the lever wants is the half of the chip that decides
          // whether to walk it: the phrase alone reads as a free lever.
          if (act.item !== undefined) {
            return t('map.obstacle.hiddenLeverItem', {
              phrase: act.say[0]!,
              itemName: graph.item(act.item)?.name ?? t('map.obstacle.itemUnknown')
            });
          }
          return t('map.obstacle.hiddenLever', { phrase: act.say[0]! });
        }
        return t('map.obstacle.hidden');
      case 'cast':
      case 'spell': {
        /*
         * A cast exit that moves the character is the one condition on this
         * list that is not a condition: nothing is being asked of anybody, and
         * what the reader has to know is that the room the exit names is not
         * the room they will be standing in. `landing` is where they will be,
         * read off the realm's own spell table, and the two shapes are two
         * different facts — an address, or a draw nobody can call.
         */
        const landing = requirement.landing;
        if (landing === undefined) return requirement.raw;
        if (scatters(landing)) {
          return t('map.obstacle.scatter', {
            spellName: landing.name,
            roomCount: graph.landingCount(landing)
          });
        }
        return t('map.obstacle.teleport', {
          spellName: landing.name,
          roomName:
            graph.byId(roomId(landing.map, landing.low))?.name ?? roomId(landing.map, landing.low)
        });
      }
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
         * Class, race, alignment, ability, timed and unknown — and a cast
         * whose spell this client could not read. The realm's own instruction
         * is the only thing said about them, because nothing here models what
         * they want and a word invented for a chip would be a claim the data
         * does not make.
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
        // Both halves: the word that opens it, and what forcing it would take
        // for somebody who would rather not say it.
        if (opens !== null) {
          return force === null
            ? opens
            : t('map.obstacle.leverOrForced', { opens, forcing: force });
        }
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
      /*
       * A lever somewhere else is the one case with a real second half, and it
       * is the half somebody acts on: *the lever for this is in 1/1339* is a
       * place to walk to, where *hidden* is a shrug. The router still does not
       * plan that detour — `Walker.fetchLever` walks it when the server refuses
       * the step — so this is what a person reads before deciding to, and it is
       * why the exit is not written off on a refusal.
       */
      case 'hidden': {
        const away = requirement.actions?.filter((act) => act.at !== undefined) ?? [];
        if (away.length === 0) return label;
        return t('map.obstacle.hiddenLeverElsewhere', {
          phrase: away[0]!.say[0]!,
          room: `${away[0]!.at!.map}/${away[0]!.at!.room}`
        });
      }
      case 'cast':
      case 'spell': {
        // The chip has room for the fact; the line has room for what it means
        // for the reader, which is that the exit table is not the answer.
        const landing = requirement.landing;
        if (landing === undefined) return label;
        if (scatters(landing)) {
          return t('map.obstacle.scatterDetail', {
            spellName: landing.name,
            roomCount: graph.landingCount(landing)
          });
        }
        return t('map.obstacle.teleportDetail', {
          spellName: landing.name,
          roomName:
            graph.byId(roomId(landing.map, landing.low))?.name ?? roomId(landing.map, landing.low)
        });
      }
      default:
        // Everything else says the same thing at both lengths — there is no
        // second half to add, and a longer sentence padding the same fact is
        // the terminal again.
        return label;
    }
  })();

  /*
   * And the conditions the realm states on this edge that nothing here can
   * check (`Requirement.unread`, written only for a room-script portal).
   *
   * Said, rather than folded into the price and left there: `edgePenalty`
   * charges them the unevaluable figure so a scripted way through is offered
   * and never preferred, and a reader who is offered it has to be able to see
   * why. 186 of Paradigm's landings and 106 of stock's carry at least one, and
   * they are not all conditions — `takeitem multicoloured sceptre` and `summon
   * 1009` are what the step *does*, which is exactly the half a plan reading
   * `Level 65+` withheld.
   *
   * In the realm's own words, because that is the rule for every instruction
   * this client does not model, and a word invented for a chip would be a
   * claim the data does not make.
   */
  const unread = requirement.unread ?? [];
  if (unread.length === 0) return { kind, label, detail, raw: requirement.raw };
  /*
   * **The chip says how many, because the first is not the worst.** `detail`
   * is hover-only on every surface that draws one (a `title` attribute on the
   * route panel, the loop builder, the map plan and the room quick view), so
   * a chip naming `unread[0]` and stopping hides the rest from anybody who
   * does not hover — and the realm's script order is not a ranking. 37 of
   * Paradigm's 186 and 28 of stock's 106 state more than one: `17/3231`'s
   * portal leads with `roomitem nexus portal` and goes on to take the
   * multicoloured sceptre and summon monster 1009.
   *
   * A count rather than a reordering, because ordering them would be a
   * severity the data does not state.
   */
  const more = unread.length - 1;
  return {
    kind,
    label:
      more === 0
        ? t('map.obstacle.alsoLabel', { label, condition: unread[0]! })
        : t('map.obstacle.alsoLabelMore', { label, condition: unread[0]!, more }),
    detail: t('map.obstacle.alsoDetail', { detail, conditions: unread.join(', ') }),
    raw: requirement.raw
  };
}
