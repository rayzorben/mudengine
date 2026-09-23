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
 * The three are never averaged, and which one answered is always said. A
 * statement from the server outranks a statement from the player about the
 * same fact — but only about the moment it was made: an `abil` is a
 * photograph, and a step the client watched run **after** it is the newer
 * evidence about a counter the server only moves upward. `questReading` is
 * that rule, in one place, for the card and for main alike.
 */
// Type-only, so no value cycle: see `module-cycle.test.ts`.
import type { AbilitySums, Denomination } from './character';
import type { ApproachGate, ItemHandover } from './world';

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
  | { kind: 'price'; amount: number }
  /**
   * `testskill <stat> <value>` — a roll, not a gate: the chance is the stat
   * less the value, clamped to 2..98% (`TextBlockPart.cs:1139`), so with
   * Intellect 45 against 30 the red book answers one try in seven. `stat` is
   * the script's own word (`intellect`, `perception`, `strength`).
   */
  | { kind: 'skill'; stat: string; value: number };

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
  /**
   * Where one of the realm's own scripts hands it over — format 39.
   *
   * The third answer, and the one the two indexes above could never give: a
   * quest component is not stocked and not on a drop list, it is `giveitem` in
   * the block a monster's death or a cave's own word runs. Three of the four
   * things PhoenixQuest sends a player to fetch were placed by nothing at all
   * until this. Carried from `WorldItem.from`, which the converter wrote.
   *
   * Each handover carries its own `approach`, because two handovers of one
   * item are two places and the way into each is its own question.
   */
  from?: ItemHandover[];
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
  /**
   * The monster whose **death** runs this step, where that is how it is done.
   *
   * Not everything a quest asks of you is said to somebody. A boss's
   * `DeathSpell` routinely ends in a text block, and that block is a step like
   * any other — gates, a counter and a reward — so *kill the dread mystic* is
   * the act, and there is nothing to say and nobody to say it to.
   *
   * Exclusive with `who` by construction (`indexQuests.ts` walks one root per
   * block), and it carries an empty `say`, so `stepSaid` can never match a
   * typed line to one: no line the player types does this.
   */
  kill?: string;
  /** Where that NPC or monster is, as `map/room`. */
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
  /**
   * `adddelay N` — how long the server holds the rest of the block before
   * it runs (`ContinueTextblockCommand`, seconds). The runner waits this long
   * for the counter to move before it reads a refusal into silence.
   */
  delaySeconds?: number;
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
  /**
   * What the way to **this step's own room** demands be carried, where the
   * realm encloses it — `ApproachGate`, outermost frontier first.
   *
   * A step is *go there and say this*, and the realm routinely puts the there
   * behind a door: PhoenixQuest's last step is thrown into the Lake of Fire,
   * whose one entrance wants the basalt key the step before it hands over. 24
   * of each shipped world's steps are behind something, and the book named
   * none of it. Joined in main like `place` and `sources`, and absent for the
   * ordinary step in an open part of the realm.
   */
  approach?: ApproachGate[];
}

/**
 * One leg of the walk a step's several items add up to.
 *
 * `moves` is the walk from the **previous** leg's room, so the first is from
 * where the character was standing when the order was solved. Moves and not
 * the router's own figure: the order is chosen in the router's units — where a
 * lair, a hazard and a door this character cannot force are all priced — and
 * what the reader is shown is the number of times they press a direction,
 * which is `scatterMoves`' rule one card across.
 */
export interface ErrandLeg {
  /** What this leg fetches. Absent on the last, which is the step itself. */
  item?: { id: number; name?: string };
  /** Where it ends, as `map/room`, and that room's own name where it has one. */
  room: string;
  place?: string;
  moves: number;
}

/**
 * The order a step's several items are best fetched in — todo 01.
 *
 * A step that demands four things states them in the order its own opcodes
 * happen to run, which is nobody's walk: PhoenixQuest's four sundries are an
 * acid gland, unfertilized eggs, a double-terminated quartz and cave roots,
 * and the realm places them in four rooms that have nothing to do with that
 * list. So the card asks main to solve the errand instead — the shortest walk
 * from where the character is standing, through one place for each item, and
 * back to the step's own room.
 *
 * **It is a plan, not a reading**, and it goes stale the moment the character
 * moves: `from` is where it was solved from and the card says so, because a
 * figure that silently described somewhere else is the confidently-wrong
 * answer this project refuses everywhere.
 */
export interface QuestErrand {
  /** The step this orders, by the block that is its identity. */
  block: number;
  /** Where the walk starts, as `map/room`, and that room's own name. */
  from: string;
  fromPlace?: string;
  /**
   * The legs in walking order, the step's own room last where it has one.
   *
   * Short of the step's item list wherever the realm places a thing nowhere,
   * or nowhere this character can get to: `left` carries those, and they are
   * never given a position in a walk nobody could plan.
   */
  legs: ErrandLeg[];
  /** The whole walk, in moves — the legs' own figures summed. */
  moves: number;
  /** What could not be ordered, in the realm's own order, and why. */
  left: Array<{ id: number; name?: string; why: 'unplaced' | 'unreachable' }>;
  /**
   * Said instead of an order, where none could be solved at all.
   *
   * `HuntingAdvice.refusal`'s shape and for its reason: a card drawing nothing
   * cannot be told from a card that was never asked, and *why* is the half the
   * reader needs — the realm places none of these, or this character cannot
   * reach any of them from here.
   */
  refusal?: string;
}

/**
 * The items a step wants in the pack, and whether it keeps each.
 *
 * Here rather than on the card because the errand solver orders exactly this
 * list and the card draws exactly this list, and a step whose walk names a
 * fifth thing the rows above it do not is two readings of one fact.
 *
 * **The step's own, never a route's.** `WorldGraph.itemsDemanded` merges every
 * class's route, which is the right answer for *where does this come from* —
 * an item on one route is still an item somebody has to find. It is the wrong
 * answer for a walk: a Warrior does not fetch the Mage's component, and a
 * route's own items are drawn under the route that wants them. `item-absent`
 * is out for the plainer reason that there is nowhere to go for a thing the
 * step wants you **not** to be carrying.
 */
export function itemsBrought(step: QuestStep): Array<{ id: number; name?: string; hand: boolean }> {
  const wanted = new Map<number, { id: number; name?: string; hand: boolean }>();
  for (const gate of step.needs) {
    if (gate.kind !== 'item') continue;
    wanted.set(gate.id, {
      id: gate.id,
      ...(gate.name === undefined ? {} : { name: gate.name }),
      hand: false
    });
  }
  // `takeitem` keeps it and `checkitem` gives it back, so a thing stated by
  // both is handed over: the stronger claim wins, as it does on the card.
  for (const item of step.takes) {
    const held = wanted.get(item.id);
    const name = item.name ?? held?.name;
    wanted.set(item.id, { id: item.id, ...(name === undefined ? {} : { name }), hand: true });
  }
  return [...wanted.values()];
}

/**
 * The quest step a typed command reaches, if any — so the book can move as the
 * player plays rather than only when they spend an `abil`.
 *
 * **Both halves must be in the line**: the asker's name and one of the words
 * that reach the step. A keyword alone is far too loose — `quest`, `box` and
 * `return` are all real `say` entries and all things somebody says in
 * conversation — and the asker alone says nothing about *which* step. Requiring
 * the pair is what makes this safe enough to act on without a capture of what
 * a successful ask looks like on the wire.
 *
 * A step the realm traces to neither an asker nor a room is therefore never
 * matched, and that is the honest answer rather than a gap: with neither there
 * is nothing to anchor the keyword to. A step scripted onto a **room** anchors
 * on the room instead — see the case below.
 *
 * It says nothing about whether the ask **worked** — no capture establishes
 * what a refusal looks like, and inventing one is the thing this project
 * refuses. What it produces is the player's own action, which is why the card
 * ranks it under the realm's own count and beside the mark a player sets by
 * hand.
 */
/**
 * The words a realm's NPC title is built out of, which name nobody.
 *
 * Short and closed on purpose: this is not a stopword list for prose, it is the
 * handful of connectives that appear in `Annora the Healer` and its like. A
 * genuine three-letter name is still a name.
 */
const TITLE_WORDS = new Set(['the', 'and', 'for']);

export function stepSaid(
  quests: readonly Quest[],
  command: string,
  here: string | null = null,
  abilities: AbilitySums | null = null
): { quest: Quest; step: QuestStep } | null {
  const line = command.toLowerCase().trim();
  const words = new Set(line.split(/[^a-z0-9']+/).filter((word) => word.length > 0));
  if (words.size < 2) return null;

  const reached: Array<{ quest: Quest; step: QuestStep }> = [];
  for (const quest of quests) {
    for (const step of quest.steps) {
      const who = step.who?.trim().toLowerCase();
      /*
       * **A room is the other anchor** (todo 12, 2026-09-13). A step the realm
       * scripts onto a *room* has no asker to name — the altar answers `touch
       * gem` to whoever is standing on it — and the room is every bit as tight
       * a pair as a name: the phrase does nothing anywhere else, and the
       * client already knows where the character is. Without this the whole
       * kind was unmatchable, which is how a player did the Dark Druid quest
       * and the book said nothing.
       *
       * The **phrase**, not a word of it: a room's script answers `touch gem`,
       * and `gem` alone is a word somebody says while standing anywhere.
       */
      if (who === undefined || who.length === 0) {
        const room = step.room?.trim();
        if (room === undefined || here === null || room !== here) continue;
        const did = step.say.some((phrase) => {
          const key = phrase.trim().toLowerCase();
          return key.length > 0 && line === key;
        });
        if (did) reached.push({ quest, step });
        continue;
      }
      /*
       * The asker's name may be several words (`Annora the Healer`), and any
       * one of them standing in the line is the realm's own way of addressing
       * them — except the connectives, which anchor nothing: `say the return`
       * would otherwise reach a step it has nothing to do with.
       */
      const named = who
        .split(/\s+/)
        .some((part) => part.length > 2 && !TITLE_WORDS.has(part) && words.has(part));
      if (!named) continue;
      const said = step.say.some((word) => {
        const key = word.trim().toLowerCase();
        return key.length > 0 && words.has(key);
      });
      if (said) reached.push({ quest, step });
    }
  }
  return theOneReached(reached, here, abilities);
}

/**
 * The quest step a monster's death runs, if any — the other half of the book
 * moving as the character plays.
 *
 * A step whose owner is a **death** (`QuestStep.kill`) carries no words and no
 * asker, so `stepSaid` can never reach one: no line the player types does it,
 * and the client had nothing for the whole kind. Reported 2026-09-15 — the
 * dread mystic died in the Meditation Chamber, the Phoenix quest's second step
 * is exactly that kill, and the book stayed at one of nine.
 *
 * **The evidence is the monster's own name**, which is far tighter than the
 * asker-and-phrase pair `stepSaid` needs: 31 of Paradigm's 43 kill steps name a
 * monster no other step does, and the twelve that do not are the Good, Neutral
 * and Evil chains sharing a boss — which `countersMet` is what separates, as it
 * separates them where they share an asker. `name` is the realm's **row**
 * (`rowNameOf`), because the room prints `nasty dread mystic` and the step
 * names the row.
 *
 * **The room narrows and never refuses, which is the one place this differs
 * from `stepSaid`.** A step's room is where the realm *summons* that monster,
 * and a monster walks: it chases a player down a corridor and dies there, and
 * the step still runs, because the server casts the death spell wherever the
 * corpse is (`Mob.ApplyDeathSpell`). A typed phrase is the other way round —
 * the asker is not there, so the ask cannot have happened — which is why that
 * filter is a refusal and this one is a tiebreak.
 *
 * Like `stepSaid` it says nothing about whether the step's **gates** passed:
 * killing the dread mystic at rank nought runs nothing. That is what the card
 * ranking this under the realm's own count is for.
 */
export function stepKilled(
  quests: readonly Quest[],
  name: string,
  here: string | null = null,
  abilities: AbilitySums | null = null
): { quest: Quest; step: QuestStep } | null {
  const row = name.trim().toLowerCase();
  if (row.length === 0) return null;

  const reached: Array<{ quest: Quest; step: QuestStep }> = [];
  for (const quest of quests) {
    for (const step of quest.steps) {
      if (step.kill?.trim().toLowerCase() === row) reached.push({ quest, step });
    }
  }
  if (reached.length < 2) return theOneReached(reached, null, abilities);

  // The tiebreak, not a gate: a candidate elsewhere is only set aside while
  // one of them is standing where this death happened.
  const here_ = here?.trim();
  const inRoom =
    here_ === undefined || here_.length === 0
      ? reached
      : reached.filter((found) => (found.step.room?.trim() ?? here_) === here_);
  return theOneReached(inRoom.length > 0 ? inRoom : reached, null, abilities);
}

/**
 * Which of the steps a line could have reached it actually did.
 *
 * `stepSaid` used to take the first and stop, and the realm punishes that:
 * `ask old man prophecy` reaches four steps — the Good, Neutral and Evil
 * chains' shared old man in 17/2020, and the Phoenix chain's in the padded
 * cell at 9/1259 — so a player standing in front of the old man in the asylum
 * had the *Good* quest credited, at rank 25, and the Phoenix quest said
 * nothing. Reported 2026-09-15.
 *
 * Three narrowings, each of them a fact the realm states rather than a
 * preference, applied only while more than one step is left:
 *
 * - **Where the character is standing.** 200 of the shipped realm's 251 steps
 *   name their room, so this is the ordinary case and not a special one; a
 *   step whose room the realm names and the character is not in cannot have
 *   run. Nothing is excluded while the client cannot place the character,
 *   which is the one thing that must not turn into a guess. `stepKilled`
 *   passes no room and narrows by its own: a monster walks out of the room the
 *   realm summons it in, so there the room is a tiebreak and not a refusal.
 * - **The quest counters the realm has stated.** The Good, Neutral and Evil
 *   chains share an asker and a phrase in one room and are told apart by
 *   `failability` on each other plus an exact rank on their own — which is
 *   precisely what `abil` puts on the wire. Applied only to a *complete*
 *   listing, since an id an incomplete one omits is unknown rather than zero.
 * - **Agreement.** Two steps that name one quest and one rank are one answer,
 *   however many rows the realm wrote them on (`greasy thief`, `bishop`).
 *
 * What is left after that is a genuine ambiguity, and the book says nothing:
 * crediting one of several is the confidently wrong claim this client refuses
 * everywhere else, and it is worse here than silence because a counter walked
 * forward wrongly never walks back.
 */
function theOneReached(
  reached: ReadonlyArray<{ quest: Quest; step: QuestStep }>,
  here: string | null,
  abilities: AbilitySums | null
): { quest: Quest; step: QuestStep } | null {
  if (reached.length === 0) return null;
  let left = reached;

  if (here !== null) {
    const inRoom = left.filter((found) => {
      const room = found.step.room?.trim();
      return room === undefined || room === here;
    });
    // Empty means the realm puts every one of them somewhere else, so the line
    // reached none of them — a refusal, never a reason to fall back.
    if (inRoom.length === 0) return null;
    left = inRoom;
  }

  if (left.length > 1 && abilities !== null) {
    const met = left.filter((found) => countersMet(found.step, abilities));
    if (met.length > 0) left = met;
  }

  if (left.length === 1) return left[0]!;
  const first = left[0]!;
  const agree = left.every(
    (found) => found.quest.id === first.quest.id && found.step.to === first.step.to
  );
  return agree ? first : null;
}

/**
 * Whether the quest counters `abil` stated satisfy this step's own gates.
 *
 * `ability` and `ability-absent` only: those two are what the chained quests
 * are told apart by, and they are the two the listing states outright. An id a
 * **complete** listing does not name is zero (the coin rule, and
 * `AbilitySums`' own); an incomplete listing settles nothing, so it narrows
 * nothing.
 */
function countersMet(step: QuestStep, abilities: AbilitySums): boolean {
  if (!abilities.complete) return false;
  const sum = (id: number): number => abilities.sums[id] ?? 0;
  for (const need of step.needs ?? []) {
    if (need.kind === 'ability-absent') {
      if (sum(need.id) !== 0) return false;
      continue;
    }
    if (need.kind !== 'ability') continue;
    const held = sum(need.id);
    if (need.atLeast !== undefined && held < need.atLeast) return false;
    if (need.atMost !== undefined && held > need.atMost) return false;
  }
  return true;
}

/**
 * A rank this character was watched reaching, and **when** it was watched.
 *
 * The clock is the whole of why this is a record and not a number. Reported
 * 2026-09-15: a player with an `abil` from 8:44 in hand asked Morukai for the
 * components at 8:50, the mage took all four, and the book went on saying
 * *5 of 9* — because the listing outranked the observation unconditionally,
 * and an unconditional rank is a claim about *now* made out of a fact about
 * *then*. A listing is exact at the moment it is read and no later; an act
 * watched after it is the newer evidence about a counter the server only ever
 * moves upward. See `questReading`.
 */
export interface QuestSeen {
  /** The rank the watched step advances the counter to. */
  to: number;
  /** Epoch ms of the act — the line typed, or the death seen. */
  at: number;
}

/** What this character has been watched doing about each quest, by counter id. */
export type QuestWatched = Readonly<Record<number, QuestSeen>>;

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

/**
 * Whether a rank leaves this step behind.
 *
 * `to <= rank`, never *before this one in the list*: the realm writes
 * alternatives as separate steps with the same `to` — two NPCs who each
 * advance the counter from 1 to 2 — and doing either does both. Ranking by
 * position would grey one and leave its twin looking outstanding.
 *
 * **And the counter has to be held at all, which no rank can say.**
 * `giveability 186 0` is the realm's spelling of a *flag*: a counter granted
 * at rank **zero**, gated by `failability`, which fails for anybody who has
 * ever had it. A complete listing that does not name an id reads it as zero,
 * correctly — that is the sum the server gates on — so `to <= rank` marked
 * such a step done for every character alive, and the book told a player who
 * had never met the dying master assassin that they had PerfectStealth. It is
 * the one step of that shape in each shipped realm, which is why it went three
 * months unseen. `held` is the other half of what a source states — the
 * counter was named, at whatever value — and it is what tells a granted zero
 * from an absent one. Reported 2026-09-15.
 */
export function stepDone(step: QuestStep, rank: number | null, held: boolean): boolean {
  if (step.to === undefined || !held) return false;
  return rank !== null && step.to <= rank;
}

/**
 * How many steps a rank leaves behind.
 *
 * One arithmetic, read by the row's chip and by the track's own count, so the
 * figure in the table and the greying on the chain cannot disagree about the
 * same quest.
 */
export function stepsDone(quest: Quest, rank: number | null, held: boolean): number {
  return quest.steps.filter((step) => stepDone(step, rank, held)).length;
}

/**
 * What the client knows about the character a book is being read for.
 *
 * Every field nullable: a card is drawn before the stat sheet arrives, and an
 * unknown class must bar nothing at all.
 */
export interface QuestDoer {
  className: string | null;
  race: string | null;
  level: number | null;
  /**
   * What `abil` stated, for the gates the realm writes on **other** counters.
   *
   * The three great chains demand you have never started either of the other
   * two (`failability 127`, `failability 128`), and that is the one bar in the
   * data that is genuinely forever — a character who took a rank of
   * NeutralQuest can never do GoodQuest, at any level, in any class. It is
   * read exactly as `countersMet` reads the same gates: a **complete** listing
   * enumerates, so an id it does not name is zero, and an incomplete one
   * settles nothing.
   */
  counters: AbilitySums | null;
}

/** Where the character stands in a quest, for deciding what is next. */
export interface QuestStanding {
  rank: number | null;
  /** Whether the counter is held at all. See `stepDone`. */
  held: boolean;
}

/** Where the character stands, and **which** of the three readings said so. */
export interface QuestReading extends QuestStanding {
  /** True where the rank is the realm's own listing. */
  observed: boolean;
  /** True where it is what this character was watched doing. */
  watched: boolean;
  /** When the realm said so. Null where the number is not the realm's. */
  at: number | null;
}

/**
 * How far through one quest a character is, out of the three things that say.
 *
 * **The listing is exact at the moment it was read, and only then.** Nothing
 * on the wire announces a counter moving, so `abil` is a photograph: it
 * outranks a guess, it outranks a note the player left themselves, and it does
 * **not** outrank the client watching the very next step happen. Read as
 * permanently authoritative it gave the failure this function exists for — a
 * listing at rank 5, an ask that took the four components, and a book that
 * went on saying *5 of 9* until somebody typed `abil` again.
 *
 * So an observation wins on two conditions and both are structural: it was
 * made **after** the listing, and it is **higher** than it, because
 * `giveability` is a set that only climbs and a step already behind the
 * listing is a step the listing has already counted. A newer listing puts the
 * realm's own number back, which is the correction path — the observation
 * says the player acted, never that the server agreed.
 *
 * The remembered mark is last and unchanged: it answers only where neither of
 * the other two has, which is a realm with no such command, or one before the
 * first listing. Written here rather than in the card because main asks the
 * same question of the same three facts (`asksHere`), and a book and a chip
 * that disagreed about one quest would be two readings of one counter.
 */
export function questReading(
  quest: number,
  counters: AbilitySums | null,
  watched: QuestWatched | null,
  marked: number | null = null
): QuestReading {
  /*
   * An id a **complete** listing does not name is a counter at zero — the
   * containers are printed whole, so absence is the server holding no
   * modifier. An id an **incomplete** one does not name is merely unknown, and
   * falls through, which is why this is decided per quest rather than per
   * listing: half a listing still settles every counter it printed.
   */
  const listed = counters === null ? undefined : counters.sums[quest];
  const stated = listed ?? (counters?.complete === true ? 0 : null);
  const seen = watched?.[quest];
  const fresher =
    seen !== undefined && (stated === null || (seen.at > (counters?.at ?? 0) && seen.to > stated));

  if (fresher) {
    // Watching a step run is watching the counter be granted, so it is held
    // whatever the listing did or did not name.
    return { rank: seen.to, held: true, observed: false, watched: true, at: null };
  }
  if (stated !== null) {
    return {
      rank: stated,
      // Zero is a rank the realm grants, so the number alone cannot say this:
      // the listing naming the id is what does. See `stepDone`.
      held: listed !== undefined,
      observed: true,
      watched: false,
      at: counters?.at ?? null
    };
  }
  const rank = seen?.to ?? marked ?? null;
  return { rank, held: rank !== null, observed: false, watched: seen !== undefined, at: null };
}

/**
 * The listing, brought up to date by what has been watched since it was read.
 *
 * The counters are what every *other* reading of a step is narrowed and
 * refused by (`countersMet`, `countersRefuse`, `theOneReached`), and those
 * readings happen while the player plays — so handing them the raw listing
 * asks them a question about a photograph. A chain answered three keywords in
 * a row moves its counter three times and `abil` says none of it.
 *
 * Only forward and only past what the listing said, exactly as `questReading`
 * decides the same thing for the card, and the listing's own clock is kept:
 * this is the same reading with the same freshness, not a new statement.
 */
export function countersNow(
  counters: AbilitySums | null,
  watched: QuestWatched | null
): AbilitySums | null {
  if (counters === null || watched === null) return counters;
  let sums: Record<number, number> | null = null;
  for (const [key, seen] of Object.entries(watched)) {
    const id = Number(key);
    if (!Number.isInteger(id) || seen.at <= counters.at) continue;
    const held = counters.sums[id] ?? (counters.complete ? 0 : undefined);
    if (held !== undefined && seen.to <= held) continue;
    sums ??= { ...counters.sums };
    sums[id] = seen.to;
  }
  return sums === null ? counters : { ...counters, sums };
}

/**
 * What stops this character taking a quest's next step, as the realm states it.
 *
 * Four kinds, and they are what the realm gates on that the client holds a
 * matching fact for. **Alignment is deliberately not one**: the gate is a
 * number and the only standing the client has is the `who` roster's *word*,
 * and `QuestGate` has already written down that a realm is free to put the
 * line anywhere — so placing the word on the realm's axis would be the guess
 * this project refuses. The card's own side chips are where that question is
 * asked, by the player, who knows.
 *
 * `level` is *not yet* and the other three are *not ever*, and the card words
 * the two apart.
 */
export type QuestBar =
  | { kind: 'class'; names: string[] }
  | { kind: 'race'; names: string[] }
  /** A counter the step demands you have never had, and this character has. */
  | { kind: 'counter'; names: string[] }
  | { kind: 'level'; level: number };

/**
 * The realm's word and the server's word for one thing, compared as words.
 *
 * An empty string is nobody's class, and it is reachable: the sheet's class is
 * a trimmed regex group. `ownWay` guards it on the same field for the same
 * reason, and answering *false* here would bar every class-gated quest in the
 * book off a blank.
 */
function sameWord(realm: string | undefined, mine: string | null): boolean {
  if (realm === undefined || mine === null) return false;
  const word = mine.trim();
  if (word.length === 0) return false;
  return realm.trim().toLowerCase() === word.toLowerCase();
}

/** Whether the client holds this character's own word for something. */
function stated(mine: string | null): boolean {
  return mine !== null && mine.trim().length > 0;
}

/**
 * The first thing in one list of gates that shuts this character out, or null.
 *
 * What cannot be changed comes before what can — class, race and a counter
 * already spent, then the level, which is the only one a character walks out
 * of. A gate the realm names no word for settles nothing, and neither does an
 * unknown class, race or level: unknown is never the reassuring answer, and
 * here the reassuring answer would be the **bar**, which sinks a quest the
 * character may well be able to do.
 *
 * `counter` is the quest's own id, and its own gates are skipped: every step
 * of a chain states `checkability` and `failability` on the counter it
 * advances, which is the bookkeeping that makes it a chain and never a reason
 * anybody is shut out of it.
 */
function gatesBar(needs: readonly QuestGate[], who: QuestDoer, counter: number): QuestBar | null {
  const sums = who.counters;
  for (const gate of needs) {
    if (gate.kind === 'class' && gate.name !== undefined && stated(who.className)) {
      if (!sameWord(gate.name, who.className)) return { kind: 'class', names: [gate.name] };
    }
    if (gate.kind === 'race' && gate.name !== undefined && stated(who.race)) {
      if (!sameWord(gate.name, who.race)) return { kind: 'race', names: [gate.name] };
    }
    // Only a complete listing enumerates, so only a complete one can say that
    // a counter the step demands you have never had is one you have.
    if (gate.kind === 'ability-absent' && gate.id !== counter && sums !== null && sums.complete) {
      if ((sums.sums[gate.id] ?? 0) !== 0) {
        return { kind: 'counter', names: [gate.name ?? String(gate.id)] };
      }
    }
  }
  for (const gate of needs) {
    if (gate.kind !== 'level' || gate.min === undefined || who.level === null) continue;
    if (who.level < gate.min) return { kind: 'level', level: gate.min };
  }
  return null;
}

/**
 * Folded to one reason per kind: the names unioned, the lowest level kept.
 *
 * The lowest, because a level bar is the one a character walks out of and the
 * figure worth drawing is the next rung that changes anything — not the
 * highest, which is what finishing would cost and is a different question.
 */
function foldBars(bars: readonly QuestBar[]): QuestBar[] {
  const names: Record<'class' | 'race' | 'counter', string[]> = {
    class: [],
    race: [],
    counter: []
  };
  let level: number | null = null;
  for (const bar of bars) {
    if (bar.kind === 'level') {
      level = level === null ? bar.level : Math.min(level, bar.level);
      continue;
    }
    for (const name of bar.names) if (!names[bar.kind].includes(name)) names[bar.kind].push(name);
  }
  const folded: QuestBar[] = [];
  for (const kind of ['class', 'race', 'counter'] as const) {
    if (names[kind].length > 0) folded.push({ kind, names: names[kind] });
  }
  if (level !== null) folded.push({ kind: 'level', level });
  return folded;
}

/**
 * Several ways of being shut, folded to the one nearest to being open.
 *
 * Wherever the realm writes alternatives — the routes through a step, or the
 * steps that share a rank — the character only has to get past **one** of
 * them, so the softest reason is the answer and a level is the only one they
 * walk out of. `Meditate` writes eleven class lines and the reader's own gated
 * at 27, and collecting every alternative's reason said *Cleric, Priest,
 * Missionary … only · needs level 27* to a Paladin whose own line wants
 * nothing from them but the levels.
 */
function softest(bars: readonly QuestBar[]): QuestBar[] {
  const levels = bars.filter((bar) => bar.kind === 'level');
  return foldBars(levels.length > 0 ? levels : bars);
}

/**
 * What shuts this character out of one step, taking its routes as alternatives.
 *
 * The shared gates first — those hold whichever route is taken — and then the
 * routes, of which one being open is enough. Where none is, every route's own
 * reason is collected and `softest` decides between them: a step whose fifteen
 * class lines are fifteen different classes shuts a sixteenth by naming all
 * fifteen, which is the useful sentence rather than *Warrior only* fourteen
 * times.
 */
function stepBars(step: QuestStep, who: QuestDoer, counter: number): QuestBar[] {
  const shared = gatesBar(step.needs, who, counter);
  if (shared !== null) return [shared];
  const ways = step.ways ?? [];
  if (ways.length === 0) return [];
  const bars = ways.map((way) => gatesBar(way.needs, who, counter));
  if (bars.some((bar) => bar === null)) return [];
  return softest(bars.filter((bar): bar is QuestBar => bar !== null));
}

/**
 * Whether a step is something the client can tell a player to go and do.
 *
 * The three owners `indexQuests` walks — an asker, a room, a death — and a
 * step with none of them is a block whose owner the traversal never found.
 * The card already draws such a step with no action line and `stepSaid` never
 * matches one, and this is the same reading in a third place.
 *
 * It is load-bearing here rather than cosmetic. The realm routinely writes the
 * *grant* in its own block at the end of a chain — `Smash`'s second step is
 * `failability 32 : giveability 32 1`, called from the `text 2949` that ends
 * the first step's own lines — so the traversal builds it as a second step at
 * the same rank, gated by nothing at all. Counted as an alternative it opened
 * every such quest to everybody: a level-4 warrior was told they could go and
 * `Smash`, whose one real step wants level 22 of them.
 */
function actable(step: QuestStep): boolean {
  if (step.kill !== undefined || step.room !== undefined) return true;
  return step.who !== undefined && step.who.trim().length > 0;
}

/**
 * What stops this character getting on with a quest, or nothing where nothing
 * does.
 *
 * **The question is about the next step, not about the whole chain**, and that
 * is the whole of the arithmetic here. A quest is a counter climbing one rank
 * at a time, so what a reader wants to know is whether there is something to
 * do *now*; a gate five ranks ahead is a fact about that step, which the track
 * states where it belongs. Read as a claim about the chain, `GoodQuest` — whose
 * first rank asks nothing but that you have started neither of the other two —
 * came out sunk and dimmed for a level-1 character, saying *needs level 10*,
 * which is rank four's gate and no reason at all not to go and start it. All
 * three of the realm's great chains did, in both shipped worlds, from connect
 * until level 60.
 *
 * So: the ranks in order, the first one not already behind this character, and
 * what shuts them out of that. **Steps that share a rank are alternatives** —
 * `stepDone`'s own rule read the other way round — so a rank two askers advance
 * is open if either of them is, and `softest` decides between their reasons.
 *
 * Empty means nothing **known** stops them, which is the answer for a
 * character whose sheet has not arrived, for one who qualifies, and for one who
 * has finished: the card draws the quest plainly in all three, because the
 * alternative is a book that dims on connect and fills in as the sheet lands.
 */
export function questBars(quest: Quest, who: QuestDoer, standing: QuestStanding): QuestBar[] {
  const ranks = new Map<number, QuestStep[]>();
  for (const step of quest.steps) {
    // Every step of both shipped worlds states its rank — `indexQuests` builds
    // one only from a line that grants — and one that did not would be nobody's
    // alternative and could never be behind anybody, so it decides nothing.
    if (step.to === undefined) continue;
    const group = ranks.get(step.to);
    if (group === undefined) ranks.set(step.to, [step]);
    else group.push(step);
  }

  for (const rank of [...ranks.keys()].sort((a, b) => a - b)) {
    // `stepDone`'s arithmetic, asked about a rank rather than about a step.
    if (standing.held && standing.rank !== null && rank <= standing.rank) continue;
    const acts = (ranks.get(rank) ?? []).filter(actable);
    // A rank written only in steps the client cannot place is one it can say
    // nothing at all about, which is a refusal and never a bar.
    if (acts.length === 0) return [];
    const bars = acts.map((step) => stepBars(step, who, quest.id));
    if (bars.some((found) => found.length === 0)) return [];
    return softest(bars.flat());
  }
  return [];
}

/**
 * A place a plan names: the realm's address, and its name where it has one.
 */
export interface PlanPlace {
  room: string;
  place?: string;
}

/**
 * How a plan proposes to get one item a step needs, from the realm's own
 * indexes and nothing else.
 *
 * The same four answers `sourceNodes` draws on the card, made a closed union
 * so the plan and the executor that will one day carry it read one fact: a
 * shop is walked to and bought from, a monster is fought for it, a script is
 * asked or told, an earlier step of this chain hands it over. `unplaced` is
 * the fifth and is the refusal, never a guess.
 */
export type PlanSource =
  | { how: 'carried' }
  | {
      how: 'buy';
      shops: string[];
      at?: PlanPlace;
      /** Moves out of the way to the counter and back onto the leg (`BuyingPlace.detour`). */
      detour?: number;
      /**
       * What that counter charges for one, in copper before charm — the
       * realm's own arithmetic (`WorldGraph.priceAt`). Absent where the realm
       * file does not state the coin.
       */
      copper?: number;
    }
  | { how: 'kill'; mob: string; at?: PlanPlace }
  | { how: 'ask'; who: string; say?: string; at?: PlanPlace }
  | { how: 'said'; say: string; at?: PlanPlace }
  | { how: 'earlier'; rank: number }
  | { how: 'unplaced' };

/** One item a plan step gathers before its act, and how. */
export interface PlanItem {
  id: number;
  name?: string;
  /** `packHolds`' three answers: in the pack, not, or nobody has listed it. */
  held: boolean | null;
  /** `takeitem` — handed over and kept by the step. Else only carried. */
  hand: boolean;
  source: PlanSource;
  /**
   * How many, where the plan buys a consumable against a spell on the way
   * (`tuning.world.hazardSupplyCount`). Absent means one, or a thing that is
   * not spent.
   */
  count?: number;
  /**
   * The room spell this is fetched against, by name — a supply the *way*
   * wants rather than the step, which is why it is drawn as one.
   */
  stops?: string;
  /**
   * The floor from the character's own stock list, where this row is a
   * top-up rather than something the quest wants (`automation.supplies`).
   *
   * `count` is the list's maximum and is what the plan buys to; this is its
   * minimum, and reaching it is enough — a counter that had four torches
   * when the plan wanted six has still done the job.
   */
  stock?: number;
}

/**
 * What a plan step does once its items are in hand — the three owners a step
 * can have, as `askWords` draws them.
 */
export type PlanAct =
  | { verb: 'ask'; who: string; say: string }
  | { verb: 'say'; phrase: string }
  | { verb: 'kill'; mob: string };

/**
 * A fact the realm states that would stop the plan being carried unattended.
 *
 * Computed, never guessed: an item the realm places nowhere, a room the
 * router cannot reach from the step before, a spell on the way. A hazard is
 * named with what settles it — `safeWith` is an item in the pack or on the
 * plan's own `Get` rows that the realm says stops the spell, and a hazard
 * the converter could not read (`unread`) is still named, because an unread
 * hazard is one the client cannot price and so cannot promise to survive. A
 * spell that only summons is scenery here and not named at all. A
 * `corridor` is a spell the way *in* puts on the character — the dive into
 * the underwater passage — with the rooms to cross before the way out lifts
 * it: nothing stops it, and the answer is to keep moving.
 */
export type PlanSnag =
  | { kind: 'unplaced'; item: string }
  | { kind: 'unreachable'; reason: string }
  | {
      kind: 'hazard';
      spell: string;
      rooms: number;
      unread: boolean;
      /** Whether it can move the character off the route. */
      moves: boolean;
      needs: string[];
      safeWith?: string;
    }
  | {
      kind: 'corridor';
      spell: string;
      /** Rooms under it: to the exit that lifts it, or to the leg's end where none does. */
      rooms: number;
      /** Whether this leg reaches the exit that lifts it; false is a leg that ends inside. */
      ends: boolean;
      ticks?: number;
      then?: string;
    };

/** One step of a plan: gather these, go there, do this. */
export interface PlanStep {
  block: number;
  /** Null where the realm traced the step to nobody, nowhere and no death. */
  act: PlanAct | null;
  items: PlanItem[];
  /** Where the act happens, where the realm names a room. */
  at?: PlanPlace;
  /**
   * Whether the router found a way from the previous step's room.
   *
   * Null where either end is unplaced — a step whose room the realm does not
   * name, or a character nobody has placed — which is *unknown* and never
   * *no*.
   */
  reachable: boolean | null;
  /**
   * The route's own steps plus the detour to every counter this leg buys at.
   * What a kill or an ask on the way costs is not priced here.
   */
  moves?: number;
  snags: PlanSnag[];
  /**
   * The roll the step makes, where it makes one (`stepRoll`): a step that
   * can fail and be asked again. `chance` is the odds of one try in percent
   * off this character's sheet (`rollChance`), absent where the stat is
   * unread or is not one the sheet prints.
   */
  roll?: { stat: string; value: number; chance?: number };
}

/**
 * The plan to reach one step of a quest from where the character stands,
 * solved by main (`SessionManager.questPlan` over `WorldGraph.planStep`) and
 * drawn by the card.
 *
 * It is *steps*, never rooms: the walk between two acts is one figure, and
 * the route panel is where the rooms are. `fromRank` is where the counter
 * stood when it was solved, so a plan drawn against a later listing says so.
 */
export interface QuestPlan {
  block: number;
  /** Absent where nobody has placed the character; every step is then unpriced. */
  from?: string;
  fromPlace?: string;
  /** The rank the plan starts after, where a listing or a mark stated one; else null. */
  fromRank: number | null;
  /**
   * Whether anything stated the counter at all — a listing naming it, a
   * complete listing not naming it (which is zero), or the player's mark.
   * False with `fromRank` null is *nobody has read a listing*, which the head
   * says rather than calling it the start.
   */
  stated: boolean;
  steps: PlanStep[];
  /** True where every step's route exists; false where any is blocked; null where any is unknown. */
  reachable: boolean | null;
  moves: number;
  /** What the plan's counters cost and where the cash comes from; absent where it buys nothing. */
  cash?: PlanCash;
}

/**
 * What the plan spends at its counters, against the purse and the vaults the
 * character's record names (todo 00). The run draws cash one purchase at a
 * time (`Supplies`); this is the same question asked of the whole plan, so the
 * card can say before the press that a run would stand at a counter. Read by
 * the card alone: the run's own refusal is each purchase's.
 */
export interface PlanCash {
  /** Copper, charm applied, over every row the realm prices and the pack lacks. */
  owed: number;
  /** Rows bought whose price the realm does not state: `owed` is then a floor. */
  unpriced: number;
  /** The purse in copper, or null where no listing has counted it. */
  purse: number | null;
  /** The vault nearest the first counter that holds what the purse lacks, where one is on record. */
  bank?: { name: string; room: string; place: string; copper: number };
  /** The purse is short and no vault on record holds the rest. */
  short: boolean;
}

/**
 * The roll a step makes, where it makes one — the first `skill` gate on the
 * step's own line. A step's roll is on the step, never on a route: the realm
 * writes the red book's one line, and a roll per class would be a shape
 * neither shipped realm has.
 */
export function stepRoll(step: QuestStep): { stat: string; value: number } | null {
  for (const gate of step.needs) {
    if (gate.kind === 'skill') return { stat: gate.stat, value: gate.value };
  }
  return null;
}

/**
 * The chance one try passes a `testskill` roll, in percent, or null where the
 * stat is unread. The server's own arithmetic (`TextBlockPart.cs:1235`): the
 * stat less the value, clamped between 2 and 98, against a roll of 1–100.
 */
export function rollChance(stat: number | null, value: number): number | null {
  if (stat === null) return null;
  return Math.min(98, Math.max(2, stat - value));
}

/**
 * How a run of a plan is going, for the card to draw in the progression's own
 * grammar (`done` / `now` / `left`) beside the plan it is carrying.
 *
 * Published on every change by `QuestRunner`, whole: a card that missed a
 * push would otherwise hold a list with a hole in it. `IDLE_QUEST_RUN` is what
 * a character that has never run one holds.
 */
export type QuestRunPhase =
  /** Stood still by a setback, about to try the same thing again. */
  | 'held'
  /** Asking for the pack, which nobody has listed. */
  | 'listing'
  /** Going and getting one of the step's items. */
  | 'fetching'
  /** Walking to where the act happens, or to where an item is handed over. */
  | 'walking'
  /** Waiting for the asker or the monster, or fighting it. */
  | 'acting'
  /** The act is sent; reading whether the counter moved. */
  | 'confirming';

export interface QuestRunStep {
  block: number;
  state: 'done' | 'now' | 'left';
  /**
   * The step named by its act, as the plan rows name it — `ask Sage hello`,
   * `kill orc` — or `#block` where the realm traced it to nobody. Said by
   * main once, so the card and the banner over the console cannot name one
   * step two ways.
   */
  words: string;
}

export interface QuestRunProgress {
  status: 'idle' | 'running' | 'done' | 'stopped';
  /** The block the run was asked to reach — how the card knows a run is this step's. */
  block: number | null;
  /** The quest's own name and the rank the run reaches; null while idle. */
  name: string | null;
  to: number | null;
  steps: QuestRunStep[];
  phase: QuestRunPhase | null;
  /** What the phase is about, in words — the item, the place, the act. */
  detail: string | null;
  /** Why it stopped, or what it finished with. Null while running. */
  reason: string | null;
  /** Tries spent on the step's roll so far, where it rolls. */
  tries: number;
}

export const IDLE_QUEST_RUN: QuestRunProgress = {
  status: 'idle',
  block: null,
  name: null,
  to: null,
  steps: [],
  phase: null,
  detail: null,
  reason: null,
  tries: 0
};

/**
 * What a step does, as the act a plan carries: the three owners a step can
 * have, read the way `askWords` reads them for the card. Null where the realm
 * traced the step to nobody, nowhere and no death.
 */
export function planAct(step: QuestStep): PlanAct | null {
  if (step.kill !== undefined) return { verb: 'kill', mob: step.kill };
  const word = step.say[0];
  if (word === undefined) return null;
  if (step.who !== undefined && step.who.trim().length > 0) {
    return { verb: 'ask', who: step.who, say: word };
  }
  return step.room === undefined ? null : { verb: 'say', phrase: word };
}

/**
 * The rank of an earlier step of this quest that hands the item over, or null.
 *
 * The realm never says so and it is one of the four answers: a later step's
 * `takeitem` is routinely an earlier step's `giveitem` — 18 of the shipped
 * realm's 82 item requirements are answered by nothing else. Every route of
 * an earlier step, not only what all of them share: an item one class's route
 * hands out is still an item that route can be taken for. `before` is the
 * step's own index; only steps ahead of it in the chain count.
 */
export function earlierHandover(quest: Quest, before: number, id: number): number | null {
  const found = quest.steps.findIndex((other) =>
    [other, ...(other.ways ?? [])].some((way) =>
      way.gives.some((reward) => reward.kind === 'item' && reward.id === id)
    )
  );
  if (found === -1 || found >= before) return null;
  return quest.steps[found]?.to ?? null;
}

/**
 * The steps a plan to `block` must carry, from a counter at `fromRank`.
 *
 * One step per rank, in rank order: the realm writes alternatives as several
 * steps sharing a `to`, and a plan does one of them, so the first the client
 * could tell somebody to go and do is taken (`actable`, the reading
 * `questBars` makes of the same alternatives). A rank already behind the
 * character is left out — the plan is what is still to do — and a target
 * the realm sets no rank for, or one already reached, plans nothing.
 */
export function planSpan(quest: Quest, block: number, fromRank: number | null): QuestStep[] {
  const target = quest.steps.find((step) => step.block === block);
  if (target === undefined || target.to === undefined) return [];
  const done = fromRank ?? -Infinity;
  if (target.to <= done) return [];
  const byRank = new Map<number, QuestStep>();
  for (const step of quest.steps) {
    if (step.to === undefined || step.to <= done || step.to > target.to) continue;
    if (!actable(step)) continue;
    if (!byRank.has(step.to)) byRank.set(step.to, step);
  }
  return [...byRank.keys()].sort((a, b) => a - b).map((rank) => byRank.get(rank) as QuestStep);
}

/**
 * Which shelf of the book a quest sits on for this character.
 *
 * Three, in the order a reader wants them: what they can get on with, what is
 * behind them, and what the realm's gates shut them out of. A finished chain
 * is never barred — `questBars` asks about the rank *after* the character's
 * and a finished chain has none — so the two cannot both be true of one quest,
 * and `done` is decided first only because it is the stronger statement.
 *
 * `total` is guarded: a quest of no steps is nothing to have finished.
 */
export type QuestGroup = 'open' | 'done' | 'barred';

/** The shelves in the order the book draws them. */
export const QUEST_GROUPS: readonly QuestGroup[] = ['open', 'done', 'barred'];

export function questGroup(done: number, total: number, bars: readonly QuestBar[]): QuestGroup {
  if (total > 0 && done >= total) return 'done';
  return bars.length > 0 ? 'barred' : 'open';
}

/**
 * One thing somebody standing in this room can be asked, as the realm scripts
 * it.
 *
 * The Room card already draws what the **room** answers (`RoomCommand`), and
 * `ask Morukai phoenix` is the same kind of fact about the monster standing
 * beside you — a word the realm scripts, that does something, and that the
 * client held in the quest book and drew only on a card in another tab.
 *
 * The step is not carried, only what a chip needs to be read and pressed: the
 * name goes after `ask` in the realm's own verb order, so `who` is spelled the
 * way the **room listed it**, not the way the quest book did — the two agree on
 * a monster the realm places, and it is the room's word the server will match.
 */
export interface RoomAsk {
  who: string;
  /** The word to say — the first spelling the step states, as the room's own chips draw. */
  say: string;
  /** The quest it advances, named, for the tooltip. */
  quest: string;
  /** The counter's own ability id, spelled the way `abil` spells one. */
  counter: number;
  /** The rank it moves the counter to, where the step states one. */
  to?: number;
  /**
   * What the step demands that this character's **listed** pack does not hold.
   *
   * Named rather than hidden, on the Room card's own rule about a blocked
   * exit: a blocked thing is still a thing, and saying why beats leaving a
   * player to wonder where the chip went. Absent where the step wants nothing,
   * and absent where nobody has listed the pack — an unlisted pack is not an
   * empty one, which is the refusal the router already makes about a key.
   */
  wants?: string[];
}

/**
 * Whether a **complete** listing says one of this step's counter gates fails.
 *
 * `countersMet` is the narrowing rule — it answers *false* on an incomplete
 * listing, because an id it omits settles nothing and a quest counter walked
 * forward wrongly never walks back. This is the opposite question asked for
 * the opposite purpose: an **offer** must not be withheld on a gate nobody has
 * read, so unknown refuses nothing and only a listing that enumerates can say
 * no.
 */
export function countersRefuse(step: QuestStep, abilities: AbilitySums | null): boolean {
  if (abilities === null || !abilities.complete) return false;
  return !countersMet(step, abilities);
}

/**
 * What the occupants of this room can be asked, for this character, now.
 *
 * Reported as *add buttons for mobs in room — `ask Morukai phoenix`, `ask
 * Morukai components`, if and only if the requirements are met*. Three gates
 * decide, and each is a fact the client has actually read:
 *
 * - **The counter.** Morukai answers four words across four ranks of one
 *   chain, so with a listing in hand exactly one of them is the thing to say
 *   and the other three are refusals waiting to happen.
 * - **What the character is** — class, race, level, a counter already spent —
 *   through `stepBars`, which is the Quest card's own reading of the same
 *   gates. What sinks a quest to the bottom of that card is what keeps a chip
 *   off this one.
 * - **Being past it.** `stepDone` already answers *this rank is behind you*.
 *
 * **Unknown refuses nothing**, which is the rule that keeps this reachable: a
 * realm with no `abil` states no counter, and a character whose sheet has not
 * arrived has no class — on either, every word the monster answers is offered
 * and the player decides. The alternative is a feature that appears only on
 * GreaterMUD after a command the player may never send.
 *
 * `carrying` is item ids, or **null for a pack nobody has listed** — the same
 * distinction `Inventory.listedAt` exists for. A listed pack that lacks what a
 * step wants marks the chip rather than removing it: the item is an errand,
 * and the client holds, on that very item, where to go and get one.
 */
export function asksHere(
  quests: readonly Quest[],
  here: readonly string[],
  who: QuestDoer,
  watched: QuestWatched | null,
  carrying: readonly number[] | null
): RoomAsk[] {
  // The room's own spelling, keyed the way every other name lookup is keyed.
  const present = new Map<string, string>();
  for (const name of here) {
    const word = name.trim();
    if (word.length > 0) present.set(word.toLowerCase(), word);
  }
  if (present.size === 0) return [];

  /*
   * The counters as they stand *now*, not as the last listing photographed
   * them: a chain answered two keywords ago has moved twice and `abil` says
   * neither. Everything below that reads a counter reads this one — the
   * refusal, and the bars, which is where a chain's `failability` on its
   * siblings is answered.
   */
  const asked: QuestDoer = { ...who, counters: countersNow(who.counters, watched) };

  const found: RoomAsk[] = [];
  for (const quest of quests) {
    /*
     * The Quest card's own reading of where this character stands, less the
     * remembered mark: that is a preference in the window's own storage and
     * this is computed in main. An observation and a watched ask are both
     * main's, and where there is neither the rank is unknown — which, by the
     * rule above, refuses nothing.
     */
    const { rank, held } = questReading(quest.id, who.counters, watched);

    for (const step of quest.steps) {
      const spelled =
        step.who === undefined ? undefined : present.get(step.who.trim().toLowerCase());
      if (spelled === undefined) continue;
      const say = step.say[0];
      if (say === undefined || say.length === 0) continue;
      if (stepDone(step, rank, held)) continue;
      if (countersRefuse(step, asked.counters)) continue;
      if (stepBars(step, asked, quest.id).length > 0) continue;
      found.push({
        who: spelled,
        say,
        quest: quest.name,
        counter: quest.id,
        ...(step.to === undefined ? {} : { to: step.to }),
        ...maybeWants(step, carrying)
      });
    }
  }
  return found;
}

/**
 * Whether a pack holds this row — **null where nobody has listed it**.
 *
 * Three-valued on purpose, and the third value is the whole of the rule: an
 * unlisted pack is not an empty one, so *no* and *nobody has looked* are
 * different answers and the second may never be drawn as the first. A chip
 * says *you are not carrying this* only on a real no, and the quest book ticks
 * an item only on a real yes — between them the row is left alone.
 *
 * One function because the two readings are one question asked from opposite
 * ends: what a step still wants (`maybeWants`) and what it already has
 * (`QuestCard`). `packRows` is where the list itself comes from.
 */
export function packHolds(carrying: readonly number[] | null, id: number): boolean | null {
  return carrying === null ? null : carrying.includes(id);
}

/**
 * The items a step demands that a listed pack does not hold, by name.
 *
 * Only `item` gates, never `item-absent`: *not carrying this* is not an errand
 * and drawing it as one would send somebody to fetch the thing that stops the
 * step. Only the gates every route shares, for the same reason the Quest card
 * keeps a route's own demands on the route: a chip is one line and a class's
 * own price is not this character's until the realm says which class it is.
 */
function maybeWants(
  step: QuestStep,
  carrying: readonly number[] | null
): { wants?: string[] } | object {
  if (carrying === null) return {};
  const missing: string[] = [];
  for (const gate of step.needs) {
    if (gate.kind !== 'item' || packHolds(carrying, gate.id) !== false) continue;
    missing.push(gate.name ?? String(gate.id));
  }
  return missing.length === 0 ? {} : { wants: missing };
}
