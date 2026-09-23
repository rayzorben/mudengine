/**
 * Parses the exit instruction vocabulary out of the realm database.
 *
 * The strings are what the GreaterMUD export contains verbatim, surveyed rather
 * than guessed:
 *
 *     Door
 *     Door [1000 picklocks/strength]
 *     Key: 1124 [or 301 picklocks/strength]
 *     Level: 10 to 999
 *     Text: go crimson, enter crimson, go crimson portal
 *     Trap, 30 damage
 *     Hidden/Searchable
 *     Hidden/Needs 2 Actions, any order
 *     Toll / Item / Class / Race / Alignment / Ability / Cast / Spell / Timed
 *
 * The legacy A* (`engine/path.coffee`) knew seven kinds and treated everything
 * else as free. That is why the `Text:` case matters most: those exits are not
 * traversed by walking a direction at all — you have to send `go crimson
 * portal` — so a route that emits `w` there simply does not work.
 */
import { asAlignment } from '../../shared/alignment';
import { COPPER_PER } from '../../shared/coins';
import type { Requirement, RequirementKind } from '../../shared/world';

/** Ordered: the first pattern that matches wins, so specific precedes general. */
/**
 * The figure the realm writes for "no upper limit", read off the data above.
 */
const NO_LEVEL_CEILING = 999;

const MATCHERS: Array<{ kind: RequirementKind; test: RegExp }> = [
  { kind: 'key', test: /^Key\b/i },
  { kind: 'door', test: /^Door\b/i },
  { kind: 'text', test: /^Text:/i },
  { kind: 'level', test: /^Level\b/i },
  { kind: 'toll', test: /^Toll\b/i },
  // `Ticket/Item` before `item`, since the generic would claim it.
  { kind: 'item', test: /^(?:Ticket\/)?Item\b/i },
  { kind: 'class', test: /^Class\b/i },
  { kind: 'race', test: /^Race\b/i },
  { kind: 'alignment', test: /^Alignment\b/i },
  { kind: 'ability', test: /^Ability\b/i },
  { kind: 'cast', test: /^Cast\b/i },
  { kind: 'spell', test: /^Spell\b/i },
  { kind: 'trap', test: /^Trap\b/i },
  { kind: 'hidden', test: /^Hidden\b/i },
  { kind: 'timed', test: /^Timed\b/i }
];

/**
 * Parses one instruction string.
 *
 * Never returns null for a non-empty input: an instruction we cannot classify
 * becomes `unknown` and keeps its raw text. Dropping it would turn a gated exit
 * into a free one, which is the more dangerous error — a route would walk the
 * player into a locked door and stall.
 */
export function parseInstruction(raw: string | undefined): Requirement | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  const kind = MATCHERS.find((matcher) => matcher.test.test(text))?.kind ?? 'unknown';
  const requirement: Requirement = { kind, raw: text };

  /*
   * `[or 301 picklocks/strength]`, the bare `Door [1000 picklocks/strength]`
   * form, and — surveyed out of the shipped realm rather than remembered —
   * `[or 157 picklocks]` with **no** `/strength` at all. 89 exits are that
   * second shape, and the regex that required `/strength` matched none of
   * them: every one read as a lock no skill substitutes for, which for a
   * `Key:` requirement is priced as a wall.
   *
   * So the two are recorded separately. `any` appears in both shapes and
   * means any skill at all will do.
   */
  const pick = /\[(?:or )?(\d+|any) picklocks(?<strength>\/strength)?\]/i.exec(text);
  if (pick) {
    const difficulty = pick[1]?.toLowerCase() === 'any' ? 0 : Number(pick[1]);
    requirement.pickDifficulty = difficulty;
    if (pick.groups?.['strength'] !== undefined) requirement.bashDifficulty = difficulty;
  }

  if (kind === 'key') {
    const key = /^Key:\s*(\d+)/i.exec(text);
    if (key) requirement.keyId = Number(key[1]);
  }

  if (kind === 'level') {
    /*
     * `Level: 10 to 999` — and **both ends can be written as "unset", with two
     * different sentinels**, which is not cosmetic: an unset maximum taken
     * literally refuses everybody.
     *
     * Measured across the shipped realm's 26 level-gated exits, every distinct
     * instruction in it:
     *
     *     Level: 10 to 999  ×7    Level: 0 to 5   ×2    Level: 0 to 3   ×2
     *     Level: 37 to 0    ×2    Level: 75 to 999 ×2   Level: 0 to 0   ×2
     *     Level: 0 to 10          Level: 10 to 10       Level: 1 to 5
     *     Level: 25 to 0          Level: 40 to 999      Level: 40 to 0
     *     Level: 37 to 99         Level: 69 to 999      Level: 66 to 255
     *
     * `Level: 37 to 0` is the tell. Read literally it admits levels 37 through
     * 0, which admits nobody — and `WorldGraph.blockFor` refuses any character
     * *above* the maximum, so four exits in the shipped realm were impassable
     * to everyone and `Level: 0 to 0` closed two more against every character
     * in the game. **A zero at either end means the realm left it unset**, and
     * `999` at the top means the same thing said the other way.
     *
     * `255` and `99` are left alone. They are above any level a character
     * reaches, so keeping them costs nothing at the router, and inventing a
     * second "this is really unlimited" threshold would be a guess where this
     * one is a reading: 999 has seven exits behind it and a zero minimum is
     * unambiguous.
     */
    const range = /^Level:\s*(\d+)\s*to\s*(\d+)/i.exec(text);
    if (range) {
      const min = Number(range[1]);
      const max = Number(range[2]);
      if (min > 0) requirement.minLevel = min;
      if (max > 0 && max < NO_LEVEL_CEILING) requirement.maxLevel = max;
    }
  }

  if (kind === 'class') {
    /*
     * `Class: 3 OK, 0 NO`, and that is the **only** shape in the shipped
     * realm — 54 exits, surveyed, every one of them written that way.
     *
     * Both numbers are `Classes` row ids and `0` is the realm's empty slot, so
     * a zero is dropped rather than stored: kept, it would read as *class zero
     * may pass* and turn an allow-list into a wall for everybody. That is the
     * `Level: 37 to 0` lesson above, in a second column.
     */
    const gate = /^Class:\s*(\d+)\s*OK(?:\s*,\s*(\d+)\s*NO)?/i.exec(text);
    if (gate) {
      const ok = Number(gate[1]);
      const no = gate[2] === undefined ? 0 : Number(gate[2]);
      if (ok > 0) requirement.classOk = ok;
      if (no > 0) requirement.classNo = no;
    }
  }

  if (kind === 'race') {
    /*
     * `Race: 13 OK, 0 NO`, and that is the only shape either database on this
     * machine holds — two exits in each, both written exactly that way.
     *
     * The same allow/deny pair the class gate states, because on the server it
     * is the same code one case further down: `RoomManager.LoadRooms` case 14
     * is case 13 with `Races` where `Classes` was, and `RaceRestrictedExit` is
     * `ClassRestrictedExit` with the word changed. So the parse is the class
     * parse, `0` dropped for the same reason — kept, it would read as *race
     * zero may pass* and shut the exit against everybody.
     */
    const gate = /^Race:\s*(\d+)\s*OK(?:\s*,\s*(\d+)\s*NO)?/i.exec(text);
    if (gate) {
      const ok = Number(gate[1]);
      const no = gate[2] === undefined ? 0 : Number(gate[2]);
      if (ok > 0) requirement.raceOk = ok;
      if (no > 0) requirement.raceNo = no;
    }
  }

  if (kind === 'alignment') {
    /*
     * `Alignment: Saint to Seedy` — a window on the standing scale, which the
     * realm writes in words and the server holds as two evil-point figures
     * (`AlignmentExit` compares `Player.EvilPoints` against them). The words
     * are the bands those figures fall in, so comparing bands is exact: a
     * bound can only have been written as a word if it sat on one.
     *
     * Fourteen exits in each database and four distinct windows in each, every
     * endpoint one of `Saint`, `Neutral`, `Outlaw`, `Seedy`, `Fiend`. **The
     * spelling is the realm's, not the roster's** — `Fiend` here against
     * `FIEND` in a `who` — which is why the words go through
     * `alignmentRank`'s case-insensitive lookup rather than being compared as
     * strings anywhere.
     *
     * A word neither the realm nor the roster names leaves **both** ends
     * absent rather than one: half a window is not a window, and a gate with a
     * minimum and no maximum would read as *everybody above Saint*, which is
     * the reassuring guess. Absent is an unreadable gate, and the router
     * discourages those rather than opening them.
     */
    const range = /^Alignment:\s*([A-Za-z]+)\s+to\s+([A-Za-z]+)/i.exec(text);
    if (range) {
      const low = asAlignment(range[1]!);
      const high = asAlignment(range[2]!);
      if (low !== null && high !== null) {
        requirement.minAlignment = low;
        requirement.maxAlignment = high;
      }
    }
  }

  if (kind === 'ability') {
    /*
     * `Ability: 152 w/value 1 to 1` — an `Abilities` id and the window the
     * character's **sum** of it has to fall in (`AbilityExit`, reading
     * `GetAbility(id).Sum`).
     *
     * Nine exits in the shipped realm, seven in the other, eight distinct
     * instructions between them. The ids that occur are `DaoLordQuest` (134),
     * `Rune` (152), `Mandos Quest` (200) and `GuildmasterQuest` (204) — quest
     * counters, which the wire states nowhere *except* in `abil`'s listing.
     *
     * **The window is kept, because there is now something that can read it.**
     * It was dropped while no client fact could be compared against it, and
     * `Ability: 0 w/value 0 to 0` — the realm's empty slot, which the server
     * builds as a plain exit (case 23) — was the only case this parse could
     * settle. `abil` states the sums, so the window is the comparison the
     * server makes and it goes on `abilities` as the one `AbilityGate` this
     * exit states, in the same shape a room script's `checkability` takes.
     * One field, one reader, and the two shapes cannot answer differently
     * about the same character.
     */
    const gate = /^Ability:\s*(\d+)\s*w\/value\s*(\d+)\s*to\s*(\d+)/i.exec(text);
    if (gate) {
      const id = Number(gate[1]);
      if (id > 0) {
        requirement.abilityId = id;
        requirement.abilities = [{ id, atLeast: Number(gate[2]), atMost: Number(gate[3]) }];
      }
    }
  }

  if (kind === 'cast') {
    /*
     * `Cast: pre-0, post-1257` — the spells fired at whoever walks the exit,
     * before the step and after it. 293 exits in each database, 25 distinct.
     *
     * `0` is *no spell* on both halves and is dropped, which also settles
     * `Cast: pre-0, post-0`: the server builds a plain exit when neither
     * resolves (`RoomManager.LoadRooms` case 22), and one exit in each
     * database is written that way.
     *
     * What the spells *do* is not in this string and is not this function's
     * to answer — `WorldGraph.resolveSpells` reads the realm's spell table
     * once at load. See `Requirement.spellEffect` for why that matters more
     * than the ids do.
     */
    const spells = /^Cast:\s*pre-(\d+)\s*,\s*post-(\d+)/i.exec(text);
    if (spells) {
      const pre = Number(spells[1]);
      const post = Number(spells[2]);
      if (pre > 0) requirement.castPre = pre;
      if (post > 0) requirement.castPost = post;
    }
  }

  if (kind === 'spell') {
    /*
     * `Spell Trap: 905` — 22 exits in each database, 21 of them `poison
     * darts`. A trap rather than a gate: `SpellTrapExit.CanMoveThroughExit`
     * returns `true` unconditionally, so the whole of what it costs is what
     * the spell does, which `WorldGraph.resolveSpells` reads.
     */
    const spell = /^Spell\s*Trap:\s*(\d+)/i.exec(text);
    if (spell) {
      const id = Number(spell[1]);
      if (id > 0) requirement.spellId = id;
    }
  }

  if (kind === 'item') {
    /*
     * `Item: 191` and `Ticket/Item: 924` — an `Items` row id the character has
     * to be carrying (`ItemRequiredExit` walks `Inventory.ItemStacks`). 267
     * exits in the shipped realm, 26 distinct ids, and the two commonest are
     * `rope and grapple` (157) and `manhole` (57).
     *
     * Stored in `keyId`, which is the same fact a `Key:` instruction states —
     * *this exit wants that item in the pack* — and reading it here is what
     * makes the Room card's item chip name the rope instead of shrugging;
     * `describeObstacle` has read `keyId` for the item case since it was
     * written, against a field nothing set.
     *
     * `Item: 0` is the realm's empty slot and the server builds a plain exit
     * for it (case 3), so the zero is dropped and the exit costs nothing —
     * one such exit in each database.
     */
    const item = /^(?:Ticket\/)?Item:\s*(\d+)/i.exec(text);
    if (item) {
      const id = Number(item[1]);
      if (id > 0) requirement.keyId = id;
    }
  }

  if (kind === 'toll') {
    /*
     * `Toll: 5`, a bare number the realm writes with no unit. It is **gold** —
     * the gate recording `Toll: 5` answered `You do not have enough to cover
     * the toll of 5 gold crowns.` on the wire (player session log, 2026-08-30)
     * — so it is converted here, once, into the copper `Traveller.wealth` is
     * counted in. `Toll: 0` is a gate that charges nothing and is kept as 0
     * rather than dropped, because zero is an answer and absent is not.
     */
    const toll = /^Toll:\s*(\d+)/i.exec(text);
    if (toll) requirement.tollCopper = Number(toll[1]) * COPPER_PER.gold;
  }

  if (kind === 'text') {
    // Everything after `Text:` is a comma-separated list of accepted phrasings.
    // The first is the canonical one; the rest are synonyms the game also takes.
    const commands = text
      .slice(text.indexOf(':') + 1)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (commands.length > 0) requirement.commands = commands;
  }

  if (kind === 'trap') {
    const damage = /(\d+)\s*damage/i.exec(text);
    if (damage) requirement.damage = Number(damage[1]);
  }

  if (kind === 'hidden') {
    // `Hidden/Searchable` can be revealed with `search <direction>`.
    requirement.searchable = /searchable/i.test(text);
    /*
     * `Hidden/Needs 2 Actions, specific order` — how many levers, and whether
     * they have to be pulled in the realm's own numbering. **What** those
     * actions are is not in this string: it is in the direction columns of
     * whichever rooms hold the levers (see `parseAction`), so the join is made
     * in `buildRealm` and lands on `Requirement.actions`.
     */
    const needs = /Needs\s+(\d+)\s+Actions?(?:,\s*(specific|any)\s+order)?/i.exec(text);
    if (needs) {
      requirement.actionsNeeded = Number(needs[1]);
      requirement.actionsOrdered = needs[2]?.toLowerCase() === 'specific';
    }
  }

  return requirement;
}

/**
 * A lever, read out of a **direction column that is not an exit**.
 *
 * The realm stores what a room *does* in the same ten columns it stores where
 * a room *leads*, in one of two shapes surveyed out of both databases on this
 * machine (299 cells in each, 33 spellings, 296 with a phrase behind them):
 *
 *     Action#1 [on the S exit of this room]: pull lever, move lever, pull lev
 *     Action [on the N exit of room 1/1331]: pull lever, push lever, move lever
 *
 * `parseExit` returns null for both, so **every one of them has been dropped
 * since the converter was written** — which is todo 01: the realm said a
 * concealed passage south out of 10/4 needs one action, said in the room's own
 * `W` column that the action is `pull lever`, and the client walked `s`, was
 * refused, and struck a real corridor out of every route for the session.
 *
 * The storage direction is deliberately **not** recorded. `10/4 W` and `10/3
 * E` hold levers whose exits are `S` and `N`; the column is a slot, not a
 * meaning, and keeping it would invite a reader to treat it as one.
 *
 * Null for anything that is not this shape, and for the three cells in each
 * database whose phrase list is empty — a lever with no word to say is not a
 * lever anybody can pull.
 */
export function parseAction(raw: unknown): ParsedAction | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  const match =
    /^Action(?:#(\d+))?\s*\[on the ([A-Za-z]{1,2}) exit of (?:this room|room (\d+)\/(\d+))\]\s*:\s*(\S.*)$/i.exec(
      text
    );
  if (!match) return null;
  /*
   * `(Item: 815)` on the end of the list is the item the action needs carried
   * — 172 cells in Paradigm's data and 170 in stock v1.11p end this way
   * (surveyed 2026-09-07), always after the last phrase, never inside one.
   * The realm's editor writes it there from the exit's own item field, and
   * the server reads that field before the action fires (`ExitAction.Perform`:
   * `You don't have <item> to use!`). Read off and kept apart, so the phrase
   * the walker says is the phrase and the item is a number the pack can be
   * asked about. `Item: 0` is the realm's empty slot, as it is on an exit.
   */
  let phrases = match[5]!;
  let item: number | undefined;
  const clause = /\s*\((?:Ticket\/)?Item:\s*(\d+)\)\s*$/i.exec(phrases);
  if (clause) {
    const id = Number(clause[1]);
    if (id > 0) item = id;
    phrases = phrases.slice(0, clause.index);
  }
  const say = phrases
    .split(',')
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
  if (say.length === 0) return null;
  const action: ParsedAction = { direction: match[2]!.toLowerCase(), say };
  if (item !== undefined) action.item = item;
  // `Action#n` numbers the levers for a `specific order` exit. A bare `Action`
  // is the only one, so its order is not a fact the data states.
  if (match[1] !== undefined) action.index = Number(match[1]);
  if (match[3] !== undefined) {
    action.map = Number(match[3]);
    action.room = Number(match[4]);
  }
  return action;
}

/** One `Action …` cell, read. `map`/`room` absent means the room it sits in. */
export interface ParsedAction {
  /** The exit it opens, canonical short. */
  direction: string;
  /** Every phrase the realm accepts, its own first. */
  say: string[];
  /** The `Items` row that must be carried to say any of them. See `RequirementAction.item`. */
  item?: number;
  /** `Action#n` — its place when the exit wants them in order. */
  index?: number;
  /** The room the exit is in, when it is not this one. */
  map?: number;
  room?: number;
}
