import type { Block } from './blocks';
import { commandOf, GREATERMUD_ONLY } from './commands';

/**
 * Which formula family a realm belongs to, and where that was read from.
 *
 * **A seam, not a feature** (docs/mudplay/03-the-realms-formula-family.md).
 * Two lineages ship in this client — GreaterMUD, whose server source is on
 * this machine, and the MajorMUD lineage Paradigm's six realms descend from —
 * and they disagree on CP cost caps, regeneration divisors, the experience
 * curve's modifier tables and most of the combat arithmetic. Anything computed
 * without this branch is silently wrong on one of the two realms this client
 * already ships, and silently is the operative word: a hit chance eight per
 * cent out produces no error, just a target choice that costs a character.
 *
 * This module is the vocabulary alone. It holds no arithmetic and never will —
 * the calculators take a family as a *parameter*, because this client runs
 * several characters in one process and an ambient global for the family is a
 * defect waiting for a second tab.
 *
 * ## Two families are in play at once, legitimately
 *
 * The data says what exists; the server says how the arithmetic runs, and they
 * are **not required to agree**. The shipped configuration was the proof for
 * two days: the shipped world was built from a Paradigm database
 * (`mdb/pmud.zip`) and `DEFAULT_REALM_NAME` pointed a new character at a
 * GreaterMUD server, so a client straight out of the box disagreed with
 * itself. That default went back to Paradigm on 2026-09-05 and the two halves
 * now agree out of the box — which changes nothing here, because a player who
 * names their own realm's database is one `database:` key away from the same
 * split, and that is the ordinary case rather than the exotic one.
 *
 * So this is two fields — `RealmFamilies.data` and `RealmFamilies.server` — and
 * a disagreement between them is reported rather than resolved. Picking a
 * winner would be exactly the confidently wrong answer the project refuses; the
 * player is the only one who can say which half of their setup is the mistake,
 * and there are setups where neither is.
 *
 * ## Where a family cannot be read, it is `null`
 *
 * Never a fallback to the other family's arithmetic. GreaterMUD has the
 * server's own source behind it and the MajorMUD lineage has captures and the
 * fight log and no source at all, so the two will honestly answer different
 * amounts for a while. That asymmetry is correct.
 */
export type RealmFamily = 'greatermud' | 'majormud';

/**
 * The runtime half of the union.
 *
 * The standing closed-union rule: the type and the list that validates against
 * it move together, and `__tests__/realm.test.ts` reads **both** out of this
 * file's own source and asserts they are the same set. A family in one and not
 * the other type-checks, then fails to load, and the only symptom is
 * arithmetic that quietly never branches.
 */
export const REALM_FAMILIES: readonly RealmFamily[] = ['greatermud', 'majormud'];

/**
 * How each family is written when it is shown.
 *
 * In code rather than in `locales/ui.en.yaml`, per the standing exemption for
 * closed-union vocabulary rendered as itself: these are the realms' own names
 * and there is no translation of them.
 *
 * Deliberately **not** MudPlay's words. Its `RealmType` calls the two `Stock`
 * and `ParaMud`, which name one distribution of one lineage rather than the
 * lineage; `docs/terminology.md`'s authority ladder puts the realm's own word
 * first, and the realms call themselves these.
 */
export const REALM_FAMILY_LABEL: Record<RealmFamily, string> = {
  greatermud: 'GreaterMUD',
  majormud: 'MajorMUD'
};

/** Parse, do not validate: anything else is `null` rather than a cast. */
export function asRealmFamily(value: unknown): RealmFamily | null {
  if (typeof value !== 'string') return null;
  const found = REALM_FAMILIES.find((family) => family === value);
  return found ?? null;
}

/**
 * The realm database's own account of itself — the `Info` table, whole.
 *
 * One row of seven columns that `buildRealm.ts` never opened until format 21.
 * It is carried in full rather than reduced to the family bit, because
 * **provenance is part of the answer**: a derived number has to be able to say
 * which build of which database it came from, and a record that names its own
 * build is what makes *how does it know that* answerable at all.
 *
 * Every field is nullable and null means the column was absent or empty — a
 * realm file is untrusted input and a derivative may carry none of this.
 */
export interface RealmBuild {
  /** `NMR Version` — the editor that wrote the file. `v1.8.2` on the shipped realm. */
  nmr: string | null;
  /** `Dat File Version` — the data set's own version. `v1.11p` on the shipped realm. */
  data: string | null;
  /** `Date` and `Time`, as the file states them. Not parsed: formats vary and nothing needs a clock. */
  date: string | null;
  time: string | null;
  /**
   * `Custom` — what the distribution calls itself. `Gmud 1.6 Final` on the
   * shipped realm, and **the column the family is read from**.
   */
  custom: string | null;
  /**
   * `Legit` — recorded, never branched on.
   *
   * MudPlay reads `Legit == 2` as GreaterMUD. The shipped GreaterMUD database
   * says `0`, and `Legit` appears nowhere in the GreaterMUD server source — not
   * in the module and not in the data project — so it is an export flag of the
   * tool that writes the `.mdb` and cannot be checked against the server at
   * all. Kept because it is part of the record and because the next person to
   * read MudPlay's source will otherwise re-derive this; read by nothing.
   */
  legit: number | null;
  /** `UpdateURL`. Shown, never fetched. */
  updateUrl: string | null;
}

/** True when the row said nothing at all, so the record is not worth carrying. */
export function isEmptyBuild(build: RealmBuild): boolean {
  return (
    build.nmr === null &&
    build.data === null &&
    build.date === null &&
    build.time === null &&
    build.custom === null &&
    build.legit === null &&
    build.updateUrl === null
  );
}

/**
 * The `Info` record read back off a realm header.
 *
 * Parsed, not cast. The header is a file on the player's disk — theirs to hand
 * edit, and written by whichever build of this client converted their database
 * — so every field is taken only when it is the right shape and dropped
 * otherwise. A record that turns out to say nothing reads as `null`, so a
 * consumer's one check is for absence rather than for absence *or* seven
 * nulls.
 */
export function readRealmBuild(value: unknown): RealmBuild | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const word = (key: string): string | null => {
    const held = record[key];
    if (typeof held !== 'string') return null;
    const trimmed = held.trim();
    return trimmed.length === 0 ? null : trimmed;
  };
  const legit = record['legit'];
  const build: RealmBuild = {
    nmr: word('nmr'),
    data: word('data'),
    date: word('date'),
    time: word('time'),
    custom: word('custom'),
    legit: typeof legit === 'number' && Number.isFinite(legit) ? legit : null,
    updateUrl: word('updateUrl')
  };
  return isEmptyBuild(build) ? null : build;
}

/**
 * The family the database states, from `Custom`.
 *
 * `Custom` and not `Legit`, for the reason recorded on that field. A
 * distribution that names neither lineage gets `null`: this client does not
 * have a *my realm is GreaterMUD* checkbox and it does not have a guess
 * either, and a wrong family is worse than no family because everything
 * downstream of it would still answer.
 *
 * **`Default` is the stock data set naming itself.** MajorMUD Explorer's export
 * of the unmodified v1.11p data — `mdb/majormud-v1.11p.zip`, the world the
 * client ships for MajorMUD realms — states `Custom: Default`, `Dat File
 * Version: v1.11p`, `Legit: 1` (read 2026-09-07). Matched whole: it is the one
 * word the stock distribution uses, and a derivative that edits the file
 * renames it.
 */
export function familyOfBuild(build: RealmBuild | null): RealmFamily | null {
  const custom = build?.custom?.trim().toLowerCase() ?? '';
  if (custom.length === 0) return null;
  if (/\bg-?mud\b|greater\s*mud/.test(custom)) return 'greatermud';
  if (/\bp-?mud\b|paradigm|paramud|major\s*mud/.test(custom)) return 'majormud';
  if (custom === 'default') return 'majormud';
  return null;
}

/**
 * What told the client the server's family. Carried with the answer, because
 * an answer with no provenance is indistinguishable from a guess.
 */
export type FamilyTell =
  /** `exp` printed a table of level costs. GreaterMUD's prints none. */
  | 'experience-table'
  /** `rm` answered with coordinates, so this server has the word. */
  | 'locate-answered'
  /**
   * A command only GreaterMUD has was said out loud in the room, so this
   * server does not have it.
   */
  | 'gmud-command-spoken'
  /**
   * A command only GreaterMUD has came back `Your command had no effect.`,
   * which is how the MajorMUD lineage refuses a word it does not have.
   */
  | 'gmud-command-refused';

export interface FamilyReading {
  family: RealmFamily;
  tell: FamilyTell;
}

/**
 * The server's family, from a block the client was already going to read.
 *
 * **Three positive tells and no negative ones.** Each says *this family*, and
 * absence says nothing — which is why it is written this way rather than as a
 * count of tables seen. An `exp` summary arriving with no table yet is not
 * evidence of GreaterMUD, it is evidence of nothing having arrived; a fold
 * that treated it as a tell would answer confidently on the first prompt of
 * every session.
 *
 * - **`user-experience-table` ⇒ MajorMUD.** `exp` on GreaterMUD answers with
 *   the summary line alone: zero tables across every recorded `orohost`
 *   session against three in one Paradigm session (`shared/experience.ts`).
 * - **`user-profile` carrying `Location:` ⇒ GreaterMUD.** The `map,room` pair
 *   is `rm`'s answer. `Recent Deaths:` matches the same block type and is
 *   *not* a tell — it is `pro`'s heading, which is why the groups are tested
 *   rather than the type.
 *
 *   That distinction turned out to be load-bearing rather than fastidious.
 *   This comment used to add *"and MajorMUD has neither `rm` nor `pro`"*, read
 *   out of docs/game-behaviour.md; measured on `bbs.bearfather.net`
 *   2026-09-05, **MajorMUD answers `pro` in full** — sixteen lines of the
 *   character's own preferences — and simply puts no `Location:` in it.
 *   Testing the type would have read that as GreaterMUD; testing the groups
 *   reads it as nothing, which is right.
 * - **A GreaterMUD-only command refused ⇒ MajorMUD**, in **two** shapes,
 *   because the two lineages refuse a word they do not have differently and
 *   this client believed for a while that they did it the same way.
 *
 *   `Your command had no effect.` (`command-no-effect`) is what the MajorMUD
 *   lineage answers, measured on `bbs.bearfather.net` 2026-09-05 (majorMUD
 *   v1.11p-WG3NT): `rm` at the prompt, that sentence back, twice, privately.
 *   The sentence **names nothing**, so the command comes from the status
 *   line's own echo — `SessionManager.answering`, the slot
 *   `Recovery.noteNoEffect` already reads — and is passed in.
 *
 *   `You say "rm"` (`command-not-understood`) is the *GreaterMUD* family's
 *   answer, measured on `orohost` (`exits`, `time`, `stats`, `gold` all came
 *   back as speech). docs/game-behaviour.md read that behaviour onto MajorMUD
 *   and it was wrong: a reading is not a capture. It is kept as a tell because
 *   it still says something true — a server that does not have `rm` is not
 *   GreaterMUD, whatever it does about it — but it is no longer the shape this
 *   is expected to arrive in.
 *
 *   **Resolved through `commandOf`, never compared as text.** `rm`, `roo` and
 *   `room` are one command to the server and would be three strings here, and
 *   a word the table does not have at all — `go manhole`, a typo — says
 *   nothing about the lineage: a text exit is room data, so it is missing from
 *   *every* realm's command table by construction.
 *
 *   **And only a `GREATERMUD_ONLY` word.** `Your command had no effect.` is
 *   also what a realm answers a word it *does* have that did nothing — `med`
 *   for a class with no mana, measured — so it is a tell about the lineage
 *   only for a command whose absence is the thing that separates them.
 *
 * None costs a command the client does not already send.
 */
export function familyToldBy(block: Block, answering: string | null = null): FamilyReading | null {
  if (block.type === 'user-experience-table') {
    return { family: 'majormud', tell: 'experience-table' };
  }
  if (block.type === 'user-profile' && block.groups['room'] !== undefined) {
    return { family: 'greatermud', tell: 'locate-answered' };
  }
  if (block.type === 'command-not-understood') {
    const spoken = commandOf(block.groups['message'] ?? '');
    if (spoken !== null && GREATERMUD_ONLY.has(spoken)) {
      return { family: 'majormud', tell: 'gmud-command-spoken' };
    }
  }
  if (block.type === 'command-no-effect') {
    const refused = commandOf(answering ?? '');
    if (refused !== null && GREATERMUD_ONLY.has(refused)) {
      return { family: 'majormud', tell: 'gmud-command-refused' };
    }
  }
  return null;
}

/**
 * The two families a session is running against.
 *
 * Kept as a pair rather than reconciled. `null` on either side is *unknown*,
 * and unknown never disagrees with anything.
 */
export interface RealmFamilies {
  /** From the realm file's `Info` row. */
  data: RealmFamily | null;
  /** From the wire, on the tells above. */
  server: RealmFamily | null;
}

/** True only when both are known and they are not the same. */
export function familiesDisagree(families: RealmFamilies): boolean {
  return families.data !== null && families.server !== null && families.data !== families.server;
}
