/**
 * A monster's death sentence, learned from where it stands: the unread line
 * immediately before this character's experience line, when it names the
 * target, is that monster's death, and the realm's lore is told.
 *
 * Out of `CharacterTracker` (todo 724; `mudengine-wire` › `parts/tracker.md`).
 * One memory, the last unread line, kept for one block: `heard` after the
 * reducer, `before` from the experience line's case. The rule and the live
 * runs behind it: `parts/combat.md` › *And the sentence is learned
 * positionally, then read whole*.
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { MobLore } from '../../shared/lore';
import { answersTo, rowNameOf } from '../../shared/mobs';
import { splitSpells } from '../../shared/spell-messages';
import { mobKey } from '../../shared/world';
import { isProcHousekeeping } from './proc';

/** What the learning reads from the rest of the character, handed in as `FightSources` are. */
export interface DeathSentenceSources {
  /** Whether the realm knows a monster by this name (`WorldGraph.mob`); false with no realm. */
  known(name: string): boolean;
  /** Where a learned sentence is written. */
  lore: Pick<MobLore, 'observeDeath'>;
}

/**
 * The shape of a death sentence, as far as free text has one: one sentence,
 * ending in a full stop or a bang, no figure in it, not a paragraph. Enough to
 * keep a listing row, a damage line the frames missed, or a `Location:` out of
 * the lore; the naming test beside it does the rest.
 */
function looksLikeDeathSentence(text: string): boolean {
  if (!/[.!]$/.test(text)) return false;
  if (/\d/.test(text)) return false;
  return text.split(/\s+/).length <= 20;
}

/**
 * Whether `text` says `name` as whole words, in the monster key's spelling —
 * or with the room's leading modifier dropped: the room lists `thin kobold`
 * and the realm's death sentence reads `The kobold falls to the ground with a
 * shriek!`, because `MobNameModifierType.Before` hangs the word on the room's
 * spelling and the message record never carries it (live, 2026-09-12; the
 * kill went unlearned and cost a stat sheet). The drop is `answersTo`'s: one
 * word, and only where the realm knows the shorter name and not the longer —
 * `kobold thief` is a row of its own, and the thief's sentence would
 * otherwise be written down as its death for good.
 *
 * A scan rather than a pattern built from the name: `compiled-patterns.test.ts`
 * holds every runtime-built expression to module load, and a key is letters
 * a word boundary is *not a letter* around.
 */
function namesMob(text: string, name: string, known: (name: string) => boolean): boolean {
  const key = mobKey(name);
  if (key.length === 0) return false;
  if (saysKey(text, key)) return true;
  const space = key.indexOf(' ');
  if (space <= 0) return false;
  const rest = key.slice(space + 1);
  return answersTo(key, rest, known) && saysKey(text, rest);
}

/**
 * Whether `text` names the target by a shorter noun its author chose, as the
 * sentence's subject: `The gnoll drops…` for `gnoll axeman`, `The fungus
 * tree collapses…` for `black fungus tree` (todo 751; orohost wire, 604 kills
 * unlearned). The subject, because a run said anywhere matched `the` in *to
 * the ground* and `black` in *black fluid* (realm data: 21 lair-mate pairs,
 * 5 as the subject). And only where no other listed monster answers to it: an
 * area caster is paid for every kill whatever it targets (GreaterMUD
 * `Mob.cs:2313-2344`), so beside a `big gnoll scout` the sentence may be the
 * scout's. A lesson is kept, so one settled room is enough.
 */
function namesPart(
  text: string,
  target: string,
  others: readonly string[],
  known: (name: string) => boolean
): boolean {
  // `mobKey` drops the leading article, so this is the subject onwards.
  const subject = mobKey(text);
  const words = mobKey(rowNameOf(target, known)).split(' ');
  const said: string[] = [];
  for (let from = 0; from < words.length; from++) {
    for (let to = from + 1; to <= words.length; to++) {
      const run = words.slice(from, to).join(' ');
      if (to - from < words.length && subject.startsWith(`${run} `)) said.push(run);
    }
  }
  if (said.length === 0) return false;
  return !others.some((other) => said.some((run) => saysKey(mobKey(other), run)));
}

function saysKey(text: string, key: string): boolean {
  const hay = mobKey(text);
  for (let from = 0; ;) {
    const at = hay.indexOf(key, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : hay.charAt(at - 1);
    const after = hay.charAt(at + key.length);
    if (!isKeyLetter(before) && !isKeyLetter(after)) return true;
    from = at + 1;
  }
}
const isKeyLetter = (ch: string): boolean => ch >= 'a' && ch <= 'z';

export class DeathSentence {
  /**
   * The last line the table could not read, kept for exactly one block.
   *
   * A monster's death sentence is realm data (`MobType.DeathMessage.Line3`)
   * and arrives immediately before `You gain N experience.` — 29 of 29 in the
   * live run of 2026-09-12 — so the experience line is what says, after the
   * fact, that the unread line before it was the target dying. Cleared by any
   * block but a prompt, as `landed` is: a line in between is somebody else's.
   */
  private lastUnknown: { text: string; at: number; candidates?: readonly string[] } | null = null;

  constructor(private readonly sources: DeathSentenceSources) {}

  /**
   * A block has been applied: keep it if it may be the sentence the next
   * experience line confirms, and let go of the last one otherwise. After the
   * reducer, so the experience line reads the line before it.
   */
  heard(block: Block): void {
    if (block.type === 'unknown') {
      const text = block.text.trim();
      if (text.length > 0) this.lastUnknown = { text, at: block.at };
    } else if (block.type === 'mob-dies' && block.groups['mob'] === undefined) {
      /*
       * A death sentence the realm's table shares between monsters, which the
       * room could not settle (`Classifier.asDeathSentence`): nobody left the
       * room on it, and it stands here as the candidate the experience line
       * can still name — the target it names is the one that died.
       */
      const text = block.text.trim();
      const candidates = splitSpells(block.groups['mobs']);
      if (text.length > 0 && candidates.length > 0) {
        this.lastUnknown = { text, at: block.at, candidates };
      }
    } else if (!isProcHousekeeping(block)) {
      this.lastUnknown = null;
    }
  }

  /**
   * Whether the line before the experience line was the target's own death
   * sentence — and if so, the realm learns it.
   *
   * Positional, not grammatical: there is no grammar to match, so the test is
   * that an unread line arrived immediately before the kill was confirmed by
   * other means **and names the monster this character was fighting**. The
   * target is the constraint that makes it safe — the experience is this
   * character's, so the thing that died is the thing it was hitting — and
   * `looksLikeDeathSentence` keeps a listing row or a figure out. Once
   * learned, the same sentence with no experience line behind it is a kill
   * somebody else landed (`mob-dies`).
   */
  before(s: CharacterState, at: number): 'sentence' | 'experience' {
    const last = this.lastUnknown;
    const target = s.combat.target;
    if (last === null || target === null) return 'experience';
    if (!looksLikeDeathSentence(last.text)) return 'experience';
    // A sentence the shipped table shares between monsters names the target
    // when the target is one of them, its modifier admitted as `namesMob`
    // admits it; any other line has to say the target's name itself.
    const known = this.sources.known;
    const others = s.room.occupants
      .filter((there) => there.kind === 'mob' && mobKey(there.name) !== mobKey(target))
      .map((there) => there.name);
    const named =
      last.candidates !== undefined
        ? last.candidates.some((candidate) => answersTo(mobKey(target), candidate, known))
        : namesMob(last.text, target, known) || namesPart(last.text, target, others, known);
    if (!named) return 'experience';
    this.sources.lore.observeDeath?.(target, last.text, at);
    return 'sentence';
  }

  /** A new connection: the line before it was about a session that is gone. */
  forget(): void {
    this.lastUnknown = null;
  }
}
