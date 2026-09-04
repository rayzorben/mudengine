/**
 * What a monster is, and whether it will start the fight.
 *
 * The one question auto-combat turns on — *is this thing going to attack me* —
 * and the realm data answers it, which is the standing rule of the world layer:
 * asking the server for something the shipped data already knows is a command
 * spent for nothing (docs/greatermud/rooms-and-items.md).
 *
 * **Read out of the server, not guessed.** `Mob.ShouldMobAttackTarget` decides
 * it from two columns of the `Monsters` table and nothing else: `Align`
 * (`MobAlignment`, 0–6) and `Type` (`TypeOfMob`, 0–3). A stationary monster —
 * a shopkeeper, a guard on a gate — plays by different rules from one that
 * walks, which the server's own comment calls out as a MajorMUD quirk it
 * inherited. Both tables are transcribed below and neither is a heuristic.
 *
 * Two of the seven alignments do not have a fixed answer: they attack, or not,
 * depending on how the *realm* ranks the character standing in front of them.
 * Those are carried as their own dispositions rather than being collapsed into
 * one of the two certain ones, because collapsing either way is a claim the
 * data does not support — and one of those directions gets somebody ambushed
 * while the other starts fights they did not choose.
 *
 * Dependency-free: the build script derives it, the tracker applies it, the
 * renderer draws it and the arbiter acts on it.
 */
import type { Alignment } from './character';

/**
 * What a monster does about a player who has done nothing to it.
 *
 * Named for the behaviour rather than for the realm's alignment word, because
 * the alignment word is not the answer on its own: `Evil` and `NeutralEvil`
 * behave identically while they walk and differently once they are stationary,
 * and `LawfulGood` is the *most* dangerous entry in the table to an outlaw.
 */
export type MobDisposition =
  /** Attacks any player on sight. `Evil`, `ChaoticEvil`, and `NeutralEvil` afoot. */
  | 'hostile'
  /** `LawfulEvil` afoot: attacks the well-behaved and leaves outlaws alone. */
  | 'hates-good'
  /** `LawfulGood` afoot: attacks `Outlaw` and worse, and nobody else. */
  | 'hates-evil'
  /** Fights only once something has hit it. Everything else. */
  | 'passive';

/**
 * Whether attacking one costs this character its standing.
 *
 * `Mob.GetEPCostForAttacking` charges **10 evil points** for attacking a `Good`
 * or `LawfulGood` monster and nothing at all for any other alignment. Ten of
 * those move a Neutral character (−50 up to 30 on the server's scale) into
 * Seedy and then Outlaw — which changes who attacks them, what the guards do
 * and how exposed they are to PvP.
 *
 * It is a fact about the *realm's* alignment column rather than about the
 * behaviour, so it does not fold into `MobDisposition`: a `LawfulGood` guard
 * afoot is `hates-evil` and a stationary one is `passive`, and attacking either
 * costs the same ten points.
 *
 * The client will not spend that unasked. See `AutoCombat`.
 */
export function costsAlignment(align: number): boolean {
  return align === 0 || align === 4;
}

/**
 * Whether attacking a monster of this *name* costs alignment.
 *
 * Three answers, because a name covers several realm rows and they need not
 * agree. `giant rat` in the shipped realm is two ChaoticEvil rows and one Good
 * one: attacking one is free two times in three and costs ten evil points the
 * third, and nothing in the stream says which is standing in front of you.
 *
 * The distinction is what keeps the refusal from swallowing the feature. A
 * monster that *always* costs is one no setting attacks unasked; one that
 * *might* is the same coin toss `WorldMob.uncertain` describes, and belongs to
 * the same setting rather than to a separate blanket refusal.
 */
export type AlignmentCost = 'never' | 'sometimes' | 'always';

/** Combines the per-row answers for one name. */
export function alignmentCost(rows: Iterable<boolean>): AlignmentCost {
  let any = false;
  let all = true;
  let seen = false;
  for (const costs of rows) {
    seen = true;
    if (costs) any = true;
    else all = false;
  }
  if (!seen || !any) return 'never';
  return all ? 'always' : 'sometimes';
}

/** Worst first. Used to combine rows that share a name. */
const DANGER: readonly MobDisposition[] = ['hostile', 'hates-good', 'hates-evil', 'passive'];

/**
 * The realm's own word for each, for a card that has to say why.
 *
 * A word before it is a hue, per docs/ui-design.md §6 — this is a fact a
 * decision about whether to keep walking gets made off.
 */
export const DISPOSITION_WORD: Record<MobDisposition, string> = {
  hostile: 'attacks on sight',
  'hates-good': 'attacks the lawful',
  'hates-evil': 'attacks outlaws',
  passive: 'attacks if attacked'
};

/**
 * The one-letter code a realm file carries.
 *
 * A letter rather than the word, because it is written 1,500 times into a file
 * that ships with the client and the word buys nothing a lookup does not.
 */
export const DISPOSITION_CODE: Record<MobDisposition, string> = {
  hostile: 'h',
  'hates-good': 'g',
  'hates-evil': 'e',
  passive: 'p'
};

const BY_CODE = new Map<string, MobDisposition>(
  (Object.keys(DISPOSITION_CODE) as MobDisposition[]).map((key) => [DISPOSITION_CODE[key], key])
);

/** A code out of a realm file, or null for anything this build does not know. */
export function dispositionFromCode(code: unknown): MobDisposition | null {
  return typeof code === 'string' ? (BY_CODE.get(code) ?? null) : null;
}

/**
 * `Monsters.Align` and `Monsters.Type` as the server reads them.
 *
 * Transcribed from `MobType.GetMobAlignment` / `GetTypeOfMob` and applied by
 * `Mob.ShouldMobAttackTarget`:
 *
 * | `Align` | | afoot | stationary |
 * |---|---|---|---|
 * | 0 | Good | if attacked | if attacked |
 * | 1 | Evil | always | always |
 * | 2 | ChaoticEvil | always | always |
 * | 3 | Neutral | if attacked | if attacked |
 * | 4 | LawfulGood | if you are Outlaw or worse | if attacked |
 * | 5 | NeutralEvil | always | **if attacked** |
 * | 6 | LawfulEvil | unless you are Seedy or worse | **if attacked** |
 *
 * `Type` 3 is `Stationary`; 0–2 (`Solo`, `Leader`, `Follower`) all walk. An
 * unrecognised value in either column falls back the way the server's own
 * `default:` arms do — `Neutral` and `Solo` — rather than being dropped, so a
 * derivative that adds a code produces a cautious answer instead of no answer.
 */
export function dispositionOf(align: number, type: number): MobDisposition {
  const stationary = type === 3;
  switch (align) {
    case 1:
    case 2:
      return 'hostile';
    case 5:
      return stationary ? 'passive' : 'hostile';
    case 6:
      return stationary ? 'passive' : 'hates-good';
    case 4:
      return stationary ? 'passive' : 'hates-evil';
    default:
      return 'passive';
  }
}

/**
 * The most dangerous of several, for a name several rows share.
 *
 * A name is all the wire ever gives, and 21 of the 1,514 names in the shipped
 * realm cover rows that disagree — `giant rat` among them, which is the first
 * monster anybody meets. Neither reading is safe on its own, so the *display*
 * takes the worst case and says it is uncertain, and the decision to swing
 * takes the certainty (see `WorldMob.uncertain`).
 */
export function worstDisposition(all: Iterable<MobDisposition>): MobDisposition {
  let worst: MobDisposition = 'passive';
  for (const one of all) {
    if (DANGER.indexOf(one) < DANGER.indexOf(worst)) worst = one;
  }
  return worst;
}

/**
 * Where the realm's alignment words sit on the scale the server compares.
 *
 * `GMUDServer.GetAlignmentTitle` turns a float into one of eight words at fixed
 * boundaries, and `ShouldMobAttackTarget` compares the *float*. Going back the
 * other way — word to number — only recovers a range, so this carries the range
 * and the two questions below are answered from it rather than from a midpoint
 * somebody picked.
 *
 * `Seedy` is the one band a boundary runs through: it spans 30 up to 40, and a
 * `LawfulEvil` monster attacks at `<= 30`. So a Seedy character is attacked by
 * one only at the exact bottom of their own band, which nothing on screen
 * distinguishes — and that is reported as *unknown* rather than resolved.
 *
 * `Lawful` is deliberately **absent**. It is in this client's `Alignment` union
 * and in the `who` pattern, and `GetAlignmentTitle` does not produce it — so
 * there is no band to place it in, and inventing one would decide a fight on a
 * number nobody has read. It reads as unknown, like every other absence here.
 */
const ALIGNMENT_RANGE: Partial<Record<Alignment, [number, number]>> = {
  Saint: [-1000, -200],
  Good: [-200, -50],
  Neutral: [-50, 30],
  Seedy: [30, 40],
  Outlaw: [40, 80],
  Criminal: [80, 120],
  Villain: [120, 210],
  FIEND: [210, 1000]
};

/**
 * Whether a monster will open the fight, given how the realm ranks you.
 *
 * Three answers, not two. `null` is *nobody can say*, and it is the honest one
 * whenever a conditional monster meets a character whose standing has not been
 * read yet — the roster is what carries an alignment, and it arrives from a
 * `who` listing rather than from anything the character does.
 *
 * Unknown must never read as `false` here for the same reason an unknown
 * maximum must never read as `0` on a meter: it would say "this is safe" about
 * something nothing has looked at.
 */
export function attacksOnSight(
  disposition: MobDisposition | null,
  mine: Alignment | null
): boolean | null {
  if (disposition === null) return null;
  if (disposition === 'hostile') return true;
  if (disposition === 'passive') return false;
  if (mine === null) return null;

  const band = ALIGNMENT_RANGE[mine];
  if (band === undefined) return null;
  const [low, high] = band;
  if (disposition === 'hates-good') {
    // `tempPlayer.Alignment <= 30.0f` — attacked while neutral or better.
    if (high <= 30) return true;
    if (low > 30) return false;
    return null; // Seedy: the boundary runs through the band.
  }
  // `hates-evil`: `tempPlayer.Alignment >= 40.0f` — Outlaw and worse.
  if (low >= 40) return true;
  if (high <= 40) return false;
  return null;
}

/**
 * The annotations the room listing hangs off a name, and the name underneath.
 *
 * `Player.cs` composes `Also here:` by appending to the name directly:
 * `*` when attacking that player costs no experience, `(Hidden)` when they are
 * hiding, and ` (Charmed)` for a monster somebody has enslaved. None of them is
 * part of the name, and all three are load-bearing: two of them are only ever
 * printed for a *player* and the third only ever for a *monster*, which makes
 * them the one thing in the line that says which it is.
 */
export interface OccupantMark {
  /** The name with the annotations taken off. */
  name: string;
  /** `*` — the realm charges nothing to attack them. Players only. */
  free: boolean;
  /** `(Hidden)`. Players only. */
  hidden: boolean;
  /** `(Charmed)` — under somebody's control. Monsters only. */
  charmed: boolean;
}

export function readOccupant(entry: string): OccupantMark {
  let name = entry.trim();
  let free = false;
  let hidden = false;
  let charmed = false;

  // Repeated because a player can be both free to attack and hiding, and the
  // server appends them in an order this must not depend on.
  for (;;) {
    const before = name;
    if (/\(Hidden\)$/i.test(name)) {
      hidden = true;
      name = name.slice(0, -'(Hidden)'.length).trim();
    }
    if (/\(Charmed\)$/i.test(name)) {
      charmed = true;
      name = name.slice(0, -'(Charmed)'.length).trim();
    }
    if (name.endsWith('*')) {
      free = true;
      name = name.slice(0, -1).trim();
    }
    if (name === before) break;
  }

  return { name, free, hidden, charmed };
}

/**
 * What the realm data knows about one name, for {@link classifyOccupant}.
 *
 * A shape rather than the graph itself, because this module is dependency-free
 * and the graph lives in main. The caller passes a lookup; nothing here holds a
 * realm.
 */
export interface MobFacts {
  disposition: MobDisposition | null;
  uncertain: boolean;
  /**
   * Whether attacking one costs this character ten evil points.
   *
   * `sometimes` when only some of the rows sharing this name are Good or
   * LawfulGood — see {@link AlignmentCost} for why the middle answer earns its
   * keep.
   */
  costly: AlignmentCost;
}

export interface OccupantSources {
  /** Names a `who` listing or an arrival broadcast gave. Lowercased. */
  players: ReadonlySet<string>;
  /** What the realm data says about a monster of this name, if anything. */
  mob(name: string): MobFacts | undefined;
}

/** One entry of `Also here:`, resolved as far as the evidence allows. */
export interface ClassifiedOccupant extends MobFacts {
  name: string;
  kind: 'player' | 'mob' | 'unknown';
  charmed: boolean;
  hidden: boolean;
  free: boolean;
}

/**
 * Which of the two kinds one entry of `Also here:` is.
 *
 * The order of the tests is the order of how much each source actually knows,
 * and it is not interchangeable — see `RoomOccupant` in `./character.ts` for
 * the reasoning written out. The short version: the roster is a statement, the
 * annotations are the server's own punctuation, the realm data is a table, and
 * capitalisation is a guess that only gets to decide when the other three have
 * said nothing.
 *
 * Names come out of the realm's `Monsters` table verbatim in the build this was
 * read against — `Mob.Name` is `MobType.MobName` unmodified — but the server
 * can also print a *modified* name, `MobNameModifierType.Before` and `.After`
 * hanging a word off either end (`fierce kobold thief`). Those modifiers are
 * realm data this client's `.mdb` does not carry, so an exact lookup is tried
 * first and then the same lookup with one word taken off each end. That is a
 * transcription of the server's own mechanism rather than the hand-written list
 * of adjectives the CoffeeScript engine carried, which was the same idea with
 * the data left out.
 */
export function classifyOccupant(entry: string, sources: OccupantSources): ClassifiedOccupant {
  const { name, free, hidden, charmed } = readOccupant(entry);
  const blank: ClassifiedOccupant = {
    name,
    kind: 'unknown',
    disposition: null,
    uncertain: false,
    costly: 'never',
    charmed,
    hidden,
    free
  };
  if (name.length === 0) return blank;

  // 1. The roster is a statement, not an inference.
  if (sources.players.has(name.toLowerCase())) return { ...blank, kind: 'player' };

  // 2. The server's own punctuation. `*` and `(Hidden)` are printed for players
  //    only and `(Charmed)` for monsters only, so any of them settles it — and
  //    a charmed monster still gets its realm-data disposition below.
  if (free || hidden) return { ...blank, kind: 'player' };

  // 3. The realm data, exactly and then allowing for a name modifier.
  const known = lookUpMob(name, sources);
  if (known) return { ...blank, kind: 'mob', ...known };
  if (charmed) return { ...blank, kind: 'mob' };

  // 4. Capitalisation, which decides only what nothing else would.
  return /[A-Z]/.test(name) ? blank : { ...blank, kind: 'mob' };
}

/**
 * Every spelling the realm might carry a printed name under, least stripping
 * first: the name itself, then one word off the front, one off the back, two
 * off the front, and so on.
 *
 * **Least stripping wins**, which is why this is an order and not a set. The
 * exact name is tried first, then one word off, then two, and the caller takes
 * the first hit — so a monster genuinely called `giant rat king` resolves to
 * itself where the realm has it, and only falls back to `giant rat` where it
 * does not. Taking more words off than necessary is the way this can be wrong
 * in the direction that matters: the disposition it leads to decides whether
 * the client swings, and a shorter name is a different monster.
 *
 * Both ends are tried because both exist — `MobNameModifierType.Before` and
 * `.After` — and the front is tried first at each width because a prefix is
 * what this family of games overwhelmingly uses. Neither modifier is a single
 * word: the server takes the whole rest of the line after `B:` or `A:`.
 *
 * Exported because the classifier is not the only thing that has to undo a
 * modifier. The Reference lookup is asked about the same names off the same
 * room listing, and when it carried no rule of its own it answered "the world
 * data does not name it" about `small elite guardsman` while the card beside
 * it was showing that monster's disposition and its alignment cost. One rule,
 * or the two ends of one client disagree about what the realm knows.
 */
export function mobNameCandidates(name: string): string[] {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return [];

  const candidates = [words.join(' ')];
  for (let drop = 1; drop < words.length; drop += 1) {
    candidates.push(words.slice(drop).join(' '));
    candidates.push(words.slice(0, words.length - drop).join(' '));
  }
  return candidates;
}

/** The realm's row for a name, allowing for a modifier on either end. */
function lookUpMob(name: string, sources: OccupantSources): MobFacts | undefined {
  for (const candidate of mobNameCandidates(name)) {
    const found = sources.mob(candidate);
    if (found) return found;
  }
  return undefined;
}

/**
 * Where a monster's name ends and the realm's own text begins.
 *
 * The server prints `The <name> <attack message>!` and `A <name> <arrival
 * verb> into the room from the <direction>!`, and **both middles are one run of
 * words with no punctuation between the two halves**. There is no grammar to
 * split them on: the message is realm data — `Monsters.AttName-0` is literally
 * the string `bites you`, and 876 distinct ones ship in one realm — so a client
 * that anchored on a verb would work until it met a monster nobody had tested.
 * docs/greatermud/messages.md is the whole argument.
 *
 * So the split is made on **evidence**, in the order of how much each source
 * knows, and it declines rather than guessing when neither has any:
 *
 * 1. **What the room is known to hold.** `Also here:` printed the name in the
 *    spelling the server uses, and that is also the spelling an `attack` has to
 *    use. Longest match wins — two monsters called `rat` and `giant rat` in one
 *    room must not resolve the second to the first.
 * 2. **The realm's monster table.** The longest prefix of the middle that
 *    *ends* in a name the realm knows, which is what allows for the modifier
 *    `MobNameModifierType.Before` hangs off the front (`large lashworm`) while
 *    still refusing to swallow the verb: `orc rogue slashes` only resolves if
 *    something called `slashes`, `rogue slashes` or `orc rogue slashes` is a
 *    monster, and `orc rogue` is.
 *
 * Returns `null` when neither source can say. That is the honest answer and the
 * safe one — a name invented here is a name auto-combat would swing at.
 */
/**
 * The name at the *end* of a fragment, for a line that names its target last.
 *
 * `nameInMessage` reads a monster off the front of `The <name> <verb> you`,
 * where the realm's own words come after the name. A first-person blow is the
 * other way round — `You critically slice gigantic black ooze`, `You fire an
 * acid jet at Thrag` — so the name is whatever the fragment *ends* in. Same two
 * sources, same order (the room in the spelling the server printed, then the
 * longest suffix the realm's monster table knows), and the same refusal to
 * guess: a fragment that ends in nothing either can name is a blow that landed
 * on something nothing could name, and the caller says so rather than
 * inventing one. Measured on the capture corpus (docs/capture-analysis.md §2),
 * the old rule that took everything after the verb set `combat.target` to
 * `fire an acid jet at Thrag` in 424 lines — a sentence fragment that a rule
 * interpolating `{target}` would then send into the room.
 */
export function nameAtEnd(fragment: string, sources: NameSources): string | null {
  const text = fragment.trim().replace(/[.!,]+$/, '');
  if (text.length === 0) return null;
  const lower = text.toLowerCase();

  // 1. The room, longest first, on a word boundary.
  let best: string | null = null;
  for (const who of sources.present()) {
    const name = who.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (lower !== key && !lower.endsWith(` ${key}`)) continue;
    if (best === null || name.length > best.length) best = name;
  }
  if (best !== null) return best;

  // 2. The realm data, longest suffix that is a name it knows. A suffix that
  //    begins with an article is skipped in favour of the one after it: the
  //    realm keys `the orc rogue` and `orc rogue` to one monster, and the
  //    spelling without the article is the one every consumer keys on.
  const words = text.split(/\s+/);
  for (let start = 0; start < words.length; start += 1) {
    if (/^(?:the|a|an)$/i.test(words[start] ?? '')) continue;
    const candidate = words.slice(start).join(' ');
    if (sources.mob(candidate)) return candidate;
  }
  return null;
}

/**
 * The name a fragment *starts* with, taken only from the room.
 *
 * For a line that names both sides — `Cercio chops massive ice dragon for 11
 * damage!` — the attacker is the leading name and the target the trailing one.
 * The realm's table is deliberately not consulted here: `nameInMessage` returns
 * the longest prefix that *ends* in a known monster, which on a line that also
 * names the target would swallow the verb and the target with it.
 */
export function nameLeading(fragment: string, sources: NameSources): string | null {
  const lower = fragment.trim().toLowerCase();
  let best: string | null = null;
  for (const who of sources.present()) {
    const name = who.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (lower !== key && !lower.startsWith(`${key} `)) continue;
    if (best === null || name.length > best.length) best = name;
  }
  return best;
}

export function nameInMessage(middle: string, sources: NameSources): string | null {
  const text = middle.trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();

  // 1. The room, longest first.
  let best: string | null = null;
  for (const who of sources.present()) {
    const name = who.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (lower !== key && !lower.startsWith(`${key} `)) continue;
    if (best === null || name.length > best.length) best = name;
  }
  if (best !== null) return best;

  // 2. The realm data, longest prefix that ends in a name it knows.
  const words = text.split(/\s+/);
  for (let end = words.length; end >= 1; end -= 1) {
    for (let start = 0; start < end; start += 1) {
      if (sources.mob(words.slice(start, end).join(' '))) return words.slice(0, end).join(' ');
    }
  }
  return null;
}

/** What {@link nameInMessage} may consult. */
export interface NameSources {
  /**
   * Names the room is known to hold, in the spelling the server printed.
   *
   * A call rather than a list, because the room changes with every step and a
   * list handed over once would name monsters from a room the character left an
   * hour ago.
   */
  present(): readonly string[];
  /** What the realm data says about a monster of this name, if anything. */
  mob(name: string): MobFacts | undefined;
}
