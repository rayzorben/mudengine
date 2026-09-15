/**
 * Assembling the realm's quests out of its text blocks.
 *
 * No realm database has a Quests table. What it has is `TBInfo` — the scripts
 * an NPC runs when somebody says a word to it — and between the gates and the
 * rewards those state a quest completely. `questScript.ts` reads one script;
 * this joins them into chains and says who to say what to.
 *
 * ## Which abilities are quests, derived rather than listed
 *
 * `src/shared/abilities.ts` names about eighteen counters, and a hard-coded
 * list of them would be this file's opinion rather than the realm's — a
 * derivative that invents its own quest would be invisible, and a name in that
 * table that no realm actually chains would produce an empty quest.
 *
 * So a counter is **an ability that is both granted by one script and demanded
 * by another**. That is exactly the walk-it-backwards test: something worth
 * `giveability`-ing that some other block then `checkability`s is a step in a
 * chain, and nothing else in the file has that shape. It finds 39 of them in
 * Paradigm against the eighteen the names table knows, and the extra ones get
 * their id as their name rather than being dropped.
 *
 * ## Ownership is traversed forwards, from columns rather than from a comment
 *
 * `TBInfo` has a `Called From` column that reads `Monster #244` or
 * `Textblock #335`, and it is tempting because it points straight at the
 * answer. It is a **denormalised note written by the editor**, not a foreign
 * key, and 168 of its rows say `Textblock(rndm) #` and 81 name two parents.
 *
 * The authoritative columns point the other way — `Monsters.GreetTXT`,
 * `Monsters.DeathSpell` and `Rooms.CMD` name a block, `TBInfo.LinkTo` names
 * the next one, and a keyword table names the rest — so the walk is forwards
 * from those roots, carrying the owner and the words that reached it. What
 * that buys is the thing a quest book is for: not just *what the step wants*
 * but **who to say it to or kill, where they stand, and the word to say**.
 *
 * ## What is deliberately not claimed
 *
 * - **No progress.** The counters are server-side abilities, no command prints
 *   one and no sentence reports one, so which step a character is on is not
 *   knowable *here*. The card lets a player hide a quest and state the rank
 *   they have reached; nothing in this file ever says *done*.
 * - **No provenance.** Where an item comes from is a join between two other
 *   indexes and is made in `WorldGraph.quests()`, not written into the file.
 * - **No flavour.** The story lives in a message table this does not read. A
 *   step states its gates and its rewards, and inventing the rest would be the
 *   confidently-wrong answer this project refuses everywhere else.
 */
import { ABILITY, HAZARD_ABILITY } from '../../shared/abilities';
import type { Quest, QuestGate, QuestStep, QuestWay } from '../../shared/quests';
import { readKeywordTable, readQuestScript } from './questScript';
import type { RealmSource } from './RealmSource';
import { number, text } from './values';

/** What the caller already has, so nothing here re-reads a table for a name. */
export interface QuestNaming {
  classes: ReadonlyArray<{ id: number; n: string }>;
  races: ReadonlyArray<{ id: number; n: string }>;
  /**
   * The spell index, for names **and** for the `Abil-n` pairs a death spell's
   * chain is followed along — `indexSpells` has already read those columns,
   * and reading them again here would be a second opinion about one row.
   */
  spells: ReadonlyArray<{ id: number; n: string; ab?: Array<[number, number]> }>;
}

/**
 * Which text blocks a spell can run, following the chain a spell hands on to.
 *
 * Two abilities, both the server's (`GMUDAbilities`): `TextBlock` names the
 * block outright, and `EndCast` is the spell this one hands the character when
 * it ends — the link every death spell in both shipped realms uses, because
 * the corpse's spell is a one-second holder whose ending is the payload.
 *
 * Memoised per spell and guarded by the walk's own visited set, so a realm
 * whose spells end in each other terminates rather than being trusted not to.
 */
function spellBlocks(spells: QuestNaming['spells']): (id: number) => number[] {
  const abilities = new Map(spells.map((spell) => [spell.id, spell.ab ?? []]));
  const answered = new Map<number, number[]>();

  const walk = (id: number, seen: Set<number>): number[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const found: number[] = [];
    for (const [ability, value] of abilities.get(id) ?? []) {
      if (value <= 0) continue;
      if (ability === HAZARD_ABILITY.textBlock) found.push(value);
      if (ability === HAZARD_ABILITY.endCast) found.push(...walk(value, seen));
    }
    return found;
  };

  return (id) => {
    const held = answered.get(id);
    if (held !== undefined) return held;
    const found = walk(id, new Set());
    answered.set(id, found);
    return found;
  };
}

/**
 * What runs a block, and therefore what a player has to *do* to reach the step
 * in it.
 *
 * Three roots and three different acts, which is why this is a tagged union
 * rather than a name that may be blank: an NPC is asked, a room's script is
 * typed at, and a **death spell** is nothing anybody says at all. Read as *a
 * `who` that might be empty*, the third would have taken the second's branch
 * and been handed the opcode at the head of its first line as a phrase to
 * type — `checkability 133 1`, offered to the player as the words to say.
 */
type Owner =
  | { kind: 'npc'; who: string; room?: string }
  | { kind: 'room'; room: string }
  | { kind: 'death'; who: string; room?: string };

/** One block, as the traversal finds it. */
interface Reached {
  owner: Owner | null;
  words: string[];
}

/**
 * The words that reach a step, which depend on what runs the block.
 *
 * An **NPC**'s come from the keyword table that reached its block — the table
 * that actually says what to ask. A **room**'s come from the step's own lines,
 * because a room's script answers `touch gem` and the block holds one line per
 * phrase (see `BlockStep.phrases`). A **death** has none: there is nothing to
 * type, and the first field of its first line is an opcode.
 */
function sayOf(owner: Owner | null, words: string[], phrases: string[]): string[] {
  if (owner?.kind === 'death') return [];
  return owner?.kind === 'npc' ? words : phrases;
}

export function indexQuests(source: RealmSource, naming: QuestNaming): Quest[] {
  const blocks = readBlocks(source);
  if (blocks.size === 0) return [];

  const counters = chainedCounters(blocks);
  if (counters.size === 0) return [];

  const reached = traverse(source, blocks, naming.spells);
  const names = nameTables(source, naming);

  /** Every step of every counter, before they are grouped and ordered. */
  const steps = new Map<number, QuestStep[]>();

  for (const [id, block] of blocks) {
    const found = reached.get(id);
    const merged = stepsInBlock(block.action, counters);
    for (const step of merged) {
      const owner = found?.owner ?? null;
      const built: QuestStep = {
        block: id,
        say: sayOf(owner, found?.words ?? [], step.phrases),
        ...nameWay(step, names),
        ...maybe('who', owner?.kind === 'npc' ? owner.who : undefined),
        ...maybe('kill', owner?.kind === 'death' ? owner.who : undefined),
        ...maybe('room', owner?.room),
        ...maybe('from', step.from),
        ...maybe('to', step.to),
        // A route naming pass each, so a way's own gates and rewards read the
        // same as the step's — the names come from one table either way.
        ...maybe(
          'ways',
          step.ways?.map((way) => nameWay(way, names))
        )
      };
      const held = steps.get(step.counter);
      if (held === undefined) steps.set(step.counter, [built]);
      else held.push(built);
    }
  }

  const quests: Quest[] = [];
  for (const [id, list] of steps) {
    // In the order the chain is walked. A step with no stated rank sorts
    // first: it is the one that starts the quest, which is the only step a
    // player who has never touched it can take.
    list.sort((a, b) => (a.to ?? a.from ?? -1) - (b.to ?? b.from ?? -1) || a.block - b.block);
    quests.push({ id, name: ABILITY[id]?.name ?? `Ability ${id}`, steps: list });
  }
  quests.sort((a, b) => a.id - b.id);
  return quests;
}

/**
 * Every block that has a script, with its `LinkTo`.
 *
 * A `TBInfo` action is stored with trailing NULs; they are padding, not text —
 * the same trimming `buildRealm` already does where it reads room scripts.
 */
function readBlocks(source: RealmSource): Map<number, { action: string; linkTo: number | null }> {
  const blocks = new Map<number, { action: string; linkTo: number | null }>();
  for (const row of source.table('TBInfo')?.rows ?? []) {
    const id = number(row['Number']);
    if (id === null) continue;
    /*
     * NULs, not spaces. Access pads this column and `buildRealm` strips the
     * same padding where it reads room scripts. The **spaces** are load-bearing:
     * they separate an opcode from its arguments and hold `Commander Markus`
     * together as one thing somebody says, so stripping those would turn
     * `checkability 126 5` into a single meaningless token.
     */
    const action = text(row['Action']).replaceAll('\u0000', '').trim();
    blocks.set(id, { action, linkTo: number(row['LinkTo']) });
  }
  return blocks;
}

/**
 * The abilities this realm actually uses as quest counters.
 *
 * Granted by one script and demanded by another — see the header for why this
 * is derived rather than read off a list of names.
 */
function chainedCounters(
  blocks: Map<number, { action: string; linkTo: number | null }>
): Set<number> {
  const granted = new Set<number>();
  const demanded = new Set<number>();
  for (const { action } of blocks.values()) {
    for (const line of action.split('\n')) {
      const script = readQuestScript(line);
      for (const grant of script.granted) granted.add(grant.id);
      for (const gate of script.needs) {
        if (gate.kind === 'ability' || gate.kind === 'ability-absent') demanded.add(gate.id);
      }
    }
  }
  const counters = new Set<number>();
  for (const id of granted) if (demanded.has(id)) counters.add(id);
  return counters;
}

/**
 * Walk from every monster's greeting, every room's script and every monster's
 * death, carrying the owner and the words that reach each block.
 *
 * Breadth-first and visit-once: a block reached two ways keeps the first
 * owner, which is the shortest path from a root and so the most direct thing
 * a player would do. Words are unioned rather than replaced, because a keyword
 * table routinely points several synonyms at one block and the player only
 * needs whichever they remember.
 *
 * **The roots are queued in that order and it is load-bearing**: a block a
 * monster both greets you with and hands over on death is a conversation, and
 * the smuggler boss is exactly that monster.
 */
function traverse(
  source: RealmSource,
  blocks: Map<number, { action: string; linkTo: number | null }>,
  spells: QuestNaming['spells']
): Map<number, Reached> {
  const reached = new Map<number, Reached>();
  const queue: Array<{ id: number; owner: Reached['owner']; words: string[] }> = [];

  const roomOf = (value: string): string | undefined => {
    const at = /Room\s+(\d+)\s*\/\s*(\d+)/i.exec(value);
    return at ? `${at[1]}/${at[2]}` : undefined;
  };

  const deaths: Array<{ id: number; owner: Owner }> = [];
  const runs = spellBlocks(spells);
  for (const row of source.table('Monsters')?.rows ?? []) {
    const who = text(row['Name']).trim();
    if (who.length === 0) continue;
    const where = maybe('room', roomOf(text(row['Summoned By'])));
    const greet = number(row['GreetTXT']);
    if (greet !== null && greet > 0) {
      queue.push({ id: greet, owner: { kind: 'npc', who, ...where }, words: [] });
    }
    /*
     * **A death is a root.** `Monsters.DeathSpell` is cast on the corpse and
     * routinely ends in a text block: the dread mystic's is `dread mystic
     * temp`, whose `EndCast` is `dread mystic text`, whose `TextBlock` is 1417
     * — *be at Phoenix rank 1, take the yellowed note, go to rank 2*. See
     * `mudengine-world` › *The world knowledge base* for what that was worth.
     */
    const death = number(row['DeathSpell']);
    if (death === null || death <= 0) continue;
    for (const block of runs(death)) {
      deaths.push({ id: block, owner: { kind: 'death', who, ...where } });
    }
  }
  for (const row of source.table('Rooms')?.rows ?? []) {
    const cmd = number(row['CMD']);
    if (cmd === null || cmd <= 0) continue;
    /*
     * **`Map Number` and `Room Number`**, which is what the table calls them
     * (todo 12, 2026-09-13). `Map`/`Number` read null on every row, so every
     * room-scripted step was built owning nothing: no place, and — because
     * `stepSaid` anchors on the asker's name — no way to notice the player
     * doing it either. The realm's own altar quest was in the book as two
     * blank steps. `buildRealm` has always used these two names.
     */
    const map = number(row['Map Number']);
    const id = number(row['Room Number']);
    const where = map !== null && id !== null ? `${map}/${id}` : undefined;
    // A room is not somebody, so it owns no `who`; what it has is a place. Its
    // words are each step's own, taken from the line that states it — see
    // `BlockStep.phrases`, and why the block's phrases as a whole are wrong.
    queue.push({ id: cmd, owner: where ? { kind: 'room', room: where } : null, words: [] });
  }
  // Last, so that a block somebody also talks to you about stays a conversation.
  for (const death of deaths) queue.push({ ...death, words: [] });

  while (queue.length > 0) {
    const next = queue.shift()!;
    const block = blocks.get(next.id);
    if (block === undefined) continue;

    const held = reached.get(next.id);
    if (held !== undefined) {
      for (const word of next.words) if (!held.words.includes(word)) held.words.push(word);
      continue;
    }
    reached.set(next.id, { owner: next.owner, words: [...next.words] });

    if (block.linkTo !== null && block.linkTo > 0) {
      queue.push({ id: block.linkTo, owner: next.owner, words: next.words });
    }
    for (const [target, words] of readKeywordTable(block.action)) {
      // The words that reach a step are the ones said *at* it, not the ones
      // said to get to the menu above it — so they replace rather than
      // accumulate down the chain.
      queue.push({ id: target, owner: next.owner, words });
    }
  }
  return reached;
}

/** One route through a block's step: the whole of what one line states. */
interface BlockWay {
  needs: QuestGate[];
  takes: number[];
  gives: ReturnType<typeof readQuestScript>['gives'];
}

/** One alternative of a block that advances a counter. */
interface BlockStep extends BlockWay {
  counter: number;
  from?: number;
  to?: number;
  /** The routes that differ; absent where the block writes one. */
  ways?: BlockWay[];
  /**
   * The phrases the lines that make up *this* step are reached by — the first
   * field of each line (`<phrase> : <step> : <step>`).
   *
   * Per step and not per block, because one block routinely states several
   * (2026-09-13, todo 12, on review). Block 4355 at `1/163` is three quests in
   * one room — `pledge good`, `pledge neutral`, `pledge evil` — and handing
   * every step every phrase told an evil character to pledge good and matched
   * whichever quest came first in the list when they typed the right one.
   * Block 9526 is worse: a temple's price list beside a quest step, so buying
   * a heal would have marked the Evil quest watched.
   *
   * Read only for a block a **room** owns. An NPC's block takes its words from
   * the keyword table that reached it, which is the table that actually says
   * what to ask; a line's own first field there is not a phrase anybody types.
   */
  phrases: string[];
}

/**
 * The steps one block states, with its alternatives kept apart.
 *
 * A block routinely holds one **line per class** — the alignment quests hold
 * fifteen — and emitting fifteen steps for one conversation would bury the
 * quest in its own bookkeeping. So lines that advance the same counter to the
 * same rank are one step. What they are *not* is one set of conditions:
 *
 *     class 1 : … : giveability 22 5 : addexp 2000000
 *     class 2 : … : giveability 69 6 : addexp 2000000
 *
 * are a Warrior's route and a Witchunter's, and unioning them said **be a
 * Warrior and a Witchunter**, be level 22 and level 20 at once, and take every
 * one of the fifteen classes' rewards. That is not a wordy answer, it is a
 * wrong one, and it was on 23 of the shipped realm's 251 steps — including
 * steps of all three great chains, where it promised a warrior the mage's mana
 * and the thief's stealth.
 *
 * So a step keeps what every route shares and hands the rest back as `ways`,
 * each route whole: its own gates, its own price, its own reward. One route
 * leaves `ways` absent and the step is exactly what it always was.
 *
 * A block that advances nothing yields nothing, which is the great majority:
 * most blocks are dialogue.
 */
function stepsInBlock(action: string, counters: Set<number>): BlockStep[] {
  const merged = new Map<
    string,
    { counter: number; from?: number; to?: number; routes: BlockWay[]; phrases: string[] }
  >();
  for (const line of action.split('\n')) {
    const script = readQuestScript(line);
    const grant = script.granted.find((entry) => counters.has(entry.id));
    // A line that only *gates* on a counter without advancing it is a refusal
    // branch or a piece of dialogue, not a step: the step is the one that pays.
    if (grant === undefined) continue;

    const gate = script.needs.find((need) => need.kind === 'ability' && need.id === grant.id) as
      Extract<QuestGate, { kind: 'ability' }> | undefined;
    const from = gate?.atMost ?? gate?.atLeast;

    const key = `${grant.id}/${grant.value}/${from ?? ''}`;
    const route: BlockWay = {
      needs: [...script.needs],
      takes: [...script.takes],
      gives: [...script.gives]
    };
    // The line's own phrase: everything before the first `:`, which is what a
    // room's script answers to. Empty where the line states none.
    const parts = line.split(':');
    const phrase = parts.length > 1 ? (parts[0] ?? '').trim() : '';
    const held = merged.get(key);
    if (held === undefined) {
      merged.set(key, {
        counter: grant.id,
        routes: [route],
        phrases: phrase.length > 0 ? [phrase] : [],
        ...maybe('from', from),
        ...maybe('to', grant.value)
      });
      continue;
    }
    // A block that states the identical line twice states one route; two
    // spellings of one act are two phrases reaching one step.
    if (!held.routes.some((seen) => same(seen, route))) held.routes.push(route);
    if (phrase.length > 0 && !held.phrases.includes(phrase)) held.phrases.push(phrase);
  }
  return [...merged.values()].map((entry) => ({
    counter: entry.counter,
    phrases: entry.phrases,
    ...maybe('from', entry.from),
    ...maybe('to', entry.to),
    ...shareRoutes(entry.routes)
  }));
}

/**
 * What every route through a step has in common, and what each adds.
 *
 * The shared part stays the step's own `needs`/`takes`/`gives`, so a step
 * written one way is unchanged and anything that never heard of a route still
 * reads something true. The remainders become `ways`, and three cases collapse
 * back to no routes at all:
 *
 * - **One route.** There is nothing to choose between.
 * - **Every remainder empty.** The block stated the same thing twice.
 * - **A remainder empty while others are not.** One route asks for nothing
 *   beyond the shared gates, so the others' extra conditions are not
 *   conditions — offering them as a choice would invent a restriction the
 *   realm does not make. Their extra *rewards* go with them, which
 *   understates what the step pays rather than overstating it: that is the
 *   safe direction, and it is the one the union got wrong. No block on the
 *   shipped realm reaches this.
 */
function shareRoutes(routes: BlockWay[]): BlockWay & { ways?: BlockWay[] } {
  const first = routes[0] ?? { needs: [], takes: [], gives: [] };
  if (routes.length === 1) return first;

  const shared: BlockWay = {
    needs: first.needs.filter((need) => routes.every((r) => r.needs.some((s) => same(s, need)))),
    takes: first.takes.filter((item) => routes.every((r) => r.takes.includes(item))),
    gives: first.gives.filter((give) => routes.every((r) => r.gives.some((s) => same(s, give))))
  };
  const rest = routes.map((route) => ({
    needs: route.needs.filter((need) => !shared.needs.some((s) => same(s, need))),
    takes: route.takes.filter((item) => !shared.takes.includes(item)),
    gives: route.gives.filter((give) => !shared.gives.some((s) => same(s, give)))
  }));
  const bare = (way: BlockWay): boolean =>
    way.needs.length === 0 && way.takes.length === 0 && way.gives.length === 0;
  if (rest.some(bare)) return shared;

  const ways: BlockWay[] = [];
  for (const way of rest) if (!ways.some((seen) => same(seen, way))) ways.push(way);
  if (ways.length > 1) return { ...shared, ways };
  // One surviving route is not a choice, so it folds back into the step —
  // *added* to what is shared, never spread over it. Unreachable as things
  // stand (a remainder common to every route is by construction shared), and
  // written to be right rather than left as a branch that would drop the
  // shared gates if it ever fired.
  const only = ways[0];
  return only === undefined
    ? shared
    : {
        needs: [...shared.needs, ...only.needs],
        takes: [...shared.takes, ...only.takes],
        gives: [...shared.gives, ...only.gives]
      };
}

/** One route's gates, items and rewards with the realm's own names on them. */
function nameWay(way: BlockWay, names: NameTables): QuestWay {
  return {
    needs: way.needs.map((gate) => named(gate, names)),
    takes: way.takes.map((item) => ({ id: item, ...maybe('name', names.item(item)) })),
    gives: way.gives.map((reward) => namedReward(reward, names))
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `{ key: value }` when there is one, and nothing at all when there is not. */
function maybe<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

interface NameTables {
  item(id: number): string | undefined;
  spell(id: number): string | undefined;
  klass(id: number): string | undefined;
  race(id: number): string | undefined;
  ability(id: number): string | undefined;
  classCount: number;
  raceCount: number;
}

function nameTables(source: RealmSource, naming: QuestNaming): NameTables {
  const items = new Map<number, string>();
  for (const row of source.table('Items')?.rows ?? []) {
    const id = number(row['Number']);
    const name = text(row['Name']).trim();
    if (id !== null && name.length > 0) items.set(id, name);
  }
  const spells = new Map(naming.spells.map((entry) => [entry.id, entry.n]));
  const classes = new Map(naming.classes.map((entry) => [entry.id, entry.n]));
  const races = new Map(naming.races.map((entry) => [entry.id, entry.n]));
  return {
    item: (id) => items.get(id),
    spell: (id) => spells.get(id),
    klass: (id) => classes.get(id),
    race: (id) => races.get(id),
    ability: (id) => ABILITY[id]?.name,
    classCount: classes.size,
    raceCount: races.size
  };
}

function named(gate: QuestGate, names: NameTables): QuestGate {
  switch (gate.kind) {
    case 'item':
    case 'item-absent':
      return { ...gate, ...maybe('name', names.item(gate.id)) };
    case 'ability':
    case 'ability-absent':
      return { ...gate, ...maybe('name', names.ability(gate.id)) };
    case 'spell':
      return { ...gate, ...maybe('name', names.spell(gate.id)) };
    case 'class':
      return { ...gate, ...maybe('name', names.klass(gate.id)) };
    case 'race':
      return { ...gate, ...maybe('name', names.race(gate.id)) };
    default:
      return gate;
  }
}

function namedReward(
  reward: ReturnType<typeof readQuestScript>['gives'][number],
  names: NameTables
): ReturnType<typeof readQuestScript>['gives'][number] {
  switch (reward.kind) {
    case 'item':
      return { ...reward, ...maybe('name', names.item(reward.id)) };
    case 'ability':
      return { ...reward, ...maybe('name', names.ability(reward.id)) };
    case 'spell':
      return { ...reward, ...maybe('name', names.spell(reward.id)) };
    default:
      return reward;
  }
}
