/**
 * Whether an unattributed damage line is a chance-on-hit off this character's
 * own gear — decided once per block, before the reducer, and handed to both
 * of its readers, the fight's ledger and the tally (`CharacterTracker.apply`).
 *
 * Out of `CharacterTracker` (todo 724; `mudengine-wire` › `parts/tracker.md`).
 * No memory: it reads the block, the equipped kit's procs and the fight's
 * one-slot binding (`FightTracker.justStruck`). The rule and the sessions it
 * was measured over: `parts/combat.md` › *The write binds it; the realm
 * bounds it*.
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { itemHitProcs } from '../../shared/items';
import type { FightTracker } from './combat';

/**
 * A block that may sit between this character's blow and the proc it fired
 * without breaking the two apart.
 *
 * Exactly two things do, and both are the terminal rather than the realm: the
 * status line the server repaints in place after every write, and the blank
 * lines it pads with. Measured over all 581 procs in the recorded sessions of
 * 2026-09-06 — nothing else has ever appeared in that gap, and anything else
 * appearing there is another actor's line interleaved. See
 * `FightTracker.landed`.
 *
 * `unknown` is admitted **only when it carries no text**. An unclassified line
 * with words in it is somebody doing something — `Vulcan makes a complex
 * circling gesture!` is the start message of the cast that produced
 * captures/168's false candidate — and letting those through would give the
 * binding back the reach this exists to take away.
 *
 * Two readers: the proc binding (`CharacterTracker.apply`) and the death
 * sentence (`DeathSentence.heard`), whose kept line survives exactly these —
 * so widening this for procs widens the death sentence's window too.
 */
export function isProcHousekeeping(block: Block): boolean {
  if (block.type === 'status-line') return true;
  return block.type === 'unknown' && block.text.trim().length === 0;
}

/**
 * Whether an unattributed damage line is a chance-on-hit off this
 * character's own gear.
 *
 * The sentence a proc prints is the spell's own message data with the target
 * and the number substituted in — `A shining spark strikes cave worm for 3
 * damage!` — and there is **no attacker in it to read**. Booking it to
 * `Damage.others` was therefore a guess, and the guess that costs this
 * character credit for the kill it is about to make; reported 2026-09-06
 * with the Combat card reading `Dealt: 48 / Party/Others: 3` in a room the
 * character was alone in.
 *
 * Three things have to hold, and each is evidence rather than taste:
 *
 * 1. **The sentence named nobody.** `A` is an article and articles are never
 *    attackers, so `Classifier` leaves the group out. A line that *does* name
 *    somebody is that somebody's, whatever else is true.
 * 2. **The realm says this character wields something that fires one.**
 *    `Items.Abil-n` carries `PercentSpell` immediately before `CastsSp`
 *    (`itemHitProcs`), which is the pair `ItemType.cs` refuses to rewrite
 *    into a `use` — a `shimmering longsword` is a forty-per-cent chance of
 *    `silvery mace`, and its power of 1–3 is the 1, 2 and 3 the spark line
 *    carries. This is the only thing on the client that can attribute the
 *    blow at all.
 * 3. **It is the line the server wrote with this character's own last blow**
 *    — same monster, nothing but the repainted prompt in between, and that
 *    blow still has procs left to give. A proc is composed into the same
 *    write as the blow that fired it: all 581 in the recorded sessions of
 *    2026-09-06 arrive with nothing else in the gap, median 3 ms behind.
 *    This is the gate that keeps a party member's article-led spell out —
 *    `A withering blast of dragonfire sears storm giant king for 163
 *    damage!` (captures/168) names nobody and lands on the monster this
 *    character last hit, and is Vulcan's, four lines and two other players
 *    later. `parse.procWindowMs` bounds the other end, where a blow is
 *    followed by silence and then an unattributed line. **How many** is the
 *    realm's answer too: a round can carry several such lines, and the
 *    count of procs the equipped kit can fire is the ceiling on how many of
 *    them are this character's.
 *
 * All of it, so it declines rather than guesses: no realm loaded, an item
 * the index does not carry, or a pack nothing has listed all leave the blow
 * exactly where it was.
 */
export function readsAsProc(
  block: Block,
  state: CharacterState,
  fight: Pick<FightTracker, 'justStruck'>
): boolean {
  if (block.type !== 'user-hits') return false;
  const groups = block.groups ?? {};
  // A line that names an attacker is that attacker's, and `you` as the
  // target is a blow on this character rather than one it dealt.
  if (groups['attacker'] !== undefined) return false;
  const target = groups['target'];
  if (target === undefined || /^you$/i.test(target)) return false;
  const allowance = state.inventory.items.reduce(
    (total, held) => total + (held.equipped ? itemHitProcs(held).length : 0),
    0
  );
  return allowance > 0 && fight.justStruck(target, block.at, allowance);
}
