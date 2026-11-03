/**
 * The Hunting card's answers (todo 20261102-2305-02): one survey kept per
 * character with what it was run on, and a card holding it answered `same`
 * with the steps from where the character stands while nothing else the
 * survey reads has moved. A looping character moves every second and a
 * quarter, and the survey is the whole realm. See `mudengine-session` ›
 * parts/hosts.md.
 */
import type { CharacterState } from '../../shared/character';
import type { GatedGround, HuntingAdvice } from '../../shared/hunting';
import {
  huntingRooms,
  movedTo,
  type HuntingMoved,
  type HuntingReply
} from '../../shared/huntReply';
import type { RoomId } from '../../shared/world';

/** Where the character stands, as a survey from there would say it. */
export interface SurveyHere {
  from: NonNullable<HuntingAdvice['from']>;
  /** Fewest steps to every room the character can reach from there. */
  reach: ReadonlyMap<RoomId, number>;
  gated: GatedGround[];
}

/** What the answers are made of (`Errands`). */
export interface HuntAnswerParts {
  /** Everything the survey reads but the room, as one string; null where there is no realm to survey. */
  inputs(measure: string | null): string | null;
  /** The card's survey, run now. */
  survey(measure: string | null): HuntingAdvice;
  /** Where the character stands; null while unplaced. */
  here(): SurveyHere | null;
}

interface Kept {
  key: string;
  inputs: string;
  advice: HuntingAdvice;
  rooms: RoomId[];
  /** `reachPrint` of the reach it was run over. */
  reach: number;
}

export class HuntAnswers {
  private kept: Kept | null = null;
  /** Numbered from the clock at boot, so a key a tab held from before a restart names nothing kept. */
  private next = Date.now();

  constructor(private readonly parts: HuntAnswerParts) {}

  /** `held` is the key of the survey the card holds, null for none. */
  answer(held: string | null, measure: string | null): HuntingReply {
    const inputs = this.parts.inputs(measure);
    const kept = this.kept;
    if (inputs !== null && kept !== null && kept.inputs === inputs) {
      const moved = this.moved(kept);
      if (moved !== null) {
        if (held === kept.key) return { kind: 'same', key: kept.key, moved };
        const advice = movedTo(kept.advice, moved);
        if (advice !== null) return { kind: 'whole', key: kept.key, advice };
      }
    }
    const advice = this.parts.survey(measure);
    if (inputs === null || advice.refusal !== null) {
      this.kept = null;
      return { kind: 'whole', key: null, advice };
    }
    const here = this.parts.here();
    if (here === null) {
      this.kept = null;
      return { kind: 'whole', key: null, advice };
    }
    const key = String(this.next++);
    this.kept = { key, inputs, advice, rooms: huntingRooms(advice), reach: reachPrint(here.reach) };
    return { kind: 'whole', key, advice };
  }

  /**
   * The steps to the kept survey's rooms from where the character stands;
   * null where the reach from here is not the one it was run over, since a
   * lair gained or lost is a different survey.
   */
  private moved(kept: Kept): HuntingMoved | null {
    const here = this.parts.here();
    if (here === null || reachPrint(here.reach) !== kept.reach) return null;
    const steps: number[] = [];
    for (const id of kept.rooms) {
      const step = here.reach.get(id);
      if (step === undefined) return null;
      steps.push(step);
    }
    return { from: here.from, swept: here.reach.size, gated: here.gated, steps };
  }
}

/**
 * The rooms a reach holds, as one number: the same rooms give the same
 * number in any order, and a room lost for one gained is a different one.
 */
function reachPrint(reach: ReadonlyMap<RoomId, number>): number {
  let print = reach.size;
  for (const id of reach.keys()) {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index += 1) {
      hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
    }
    print = (print + (hash >>> 0)) % 4294967296;
  }
  return print;
}

/**
 * The character as the survey reads it, for its key: what moves with a step
 * or a blow and is read only through `reachKey` (health, the purse, the fight)
 * or not at all (the room, the tallies, the who list, whether it is sneaking
 * or resting now, the experience past whether a level is ready to train) is
 * left out, and so is the party, which the survey reads as its plan and its
 * share. Loot moves the pack, and a kill moves the key elsewhere anyway.
 */
export function surveyedState(state: CharacterState): unknown {
  const {
    room: _room,
    peeked: _peeked,
    sight: _sight,
    inCombat: _inCombat,
    combat: _combat,
    tally: _tally,
    statline: _statline,
    lastStatusAt: _lastStatusAt,
    updatedAt: _updatedAt,
    online: _online,
    shopListing: _shopListing,
    gangListing: _gangListing,
    banks: _banks,
    lastDeath: _lastDeath,
    party: _party,
    stealth: _stealth,
    vitals: { hp: _hp, mana, resting: _resting, meditating: _meditating, ...vitals },
    progress: { exp: _exp, expThisSession: _expThisSession, expNeeded, ...progress },
    ...read
  } = state;
  return {
    ...read,
    // `castingCost` and `healingCast` price a cycle begun rested, off the mana now only while its maximum is unread.
    vitals: { ...vitals, mana: vitals.manaMax === null ? mana : null },
    // `reachAfterTraining` asks only whether the next level is ready.
    progress: { ...progress, trainable: expNeeded === null ? null : expNeeded <= 0 }
  };
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/** A number for an object kept whole until it is replaced: the realm, the tuning. */
export function identityOf(value: object): number {
  let known = identities.get(value);
  if (known === undefined) {
    known = nextIdentity++;
    identities.set(value, known);
  }
  return known;
}
