import { beforeEach, describe, expect, it } from 'vitest';

import { StopperOutfit, type StopperOutfitParts } from '../StopperOutfit';
import { t } from '../../app/i18n';
import type { StopperAnswer } from '../../automation/PartyStoppers';
import type { SafetyDecision } from '../../../shared/automation';
import type { Block } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState, type PartyMember } from '../../../shared/character';
import { chargedInCopper } from '../../../shared/coins';
import { wireItem } from '../../../shared/entities';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { coinWords } from '../../../shared/world';
import type { WayStopper } from '../../world/navigation/stoppers';

const RIVER: WayStopper = {
  spell: 753,
  name: 'river damage',
  items: [{ id: 690, name: 'log raft' }]
};
const LAUNCH = {
  room: '1/1814',
  at: { map: 1, room: 1814 },
  shop: 'Boat Launch',
  item: { id: 690, name: 'log raft' }
};
const RAFT_COPPER = 300;

const member = (name: string): PartyMember => ({
  name,
  className: null,
  health: 1,
  mana: null,
  rank: null,
  activity: null,
  invited: false,
  vitals: null,
  pool: null,
  sheet: null
});

/** Rayzor leading Brakkle, at the pier with some copper, the pack listed. */
function leading(
  over: {
    rafts?: number;
    wealth?: number | null;
    here?: string[];
    following?: string | null;
  } = {}
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  const rafts = over.rafts ?? 0;
  return {
    ...base,
    phase: 'in-game',
    name: 'Rayzor',
    room: {
      ...base.room,
      map: 1,
      number: 1813,
      occupants: (over.here ?? ['Brakkle']).map((name) => ({
        name,
        kind: 'player' as const,
        disposition: null,
        uncertain: false,
        costly: 'never' as const,
        charmed: false,
        hidden: false,
        free: false
      }))
    },
    inventory: {
      ...base.inventory,
      listedAt: 1,
      rows: rafts > 0 ? [690] : [],
      items: Array.from({ length: rafts }, () => wireItem('log raft')),
      wealth: over.wealth === undefined ? 1000 : over.wealth
    },
    party: {
      ...base.party,
      following: over.following ?? null,
      members: [member('Rayzor'), member('Brakkle')]
    }
  };
}

let answers: Map<string, StopperAnswer>;
let asking: string[];
let purses: Map<string, number | null>;
let sent: string[];
let notices: string[];
let decisions: SafetyDecision[];
let fetched: Array<{ name: string; min: number; max: number; shop: string }>;
let fetching: boolean;
let retried: number;
let now: number;
let forgotten: string[];
let outfit: StopperOutfit;
let parts: StopperOutfitParts;

beforeEach(() => {
  answers = new Map();
  asking = [];
  purses = new Map();
  sent = [];
  notices = [];
  decisions = [];
  fetched = [];
  fetching = false;
  retried = 0;
  now = 10_000;
  forgotten = [];
  parts = {
    stoppers: {
      settle: (_question, members) => ({
        asking: asking.filter((who) => members.includes(who)),
        answers: new Map([...answers].filter(([who]) => members.includes(who)))
      }),
      askWealth: (who) => {
        sent.push(`${who} @wealth`);
        return true;
      },
      purseOf: (who) => purses.get(who),
      forget: (who) => void forgotten.push(who)
    },
    counterFor: () => LAUNCH,
    priceAt: () => RAFT_COPPER,
    fetch: (row) => {
      fetched.push({ name: row.name, min: row.min, max: row.max, shop: row.shop });
      fetching = true;
      return null;
    },
    fetching: () => fetching,
    give: (item, who) => {
      sent.push(`give ${item} to ${who}`);
      return true;
    },
    tellDo: (who, command) => {
      sent.push(`${who} @do ${command}`);
      return true;
    },
    walkTo: (room) => {
      sent.push(`walk ${room}`);
      return null;
    },
    walking: () => false,
    notice: (message) => notices.push(message),
    decided: (decision) => decisions.push(decision)
  };
  outfit = new StopperOutfit(parts, () => now);
});

const retry = (): void => void (retried += 1);
const gave = (who: string): Block =>
  ({ type: 'user-gives', groups: { item: 'log raft', target: who } }) as unknown as Block;

describe('outfitting the party against the river', () => {
  it('walks at once where the way wants nothing, or everyone carries one', () => {
    expect(outfit.consider([], leading(), false, retry)).toEqual({ kind: 'go' });
    answers.set('Brakkle', { kind: 'has', item: 690 });
    expect(outfit.consider([RIVER], leading(), false, retry)).toEqual({ kind: 'go' });
    expect(outfit.busy).toBe(false);
    expect(retried).toBe(0);
  });

  it('holds while a member is asked, and refuses naming one who never answered', () => {
    asking = ['Brakkle'];
    const held = outfit.consider([RIVER], leading(), false, retry);
    expect(held).toEqual({
      kind: 'held',
      said: t('automation.stoppers.asking', {
        who: 'Brakkle',
        spell: 'river damage',
        items: 'log raft'
      })
    });
    expect(outfit.busy).toBe(true);
    outfit.onCharacter(leading());
    expect(notices).toHaveLength(1);
    asking = [];
    answers.set('Brakkle', { kind: 'silent' });
    outfit.onCharacter(leading());
    expect(outfit.busy).toBe(false);
    expect(decisions.at(-1)?.refused).toBe(
      t('automation.stoppers.refusalSilent', {
        who: 'Brakkle',
        spell: 'river damage',
        items: 'log raft'
      })
    );
    expect(retried).toBe(0);
  });

  it('buys a raft for a member who lacks one, hands it over here, and walks on once they say so', () => {
    answers.set('Brakkle', { kind: 'lacks' });
    const price = chargedInCopper(RAFT_COPPER, EMPTY_CHARACTER.progress.charm);
    expect(outfit.consider([RIVER], leading({ rafts: 1 }), false, retry)).toEqual({
      kind: 'held',
      said: t('automation.stoppers.buying', {
        count: 1,
        item: 'log raft',
        shop: 'Boat Launch',
        price: coinWords(price),
        who: 'Brakkle'
      })
    });
    expect(fetched).toEqual([{ name: 'log raft', min: 2, max: 2, shop: 'Boat Launch' }]);
    // The errand runs; nothing is handed over yet.
    outfit.onCharacter(leading({ rafts: 1 }));
    expect(sent).toEqual([]);
    fetching = false;
    outfit.onCharacter(leading({ rafts: 2 }));
    expect(sent).toEqual(['give log raft to Brakkle']);
    outfit.onBlock(gave('Brakkle'));
    expect(forgotten).toEqual(['Brakkle']);
    // Asked again after the hand-over, and now carrying one.
    answers.set('Brakkle', { kind: 'has', item: 690 });
    outfit.onCharacter(leading({ rafts: 1 }));
    expect(retried).toBe(1);
    expect(outfit.busy).toBe(false);
    expect(notices.at(-1)).toBe(t('automation.stoppers.settled'));
  });

  it("buys this character's own copy too for a lap, and refuses where the purse is short", () => {
    answers.set('Brakkle', { kind: 'lacks' });
    outfit.consider([RIVER], leading(), true, retry);
    expect(fetched).toEqual([{ name: 'log raft', min: 2, max: 2, shop: 'Boat Launch' }]);
    outfit.abandon('test');
    fetched = [];
    const short = leading({ wealth: 10 });
    const why = t('automation.stoppers.refusalPurse', {
      item: 'log raft',
      price: coinWords(2 * chargedInCopper(RAFT_COPPER, EMPTY_CHARACTER.progress.charm))
    });
    expect(outfit.consider([RIVER], short, true, retry)).toEqual({ kind: 'refused', why });
    expect(fetched).toEqual([]);
    expect(decisions.at(-1)?.refused).toBe(why);
    expect(outfit.busy).toBe(false);
  });

  it('waits for a member who is not here, and gives up naming them', () => {
    answers.set('Brakkle', { kind: 'lacks' });
    outfit.consider([RIVER], leading({ rafts: 1 }), false, retry);
    fetching = false;
    outfit.onCharacter(leading({ rafts: 2, here: [] }));
    expect(sent).toEqual([]);
    now += DEFAULT_INTERNAL.tuning.remotes.replyMs + 1;
    outfit.onCharacter(leading({ rafts: 2, here: [] }));
    expect(decisions.at(-1)?.refused).toBe(
      t('automation.stoppers.refusalNotHere', { who: 'Brakkle', item: 'log raft' })
    );
    expect(outfit.busy).toBe(false);
  });

  it('has a member buy their own where this character cannot pay, at the counter, by @do', () => {
    answers.set('Brakkle', { kind: 'lacks' });
    const price = chargedInCopper(RAFT_COPPER, EMPTY_CHARACTER.progress.charm);
    const poor = leading({ rafts: 1, wealth: 10 });
    expect(outfit.consider([RIVER], poor, false, retry)).toEqual({
      kind: 'held',
      said: t('automation.stoppers.askingWealth', {
        who: 'Brakkle',
        item: 'log raft',
        price: coinWords(price)
      })
    });
    expect(sent).toEqual(['Brakkle @wealth']);
    outfit.onCharacter(poor);
    purses.set('Brakkle', price);
    outfit.onCharacter(poor);
    expect(sent).toEqual(['Brakkle @wealth', 'walk 1/1814']);
    // At the counter with them: told to buy, then asked again after the buy's window.
    const atCounter = { ...poor, room: { ...poor.room, number: 1814 } };
    outfit.onCharacter(atCounter);
    expect(sent.at(-1)).toBe('Brakkle @do buy log raft');
    now += DEFAULT_INTERNAL.tuning.supplies.buyTimeoutMs + 1;
    outfit.onCharacter(atCounter);
    expect(forgotten).toEqual(['Brakkle']);
    answers.set('Brakkle', { kind: 'has', item: 690 });
    outfit.onCharacter(atCounter);
    expect(retried).toBe(1);
  });

  it('refuses naming a member whose purse is short, or who never said', () => {
    answers.set('Brakkle', { kind: 'lacks' });
    const poor = leading({ rafts: 1, wealth: 10 });
    outfit.consider([RIVER], poor, false, retry);
    purses.set('Brakkle', 5);
    outfit.onCharacter(poor);
    expect(decisions.at(-1)?.refused).toBe(
      t('automation.stoppers.refusalMemberPurse', {
        who: `Brakkle (${coinWords(5)})`,
        item: 'log raft',
        price: coinWords(chargedInCopper(RAFT_COPPER, EMPTY_CHARACTER.progress.charm))
      })
    );
    outfit.consider([RIVER], poor, false, retry);
    purses.set('Brakkle', null);
    outfit.onCharacter(poor);
    expect(decisions.at(-1)?.refused).toBe(
      t('automation.stoppers.refusalWealthSilent', { who: 'Brakkle', item: 'log raft' })
    );
  });

  it('asks nobody while following, and refuses while another outfitting runs', () => {
    asking = ['Brakkle'];
    expect(outfit.consider([RIVER], leading({ following: 'Brakkle' }), false, retry)).toEqual({
      kind: 'go'
    });
    expect(outfit.consider([RIVER], leading(), false, retry).kind).toBe('held');
    expect(outfit.consider([RIVER], leading(), false, retry)).toEqual({
      kind: 'refused',
      why: t('automation.stoppers.busy')
    });
  });
});
