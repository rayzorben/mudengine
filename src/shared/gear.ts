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
import type { ItemEntity } from './entities';
import type { UiLookup } from './i18n';
import { OFF_HAND, sameItem, WEAPON_HAND } from './items';

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
 * `paradigm.jsonl.gz` — and not a guess from the name or from the kind. Without
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

/**
 * The refusal in words, from the realm's tables where it can name them.
 *
 * *You may not wear this* is the answer the server already gives for free;
 * the whole reason to say it here is to say **why**, and `#4` under a heading
 * is a half-read. A class or race the table cannot name falls back to the
 * unnamed sentence rather than printing an id.
 */
export function blockReason(
  blocked: EquipBlock,
  classNames: Record<number, string>,
  raceNames: Record<number, string>,
  t: UiLookup
): string {
  switch (blocked.kind) {
    case 'class': {
      const named = blocked.allowed
        .map((id) => classNames[id])
        .filter((name) => name !== undefined);
      return named.length === blocked.allowed.length && named.length > 0
        ? t('cards.inventory.blocked.byClass', { classList: named.join(', ') })
        : t('cards.inventory.blocked.byClassUnnamed');
    }
    case 'race': {
      const named = blocked.allowed.map((id) => raceNames[id]).filter((name) => name !== undefined);
      return named.length === blocked.allowed.length && named.length > 0
        ? t('cards.inventory.blocked.byRace', { raceList: named.join(', ') })
        : t('cards.inventory.blocked.byRaceUnnamed');
    }
    case 'level':
      return t('cards.inventory.blocked.byLevel', { needed: blocked.needs, have: blocked.has });
    case 'strength':
      return t('cards.inventory.blocked.byStrength', { needed: blocked.needs, have: blocked.has });
  }
}

/**
 * What a control beside a carried item is, decided once for the pack card
 * and the console's rewritten listing alike.
 *
 * `worn` comes off: **before every other test**, since an item the character
 * is demonstrably wearing can come off whatever the realm file says (a lit
 * torch has no `Worn` slot at all). `none` is a thing that is not kit — a
 * glass jug — for which a control could only ever earn a refusal. `blocked`
 * is kit this character may not put on, with the reason; `wearable` is the
 * rest, an unknown realm row included, because unknown never refuses.
 */
export interface EquipVerdict {
  state: 'worn' | 'wearable' | 'blocked' | 'none';
  /** The tooltip: what pressing does, or why nothing can be pressed. */
  label: string;
  /** The realm's own verb, or null where there is nothing to send. */
  command: string | null;
}

export function equipVerdict(item: ItemEntity, wearer: Wearer, t: UiLookup): EquipVerdict {
  if (item.equipped) {
    return {
      state: 'worn',
      label: t('cards.inventory.removeTooltip', { item: item.name }),
      command: unequip(item.name)
    };
  }
  const realm: EquipRestrictions = {
    ...(item.realmSlot === undefined ? {} : { slot: item.realmSlot }),
    ...(item.classes === undefined ? {} : { classes: item.classes }),
    ...(item.races === undefined ? {} : { races: item.races }),
    ...(item.minLevel === undefined ? {} : { minLevel: item.minLevel }),
    ...(item.weapon === undefined ? {} : { weapon: item.weapon })
  };
  // A realm row with no slot is not kit; a row the realm lacks keeps its
  // control, which is the refuse-rather-than-guess rule pointing the other way.
  if (item.id !== undefined && !isWearable(realm))
    return { state: 'none', label: '', command: null };
  const blocked = equipBlock(realm, wearer);
  if (blocked !== null) {
    return {
      state: 'blocked',
      label: blockReason(blocked, wearer.classNames, wearer.raceNames, t),
      command: null
    };
  }
  return {
    state: 'wearable',
    label: t('cards.inventory.equipTooltip', { item: item.name }),
    command: equip(item.name)
  };
}

/* ------------------------------------------------- the equipment manager */

/**
 * When a set applies. Ordered **least specific first**, because the array's
 * order is the precedence and `GEAR_WHENS.indexOf` is what ranks two sets that
 * both match.
 *
 * Three, because three is what the client can answer without guessing:
 * `always` is the kit a character is in when nothing else is happening,
 * `moving` is a walk or a lap under way, `fighting` is `fightIsRunning`. A
 * fourth band for *resting* was left out — a rest is broken by the `wear` that
 * would start it, so a set for it could never take effect.
 */
export const GEAR_WHENS = ['always', 'moving', 'fighting'] as const;

export type GearWhen = (typeof GEAR_WHENS)[number];

/**
 * One kit, or part of one — `automation.gear.sets`.
 *
 * **Partial on purpose.** A set names only the slots it cares about, so
 * *Moving* is one line about boots rather than a second copy of everything the
 * character owns; what it does not name is left as the `always` set has it.
 * That is also what makes the list editable: a kit restated in full in four
 * places is four places to forget a ring.
 */
export interface GearSet {
  /** What the player calls it. Shown, never sent. */
  name: string;
  /** When it applies. See `GEAR_WHENS`. */
  when: GearWhen;
  /**
   * Only while fighting this monster, keyed as the wire spells it. Blank is
   * *any* monster.
   *
   * The narrowing todo 00 asks for by name: a lap fought with throwing hammers
   * and one boss that wants the magic weapon. Meaningless on `always` and
   * `moving`, where it is ignored rather than refused — the form offers it
   * only on a fighting row.
   */
  mob: string;
  /** The items to have on, as the pack lists them. */
  wear: string[];
}

/** What the client knows about the character's situation, for choosing a set. */
export interface GearSituation {
  /** A route or a lap is under way. */
  moving: boolean;
  /** Anything is swinging — `fightIsRunning`. */
  fighting: boolean;
  /** The monster being fought, or null. */
  target: string | null;
}

/**
 * Which set applies now, or null.
 *
 * **Most specific wins, and the tie is the list's own order**, so a player who
 * writes two sets for the same situation gets the first one rather than an
 * answer that depends on how the file was sorted. Specificity is: a fighting
 * set naming this monster, then any fighting set, then a moving set. A
 * fighting character that is also walking is *fighting* — the fight is the
 * thing that decides what the next round costs.
 */
export function overlayFor(sets: readonly GearSet[], now: GearSituation): GearSet | null {
  const matches = (set: GearSet): boolean => {
    if (set.when === 'always') return false;
    if (set.when === 'moving') return now.moving;
    if (!now.fighting) return false;
    const mob = set.mob.trim();
    return mob.length === 0 || (now.target !== null && sameItem(now.target, mob));
  };
  const rank = (set: GearSet): number =>
    set.when === 'fighting' ? (set.mob.trim().length > 0 ? 3 : 2) : 1;

  let best: GearSet | null = null;
  for (const set of sets) {
    if (!matches(set)) continue;
    if (best === null || rank(set) > rank(best)) best = set;
  }
  return best;
}

/** The base kit every overlay is laid over: the first `always` set, or none. */
export function baseSet(sets: readonly GearSet[]): GearSet | null {
  return sets.find((set) => set.when === 'always') ?? null;
}

/**
 * The kit the character should be in: the base, overlaid by whichever set
 * applies, as slot → item.
 *
 * `slotOf` is the realm's answer for a name (`WorldItem.slot`), because a set
 * is written before anything is worn and the slot is what says which of the
 * base's items this one *replaces*. An item the realm cannot place is carried
 * through under its own name as its own key: it is still something the player
 * asked to have on, and refusing to wear it because the client could not file
 * it would be the client overruling them about their own pack.
 */
export function kitFor(
  sets: readonly GearSet[],
  now: GearSituation,
  slotOf: (name: string) => string | null
): Map<string, string> {
  const kit = new Map<string, string>();
  const lay = (set: GearSet | null): void => {
    for (const name of set?.wear ?? []) {
      const item = name.trim();
      if (item.length === 0) continue;
      kit.set((slotOf(item) ?? `item:${item}`).toLowerCase(), item);
    }
  };
  lay(baseSet(sets));
  lay(overlayFor(sets, now));
  return kit;
}

/**
 * What to send to get into a kit, in the order it has to be sent.
 *
 * Three rungs, and the middle one is the whole reason this is not a list of
 * `wear`s:
 *
 * 1. **The off-hand comes off first**, where a two-handed weapon is going on
 *    over something held. `Items.WeaponType` carries handedness as its own
 *    axis (`src/shared/items.ts`), so this is the realm's answer and not a
 *    guess from the name.
 * 2. **Then the weapon hand**, so that coming back the other way — a
 *    one-handed weapon replacing the two-hander — frees the off-hand before
 *    the shield is asked for. One ordering serves both directions.
 * 3. **Then everything else**, in the kit's own order.
 *
 * An item the pack does not hold is reported rather than asked for, as
 * `restorePlan` reports it: the difference between *put it on* and *it is
 * gone* is the thing worth knowing. An item already worn anywhere is left
 * alone — `wear` at something already on earns a refusal out of the budget a
 * fight is fought with.
 */
export function swapPlan(
  kit: ReadonlyMap<string, string>,
  items: readonly CarriedItem[],
  max: number,
  handsOf: (name: string) => 1 | 2 | null
): GearPlan {
  const missing: string[] = [];
  const wanted: Array<{ slot: string; item: string }> = [];

  for (const [slot, name] of kit) {
    const held = items.filter((item) => sameItem(item.name, name));
    if (held.length === 0) {
      missing.push(name);
      continue;
    }
    if (held.some((item) => item.equipped)) continue;
    wanted.push({ slot, item: name });
  }

  const weapon = wanted.find((row) => row.slot === WEAPON_HAND.toLowerCase());
  /*
   * The off-hand item to take off first: only where a two-hander is going on,
   * only where something is actually in that hand, and only where the kit is
   * not asking for that very thing to stay — a kit naming both is a kit the
   * server will refuse, and saying so is the form's job, not this one's.
   */
  const removals: string[] = [];
  if (weapon !== undefined && handsOf(weapon.item) === 2) {
    const held = items.find(
      (item) => item.equipped && (item.slot ?? '').toLowerCase() === OFF_HAND.toLowerCase()
    );
    if (held !== undefined && !kit.has(OFF_HAND.toLowerCase())) removals.push(unequip(held.name));
  }

  const rest = wanted.filter((row) => row !== weapon);
  const commands = [
    ...removals,
    ...(weapon === undefined ? [] : [equip(weapon.item)]),
    ...rest.map((row) => equip(row.item))
  ];
  return capped(commands, missing, max);
}

/**
 * The off-round invocation, whole: `use <item> <target>` with the item in hand
 * and the kit put back afterwards (todo 00, case 2).
 *
 * **The item has to be equipped and that is the server's rule, not a
 * courtesy**: `UseCommand` answers a weapon that is not worn with *You do not
 * have <item> equipped.* (`UseCommand.cs`), and it is what makes this a dance
 * rather than one command. The target is split off the item name by the server
 * itself — `GetPossibleItemStacks` grows the item name word by word and hands
 * back the remainder (`ItemContainer.cs:277`) — so `use nexus spear big
 * sandworm` reaches the right pair with nothing for this client to escape.
 *
 * Returns the commands in order and nothing else: the caller decides whether
 * the round can afford them, because only the caller knows what else is
 * queued.
 */
export function offRoundPlan(
  item: string,
  target: string,
  items: readonly CarriedItem[],
  handsOf: (name: string) => 1 | 2 | null
): string[] {
  const spear = items.find((each) => sameItem(each.name, item));
  if (spear === undefined || target.trim().length === 0) return [];

  const inHand = items.find(
    (each) => each.equipped && (each.slot ?? '').toLowerCase() === WEAPON_HAND.toLowerCase()
  );
  const offHand = items.find(
    (each) => each.equipped && (each.slot ?? '').toLowerCase() === OFF_HAND.toLowerCase()
  );
  // Already the weapon in hand: the whole dance is one command.
  if (inHand !== undefined && sameItem(inHand.name, item)) return [`use ${spear.name} ${target}`];

  const twoHanded = handsOf(spear.name) === 2;
  return [
    ...(twoHanded && offHand !== undefined ? [unequip(offHand.name)] : []),
    equip(spear.name),
    `use ${spear.name} ${target}`,
    // Back the way it was, weapon first so the hand is free for the off-hand.
    ...(inHand === undefined ? [] : [equip(inHand.name)]),
    ...(twoHanded && offHand !== undefined ? [equip(offHand.name)] : [])
  ];
}
