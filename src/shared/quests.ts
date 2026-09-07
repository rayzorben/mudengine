/**
 * The realm's quests, derived from its own text blocks.
 *
 * ## Where a quest comes from
 *
 * No realm database has a Quests table — both of the ones on this machine hold
 * the same ten tables and none of them is one. What they do hold is `TBInfo`,
 * the **text blocks**: 4,355 of them in Paradigm, each a line of colon-
 * separated opcodes that the server runs when a player says something to an
 * NPC. `Textblocks/TextBlockPart.cs` implements 47 of them, and between the
 * gates and the rewards they state a quest completely:
 *
 *     goodaligned -51 801 : testability 126 5 : checkability 126 5 :
 *     checkitem 622 3208 : takeitem 622 : giveability 126 6 :
 *     giveitem 642 : giveitem 974 : addexp 150000 : text 354
 *
 * That is one step of the good-alignment quest, asked of Chancellor Annora:
 * *be good, be exactly at rank 5, be carrying item 622; hand it over, take
 * rank 6, two items and 150,000 experience.*
 *
 * **And the steps chain.** `giveability 126 6` is what the next step's
 * `checkability 126 6` demands, so walking the blocks backwards from every
 * reward assembles the whole quest in order. That is the derivation this file
 * exists for, and it is why a quest here is a *list of steps* rather than a
 * paragraph somebody wrote.
 *
 * ## What this is not
 *
 * It is not a walkthrough. The realm states what a step demands and what it
 * pays; it does not state where the item comes from or why anybody wants it,
 * and the flavour text lives in a message table this does not read. A step
 * that says *carry item 622 to Chancellor Annora* is the whole of what the
 * data supports, and inventing the rest would be the confidently-wrong answer
 * this project refuses everywhere else.
 *
 * ## Progress is read where the realm prints it, and stated where it does not
 *
 * The counters are server-side abilities and **no sentence ever reports one**,
 * so nothing the server volunteers says which step a character is on. One
 * command does: GreaterMUD's `abil` prints every ability the character has,
 * summed exactly as `checkability` sums it, quest counters included
 * (`CharacterState.abilities`, 2026-09-07). Where a listing has been read the
 * book draws the realm's own number; where none has — a realm with no such
 * command, or one before the first `abil` — the rank on the track is the
 * player saying *I have got this far*, which is a preference kept beside the
 * card's filters and never a claim about the wire. Hiding a quest is the same
 * kind of statement and has no wire answer at all.
 *
 * The two are never merged. A statement from the server outranks a statement
 * from the player about the same fact, and the card says which it is drawing.
 */
// Type-only, so no value cycle: see `module-cycle.test.ts`.
import type { Denomination } from './character';

/**
 * One thing a step demands before the server will run it.
 *
 * Structured rather than composed into a sentence here, because the card wants
 * to filter on the parts — *which quests can my race do* is a question about
 * `race`, not about the words a description happened to use.
 */
export type QuestGate =
  /**
   * The quest counter itself, or any other granted ability.
   *
   * `checkability` is `sum >= atLeast`, `testability` is `sum <= atMost`, and
   * a step that states both is asking for an **exact** rank — which is how
   * every chained quest is written, so that doing step five twice is not a way
   * to skip step six.
   */
  | { kind: 'ability'; id: number; name?: string; atLeast?: number; atMost?: number }
  /** `failability` — the step runs only for somebody who has never had it. */
  | { kind: 'ability-absent'; id: number; name?: string }
  | { kind: 'item'; id: number; name?: string }
  | { kind: 'item-absent'; id: number; name?: string }
  | { kind: 'spell'; id: number; name?: string }
  | { kind: 'class'; id: number; name?: string }
  | { kind: 'race'; id: number; name?: string }
  | { kind: 'level'; min?: number; max?: number }
  /**
   * `goodaligned L` is `alignment <= L` and `evilaligned L` is `>= L`.
   *
   * Lower is better on this lineage, which is why the two read backwards from
   * their names. Kept as the server's own numbers rather than as the words
   * *good* and *evil*, because a realm is free to put the line anywhere.
   */
  | { kind: 'alignment'; atMost?: number; atLeast?: number }
  | { kind: 'lives'; atLeast: number }
  | { kind: 'price'; amount: number };

/** One thing a step hands over when it runs. */
export type QuestReward =
  | { kind: 'exp'; amount: number }
  | { kind: 'item'; id: number; name?: string }
  | { kind: 'coins'; amount: number; coin: Denomination }
  /** `giveability` sets (and only upward); `addability` adds to what is there. */
  | { kind: 'ability'; id: number; name?: string; value: number; mode: 'set' | 'add' }
  | { kind: 'spell'; id: number; name?: string }
  | { kind: 'lives'; amount: number }
  /** `addevil` — a shift along the alignment axis, negative being good. */
  | { kind: 'alignment'; amount: number };

/**
 * Where an item a step demands can be got, as the realm's own indexes state it.
 *
 * Joined onto the step in main (`WorldGraph.quests`) rather than built into the
 * world file: both halves — which shops stock an id, which monsters drop a name
 * — are already on disk, and writing the answer down a third time would be a
 * copy to keep in step with them.
 *
 * **Absence is the common case and is drawn as silence.** The realm's own
 * indexes place 29 of the shipped realm's 79 item requirements — 24 on a
 * monster, 7 in a shop — and the card adds 14 more off the quest's own chain.
 * The rest name the item and stop, which is the same refusal `localMap` makes
 * about a key with no known source: a guess about where to find a quest item
 * is worse than an admission.
 */
export interface QuestSource {
  id: number;
  /** Shops known to stock it, by name. */
  shops?: string[];
  /** Monsters known to drop it, by name. */
  mobs?: string[];
}

/**
 * One route through a step, where the realm writes several.
 *
 * A block holds one **line per class** on the long chains, and each line is a
 * complete alternative: a Warrior's gate and a Warrior's reward, then a Mage's,
 * then a Thief's. They used to be unioned into the step, which said *be a
 * Warrior and a Witchunter*, *be level 22 and level 20*, and *take all fifteen
 * classes' perks* — a wrong answer rather than merely a long one.
 *
 * A way carries only what its route adds: what every route shares stays on the
 * step, so a step with one route has no `ways` and reads exactly as before.
 */
export interface QuestWay {
  needs: QuestGate[];
  takes: Array<{ id: number; name?: string }>;
  gives: QuestReward[];
}

/** One step of a quest: what to say, to whom, and what it costs and pays. */
export interface QuestStep {
  /** The text block, which is this step's identity and never changes. */
  block: number;
  /** The NPC that answers, where the block could be traced back to one. */
  who?: string;
  /** Where that NPC is, as `map/room`. */
  room?: string;
  /**
   * That room's own name, where the realm has one.
   *
   * `map/room` is an address and not somewhere anybody can picture; the name is
   * what makes the walk control readable. Joined in main beside the sources,
   * for the same reason — the room index is already on disk.
   */
  place?: string;
  /**
   * The words that reach this step — `ask return`, `ask box`.
   *
   * Several, because a keyword table routinely lists synonyms onto one block
   * (Annora answers `return`, `Markus`, `box` and `quest` with the same one),
   * and the player only needs whichever they can remember.
   */
  say: string[];
  /** The rank of the quest counter this step advances **from**, when it says. */
  from?: number;
  /** And the rank it advances **to**. */
  to?: number;
  /** What **every** route through this step demands. */
  needs: QuestGate[];
  /** Items the step consumes — `takeitem`. What every route consumes. */
  takes: Array<{ id: number; name?: string }>;
  /** What every route pays. */
  gives: QuestReward[];
  /**
   * The routes that differ — a class each, with its own price and its own
   * reward. Absent, and not empty, where the realm writes one way through.
   */
  ways?: QuestWay[];
  /**
   * Where the items this step demands can be got, for the ones the realm places
   * somewhere. Absent for a step that demands none, and short of the step's own
   * item list wherever the realm does not say.
   */
  sources?: QuestSource[];
}

/** A quest: one counter, and the steps that advance it, in order. */
export interface Quest {
  /** The ability id the realm counts this quest with. */
  id: number;
  /** The realm's own name for that counter, where `abilities.ts` has one. */
  name: string;
  steps: QuestStep[];
}

/**
 * Which side of the alignment line a quest sits on, from its own gates.
 *
 * Read off the steps rather than stored, because it is a *summary* of what the
 * realm states and the realm states it per step. A quest whose steps disagree
 * — one good gate and one evil — is `any` rather than either, which is the
 * refusal this project makes everywhere a lookup is not unanimous.
 */
export type QuestSide = 'good' | 'neutral' | 'evil' | 'any';

/**
 * Which band **one gate** restricts a character to, or null if it is not about
 * alignment at all.
 *
 * `goodaligned L` is `alignment <= L` and `evilaligned L` is `>= L`, so a gate
 * with one bound names an *end* of the axis and a gate with **both** names the
 * span between them — which is the middle, whatever numbers a realm chooses to
 * put its boundaries at. That is structural and not a guess: the client never
 * needs to know where the lines are to know that between them is between them.
 *
 * It was read as two independent flags, and a two-sided gate therefore set
 * *both* — so the realm's own `NeutralQuest`, whose every step states
 * `alignment >= -50 and <= 29`, came out as **`any`** and the book told a
 * paladin they could do it. Two of the three great chains classified, one of
 * them wrongly, and the reassuring way round.
 */
function gateSide(gate: QuestGate): QuestSide | null {
  if (gate.kind !== 'alignment') return null;
  const low = gate.atLeast !== undefined;
  const high = gate.atMost !== undefined;
  if (low && high) return 'neutral';
  if (high) return 'good';
  if (low) return 'evil';
  return null;
}

export function questSide(quest: Quest): QuestSide {
  const bands = new Set<QuestSide>();
  for (const step of quest.steps) {
    // Routes too: a realm is free to put the alignment gate on the per-class
    // line rather than on the line every class shares.
    for (const way of [step, ...(step.ways ?? [])]) {
      for (const gate of way.needs) {
        const band = gateSide(gate);
        if (band !== null) bands.add(band);
      }
    }
  }
  // Unanimous or nothing: a quest whose steps name two different bands is one
  // the realm does not restrict to either, which is the refusal this project
  // makes everywhere a lookup does not agree with itself.
  const only = [...bands];
  return only.length === 1 ? (only[0] ?? 'any') : 'any';
}

/**
 * The lowest level any step of a quest demands, or null when none does.
 *
 * The lowest rather than the first step's: the steps are in counter order and
 * a realm is free to put the level gate on a later one, so *what level do I
 * need to start* and *what does this quest ask of me* are different questions
 * and this is the second.
 */
export function questLevel(quest: Quest): number | null {
  let lowest: number | null = null;
  for (const step of quest.steps) {
    // Every route, not only what all of them share. The realm states a level
    // per class on the routed steps, so a book that read `needs` alone drew
    // `Smash`, `PerfectStealth` and `Meditate` — each gated at 20 to 27 on
    // every one of their routes — as quests with no level at all. Unknown
    // rendered as the reassuring answer, which is the one this project
    // refuses: a level-1 character would have walked to a master assassin.
    for (const way of [step, ...(step.ways ?? [])]) {
      for (const gate of way.needs) {
        if (gate.kind !== 'level' || gate.min === undefined) continue;
        if (lowest === null || gate.min < lowest) lowest = gate.min;
      }
    }
  }
  return lowest;
}

/** What the whole quest pays in experience, added across its steps. */
export function questExperience(quest: Quest): number {
  let total = 0;
  for (const step of quest.steps) {
    for (const reward of step.gives) if (reward.kind === 'exp') total += reward.amount;
  }
  return total;
}
