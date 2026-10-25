import { beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import { FareCash, type FareCashParts } from '../FareCash';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { coinWords, type CashPlace } from '../../../shared/world';

const BANK: CashPlace = {
  shop: 8,
  name: 'Bank of Godfrey',
  map: 1,
  room: 2170,
  roomName: 'Bank Lobby',
  copper: 3_000_000,
  detour: 4,
  moves: 4
};
const FARE = 2_000_000;
const SHORT = 500_000;

function at(map: number, room: number, copper: number | null = null): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map, number: room },
    banks:
      copper === null ? [] : [{ shop: 8, name: 'Bank of Godfrey', copper, at: Date.now() + 1 }]
  };
}

let seq = 0;
function block(type: BlockType, groups: Record<string, string>): Block {
  seq += 1;
  return {
    seq,
    at: Date.now(),
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

let sent: string[];
let notices: string[];
let walks: string[];
let walking: boolean;

function fareCash(over: Partial<FareCashParts> = {}): FareCash {
  return new FareCash({
    queue: {
      enqueue: (intent) => (sent.push(intent.command), true),
      cancel: () => 0
    },
    cashFrom: () => [BANK],
    routeTo: (room) => ({ steps: [{ from: '1/1', to: room }], cost: 1, blocked: false }) as never,
    walk: (route) => (walks.push(route.steps.at(-1)!.to), (walking = true), null),
    walking: () => walking,
    moveInFlight: () => false,
    escaping: () => false,
    notice: (message) => void notices.push(message),
    ...over
  });
}

beforeEach(() => {
  sent = [];
  notices = [];
  walks = [];
  walking = false;
});

describe('FareCash', () => {
  it('walks to the bank, draws the shortfall, and asks for the walk again', () => {
    const retry = vi.fn();
    const cash = fareCash();
    expect(cash.start(SHORT, FARE, '14/759', at(1, 1), retry)).toEqual({ kind: 'held' });
    expect(walks).toEqual(['1/2170']);
    expect(notices[0]).toBe(
      t('session.walk.fareCash.going', {
        fare: coinWords(FARE),
        short: coinWords(SHORT),
        bank: BANK.name
      })
    );
    // Still walking: nothing asked of the vault.
    cash.onCharacter(at(1, 50));
    expect(sent).toEqual([]);
    walking = false;
    cash.onCharacter(at(1, 2170));
    expect(sent).toEqual(['bank']);
    cash.onCharacter(at(1, 2170, 3_000_000));
    expect(sent).toEqual(['bank', `withdraw ${SHORT}`]);
    expect(retry).not.toHaveBeenCalled();
    cash.onBlock(block('user-withdraws', { amount: String(SHORT) }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(cash.busy).toBe(false);
  });

  it('refuses, said, where no bank on record holds the shortfall', () => {
    const cash = fareCash({ cashFrom: () => [] });
    const started = cash.start(SHORT, FARE, null, at(1, 1), vi.fn());
    const why = t('session.walk.fareCash.noBank', {
      fare: coinWords(FARE),
      short: coinWords(SHORT)
    });
    expect(started).toEqual({ kind: 'refused', why });
    expect(notices).toEqual([why]);
    expect(walks).toEqual([]);
  });

  it('ends without the walk where the vault holds less than its record', () => {
    const retry = vi.fn();
    const cash = fareCash();
    cash.start(SHORT, FARE, null, at(1, 2170), retry);
    expect(sent).toEqual(['bank']);
    cash.onCharacter(at(1, 2170, 100));
    expect(sent).toEqual(['bank']);
    expect(retry).not.toHaveBeenCalled();
    expect(cash.busy).toBe(false);
    expect(notices.at(-1)).toBe(
      t('session.walk.fareCash.bankShort', {
        bank: BANK.name,
        held: coinWords(100),
        short: coinWords(SHORT)
      })
    );
  });

  it('walks a leg again after a fight, and gives up past fareLegs', () => {
    const cash = fareCash();
    cash.start(SHORT, FARE, null, at(1, 1), vi.fn());
    // A fight stopped each leg short of the vault: the next is planned from there.
    for (let leg = 1; leg < tuning().banking.fareLegs; leg += 1) {
      walking = false;
      cash.onCharacter(at(1, 30 + leg));
    }
    expect(walks).toHaveLength(tuning().banking.fareLegs);
    walking = false;
    cash.onCharacter(at(1, 99));
    expect(cash.busy).toBe(false);
    expect(notices.at(-1)).toBe(t('automation.hostTrip.tooManyLegs', { place: BANK.roomName }));
  });

  it('waits out a fight before the next leg', () => {
    const cash = fareCash();
    cash.start(SHORT, FARE, null, at(1, 1), vi.fn());
    walking = false;
    cash.onCharacter({ ...at(1, 5), inCombat: true });
    expect(walks).toHaveLength(1);
    // The positive control: the fight over, the leg is walked.
    cash.onCharacter(at(1, 5));
    expect(walks).toHaveLength(2);
  });
});
