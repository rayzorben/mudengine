import { mobKey } from './world';

/**
 * One fight, written down so a later version of this client can be argued with.
 *
 * Nothing reads these yet, and that is the point of writing them: every
 * question worth asking about how a character fights — *is this monster worth
 * the time at this level, does the opener earn its round, does the armour I
 * bought change anything* — needs a record that predates the question. A client
 * that starts collecting on the day somebody asks has to wait a month for an
 * answer.
 *
 * ## What is in a record, and why each thing is
 *
 * **Everything that could plausibly change the outcome**, because the whole
 * value is in being able to hold something constant later. The monster and what
 * it took to kill it are the measurement; the character's level, class, race,
 * maxima and what it had *on* are the conditions the measurement was taken
 * under, and a damage figure without them cannot be compared with anything.
 *
 * **And nothing that is not a fact.** No verdict, no efficiency score, no
 * "was this worth it". Those are the questions, and a record that answered them
 * would be a record that had already decided what to ask.
 *
 * ## Two properties it has to have
 *
 * - **Append-only, one line each.** A fight ends and its line is written; no
 *   record is ever revised. That is what makes the file safe to read while the
 *   client is running and safe to lose the tail of.
 * - **Compressed, and still appendable.** `gzip` members concatenate — a file
 *   of many independent members is one valid gzip stream, and every tool reads
 *   it whole. So each flush appends its own member rather than rewriting the
 *   file, and a crash costs the last flush rather than the file.
 *
 * Dependency-free, like everything in `shared/`: the tracker produces these in
 * main and nothing about the shape may need a file handle to describe.
 */

/** What a character had on when the fight happened. */
export interface FightGear {
  /** The item's name as the listing spelled it. */
  name: string;
  /** The slot, when a listing has ever named one. */
  slot: string | null;
}

/** One fight, as it ended. */
export interface FightRecord {
  /** Epoch ms of the last blow. */
  at: number;
  /** How long the fight ran, in ms, or null when only one blow was seen. */
  ms: number | null;

  /* --------------------------------------------------------- the monster */
  /**
   * The `mobKey` spelling, which is what the lore and the realm are keyed by.
   *
   * As the server printed it, **modifier and all**: `tall kobold thief` and
   * `nasty kobold thief` are two records, not one. That is deliberate — the
   * modifier is realm data (`MobNameModifierType`) and may well be the thing
   * being measured. Grouping them is a later reader's decision, and it has the
   * same rule available that `classifyOccupant` uses: try the exact name, then
   * progressively shorter ones, least stripping first.
   */
  mob: string;
  /** Whether it died, as far as the death suspicion could tell. */
  killed: boolean;
  /** Damage this character dealt. */
  mine: number;
  /** Damage anybody else dealt, which is a different fight. */
  others: number;
  /** Blows exchanged, both ways, as the classifier counted them. */
  blows: number;
  /** The last wound word a `look` reported, when one ever did. */
  wound: string | null;
  /**
   * Whether the first blow this client saw was its own.
   *
   * The same flag the health estimator refuses to learn from a kill without,
   * and it matters here for the same reason: a fight joined halfway is not a
   * measurement of anything.
   */
  opened: boolean;

  /* ------------------------------------------------- the character, then */
  name: string | null;
  race: string | null;
  className: string | null;
  level: number | null;
  hp: number | null;
  hpMax: number | null;
  mana: number | null;
  manaMax: number | null;
  /**
   * Two skills off the stat sheet that decide how big a blow is.
   *
   * A Mystic's damage turns on martial arts and how much of a spell lands turns
   * on magic resistance, so a damage figure recorded without them cannot be
   * compared with the same character a hundred levels of training later — which
   * is the comparison this file exists to make possible. Null until a sheet has
   * stated them, like every other condition here.
   */
  martialArts: number | null;
  magicRes: number | null;
  /** How the realm ranked this character, from its own row in a `who`. */
  alignment: string | null;
  /** What it weighed, which is what decides whether it could act. */
  encumbrance: number | null;
  encumbranceMax: number | null;
  /** Worn and wielded only. What is merely in the pack changes nothing. */
  gear: FightGear[];

  /* -------------------------------------------------------- and where */
  /** `map/room` when the client knew, which it usually does. */
  room: string | null;
  roomName: string | null;
  /** How many other monsters were in the room. A fight of one is not a fight of three. */
  others_here: number;
}

/**
 * Where fights are written for a character.
 *
 * An interface rather than the writer, for the reason every other store here is
 * one: `CharacterTracker` is the parse path and may not acquire a file handle.
 * It reports; whoever wired it up decides where that goes.
 */
export interface FightSink {
  record(fight: FightRecord): void;
}

/** The one that writes nothing, for a session with nowhere to write. */
export const NO_FIGHTS: FightSink = { record: () => {} };

/**
 * What the record says about one monster, added up — and nothing that is not
 * a fact. Fights, kills, the damage this character dealt on average, the blows
 * a fight took, how long one ran. No verdict: whether that is "worth it" is
 * the question, and a summary that answered it would have decided what to ask.
 *
 * Null means *no fights*, not zero of everything; `meanMs` is null when no
 * fight had a measured duration.
 */
export interface FightSummary {
  fights: number;
  kills: number;
  /** Damage this character dealt, averaged over the fights. */
  meanMine: number;
  /** Blows a fight took, averaged. */
  meanBlows: number;
  /** How long a fight ran, averaged over the ones that were timed; null when none was. */
  meanMs: number | null;
  /** How many this character opened rather than joined. */
  opened: number;
  /** Epoch ms of the latest fight. */
  latest: number;
}

/**
 * What a printed monster name *is*: the first name on its ladder that the realm
 * table knows, or the printed name itself where the table knows none of them.
 *
 * Passed in rather than computed here because it needs the realm table, and
 * this module is dependency-free. `WorldGraph.mobAsPrinted` is the intended
 * implementation. **First hit, not any hit**: `mobNameCandidates` is an order
 * whose safety comes from the caller stopping at the first name the realm has
 * — `giant rat king` resolves to itself where the realm has it, and only to
 * `giant rat` where it does not — and a reader that took any rung of the
 * ladder would fold a rat king's fifty fights into the rat's two.
 */
export type MobResolver = (printed: string) => string;

/** The resolver for a client with no realm table: a name is itself. */
export const AS_PRINTED: MobResolver = (printed) => printed;

/**
 * Adds up every record about the asked monster. Records are keyed by the name
 * the server printed, modifier and all (`small elite guardsman`), and a card
 * asks by the table's bare name — so a record counts when its printed name
 * *resolves* to the same realm monster as the asked one. `small giant rat`
 * and `large giant rat` fold onto `giant rat`; `giant rat king` does not,
 * because the realm names it.
 */
export function summarizeFights(
  records: readonly FightRecord[],
  name: string,
  resolve: MobResolver = AS_PRINTED
): FightSummary | null {
  const wanted = mobKey(name);
  if (wanted.length === 0) return null;
  const target = resolve(wanted);
  const mine = records.filter((record) => record.mob === wanted || resolve(record.mob) === target);
  if (mine.length === 0) return null;
  const timed = mine.filter((record) => record.ms !== null);
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
  return {
    fights: mine.length,
    kills: mine.filter((record) => record.killed).length,
    meanMine: sum(mine.map((record) => record.mine)) / mine.length,
    meanBlows: sum(mine.map((record) => record.blows)) / mine.length,
    meanMs: timed.length === 0 ? null : sum(timed.map((record) => record.ms ?? 0)) / timed.length,
    opened: mine.filter((record) => record.opened).length,
    latest: Math.max(...mine.map((record) => record.at))
  };
}
