/**
 * What the server's answer to a `use <item>` means for the next one (todo 43).
 * The sentences are `UseCommand.cs` and `Player.InitiateSpell` /
 * `TryInvokeSpell`, server source only until orohost prints them. None names
 * the `use` it answers except `You do not have <item> equipped.`, so
 * `AutoInvoke` reads them only while its own `use` is the one outstanding.
 * See `mudengine-automation` › parts/recovery.md.
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';

/** The `use` waiting on an answer. */
export interface UseOut {
  /** The item as the pack spelled it, which is what went out. */
  item: string;
  /** The spell that lands, the first the item casts. */
  spell: string;
  /** More than one spell: every one after the first is refused for the round. */
  several: boolean;
}

/** What an answer means. A closed union; `holdFor` covers every member. */
export type InvokeAnswer =
  /**
   * Something landed on this character: an onset sentence or its own cast
   * confirmation. It ends the wait, so a later refusal is not read as this
   * `use`'s; the buff list says whether it was the item's spell.
   */
  | 'landed'
  /** The roll failed (`You attempt to cast X, but fail.`): try again next round. */
  | 'failed'
  /** The round's cast was already spent: try again next round. */
  | 'round-spent'
  /** Refused for mana before the roll: hold until the mana rises. */
  | 'short-of-mana'
  /** A weapon or armour not worn: hold until the inventory is read again. */
  | 'not-equipped'
  /** No uses left on an item the realm calls unlimited: hold for the session. */
  | 'used-up';

/**
 * The answer `block` gives the outstanding `use`, or null when it answers
 * something else. `same` says whether a printed spell name is the item's.
 */
export function answerOf(
  block: Block,
  out: UseOut,
  same: (printed: string) => boolean,
  sameItem: (printed: string) => boolean
): InvokeAnswer | null {
  switch (block.type) {
    case 'spell-onset':
      return 'landed';
    case 'spell-cast':
      return block.groups['caster'] === 'You' && block.groups['announced'] === undefined
        ? 'landed'
        : null;
    case 'spell-failed': {
      const spell = block.groups['spell'];
      return spell !== undefined && same(spell) ? 'failed' : null;
    }
    // An item that casts several spells is answered this way for each one
    // after the first every time it is used, so it says nothing about the first.
    case 'spell-refused':
      return out.several ? null : 'round-spent';
    case 'spell-short-of-mana':
      return 'short-of-mana';
    case 'item-not-equipped': {
      const item = block.groups['item'];
      return item !== undefined && sameItem(item) ? 'not-equipped' : null;
    }
    case 'item-used-up': {
      // Only `There are no more uses in X.`: the other sentence names no item,
      // and a `use` the player typed of a spent wand would read as this one's.
      const item = block.groups['item'];
      return item !== undefined && sameItem(item) ? 'used-up' : null;
    }
    default:
      return null;
  }
}

/** Why an item is not used again yet, and what lifts it. */
export type InvokeHold =
  | { answer: 'short-of-mana'; mana: number | null }
  | { answer: 'not-equipped'; listedAt: number | null }
  | { answer: 'used-up' };

/** The hold an answer puts on the item, or null for one that puts none. */
export function holdFor(answer: InvokeAnswer, state: CharacterState): InvokeHold | null {
  switch (answer) {
    case 'landed':
    case 'failed':
    case 'round-spent':
      return null;
    case 'short-of-mana':
      return { answer, mana: state.vitals.mana };
    case 'not-equipped':
      return { answer, listedAt: state.inventory.listedAt };
    case 'used-up':
      return { answer };
    default: {
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

/**
 * Whether the hold still stands. Unknown mana keeps it: the refusal is the
 * last word on the mana until a number says it has risen, or is first known.
 */
export function stillHeld(hold: InvokeHold, state: CharacterState): boolean {
  switch (hold.answer) {
    case 'short-of-mana':
      if (state.vitals.mana === null) return true;
      return hold.mana !== null && state.vitals.mana <= hold.mana;
    case 'not-equipped':
      return state.inventory.listedAt === hold.listedAt;
    case 'used-up':
      return true;
    default: {
      const unreachable: never = hold;
      return unreachable;
    }
  }
}
