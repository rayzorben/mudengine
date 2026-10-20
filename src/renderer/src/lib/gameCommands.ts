/**
 * The game view's command bar (todo 140): only what can be done now, each on a
 * letter key, sending the line a player would type. The words are the realm's
 * own command table (`shared/commands.ts`: `hide`, not `hi`). Pure, so the
 * suite holds which commands a room offers. See `mudengine-ui` › *The game view*.
 */
import type { CharacterState } from '@shared/character';
import type { ShopIcon } from '@shared/gameMap';
import { asDirection, type Direction } from '@shared/world';
import { t } from './i18n';

/** What a key does that is not a line sent to the realm. */
export type GameAction = 'nextTarget' | 'run' | 'party' | 'character' | 'talk' | 'pack';

export type CommandGlyph =
  | 'attack'
  | 'backstab'
  | 'sneak'
  | 'hide'
  | 'look'
  | 'rest'
  | 'search'
  | 'get'
  | 'party'
  | 'run'
  | 'next'
  | 'character'
  | 'talk'
  | 'pack';

/**
 * The command layer's keys, one table for the bar, the key layer and the
 * tutorial. A letter acts at once; Enter and Esc are the layer's own.
 */
export const GAME_KEYS = {
  attack: 'a',
  next: 'Tab',
  backstab: 'b',
  run: 'f',
  get: 'g',
  sneak: 'k',
  hide: 'h',
  rest: 'r',
  search: 'x',
  look: 'l',
  business: 'y',
  party: 'p',
  character: 'c',
  talk: 't',
  pack: 'i',
  help: '?',
  console: 'Enter',
  back: 'Escape'
} as const;

export interface GameCommand {
  key: string;
  label: string;
  glyph: CommandGlyph | null;
  /** The line sent, as typed. */
  line?: string;
  action?: GameAction;
  /** The loud one: what the room is asking for. */
  main?: true;
  /** The place's icon, for the room's own business. */
  place?: ShopIcon;
  /** How many things wait behind it: lines for this character, on Talk. */
  badge?: number;
}

export interface GameExit {
  direction: Direction;
  /** The next room's name, where the realm or the wire says it. */
  name: string | null;
  /** A door or anything else standing in the way. */
  blocked: boolean;
}

export interface GameCommands {
  fight: GameCommand[];
  here: GameCommand[];
  you: GameCommand[];
  exits: GameExit[];
}

export interface CommandInputs {
  character: CharacterState;
  /** The monster picked with Tab or a click; null for the first hostile one. */
  picked: string | null;
  /** The place the room is, from the map's cell. */
  place: ShopIcon | null;
  /** Lines said to this character since the Talk panel was last open. */
  unread: number;
}

/** The monsters in the room, as `Also here:` names them. */
export function monstersHere(character: CharacterState): string[] {
  return character.room.occupants.filter((one) => one.kind === 'mob').map((one) => one.name);
}

/** Who a key attacks: the picked monster, the fight's, the first hostile one, or the first. */
export function targetOf(character: CharacterState, picked: string | null): string | null {
  const here = monstersHere(character);
  if (picked !== null && here.includes(picked)) return picked;
  const fighting = character.combat.target;
  if (fighting !== null && here.includes(fighting)) return fighting;
  const hostile = character.room.occupants.find(
    (one) => one.kind === 'mob' && one.disposition === 'hostile'
  );
  return hostile?.name ?? here[0] ?? null;
}

/** The room's exits as the bar offers them, in the order the realm printed them. */
export function exitsOf(character: CharacterState): GameExit[] {
  const out: GameExit[] = [];
  for (const exit of character.room.exits) {
    const direction = asDirection(exit.direction);
    if (direction === null) continue;
    out.push({
      direction,
      name: exit.targetName,
      blocked: (exit.obstacle ?? null) !== null || exit.requirement !== null
    });
  }
  return out;
}

export function gameCommands({ character, picked, place, unread }: CommandInputs): GameCommands {
  const engaged = character.combat.engaged;
  const sneaking = character.stealth === 'sneaking';
  const target = targetOf(character, picked);
  const hostile = character.room.occupants.some(
    (one) => one.kind === 'mob' && one.name === target && one.disposition === 'hostile'
  );
  const fight: GameCommand[] = [];
  const here: GameCommand[] = [];

  if (target !== null) {
    fight.push({
      key: GAME_KEYS.attack,
      label: t('game.commands.attack', { name: target }),
      glyph: 'attack',
      line: `a ${target}`,
      ...(engaged || hostile ? { main: true as const } : {})
    });
    if (monstersHere(character).length > 1)
      fight.push({
        key: GAME_KEYS.next,
        label: t('game.commands.next'),
        glyph: 'next',
        action: 'nextTarget'
      });
    if (sneaking && !engaged)
      fight.push({
        key: GAME_KEYS.backstab,
        label: t('game.commands.backstab'),
        glyph: 'backstab',
        line: `bs ${target}`,
        main: true
      });
  }
  if (engaged)
    fight.push({ key: GAME_KEYS.run, label: t('game.commands.run'), glyph: 'run', action: 'run' });

  const cash = character.room.cash;
  const item = character.room.items[0]?.name ?? null;
  if (cash !== null && cash.totalCopper > 0)
    here.push({
      key: GAME_KEYS.get,
      label: t('game.commands.getCoins'),
      glyph: 'get',
      line: 'get coins'
    });
  else if (item !== null)
    here.push({
      key: GAME_KEYS.get,
      label: t('game.commands.get', { item }),
      glyph: 'get',
      line: `get ${item}`
    });

  if (!engaged) {
    if (!sneaking)
      here.push({
        key: GAME_KEYS.sneak,
        label: t('game.commands.sneak'),
        glyph: 'sneak',
        line: 'sneak'
      });
    here.push({ key: GAME_KEYS.hide, label: t('game.commands.hide'), glyph: 'hide', line: 'hide' });
    const { hp, hpMax, mana, manaMax } = character.vitals;
    const hurt =
      (hp !== null && hpMax !== null && hp < hpMax) ||
      (mana !== null && manaMax !== null && mana < manaMax);
    if (hurt && !character.vitals.resting)
      here.push({
        key: GAME_KEYS.rest,
        label: t('game.commands.rest'),
        glyph: 'rest',
        line: 'rest'
      });
    here.push({
      key: GAME_KEYS.search,
      label: t('game.commands.search'),
      glyph: 'search',
      line: 'search'
    });
    const business = businessOf(place, character);
    if (business !== null) here.unshift(business);
  }
  here.push({
    key: GAME_KEYS.look,
    label:
      target !== null && engaged
        ? t('game.commands.lookAt', { name: target })
        : t('game.commands.look'),
    glyph: 'look',
    line: target !== null && engaged ? `look ${target}` : 'look'
  });

  const you: GameCommand[] = [
    { key: GAME_KEYS.party, label: t('game.commands.party'), glyph: 'party', line: 'party' },
    {
      key: GAME_KEYS.character,
      label: t('game.commands.character'),
      glyph: 'character',
      action: 'character'
    },
    {
      key: GAME_KEYS.talk,
      label: t('game.commands.talk'),
      glyph: 'talk',
      action: 'talk',
      ...(unread > 0 ? { badge: unread, main: true as const } : {})
    },
    { key: GAME_KEYS.pack, label: t('game.commands.pack'), glyph: 'pack', action: 'pack' }
  ];
  return { fight, here, you, exits: exitsOf(character) };
}

/** `y`: what the room is for — the bank, a shop's wares, the trainer. */
function businessOf(place: ShopIcon | null, character: CharacterState): GameCommand | null {
  switch (place) {
    case null:
      return null;
    case 'bank': {
      const carried = character.inventory.wealth;
      return carried !== null && carried > 0
        ? {
            key: GAME_KEYS.business,
            label: t('game.commands.deposit'),
            glyph: null,
            line: `deposit ${carried}`,
            place,
            main: true
          }
        : null;
    }
    case 'trainer':
      return {
        key: GAME_KEYS.business,
        label: t('game.commands.train'),
        glyph: null,
        line: 'train',
        place
      };
    case 'temple':
    case 'guild':
      return null;
    case 'tavern':
    case 'inn':
    case 'weapons':
    case 'bows':
    case 'armour':
    case 'shields':
    case 'clothing':
    case 'magic':
    case 'songs':
    case 'jewels':
    case 'goods':
    case 'potions':
    case 'food':
    case 'boats':
    case 'keys':
    case 'deeds':
    case 'recycler':
    case 'oddities':
    case 'furniture':
      return {
        key: GAME_KEYS.business,
        label: t('game.commands.list'),
        glyph: null,
        line: 'list',
        place
      };
    default: {
      const never: never = place;
      return never;
    }
  }
}

/** Every key the bar can hold, for the layer that listens for them. */
export function commandFor(commands: GameCommands, key: string): GameCommand | null {
  return (
    [...commands.fight, ...commands.here, ...commands.you].find((one) => one.key === key) ?? null
  );
}

/** The movement keys: the four compass letters, up and down. */
const MOVE_KEYS: Readonly<Record<string, Direction>> = {
  n: 'n',
  s: 's',
  e: 'e',
  w: 'w',
  u: 'u',
  d: 'd'
};

export function moveKey(key: string): Direction | null {
  return MOVE_KEYS[key] ?? null;
}

/**
 * Whether `n` or `s` must wait for an `e` or `w`: only when the room has a
 * diagonal that starts with it. Anywhere else the key moves at once.
 */
export function diagonalWaits(first: Direction, exits: readonly Direction[]): boolean {
  if (first !== 'n' && first !== 's') return false;
  return exits.some((exit) => exit.length === 2 && exit.startsWith(first));
}

/** `n` then `e` is `ne`; anything else is no diagonal. */
export function diagonalOf(first: Direction, second: Direction): Direction | null {
  if ((first !== 'n' && first !== 's') || (second !== 'e' && second !== 'w')) return null;
  return asDirection(`${first}${second}`);
}
