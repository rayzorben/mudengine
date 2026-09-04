/**
 * What a character was wearing, and what to send to put it back on.
 *
 * `CarriedItem` already says what is in the pack and which of it is in use;
 * what it cannot say is what *was* in a slot. Dying takes everything off — the
 * items stay in the pack — and at that moment `slot` is null on every one of
 * them, because a slot is where the *listing* said something sits and the
 * listing no longer says. So a character standing up after a death has a pack
 * full of kit and nothing that knows which helm was on its head.
 *
 * This is the memory that answers that, and the decisions taken from it. Both
 * pure and both here, in `shared/`, because they are read in main (which sends
 * the commands) and stated in the renderer (which draws the buttons), and a
 * second copy of "which of these can be worn" would have the card offering a
 * button main then refuses.
 */
import type { CarriedItem } from './character';
import { sameItem } from './items';

/**
 * The five things a gear button can ask for.
 *
 * A closed union, checked in main against this list before anything reaches a
 * socket, for the reason `ask` checks its own command: a string arriving from a
 * renderer is a payload, and an unrecognised command on this server is **said
 * out loud in the room**.
 *
 * Each is named for the server's own command family — `Equip` and `Remove`,
 * `Drop` — rather than for what the card calls the button, so that adding an
 * action is choosing a verb the realm already has.
 */
export const GEAR_ACTIONS = ['restore', 'equip-all', 'drop-all', 'equip', 'remove'] as const;

export type GearAction = (typeof GEAR_ACTIONS)[number];

/** One slot and what was last in it. */
export interface WornSlot {
  /** The server's own word — `Head`, `Weapon Hand`. Never one we invented. */
  slot: string;
  /** The item that was in it, as the listing spelled it. */
  item: string;
  /** When it was last seen there. */
  at: number;
}

/**
 * Every slot this character has been seen to fill.
 *
 * **Nothing is ever taken out of it by an item coming off**, which is the whole
 * point: a slot emptied is exactly the state this exists to undo. A slot is
 * only ever *replaced*, by something else being worn in it — which is how
 * swapping a helm by hand quietly re-teaches the loadout, with no second
 * gesture to remember.
 */
export type Loadout = readonly WornSlot[];

/**
 * The loadout after a listing.
 *
 * Returns the same reference when nothing moved, so a caller can tell a real
 * change from a status line arriving and skip the write.
 */
export function learnLoadout(held: Loadout, items: readonly CarriedItem[], at: number): Loadout {
  const next = new Map(held.map((worn) => [worn.slot.toLowerCase(), worn] as const));
  let changed = false;

  for (const item of items) {
    /*
     * Both halves are required. `equipped` with no slot is an item in use
     * somewhere no listing has named — the state `CarriedItem.slot` documents
     * as *not* the same question as `equipped` — and filing it under a slot
     * word we do not have would be inventing the one thing this must not.
     */
    if (!item.equipped || item.slot === null) continue;
    const key = item.slot.toLowerCase();
    const before = next.get(key);
    if (before && sameItem(before.item, item.name)) continue;
    next.set(key, { slot: item.slot, item: item.name, at });
    changed = true;
  }

  if (!changed) return held;
  // Ordered by slot so a file written twice from the same facts is the same
  // file, and a diff of one is about what moved.
  return [...next.values()].sort((a, b) => a.slot.localeCompare(b.slot));
}

/** What a bulk gear action would send, and what it could not do. */
export interface GearPlan {
  /** The commands, in order. Empty when there is nothing to do. */
  commands: string[];
  /**
   * Items named by the loadout that the pack does not hold.
   *
   * Reported rather than silently skipped: after a death the difference
   * between "put back on" and "gone" is the thing the player most needs to
   * know, and a button that quietly did four of six would hide it.
   */
  missing: string[];
  /** How many more there were than the cap allowed. */
  overflow: number;
}

const NOTHING: GearPlan = { commands: [], missing: [], overflow: 0 };

/**
 * Put back what was on, from the remembered loadout.
 *
 * Only what is **carried and not in use**. A slot already filled by the right
 * item is left alone — re-wearing it earns `You are already wearing …`, a
 * command spent to be told so — and an item the pack does not hold at all is
 * reported instead of asked for.
 *
 * `wear` is the server's own `Equip` verb and covers wielding and holding as
 * well (docs/greatermud/commands.md: `ready`, `arm` and `wear` are one
 * command), which is why there is one verb here and not three chosen by slot.
 */
export function restorePlan(
  loadout: Loadout,
  items: readonly CarriedItem[],
  max: number
): GearPlan {
  const wanted: string[] = [];
  const missing: string[] = [];

  for (const worn of loadout) {
    const held = items.filter((item) => sameItem(item.name, worn.item));
    if (held.length === 0) {
      missing.push(worn.item);
      continue;
    }
    // Already on, somewhere. Not "already on *here*": the server decides which
    // slot an item lands in, and second-guessing it is how a client comes to
    // send `wear` at something it is wearing.
    if (held.some((item) => item.equipped)) continue;
    wanted.push(worn.item);
  }

  return capped(wanted.map(equip), missing, max);
}

/**
 * Put on everything in the pack the realm says can be worn.
 *
 * `wearable` is the realm's own answer — an item with a `Worn` slot in
 * `rooms.jsonl.gz` — and not a guess from the name or from the kind. Without
 * it this would send `wear healing potion` once per potion, each answered with
 * a refusal, out of the budget a fight is fought with.
 *
 * An item the realm does not know is **not** offered. That is the refuse-
 * rather-than-guess rule: a private realm's own item is exactly the case where
 * the client knows nothing, and a broadcast `wear` is what a wrong guess costs.
 */
export function equipAllPlan(
  items: readonly CarriedItem[],
  wearable: (name: string) => boolean,
  max: number
): GearPlan {
  const wanted = items
    .filter((item) => !item.equipped && wearable(item.name))
    .map((item) => item.name);
  return capped(dedupe(wanted).map(equip), [], max);
}

/**
 * The whole pack onto the floor.
 *
 * Everything, worn included: `drop` takes an item off on the way down, and a
 * button called *Drop all* that left the kit on would be one nobody could use
 * for the thing it is for. Bounded like every other bulk action here.
 */
export function dropAllPlan(items: readonly CarriedItem[], max: number): GearPlan {
  return capped(
    dedupe(items.map((item) => item.name)).map((name) => `drop ${name}`),
    [],
    max
  );
}

/** One item, put on. The single-row button, and the unit the plans are built of. */
export function equip(item: string): string {
  return `wear ${item}`;
}

/**
 * One item, taken off. Still carried — this is the opposite of `equip`, not of
 * a pick-up.
 *
 * `remove` is the server's own verb (docs/greatermud/commands.md: `rem` …
 * `remove`) and covers unwielding and putting out a lit thing as well as
 * unwearing, exactly as `wear` covers all three going on. So there is one verb
 * here and not three chosen by slot, for the same reason `equip` has one — and
 * **not `drop`**, which would put the kit on the floor of a room anybody
 * standing in can pick it up from.
 */
export function unequip(item: string): string {
  return `remove ${item}`;
}

/**
 * Whether anything on this pack could be put back where it was.
 *
 * The renderer asks so a button that would do nothing is drawn as unavailable
 * rather than as a control that shrugs. Same function as the plan, so the
 * button and the action cannot disagree about it.
 */
export function canRestore(loadout: Loadout, items: readonly CarriedItem[]): boolean {
  return restorePlan(loadout, items, Number.MAX_SAFE_INTEGER).commands.length > 0;
}

/**
 * Two of one name is one command.
 *
 * `wear padded gloves` with a spare pair puts one pair on; asking twice puts
 * the spare on the same hands, which the server refuses, out loud.
 */
function dedupe(names: readonly string[]): string[] {
  const seen: string[] = [];
  for (const name of names) {
    if (seen.some((held) => sameItem(held, name))) continue;
    seen.push(name);
  }
  return seen;
}

function capped(commands: string[], missing: string[], max: number): GearPlan {
  if (commands.length === 0 && missing.length === 0) return NOTHING;
  return {
    commands: commands.slice(0, Math.max(0, max)),
    missing,
    overflow: Math.max(0, commands.length - Math.max(0, max))
  };
}

/**
 * The half of a `WorldItem` that decides whether it can go on.
 *
 * Structural rather than an import of `WorldItem` itself, and deliberately:
 * `world.ts` is the realm's whole vocabulary and this file is read by the
 * renderer, by main and by tests that have no realm at all. Naming the four
 * fields is also what makes a test case one line instead of a whole item.
 */
export interface EquipRestrictions {
  /** Where it is worn. Absent for a thing that is not kit — a glass jug. */
  slot?: string;
  /** Classes allowed it, as row ids. Empty or absent restricts nobody. */
  classes?: readonly number[];
  /** Races allowed it, as row ids. */
  races?: readonly number[];
  /** The level the realm requires. */
  minLevel?: number;
  /** A weapon's `StrReq`, the one requirement stated as a plain column. */
  weapon?: { strength?: number };
}

/**
 * Why the realm says this character may not put a thing on.
 *
 * A closed union, because the reason is shown to somebody who then has to do
 * something about it: `level` is *wait*, `class` and `race` are *give it to
 * somebody else*, and `strength` is a number that can still go up. A single
 * boolean would have collapsed all four into "no", which is the answer the
 * server already gives for free.
 */
export type EquipBlock =
  | { kind: 'class'; allowed: readonly number[] }
  | { kind: 'race'; allowed: readonly number[] }
  | { kind: 'level'; needs: number; has: number }
  | { kind: 'strength'; needs: number; has: number };

/**
 * What the character is, as the checks below need it.
 *
 * Ids rather than the words the stat sheet prints, because the realm states
 * its restrictions as row ids and the *resolution* from a word to an id needs
 * the realm's own tables — which live in main. Doing it at the edge keeps this
 * function pure and keeps one spelling of `Half-Ogre` from deciding whether a
 * character can wear a helm.
 *
 * **Every field is nullable and null means unknown, never zero.** Race, class
 * and level are all null until a stat sheet has printed once, and a client that
 * read those as "level 0, no class" would grey out the entire pack of a
 * character that had merely not typed `st` yet.
 */
export interface Wearer {
  classId: number | null;
  raceId: number | null;
  level: number | null;
  strength: number | null;
  /**
   * The realm's class and race tables as `{ id: name }`, so a refusal can be
   * read.
   *
   * *You may not wear this* is the answer the server already gives for free;
   * the whole reason to say it here is to say **why**, and `#4` under a
   * heading is the half-read this project has already written down once, for
   * `ClassOk`. Fifteen classes and thirteen races is a table small enough to
   * send with the answer rather than fetch beside it.
   *
   * Empty on a realm converted before v10, which names no classes at all —
   * and an empty table is why `blockReason` still has to answer without one.
   */
  classNames: Record<number, string>;
  raceNames: Record<number, string>;
}

/**
 * A character nothing is known about yet.
 *
 * The state every session starts in and returns to on a disconnect, and the
 * one every check below passes: null is unknown, and unknown never refuses.
 */
export const UNKNOWN_WEARER: Wearer = {
  classId: null,
  raceId: null,
  level: null,
  strength: null,
  classNames: {},
  raceNames: {}
};

/**
 * What the realm says stops this character wearing this item — or `null`.
 *
 * The one place this question is answered, for the reason this file exists:
 * the card draws a control from it and main sends a command from it, and a
 * second copy of the rule would have the pack offering a button main refuses.
 *
 * **Unknown never refuses.** Each check is skipped when either half is absent:
 * a character whose class the client has not read yet, or an item the realm
 * does not carry, is *not* ruled out. That is this project's standing rule
 * applied to a control — an unknown that greyed a row out would hide a wearable
 * item behind a reason the client cannot state, and the player would have no
 * way to discover the client was simply guessing. The server remains the
 * authority; this only declines to spend a command on a refusal the realm has
 * already written down.
 *
 * The order is the order the reasons are worth reading: who you are before
 * what you have reached, because a class restriction never changes and a level
 * does. Only the first is reported — a list of four reasons is not more useful
 * than the one that will still be true tomorrow.
 */
export function equipBlock(item: EquipRestrictions, wearer: Wearer): EquipBlock | null {
  /*
   * An allow-list, not a deny-list. Measured 2026-08-31 against
   * `gmud20230902`: `golden battleaxe` names `Warrior` and nothing else, and
   * `silver holy amulet` names the four holy classes — which is why a Mystic
   * wearing it earned `You may not wear that item!`. Read the other way round
   * this would refuse every item to everyone but the classes named.
   */
  const classes = item.classes ?? [];
  if (classes.length > 0 && wearer.classId !== null && !classes.includes(wearer.classId)) {
    return { kind: 'class', allowed: classes };
  }

  const races = item.races ?? [];
  if (races.length > 0 && wearer.raceId !== null && !races.includes(wearer.raceId)) {
    return { kind: 'race', allowed: races };
  }

  if (item.minLevel !== undefined && wearer.level !== null && wearer.level < item.minLevel) {
    return { kind: 'level', needs: item.minLevel, has: wearer.level };
  }

  /*
   * A weapon's `StrReq`, which is the one requirement the realm states as a
   * plain column rather than a gate. Only a weapon has one, and `strength`
   * comes off the same stat sheet as the rest.
   */
  const needs = item.weapon?.strength;
  if (needs !== undefined && needs > 0 && wearer.strength !== null && wearer.strength < needs) {
    return { kind: 'strength', needs, has: wearer.strength };
  }

  return null;
}

/**
 * Whether the realm gives this thing a slot at all.
 *
 * A glass jug has `Worn` 0 and is not kit — there is nothing to put it on, and
 * a control offering to try is one that can only ever earn a refusal. Distinct
 * from `equipBlock` on purpose: *not wearable by anyone* and *not wearable by
 * you* are two different sentences, and the card draws them differently —
 * nothing at all for the first, a struck-through glyph with a reason for the
 * second.
 */
export function isWearable(item: EquipRestrictions | undefined): item is EquipRestrictions {
  return item?.slot !== undefined;
}
