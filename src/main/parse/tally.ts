/**
 * The running totals behind the Combat Stats card, folded from the block
 * stream.
 *
 * Placed exactly where `trackPlayers` is and for the same reason: this needs a
 * handful of facts off blocks that already have cases among the seventy-four in
 * `CharacterTracker.reduce`, and a line added to each of those cases would be
 * seventy-four chances to forget one. It runs **after** the reducer, over the
 * state the reducer produced and the state before it, so the engagement clock
 * can be read from the transition rather than from a case.
 *
 * It observes and never decides: nothing here touches the fight, the room or
 * the queue. A tally that could change what the client does would be a
 * measurement altering the thing it measures.
 */
import type { Block } from '../../shared/blocks';
import { DENOMINATIONS, type Denomination } from '../../shared/character';
import type { CharacterState } from '../../shared/character';
import { COPPER_PER } from '../../shared/coins';
import { blowKind, withArrival, withBlow, withSample, type CombatTally } from '../../shared/tally';
import { tuning } from '../app/tuning';

/** `You` and this character's own name are the same swing, said to two audiences. */
function isSelf(who: string | undefined, state: CharacterState): boolean {
  if (who === undefined) return false;
  if (/^you$/i.test(who)) return true;
  return state.name !== null && who.toLowerCase() === state.name.toLowerCase();
}

function int(value: string | undefined): number {
  const found = Number.parseInt(value ?? '', 10);
  return Number.isFinite(found) ? found : 0;
}

/**
 * A pick-up in copper, or nothing where the noun is not a coin this ladder
 * names.
 *
 * The conversion is done here rather than in `shared/tally.ts` because
 * `coins.ts` reads `DENOMINATIONS` out of `character.ts`, and `character.ts`
 * holds a `CombatTally` — so a shared tally that imported the ladder would
 * close a **value** cycle, which is the one this repository has already been
 * bitten by (`src/shared/__tests__/module-cycle.test.ts`). Main may import
 * both; neither shared module gains an edge.
 *
 * Only the first word of the noun is read (`gold` of `gold crowns`), the rule
 * `quotedInCopper` already states: the noun is realm data and a derivative
 * renames the runic coin outright.
 */
function inCopper(count: number, noun: string | undefined): number {
  const word = (noun ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  const denomination = DENOMINATIONS.find((name): name is Denomination => name === word);
  return denomination === undefined ? 0 : count * COPPER_PER[denomination];
}

/**
 * The tally after one block.
 *
 * Returns the same object when nothing was counted, so `CharacterTracker` can
 * tell "this block changed nothing" by identity, exactly as it does for the
 * player registry.
 */
export function trackTally(
  tally: CombatTally,
  block: Block,
  after: CharacterState,
  before: CharacterState,
  /**
   * Whether this block was read as a chance-on-hit off this character's own
   * gear — see `CharacterTracker.readsAsProc`.
   *
   * Handed in rather than derived, because the one thing that can attribute
   * such a line is the realm's item row and the round it landed in, and
   * neither is anywhere near here. Decided once so the ledger and this table
   * cannot disagree about the same blow.
   */
  proc = false
): CombatTally {
  const g = block.groups ?? {};
  let next = tally;

  const count = (change: Partial<CombatTally>): void => {
    next = { ...next, ...change, since: next.since ?? block.at, at: block.at };
  };

  switch (block.type) {
    /*
     * A landed blow. Only this character's own: somebody else's blow on the
     * same monster is a real fact the fight ledger records, and counting it
     * here would put another player's damage into this character's average.
     */
    case 'user-hits': {
      if (/^you$/i.test(g['target'] ?? '')) break;
      /*
       * A weapon's proc is this character's damage and **not** one of its
       * swings, so it gets its own kind rather than being folded into
       * `melee`: it lands off a swing that is already counted, and adding it
       * there would inflate the hit count that the accuracy share divides by
       * and drag the melee average down with a figure a weapon rolled. Its
       * line names nobody, so `blowKind` has nothing to read and the verdict
       * arrives from the tracker instead.
       */
      const kind = proc ? 'proc' : isSelf(g['attacker'], after) ? blowKind(g['line']) : null;
      if (kind === null) break;
      count({ dealt: { ...next.dealt, [kind]: withBlow(next.dealt[kind], int(g['damage'])) } });
      break;
    }

    /*
     * A swing that did not land. Counted apart from the kinds — there is no
     * such thing as a critical that missed — and it is the third share of the
     * same denominator, which is how MegaMUD's own window read it.
     */
    case 'user-misses':
      count({ missed: next.missed + 1 });
      break;

    /*
     * A blow on this character, and a blow with nobody behind it — a trap, a
     * spell's aftermath, the room. Both are damage that landed, which is what
     * `taken` counts; the difference is only whether anything could be named,
     * and a total that omitted the unattributable half would understate what
     * this character actually survived.
     */
    case 'mob-hits':
    case 'user-takes-damage':
      count({ taken: withBlow(next.taken, int(g['damage'])) });
      break;

    /*
     * A swing at this character that did no damage — and whether the server
     * said *why*.
     *
     * `but you dodge!`, `but you dodge it!`, `but you dodge out of the way!`
     * and `but you dodge the attack!` are 362 lines across the corpus, and
     * every one of them was being counted as an unexplained turn. A dodge is
     * a fact about the character; a swing that simply did nothing is a fact
     * about the swing, and the two do not belong in one figure.
     */
    case 'mob-misses':
      if (/\byou dodge\b/i.test(g['line'] ?? '')) count({ dodged: next.dodged + 1 });
      else count({ turned: next.turned + 1 });
      break;

    /*
     * Sneaking, MegaMUD's `Sneak:` row. Every `Attempting to sneak...` is an
     * attempt; the ones the server refused arrive with the refusal glued to
     * the attempt on one line, which is why `user-sneak-failed` counts as
     * both. `user-not-sneaking` — a sneak lost on entering a room — is
     * deliberately not folded in: see `CombatTally.sneakTried`.
     */
    case 'user-sneak-initiate':
      count({ sneakTried: next.sneakTried + 1 });
      break;

    case 'user-sneak-failed':
      count({ sneakTried: next.sneakTried + 1, sneakFailed: next.sneakFailed + 1 });
      break;

    /*
     * Coins off the floor. The server's own sentence, never a difference
     * between two readings of `Wealth:` — that figure moves when anything is
     * bought, sold, banked or dropped, so a rate read off it would call
     * spending income.
     */
    case 'user-gets-coins':
      count({ coins: next.coins + inCopper(int(g['count']), g['coin']) });
      break;

    /*
     * `You gain N experience.` — and, when the character was in a fight at the
     * time, a kill.
     *
     * The server never says a monster died; the client's own death suspicion
     * is what removes it from the room. So the kill count is *this* claim and
     * says so: experience gained while engaged. Experience from anything else
     * — a quest, a hand-in — arrives out of combat and is counted as
     * experience without being counted as a kill.
     */
    case 'user-gain-experience': {
      count({
        experience: next.experience + int(g['exp']),
        kills: before.inCombat ? next.kills + 1 : next.kills
      });
      // And the moment, for the rate graph (todo 08).
      next = withSample(
        next,
        block.at,
        tuning().parse.statsSampleMs,
        tuning().parse.statsSamplesKept
      );
      break;
    }

    default:
      break;
  }

  /*
   * The engagement clock, read off the transition rather than off the block.
   *
   * `*Combat Engaged*` and `*Combat Off*` are not the only things that move
   * `inCombat` — leaving the realm drops it too — and reading the transition
   * catches every one of them without a case per cause. An open interval that
   * never closes is settled by `leaveRealm` when the socket does.
   */
  if (after.inCombat && !before.inCombat) {
    next = { ...next, since: next.since ?? block.at, at: block.at, engagedSince: block.at };
  } else if (!after.inCombat && before.inCombat && next.engagedSince !== null) {
    next = {
      ...next,
      at: block.at,
      engagedMs: next.engagedMs + Math.max(0, block.at - next.engagedSince),
      engagedSince: null
    };
  }

  /*
   * And the clock the rates divide by, read off the same kind of transition:
   * in the realm or not. A tally that outlives the socket needs it, because
   * wall-clock time since `since` would count a night spent disconnected as
   * hours the character earned nothing in. `leaveRealm` closes it when the
   * socket does, since no block describes that moment. Every clock-opening
   * transition moves `at` as well: `at` is the moment a baseline dates its
   * scope from, and `clockSince` clamps an open clock to it — a clock opened
   * without moving `at` would be one the reset could not clamp.
   */
  if (after.phase === 'in-game' && before.phase !== 'in-game') {
    next = withArrival(
      {
        ...next,
        since: next.since ?? block.at,
        at: block.at,
        onlineSince: next.onlineSince ?? block.at
      },
      block.at,
      tuning().parse.statsSampleMs * tuning().parse.statsSamplesKept
    );
  } else if (after.phase !== 'in-game' && before.phase === 'in-game' && next.onlineSince !== null) {
    next = {
      ...next,
      at: block.at,
      onlineMs: next.onlineMs + Math.max(0, block.at - next.onlineSince),
      onlineSince: null,
      leftAt: block.at
    };
  }

  return next;
}
