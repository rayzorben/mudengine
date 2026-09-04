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
    // `Hidden/Needs N Actions` and `Hidden/Unknown` cannot, from data alone.
    requirement.searchable = /searchable/i.test(text);
  }

  return requirement;
}
