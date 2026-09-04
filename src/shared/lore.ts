/**
 * What is known about how much health a monster has, and how it is learned.
 *
 * The realm database answers this for the monsters it names. Nothing answers it
 * for the rest — a derivative realm, a monster added since the extraction, or a
 * name the stream spells differently — and those are exactly the fights where a
 * bar would be most welcome. So the client learns by watching.
 *
 * **The estimator is a minimum, and the reason is arithmetic rather than
 * taste.** Total damage dealt to kill a monster is always at least its maximum
 * health, because the last blow overkills and because it regenerates while the
 * fight runs. Every fight therefore produces an *upper bound*, and the least
 * upper bound ever seen is the tightest one. Averaging would converge on
 * something above the truth and stay there.
 *
 * That estimator has one failure mode and it is silent: an **undercount**. Walk
 * in on a fight somebody else started, land the last blow, and the total this
 * client saw is far below the monster's real health — and because the estimator
 * takes the minimum, that one fight poisons the entry permanently. Two things
 * guard it:
 *
 * - **Only a fight this character opened is learned from.** If the first blow
 *   this client saw was somebody else's, it has no idea what came before it.
 * - **`survived` is a floor, and it outranks the minimum.** The largest total
 *   ever dealt to a monster that was *still alive* is a hard lower bound on its
 *   health. When it exceeds the learned minimum, the minimum was an undercount
 *   and is overruled. An entry corrects itself rather than staying wrong.
 *
 * Dependency-free: main learns and persists it, the renderer only reads what
 * reaches it inside `TargetHealth`.
 */

/** What fighting one kind of monster repeatedly has taught. */
export interface MobLoreEntry {
  /**
   * Least total damage ever seen to kill it, or null before the first kill.
   *
   * The tightest upper bound on its maximum health. See the note above for why
   * this is a minimum and not a mean.
   */
  kill: number | null;
  /**
   * Most total damage ever dealt to one that was still alive afterwards.
   *
   * A hard lower bound, and the correction for an undercounted `kill`. A
   * monster that regenerates can absorb more than its maximum over a long
   * fight, so this can sit above the truth — which errs towards saying a
   * monster is healthier than it is, and that is the safe direction.
   */
  survived: number;
  /** How many kills `kill` is drawn from, so a card can say how sure it is. */
  kills: number;
  /** Epoch ms of the last change, for pruning and for saying how old it is. */
  at: number;
}

export function emptyLore(): MobLoreEntry {
  return { kill: null, survived: 0, kills: 0, at: 0 };
}

/**
 * The working maximum an entry supports, or null when it supports none.
 *
 * `survived` outranks `kill` when the two disagree, because they disagree only
 * in one direction: damage absorbed by something that lived is evidence the
 * recorded kill total was short.
 */
export function loreMaximum(entry: MobLoreEntry | undefined): number | null {
  if (!entry || entry.kill === null) return null;
  return Math.max(entry.kill, entry.survived);
}

/**
 * Folds one finished fight into an entry, returning a new one.
 *
 * Pure, and returns the entry unchanged when nothing was learned, so a caller
 * can use identity to decide whether the store needs writing.
 *
 * `damage` of zero teaches nothing either way: a monster that died without this
 * client seeing a blow land was killed by something it could not see.
 */
export function learn(
  entry: MobLoreEntry | undefined,
  outcome: { damage: number; killed: boolean; at: number }
): MobLoreEntry {
  const current = entry ?? emptyLore();
  if (!Number.isFinite(outcome.damage) || outcome.damage <= 0) return current;

  if (!outcome.killed) {
    // Still standing after this much: a floor, and only ever raised.
    if (outcome.damage <= current.survived) return current;
    return { ...current, survived: outcome.damage, at: outcome.at };
  }

  const kill = current.kill === null ? outcome.damage : Math.min(current.kill, outcome.damage);
  return { kill, survived: current.survived, kills: current.kills + 1, at: outcome.at };
}

/**
 * What the client knows about monsters, from wherever it knows it.
 *
 * An interface rather than a class so `CharacterTracker` depends on the
 * question and not on the answer: the realm data is a file, the learned half is
 * another file with a write schedule, and a test wants neither. §1 dependency
 * inversion, in the one place in the parse path where it would otherwise be
 * tempting to reach for a database handle — which is precisely the mistake
 * docs/legacy-assessment.md §5 records the CoffeeScript engine making.
 */
export interface MobLore {
  /**
   * The maximum health to work from for a monster of this name.
   *
   * `null` is a real answer and the common one for a realm the client does not
   * ship: nothing knows, and the caller says so rather than inventing a bar.
   */
  maximumFor(name: string): {
    max: number | null;
    source: 'realm' | 'learned' | null;
    span: [number, number] | null;
  };
  /**
   * One finished engagement, learned from.
   *
   * Called once per monster per fight, on the fight ending — not per blow.
   * Implementations persist lazily; nothing in the parse path may block on a
   * write.
   */
  observe(name: string, outcome: { damage: number; killed: boolean; at: number }): void;
  /**
   * What fighting has taught about a monster, whole — kills, the least that
   * killed it, the most it survived — for a card to state beside the realm's
   * figure. Null when nothing has been learned, which is not an entry of
   * zeros. `maximumFor` is the *decision* (which figure to work from) and
   * prefers the realm; this is the *record*, which a card wants even when the
   * realm speaks, because "the realm says 60 and this character has seen it
   * survive 75" is the sentence that decides whether to trust the bar.
   */
  learnedFor(name: string): MobLoreEntry | null;
  /**
   * Every word a listing has printed for items of this `Worn` code.
   *
   * The list rather than the verdict, because the two ways of having no verdict
   * are different facts and the caller acts on the difference. **Empty** means
   * no listing has ever named a slot for this code, and the realm file's own
   * reading of the code is then worth showing, marked as the realm's
   * (`CarriedItem.slotSource`). **Two or more** means listings have disagreed,
   * so the code does not decide the word on this realm — and the realm file's
   * reading is a guess between them wearing a different hat. One word is the
   * answer. See {@link SlotLoreEntry}.
   */
  slotWordsFor(worn: number): readonly string[];
  /**
   * How much health a monster of this name recovers per regeneration tick, from
   * the realm data — and null where the realm does not say.
   *
   * The **other half of the wound estimate**. `1 - damage/max` only ever falls,
   * so an estimate built from damage alone drifts below the truth for as long as
   * a fight lasts, and the only correction was a `look` re-anchoring it. The
   * realm records the figure per monster (`Monsters.HPRegen`, format 12) and the
   * tick is realm-wide, so the drift is now arithmetic rather than something to
   * be surprised by.
   *
   * Realm data only — deliberately **not** learned. Nothing on the wire ever
   * announces a regeneration, so there is nothing to learn it from; a figure
   * inferred from an estimate that is itself the thing being corrected would be
   * a loop.
   */
  regenFor(name: string): number | null;
  /** A listing named an item the realm knows and the slot it sits in. */
  observeSlot(worn: number, word: string, at: number): void;
}

/** A lore that knows nothing and learns nothing. The zero-realm client. */
export const NO_LORE: MobLore = {
  maximumFor: () => ({ max: null, source: null, span: null }),
  observe: () => {},
  learnedFor: () => null,
  regenFor: () => null,
  slotWordsFor: () => [],
  observeSlot: () => {}
};

/**
 * Where an item of one `Worn` code is listed as sitting, in the server's words.
 *
 * The realm database records a `Worn` code per item and the listing prints a
 * word per worn item — `padded boots (Feet)` — and neither says the other. A
 * listing that names an item the realm knows therefore teaches the pair: code 5
 * prints `Feet`. Learned realm-wide like a monster's health, because where a
 * boot goes is a fact about the realm and not about who wore it, and so that a
 * pair of boots worn for the first time can read `(Feet)` without an `i`.
 *
 * **Every word ever seen for a code is kept, and the answer is the word only
 * while there is exactly one.** Two words for one code is the realm printing
 * differently for items the code alone does not distinguish, and choosing
 * between them would be the guess this exists to avoid — the card falls back to
 * `in use`, which is true. The static `WORN_SLOT` table in `items.ts` was read
 * off the item *names* and is what the Reference card shows about an item; it is
 * deliberately not what the Carrying card says about a slot, because that
 * heading looks like the server's and only the server's words belong under it.
 */
export interface SlotLoreEntry {
  /** Distinct words a listing has printed for this code, sorted. */
  words: string[];
  /** Epoch ms of the last new word. */
  at: number;
}

/**
 * Folds one listed word into an entry. Pure, and returns its input when the
 * word was already known, so a caller can use identity to decide whether the
 * store needs writing. An empty word teaches nothing.
 */
export function learnSlot(
  entry: SlotLoreEntry | undefined,
  word: string,
  at: number
): SlotLoreEntry | undefined {
  const clean = word.trim();
  if (clean.length === 0) return entry;
  if (entry?.words.includes(clean)) return entry;
  return { words: [...(entry?.words ?? []), clean].sort(), at };
}
