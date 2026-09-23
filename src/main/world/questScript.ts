/**
 * Reading a text block's action script.
 *
 * `TBInfo.Action` is what the server runs when somebody says a word to an NPC:
 * colon-separated opcodes, newline-separated alternatives, and 47 verbs
 * implemented in `Textblocks/TextBlockPart.cs`. This reads the ones that state
 * a **requirement** or a **reward** and ignores the rest — the flow control
 * (`text`, `message`, `delay`, `random`), the world effects (`summon`,
 * `teleport`, `cast`) and everything whose meaning is a sentence somebody
 * reads rather than a fact somebody can act on.
 *
 * Pure and here rather than inside `buildRealm`, for `roomScript.ts`'s reason:
 * it is a function of one string, it has edge cases worth testing, and the
 * suite runs with no database.
 *
 * ## The semantics are the server's, transcribed
 *
 * Each of these was read out of `TextBlockPart.Execute` rather than inferred
 * from the verb, and two of them do **not** mean what they look like:
 *
 * | opcode | what the server does |
 * |---|---|
 * | `checkability N [V]` | succeeds when the player's sum of N is **>= V**; V defaults to -1, so one argument means *has it at all* |
 * | `testability N V` | succeeds when the sum is **<= V** — the opposite comparison, not a different subject |
 * | `failability N` | succeeds only when the player does **not** have N |
 * | `goodaligned L` | `alignment <= L`; lower is better on this lineage |
 * | `evilaligned L` | `alignment >= L` |
 * | `giveability N V` | sets N to V, and only upward |
 * | `addability N V` | adds V to whatever N already is |
 *
 * A step that states `testability 126 5` **and** `checkability 126 5` is
 * therefore asking for rank *exactly* 5, which is how every chained quest in
 * both databases is written — so that doing step five twice cannot skip step
 * six. Reading only one half of that pair would make every step of every quest
 * look available at every rank.
 *
 * The trailing number on a gate (`goodaligned -51 801`, `checkitem 622 3208`)
 * is the block to jump to on failure. It is read past deliberately: it names
 * the *refusal*, and a refusal is a sentence rather than a requirement.
 *
 * Two more are kept since todo 106 (2026-09-21), because the runner and the
 * card both need them: `testskill <stat> <value> [block]` is a **roll** —
 * the stat less the value, clamped to 2..98, against 1–100
 * (`TextBlockPart.cs:1139`) — kept as a `skill` gate; and `adddelay N` (or
 * `delay N`) is the server holding the rest of the block for N seconds
 * (`ContinueTextblockCommand`), kept as the line's `delay`.
 */
import type { Denomination } from '../../shared/character';
import type { QuestGate, QuestReward } from '../../shared/quests';

/** What one line of a script says, before anything is joined to anything. */
export interface QuestScript {
  needs: QuestGate[];
  takes: number[];
  gives: QuestReward[];
  /**
   * The quest counter this line advances, when it advances one.
   *
   * A line may `giveability` several things — the alignment quests hand out
   * class perks alongside the counter — so which one is *the quest* is decided
   * by `buildRealm` against the set of counters the realm actually chains,
   * never guessed at here.
   */
  granted: Array<{ id: number; value: number }>;
  /** `adddelay N`: how long the server holds the rest of the line, in seconds. */
  delay?: number;
}

/** The coin letters `givecoins` takes, in the server's own spelling. */
const COINS: Record<string, Denomination> = {
  C: 'copper',
  S: 'silver',
  G: 'gold',
  P: 'platinum',
  R: 'runic'
};

/**
 * Reads one script line into the facts it states.
 *
 * Returns a script with nothing in it for a line that states none, which is
 * most of them: the great majority of blocks are dialogue, and a keyword table
 * is not a script at all.
 */
export function readQuestScript(line: string): QuestScript {
  const needs: QuestGate[] = [];
  const takes: number[] = [];
  const gives: QuestReward[] = [];
  const granted: Array<{ id: number; value: number }> = [];

  const text = line.trim();
  if (text.length === 0) return { needs, takes, gives, granted };

  /*
   * An ability gate is accumulated rather than pushed, because the pair that
   * means "exactly" arrives as two opcodes and has to come out as one fact.
   * Keyed by ability id, in the order first seen.
   */
  const abilities = new Map<number, { atLeast?: number; atMost?: number }>();
  const order: number[] = [];
  const gate = (id: number): { atLeast?: number; atMost?: number } => {
    let held = abilities.get(id);
    if (held === undefined) {
      held = {};
      abilities.set(id, held);
      order.push(id);
    }
    return held;
  };

  let level: { min?: number; max?: number } | null = null;
  let alignment: { atMost?: number; atLeast?: number } | null = null;
  let delay: number | null = null;

  for (const raw of text.split(':')) {
    const parts = raw.trim().split(/\s+/);
    const verb = (parts[0] ?? '').toLowerCase();
    const a = num(parts[1]);
    const b = num(parts[2]);

    switch (verb) {
      case 'checkability':
        // One argument is "has it at all", which the server spells as `>= -1`.
        if (a !== null) gate(a).atLeast = b ?? -1;
        break;
      case 'testability':
        if (a !== null && b !== null) gate(a).atMost = b;
        break;
      case 'checkabilityexact':
        if (a !== null && b !== null) {
          const held = gate(a);
          held.atLeast = b;
          held.atMost = b;
        }
        break;
      case 'failability':
        if (a !== null) needs.push({ kind: 'ability-absent', id: a });
        break;
      case 'checkitem':
        if (a !== null) needs.push({ kind: 'item', id: a });
        break;
      case 'failitem':
        if (a !== null) needs.push({ kind: 'item-absent', id: a });
        break;
      case 'checkspell':
        if (a !== null) needs.push({ kind: 'spell', id: a });
        break;
      case 'class':
        if (a !== null) needs.push({ kind: 'class', id: a });
        break;
      case 'race':
        if (a !== null) needs.push({ kind: 'race', id: a });
        break;
      case 'minlevel':
        if (a !== null) level = { ...(level ?? {}), min: a };
        break;
      case 'maxlevel':
        if (a !== null) level = { ...(level ?? {}), max: a };
        break;
      case 'goodaligned':
        if (a !== null) alignment = { ...(alignment ?? {}), atMost: a };
        break;
      case 'evilaligned':
        if (a !== null) alignment = { ...(alignment ?? {}), atLeast: a };
        break;
      case 'checklives':
        if (a !== null) needs.push({ kind: 'lives', atLeast: a });
        break;
      case 'price':
        if (a !== null) needs.push({ kind: 'price', amount: a });
        break;
      case 'testskill': {
        // The stat is the script's own word; the value is what is rolled
        // against. `current_hp` is absolute rather than a chance and is
        // read past: it is a gate on the moment, not a roll on the sheet.
        const stat = (parts[1] ?? '').toLowerCase();
        const value = num(parts[2]);
        if (stat.length > 0 && stat !== 'current_hp' && value !== null) {
          needs.push({ kind: 'skill', stat, value });
        }
        break;
      }
      case 'adddelay':
      case 'delay':
        // Several on one line add up: the server holds at each in turn.
        if (a !== null && a > 0) delay = (delay ?? 0) + a;
        break;

      case 'takeitem':
        if (a !== null) takes.push(a);
        break;
      case 'addexp':
        if (a !== null && a !== 0) gives.push({ kind: 'exp', amount: a });
        break;
      case 'giveitem':
        if (a !== null) gives.push({ kind: 'item', id: a });
        break;
      case 'givecoins': {
        const coin = COINS[(parts[2] ?? '').toUpperCase()];
        // A denomination the server does not spell is not a coin this can
        // count; saying nothing beats naming the wrong purse.
        if (a !== null && coin !== undefined) gives.push({ kind: 'coins', amount: a, coin });
        break;
      }
      case 'giveability':
      case 'setability':
        if (a !== null && b !== null) {
          gives.push({ kind: 'ability', id: a, value: b, mode: 'set' });
          granted.push({ id: a, value: b });
        }
        break;
      case 'addability':
        if (a !== null && b !== null) gives.push({ kind: 'ability', id: a, value: b, mode: 'add' });
        break;
      case 'learnspell':
        if (a !== null) gives.push({ kind: 'spell', id: a });
        break;
      case 'addlife':
        if (a !== null) gives.push({ kind: 'lives', amount: a });
        break;
      case 'addevil':
        if (a !== null && a !== 0) gives.push({ kind: 'alignment', amount: a });
        break;
      default:
        break;
    }
  }

  for (const id of order) {
    needs.push({ kind: 'ability', id, ...abilities.get(id)! });
  }
  if (level !== null) needs.push({ kind: 'level', ...level });
  if (alignment !== null) needs.push({ kind: 'alignment', ...alignment });

  return { needs, takes, gives, granted, ...(delay === null ? {} : { delay }) };
}

/**
 * A keyword table — the shape a monster's greeting block takes.
 *
 * `adventurer:3` per line, one word to one block, and an NPC routinely points
 * several words at the same one: Chancellor Annora answers `return`, `Markus`,
 * `Commander Markus`, `box`, `darkwood box` and `quest` with the same block.
 *
 * Told from a script by its right-hand side being a bare number and its left
 * being something a person types. A phrase with a space in it is kept whole,
 * because that is what the player has to say.
 */
export function readKeywordTable(action: string): Map<number, string[]> {
  const table = new Map<number, string[]>();
  for (const line of action.split('\n')) {
    const row = line.trim();
    if (row.length === 0) continue;
    const at = row.lastIndexOf(':');
    if (at <= 0) continue;
    const word = row.slice(0, at).trim();
    const block = num(row.slice(at + 1).trim());
    // A left-hand side holding a digit is an opcode's argument, not a word
    // somebody says, which is what keeps a one-line script out of this.
    if (block === null || word.length === 0 || /\d/.test(word)) continue;
    const held = table.get(block);
    if (held === undefined) table.set(block, [word]);
    else if (!held.includes(word)) held.push(word);
  }
  return table;
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
