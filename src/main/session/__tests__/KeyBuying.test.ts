import { describe, expect, it } from 'vitest';

import { KeyBuying, type KeyBuyingParts } from '../KeyBuying';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { chargedInCopper, coveredBy } from '../../../shared/coins';
import type { Plan } from '../../../shared/navigation';
import { coinWords, type Route, type RouteStep } from '../../../shared/world';

const step = (from: string, to: string, item?: number): RouteStep =>
  ({
    from,
    to,
    direction: 'e',
    command: 'e',
    name: to,
    requirement: item === undefined ? null : { kind: 'item', raw: `Item: ${item}`, keyId: item }
  }) as RouteStep;

/* Round by the vortex: long, and the search met the guild's door. */
const round: Route = {
  steps: Array.from({ length: 12 }, (_, i) => step(`6/${i}`, `6/${i + 1}`)),
  cost: 12,
  blocked: false,
  keysAhead: true
};
/* The same way, where the search met no keyed door. */
const unkeyed: Route = { steps: round.steps, cost: 12, blocked: false };
/* Through the guild's door, the mine pass bought at its counter. */
const through: Route = {
  steps: [step('6/0', '6/1567'), step('6/1567', '6/1568', 942), step('6/1568', '6/12')],
  cost: 3,
  blocked: false
};
const pass = { id: 942, name: 'mine pass' };
const plan: Extract<Plan, { kind: 'plan' }> = {
  kind: 'plan',
  steps: [
    { kind: 'walk', route: { ...through, steps: through.steps.slice(0, 1) } },
    { kind: 'buy', item: pass, room: '6/1567' },
    { kind: 'walk', route: { ...through, steps: through.steps.slice(1) } }
  ],
  cost: 3
};

const listed = (at: number | null): CharacterState => ({
  ...EMPTY_CHARACTER,
  inventory: { ...EMPTY_CHARACTER.inventory, listedAt: at, rows: [] }
});

function rig(over: Partial<KeyBuyingParts> = {}, clock = { now: 0 }) {
  const said: string[] = [];
  const asked: string[] = [];
  const parts: KeyBuyingParts = {
    choices: () => ({ buyKeys: true, buyKeysMaxGold: 500 }),
    boughtTo: () => ({ way: through, plan }),
    priceAt: () => 10_000,
    listPack: () => {
      asked.push('i');
      return true;
    },
    notice: (message) => said.push(message),
    ...over
  };
  return { keys: new KeyBuying(parts, () => clock.now), said, asked, clock };
}

describe('a walk that can buy its key on the way', () => {
  it('buys the mine pass for the shorter way, and says what and for how much', () => {
    const { keys, said } = rig();
    const choice = keys.choose(round, false, listed(1));
    expect(choice).toMatchObject({
      kind: 'buy',
      way: through,
      items: [expect.objectContaining({ id: 942 })]
    });
    expect(said).toEqual([
      t('session.walk.keys.buying', {
        items: 'mine pass',
        price: coinWords(chargedInCopper(10_000, EMPTY_CHARACTER.progress.charm)),
        moves: 3,
        instead: 12
      })
    ]);
  });

  it('walks the way round where the keys cost more than the ceiling, and says so', () => {
    const { keys, said } = rig({ choices: () => ({ buyKeys: true, buyKeysMaxGold: 50 }) });
    expect(keys.choose(round, false, listed(1))).toEqual({ kind: 'walk' });
    expect(said).toEqual([
      t('session.walk.keys.overCeiling', {
        items: 'mine pass',
        price: coinWords(chargedInCopper(10_000, EMPTY_CHARACTER.progress.charm)),
        ceiling: 50
      })
    ]);
  });

  it('walks the way round where the price is unknown, and says so', () => {
    const { keys, said } = rig({ priceAt: () => null });
    expect(keys.choose(round, false, listed(1))).toEqual({ kind: 'walk' });
    expect(said).toEqual([t('session.walk.keys.unpriced', { item: 'mine pass' })]);
  });

  it('does nothing with the setting off, or where the search met no keyed door', () => {
    const off = rig({ choices: () => ({ buyKeys: false, buyKeysMaxGold: 500 }) });
    expect(off.keys.choose(round, false, listed(1))).toEqual({ kind: 'walk' });
    const plain = rig();
    expect(plain.keys.choose(unkeyed, false, listed(1))).toEqual({
      kind: 'walk'
    });
    expect([...off.said, ...plain.said]).toEqual([]);
  });

  it('lists an unlisted pack first, and lets the walk go once the listing is read', () => {
    const { keys, asked, said } = rig();
    expect(keys.choose(through, true, listed(null))).toEqual({ kind: 'listing' });
    expect(asked).toEqual(['i']);
    expect(said).toEqual([t('session.walk.keys.listing')]);
    expect(keys.released(listed(null))).toBeNull();
    expect(keys.released(listed(5))).toEqual({ route: through, run: true, listed: true });
    expect(keys.released(listed(5))).toBeNull();
  });

  it('walks as planned when the listing never comes, and says so', () => {
    const clock = { now: 0 };
    const { keys, said } = rig({}, clock);
    keys.choose(through, false, listed(null));
    clock.now = tuning().queue.unreadRetryMs;
    expect(keys.released(listed(null))).toEqual({ route: through, run: false, listed: false });
    expect(said.at(-1)).toBe(t('session.walk.keys.unlisted'));
  });

  it('asks for no listing on a way past no keyed door', () => {
    const { keys, asked } = rig();
    expect(keys.choose(unkeyed, false, listed(null))).toEqual({
      kind: 'walk'
    });
    expect(asked).toEqual([]);
  });
});

describe('what the purse and the bank can pay', () => {
  it('pays from the purse, or from one bank holding the rest', () => {
    expect(coveredBy(100, 100, [])).toBe(true);
    expect(coveredBy(100, 40, [{ copper: 60 }])).toBe(true);
    expect(coveredBy(100, 40, [{ copper: 30 }, { copper: 30 }])).toBe(false);
    expect(coveredBy(100, null, [{ copper: 1000 }])).toBeNull();
  });
});
