/**
 * The monster list, `combat.mobRules`: one row per monster, and what the
 * automation does about it. Out of `config.ts` (todo 818), whose block it is a
 * field of, with the readers every module asks through, so a row means one
 * thing everywhere. The rules: `mudengine-automation` › `parts/combat.md` ›
 * *One list per monster, not two* and *A row may say what a monster is*.
 */
import type { Alignment } from './alignment';
import type { RoomOccupant } from './character';
import { attacksOnSight } from './mobs';
import { int, isRecord, str } from './values';
import { mobKey } from './world';

/**
 * One monster, and how the automation treats it.
 *
 * The row shape of the monster list. `mob` is a `mobKey` — lowercased, the
 * leading article stripped — because that is the one spelling the wire ever
 * uses and the same normalisation the old flat `avoid` list always applied.
 *
 * Two shapes, because a monster that is not fought is fought with nothing: a
 * stance row carries no way of fighting it, and a banded one may say how (todo
 * 816, MegaMUD's monster table, on this list rather than a second one beside
 * it).
 */
export type MobRule =
  | {
      /** The monster, keyed the way the wire spells it. */
      mob: string;
      /** Not opened on, and what else the stance says. See `MOB_STANCES`. */
      treat: MobStance;
    }
  | {
      mob: string;
      /** The band it is attacked in. See `MOB_TREATMENTS`. */
      treat: MobPriorityBand;
      /** The spell it is fought with, in place of the character's own. See `MobCast`. */
      cast?: MobCast;
      /**
       * Never opened on with a backstab — MegaMUD's *No Backstab*: the
       * `combat.opener` a class spends on everything else is not spent on it,
       * and the fight opens as it would with no opener.
       */
      noBackstab?: boolean;
      /**
       * MegaMUD's *Not Hostile*: it does not attack first, whatever the realm's
       * disposition says. Read by `peaceOf`, and shown beside the realm's
       * disposition rather than instead of it.
       */
      notHostile?: boolean;
    };

/**
 * *Cast X, at most N times* — MegaMUD's monster attack spell and its *Max
 * Casts*. `spell` stands in for `spells.attack` (and for the choice
 * `autoChoose` would make) against this monster, and opens the fight in place
 * of the attack verb; past `times` confirmed casts, or once the server says it
 * has no effect, the character's own spells and then the melee round carry the
 * fight. `times` 0 is no limit, as `spells.attackCasts` reads it.
 */
export interface MobCast {
  spell: string;
  times: number;
}

/** The most casts a row may name — MegaMUD's own field, 0–99. */
export const MOB_CAST_MOST = 99;

/** The row for a monster, in the wire's spelling or the room's, or undefined. */
export function mobRuleFor(rules: readonly MobRule[], name: string): MobRule | undefined {
  const wanted = mobKey(name);
  return rules.find((row) => mobKey(row.mob) === wanted);
}

/** A row given a new treatment: a stance takes the way of fighting it. */
export function treated(row: MobRule, treat: MobTreatment): MobRule {
  return isStance(treat) ? { mob: row.mob, treat } : { ...row, treat };
}

/**
 * The five bands, ordered exactly as they are attacked.
 *
 * The array's order **is** the ranking — `MOB_PRIORITIES.indexOf` is what
 * sorts a room — so these are never reordered for readability, and nothing
 * that is not a rank ever joins them. `default` is the middle on purpose:
 * `high` and `low` are defined against it, and a monster nobody listed is in
 * it, which is what makes the list something you add one row to rather than a
 * ranking of every monster in the realm.
 */
export const MOB_PRIORITIES = ['first', 'high', 'default', 'low', 'last'] as const;
export type MobPriorityBand = (typeof MOB_PRIORITIES)[number];

/**
 * What a row may say instead of where a monster comes in the order —
 * MegaMUD's *relationships* beside its *Enemy*, which is every band (todo
 * 818). None is opened on, so none carries a way of fighting (`treated`).
 *
 * - `never` — MegaMUD's *Avoid*, and stricter: not hit back either.
 * - `friend` — will not attack the character: never opened on, never hit
 *   back, and not a threat (`peaceOf`).
 * - `escape` — MegaMUD's *Flee*: the escape leaves the room while it is here
 *   (`Travel.considerEscape`, under `safety.retreat`), and it is hit back if
 *   it swings, as MegaMUD attacks it when unable to move.
 * - `hangup` — the connection is dropped while it is here
 *   (`Safety.considerHangingUp`, under `safety.hangUp` and the realm's
 *   penalty), and it is hit back if it swings.
 *
 * While an `escape` or `hangup` monster stands in the room no fight is opened
 * beside it (`stanceHere`): MegaMUD's *any other monsters are ignored*.
 */
export const MOB_STANCES = ['never', 'friend', 'escape', 'hangup'] as const;
export type MobStance = (typeof MOB_STANCES)[number];

/** The two stances that take the character away, and beside which nothing is opened. */
export const LEAVING_STANCES = ['escape', 'hangup'] as const satisfies readonly MobStance[];
export type LeavingStance = (typeof LEAVING_STANCES)[number];

/**
 * What a row may say: a stance, or where it comes in the order.
 *
 * Two kinds of fact in one closed union, deliberately — a stance and a rank —
 * because they are answers to one question a player asks about one monster,
 * and because holding them apart is what made *never attack* a second list
 * that merged by different rules. The stances are first because they are read
 * first: `AutoCombat.choose` declines on one before anything is ranked at
 * all. None is in `MOB_PRIORITIES`, so no ranking can ever sort on it.
 */
export const MOB_TREATMENTS = [...MOB_STANCES, ...MOB_PRIORITIES] as const;
export type MobTreatment = (typeof MOB_TREATMENTS)[number];

/** Where an unlisted monster sits: the middle band, and the reason it exists. */
export const DEFAULT_MOB_PRIORITY: MobPriorityBand = 'default';

/** Whether a treatment is a stance rather than a band. */
export function isStance(treat: MobTreatment): treat is MobStance {
  return (MOB_STANCES as readonly string[]).includes(treat);
}

/** A banded row: the one shape that ranks its monster and says how it is fought. */
export type BandedRule = Extract<MobRule, { treat: MobPriorityBand }>;

/** Whether a row is a band rather than a stance. */
export function isBanded(row: MobRule): row is BandedRule {
  return !isStance(row.treat);
}

/** Whether a row leaves its monster unopened on: every stance. */
export function leavesAlone(row: MobRule | undefined): boolean {
  return row !== undefined && isStance(row.treat);
}

/**
 * Whether the character hits the monster back when it swings. No row, or a
 * band, is the ordinary answer; `never` and `friend` say no, and the two that
 * leave the room say yes, since the way out may be refused.
 */
export function hitsBack(row: MobRule | undefined): boolean {
  if (row === undefined) return true;
  switch (row.treat) {
    case 'never':
    case 'friend':
      return false;
    case 'escape':
    case 'hangup':
    case 'first':
    case 'high':
    case 'default':
    case 'low':
    case 'last':
      return true;
    default: {
      const unreachable: never = row;
      return unreachable;
    }
  }
}

/** What a row claims about a monster opening the fight: `friend`, or a band's *Not Hostile*. */
export type RowPeace = 'friend' | 'not-hostile';

/** The row's claim that its monster does not attack first, or null where it makes none. */
export function peaceOf(row: MobRule | undefined): RowPeace | null {
  if (row === undefined) return null;
  switch (row.treat) {
    case 'friend':
      return 'friend';
    case 'never':
    case 'escape':
    case 'hangup':
      return null;
    case 'first':
    case 'high':
    case 'default':
    case 'low':
    case 'last':
      return row.notHostile === true ? 'not-hostile' : null;
    default: {
      const unreachable: never = row;
      return unreachable;
    }
  }
}

/** The claim the row for a monster makes, in the wire's spelling or the room's, or null. */
export function rowPeaceFor(rules: readonly MobRule[], name: string): RowPeace | null {
  return peaceOf(mobRuleFor(rules, name));
}

/**
 * Whether a monster opens the fight itself: the row's claim where it makes one
 * (`peaceOf`), the realm's disposition (`attacksOnSight`) otherwise. What the
 * character does about it — open, rest beside it, count it in a crowd — reads
 * this; the hang-up's own reading does not, since the server's penalty turns
 * on what the monster does, which no row changes (`HangUp.ts`).
 */
export function attacksFirst(
  who: Pick<RoomOccupant, 'name' | 'disposition'>,
  mine: Alignment | null,
  rules: readonly MobRule[]
): boolean | null {
  return rowPeaceFor(rules, who.name) === null ? attacksOnSight(who.disposition, mine) : false;
}

/**
 * The first monster in the room whose row takes this stance, in the room's
 * spelling, or null.
 */
export function stanceHere(
  occupants: readonly Pick<RoomOccupant, 'name' | 'kind'>[],
  rules: readonly MobRule[],
  stance: MobStance
): string | null {
  if (rules.length === 0) return null;
  const found = occupants.find(
    (who) => who.kind === 'mob' && mobRuleFor(rules, who.name)?.treat === stance
  );
  return found?.name ?? null;
}

/**
 * Monster rows, keyed the way the wire spells the name.
 *
 * Keyed here rather than at every comparison, so `Giant Rat`, `giant rat` and
 * `the giant rat` in a config file are one row and match the one thing the
 * stream ever calls it. Bounded at 64, because a list this long is a rule file
 * written in the wrong place.
 *
 * A row naming no monster is dropped rather than defaulted, as a potion rule
 * and a supply row are: it could only ever match nothing. A treatment the
 * table does not know is dropped too — the runtime half of a closed union —
 * rather than falling back to `default`, which would silently turn a typo into
 * a row that reads as deliberate and does nothing. A typo in `never` is the
 * case that argues hardest for dropping it: defaulted, it would read as *leave
 * this alone* and attack it.
 *
 * The **first** row for a monster wins: these rows are merged across three
 * scopes by `mergeMobRules` before they get here, so by this point the
 * narrowest scope's row is already in front and anything behind it is the
 * broader scope it overrode.
 */
export function normalizeMobRules(value: unknown): MobRule[] {
  const rows: MobRule[] = [];
  if (!Array.isArray(value)) return rows;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const mob = mobKey(String(entry['mob'] ?? ''));
    if (mob.length === 0 || seen.has(mob)) continue;
    const treat = str(entry['treat'], DEFAULT_MOB_PRIORITY).trim() as MobTreatment;
    if (!MOB_TREATMENTS.includes(treat)) continue;
    seen.add(mob);
    rows.push(isStance(treat) ? { mob, treat } : { mob, treat, ...fightingOf(entry) });
    if (rows.length >= 64) break;
  }
  return rows;
}

/**
 * How a banded row says to fight its monster, each key only where it says
 * something: a cast naming no spell is dropped rather than kept as a cast of
 * nothing, and its count is clamped to `MOB_CAST_MOST`.
 */
function fightingOf(entry: Record<string, unknown>): {
  cast?: MobCast;
  noBackstab?: boolean;
  notHostile?: boolean;
} {
  const raw = isRecord(entry['cast']) ? entry['cast'] : {};
  const spell = str(raw['spell'], '').trim();
  const times = int(raw['times'], 0, 0, MOB_CAST_MOST);
  return {
    ...(spell.length > 0 ? { cast: { spell, times } } : {}),
    ...(entry['noBackstab'] === true ? { noBackstab: true } : {}),
    ...(entry['notHostile'] === true ? { notHostile: true } : {})
  };
}

/**
 * One monster list from several scopes, with the narrower winning per monster.
 *
 * The one list in `automation:` that is merged rather than replaced, and the
 * exception is deliberate. `overlay` replaces an array wholesale because a
 * character that restates `automation.rules` means *those* rules — but a
 * monster list is addressed by monster, exactly as loops are addressed by
 * name, so the same argument that made `mergeLoops` additive applies: a
 * character that wants the realm's ranking plus one row of its own should not
 * have to restate the realm's, and would have no way to keep the copy in step.
 *
 * Removing a broader scope's row is therefore done by **overriding** it —
 * naming the monster again at `default`, which is what "follow the game logic"
 * already means — rather than by deleting it, which is the trade `mergeNamed`
 * makes everywhere else it is used.
 *
 * Lists are given broadest first; the first row for a monster wins, so callers
 * pass global, then realm, then character.
 */
export function mergeMobRules(...lists: readonly (readonly MobRule[])[]): MobRule[] {
  const rows: MobRule[] = [];
  const seen = new Set<string>();
  // Reversed: the narrowest scope is stated last and has to arrive first, so
  // that `normalizeMobRules`' first-wins rule keeps it.
  for (const list of [...lists].reverse()) {
    for (const row of list) {
      const mob = mobKey(row.mob);
      if (mob.length === 0 || seen.has(mob)) continue;
      seen.add(mob);
      rows.push({ ...row, mob });
    }
  }
  return rows;
}
