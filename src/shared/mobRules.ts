/**
 * The monster list, `combat.mobRules`: one row per monster, and what the
 * automation does about it. Out of `config.ts` (todo 818), whose block it is a
 * field of, with the readers every module asks through, so a row means one
 * thing everywhere. The rules: `mudengine-automation` › `parts/combat.md` ›
 * *One list per monster, not two* and *A row may say what a monster is*.
 */
import type { RoomOccupant } from './character';
import { attacksOnSight, type MobAvoid, type Standing } from './mobs';
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
      /**
       * MegaMUD's *Stop to kill if able*: not walked past. It is opened on in a
       * room under `minMobs` and whoever outside the party has claimed it
       * (`politeAttacks`); every other refusal still stands.
       */
      stopToKill?: boolean;
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

/**
 * Where a monster list comes from, broadest first (todo 817): MegaMUD's
 * shipped table, the options file, the realm. A character's own list is the
 * narrowest and is the one its form edits, so it is never inherited.
 */
export const MOB_RULE_SOURCES = ['megamud', 'global', 'realm'] as const;
export type MobRuleSource = (typeof MOB_RULE_SOURCES)[number];

/** One broader scope's rows, as a settings form shows them beneath its own. */
export interface MobRuleLayer {
  source: MobRuleSource;
  rows: readonly MobRule[];
}

/** Which list a settings form edits, and so which sources sit beneath it. */
export const MOB_RULE_SCOPES = ['global', 'realm', 'character'] as const;
export type MobRuleScope = (typeof MOB_RULE_SCOPES)[number];

/** A scope off the wire, or null. */
export function asMobRuleScope(value: unknown): MobRuleScope | null {
  return (MOB_RULE_SCOPES as readonly unknown[]).includes(value) ? (value as MobRuleScope) : null;
}

/** The sources beneath a scope's own list, broadest first. */
export function sourcesBeneath(scope: MobRuleScope): readonly MobRuleSource[] {
  switch (scope) {
    case 'global':
      return ['megamud'];
    case 'realm':
      return ['megamud', 'global'];
    case 'character':
      return MOB_RULE_SOURCES;
    default: {
      const unreachable: never = scope;
      return unreachable;
    }
  }
}

/** A row a form inherits: the one that holds for its monster, where it comes from, and whether the form's own list replaces it. */
export interface InheritedRow {
  row: MobRule;
  source: MobRuleSource;
  replaced: boolean;
}

/**
 * The rows beneath a form's own list, one per monster, the narrowest source
 * holding, as `mergeMobRules` would merge them; each marked where the form's
 * own rows already name the monster. Sorted by monster.
 */
export function inheritedRows(
  layers: readonly MobRuleLayer[],
  own: readonly MobRule[]
): InheritedRow[] {
  const mine = new Set(own.map((row) => mobKey(row.mob)));
  const held = new Map<string, InheritedRow>();
  for (const layer of [...layers].reverse()) {
    for (const row of layer.rows) {
      const mob = mobKey(row.mob);
      if (mob.length === 0 || held.has(mob)) continue;
      held.set(mob, { row: { ...row, mob }, source: layer.source, replaced: mine.has(mob) });
    }
  }
  return [...held.values()].sort((a, b) => a.row.mob.localeCompare(b.row.mob));
}

/** The most rows one scope's list may hold; the shipped MegaMUD scope passes its own. */
export const MOB_RULES_MOST = 64;

/** The most casts a row may name — MegaMUD's own field, 0–99. */
export const MOB_CAST_MOST = 99;

/** Each list's rows by monster, built once: MegaMUD's scope makes a list of hundreds (todo 817). */
const indexed = new WeakMap<readonly MobRule[], Map<string, MobRule>>();

/**
 * A monster a row is looked up for: a bare name, or the room's occupant, which
 * also carries the realm's row name behind the printed one.
 */
export type RowNamed = string | Pick<RoomOccupant, 'name' | 'mob'>;

/**
 * The row for a monster, or undefined. An occupant is looked up by its printed
 * name, then by the realm's row name: the server hangs a modifier on the row's
 * name (`large gravedigger`, `MobNameModifierType`) and a player writes the
 * row for the realm's monster, so a `gravedigger` row never matched one (2026-10-23).
 */
export function mobRuleFor(rules: readonly MobRule[], who: RowNamed): MobRule | undefined {
  const index = indexOf(rules);
  if (typeof who === 'string') return index.get(mobKey(who));
  const printed = index.get(mobKey(who.name));
  return printed !== undefined || who.mob === undefined ? printed : index.get(mobKey(who.mob.name));
}

/** The realm's row name for an occupant, else the name the room printed. */
export function rowName(who: Pick<RoomOccupant, 'name' | 'mob'>): string {
  return who.mob?.name ?? who.name;
}

/** The monster the room lists under a printed name, by `mobKey`, or undefined. */
export function mobListed<T extends Pick<RoomOccupant, 'name' | 'kind'>>(
  occupants: readonly T[],
  name: string
): T | undefined {
  const key = mobKey(name);
  return occupants.find((who) => who.kind === 'mob' && mobKey(who.name) === key);
}

/** The realm's row behind a name the room lists, else the name. */
export function rowListed(
  occupants: readonly Pick<RoomOccupant, 'name' | 'kind' | 'mob'>[],
  name: string
): string {
  const who = mobListed(occupants, name);
  return who === undefined ? name : rowName(who);
}

function indexOf(rules: readonly MobRule[]): Map<string, MobRule> {
  let index = indexed.get(rules);
  if (index === undefined) {
    index = new Map();
    // The first row for a monster wins, as `normalizeMobRules` keeps it.
    for (const row of rules) {
      const key = mobKey(row.mob);
      if (!index.has(key)) index.set(key, row);
    }
    indexed.set(rules, index);
  }
  return index;
}

/**
 * A row laid beneath every list from MegaMUD's table rather than written by
 * the player (todo 856). Marked on the resolved list only: `normalizeMobRules`
 * builds each row from its known keys, so the mark is never read from a file
 * and never written to one.
 */
export type LaidMobRule = MobRule & { laid: Extract<MobRuleSource, 'megamud'> };

/** MegaMUD's rows, marked as laid. */
export function laidFromTable(rows: readonly MobRule[]): LaidMobRule[] {
  return rows.map((row) => ({ ...row, laid: 'megamud' }));
}

/**
 * The row for a monster when the player wrote it, in any of their three
 * scopes; undefined for none, and for a row MegaMUD's table laid.
 */
export function ownRow(rules: readonly MobRule[], who: RowNamed): MobRule | undefined {
  const row = mobRuleFor(rules, who);
  return row === undefined || ('laid' in row && row.laid === 'megamud') ? undefined : row;
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
 * beside it (`stanceHere`): MegaMUD's *any other monsters are ignored*. Those
 * two reach a player the row names as well (todo 87).
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
/** A treatment off the wire, or null. */
export function asMobTreatment(value: unknown): MobTreatment | null {
  return (MOB_TREATMENTS as readonly unknown[]).includes(value) ? (value as MobTreatment) : null;
}

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
export function rowPeaceFor(rules: readonly MobRule[], who: RowNamed): RowPeace | null {
  return peaceOf(mobRuleFor(rules, who));
}

/**
 * Whether a monster opens the fight itself: the row's claim where it makes one
 * (`peaceOf`), the realm's disposition (`attacksOnSight`) otherwise. What the
 * character does about it — open, rest beside it, count it in a crowd — reads
 * this; the hang-up's own reading does not, since the server's penalty turns
 * on what the monster does, which no row changes (`HangUp.ts`).
 */
export function attacksFirst(
  who: Pick<RoomOccupant, 'name' | 'disposition' | 'mob'>,
  standing: Standing,
  rules: readonly MobRule[]
): boolean | null {
  return rowPeaceFor(rules, who) === null ? occupantAttacksOnSight(who, standing) : false;
}

/** `attacksOnSight` for a monster the room listed: its disposition and its row's effects. */
export function occupantAttacksOnSight(
  who: Pick<RoomOccupant, 'disposition' | 'mob'>,
  standing: Standing
): boolean | null {
  return attacksOnSight(who.disposition, who.mob?.abilities, standing);
}

/**
 * Why the realm data says to leave a monster alone unless it or the party
 * starts the fight (`MobAvoid`), or null. A banded row the player wrote for it
 * says to fight it, and outranks the realm; a stance row is refused on its own.
 */
export function avoidedFor(
  who: Pick<RoomOccupant, 'name' | 'mob'>,
  rules: readonly MobRule[]
): MobAvoid | null {
  const avoid = who.mob?.avoid;
  return avoid === undefined || mobRuleFor(rules, who) !== undefined ? null : avoid;
}

/** Whether the row for a monster says it is stopped for and killed (`stopToKill`). */
export function stopsToKill(rules: readonly MobRule[], who: RowNamed): boolean {
  const row = mobRuleFor(rules, who);
  return row !== undefined && isBanded(row) && row.stopToKill === true;
}

/**
 * The first occupant whose row takes this stance, in the room's spelling, or
 * null. A leaving stance (`escape`, `hangup`) reaches a player named in a row
 * too, as MegaMUD keeps one list for players and monsters (todo 87), and an
 * occupant of unknown kind, since unknown is the unsafe case; the others
 * reach monsters only.
 */
export function stanceHere(
  occupants: readonly Pick<RoomOccupant, 'name' | 'kind' | 'mob'>[],
  rules: readonly MobRule[],
  stance: MobStance
): string | null {
  if (rules.length === 0) return null;
  const anyone = (LEAVING_STANCES as readonly MobStance[]).includes(stance);
  const found = occupants.find(
    (who) => (anyone || who.kind === 'mob') && mobRuleFor(rules, who)?.treat === stance
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
export function normalizeMobRules(value: unknown, most = MOB_RULES_MOST): MobRule[] {
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
    if (rows.length >= most) break;
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
  stopToKill?: boolean;
} {
  const raw = isRecord(entry['cast']) ? entry['cast'] : {};
  const spell = str(raw['spell'], '').trim();
  const times = int(raw['times'], 0, 0, MOB_CAST_MOST);
  return {
    ...(spell.length > 0 ? { cast: { spell, times } } : {}),
    ...(entry['noBackstab'] === true ? { noBackstab: true } : {}),
    ...(entry['notHostile'] === true ? { notHostile: true } : {}),
    ...(entry['stopToKill'] === true ? { stopToKill: true } : {})
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
