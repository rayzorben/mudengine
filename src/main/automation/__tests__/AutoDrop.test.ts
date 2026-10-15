import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionKind } from '../../../shared/decisionSettings';

import { AutoDrop } from '../AutoDrop';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { DEFAULT_DROP, type DropConfig } from '../../../shared/packConfig';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';
import type { SafetyDecision } from '../../../shared/automation';
import type { QuestKeep } from '../../../shared/questKeep';
import { t } from '../../app/i18n';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const config = (over: Partial<DropConfig> = {}): DropConfig => ({
  ...DEFAULT_DROP,
  enabled: true,
  items: ['rusty sword'],
  whenEncumbered: false,
  worthless: false,
  ...over
});

function item(name: string, over: Partial<CarriedItem> = {}): CarriedItem {
  return { ...wireItem(name), ...over };
}

/** A character in the realm carrying `items`, graded `word` by the listing. */
function carrying(items: CarriedItem[], word: string | null = null): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    inventory: { ...base.inventory, items, encumbranceWord: word }
  };
}

let sent: string[];
/** The decision each sent command was offered as, in send order. */
let kinds: Array<DecisionKind | undefined>;
let queue: CommandQueue;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  kinds = [];
  wantedBy = () => null;
  notices = [];
  decisions = [];
  queue = new CommandQueue(automation, {
    send: (command, intent) => {
      sent.push(command);
      kinds.push(intent.decision);
    }
  });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

let wantedBy: QuestKeep['wantedBy'];
let notices: string[];
let decisions: SafetyDecision[];
const make = (over: Partial<DropConfig> = {}, enabled = true): AutoDrop =>
  new AutoDrop(
    config(over),
    enabled,
    queue,
    { wantedBy: (it) => wantedBy(it) },
    {
      notice: (message) => notices.push(message),
      decided: (decision) => decisions.push(decision)
    }
  );
const drain = (): void => void vi.advanceTimersByTime(500);

describe('shedding named junk', () => {
  it('drops an item on the list the moment the pack lists it', () => {
    const auto = make();
    auto.onCharacter(carrying([item('rusty sword')]));
    drain();
    expect(sent).toEqual(['drop rusty sword']);
    expect(kinds).toEqual(['drop-junk']);
  });

  it('matches by the server’s own rule for a typed name', () => {
    // `rusty` is a prefix of `rusty sword`, exactly as `drop rusty` would be.
    const auto = make({ items: ['rusty'] });
    auto.onCharacter(carrying([item('rusty sword')]));
    drain();
    expect(sent).toEqual(['drop rusty sword']);
  });

  it('proposes nothing while the module or the master switch is off', () => {
    make({ enabled: false }).onCharacter(carrying([item('rusty sword')]));
    make({}, false).onCharacter(carrying([item('rusty sword')]));
    drain();
    expect(sent).toEqual([]);
  });

  /* A worn helm that answers to a junk name stays on the head. */
  it('never drops an equipped item, whatever the list says', () => {
    const auto = make({ items: ['rusty'] });
    auto.onCharacter(
      carrying([item('rusty helm', { equipped: true, slot: 'Head' }), item('rusty sword')])
    );
    drain();
    expect(sent).toEqual(['drop rusty sword']);
  });

  it('drops nothing the player did not name', () => {
    const auto = make();
    auto.onCharacter(carrying([item('ancient amulet'), item('torch')]));
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * A `drop` the server refused would otherwise be re-proposed on every
   * listing. One ask per item; the pack no longer listing the name is the
   * release, so junk picked up again is junk dropped again.
   */
  it('asks once per item, until the pack stops listing it', () => {
    const auto = make();
    auto.onCharacter(carrying([item('rusty sword')]));
    auto.onCharacter(carrying([item('rusty sword')]));
    drain();
    expect(sent).toEqual(['drop rusty sword']);

    // Gone from the pack, then picked up again: a fresh decision.
    auto.onCharacter(carrying([]));
    auto.onCharacter(carrying([item('rusty sword')]));
    drain();
    expect(sent).toEqual(['drop rusty sword', 'drop rusty sword']);
  });

  it('holds during combat and while resting', () => {
    const auto = make();
    auto.onCharacter({ ...carrying([item('rusty sword')]), inCombat: true });
    const resting = carrying([item('rusty sword')]);
    auto.onCharacter({ ...resting, vitals: { ...resting.vitals, resting: true } });
    drain();
    expect(sent).toEqual([]);
  });
});

describe('waiting for the realm to grade the load', () => {
  /*
   * The trigger is the listing's own word being anything but `None` — never a
   * percentage this client computed, because the thresholds behind the grades
   * are unsampled. An unread grade drops nothing: unknown is not encumbered.
   */
  it('holds junk while the grade is None, or has never been read', () => {
    const auto = make({ whenEncumbered: true });
    auto.onCharacter(carrying([item('rusty sword')], null));
    auto.onCharacter(carrying([item('rusty sword')], 'None'));
    drain();
    expect(sent).toEqual([]);
  });

  it('sheds junk once the realm says the load is anything else', () => {
    const auto = make({ whenEncumbered: true });
    auto.onCharacter(carrying([item('rusty sword')], 'Medium'));
    drain();
    expect(sent).toEqual(['drop rusty sword']);
  });
});

/*
 * Shedding what the realm itself prices at nothing.
 *
 * The one predicate safe to act on unasked here, and only because it is the
 * realm's explicit zero rather than its silence: a price nobody has stated is
 * not a price of nothing, and dropping on absence would empty a kit into the
 * road the first time somebody played a realm this client has no data for.
 */
describe('dropping what the realm prices at nothing', () => {
  const priced = (name: string, over: Partial<CarriedItem> = {}): CarriedItem =>
    item(name, { source: 'hybrid', ...over });

  it('sheds an explicit zero and leaves everything else', () => {
    const auto = make({ items: [], worthless: true });
    auto.onCharacter(
      carrying([priced('rusty nail', { price: 0 }), priced('gold ring', { price: 5000 })])
    );
    drain();
    expect(sent).toEqual(['drop rusty nail']);
    expect(kinds).toEqual(['drop-worthless']);
  });

  /* Silence is not zero — this is the case that would empty a pack. */
  it('leaves alone anything the realm has not priced', () => {
    const auto = make({ items: [], worthless: true });
    auto.onCharacter(carrying([item('gnarled widget')]));
    drain();
    expect(sent).toEqual([]);
  });

  /* The realm refusing outright outranks its own price: the server would
     answer the `drop` out loud in the room. */
  it('never drops something the realm marks Not Droppable', () => {
    const auto = make({ items: [], worthless: true });
    auto.onCharacter(carrying([priced('bound tome', { price: 0, notDroppable: true })]));
    drain();
    expect(sent).toEqual([]);
  });

  it('still refuses anything equipped', () => {
    const auto = make({ items: [], worthless: true });
    auto.onCharacter(carrying([priced('rusty helm', { price: 0, equipped: true, slot: 'Head' })]));
    drain();
    expect(sent).toEqual([]);
  });

  /* Off is the shipped default, and off means the list is the only authority. */
  it('does nothing on price while the setting is off', () => {
    const auto = make({ items: [], worthless: false });
    auto.onCharacter(carrying([priced('rusty nail', { price: 0 })]));
    drain();
    expect(sent).toEqual([]);
  });
});

describe('keeping what an unfinished quest still needs (todo 52)', () => {
  it('keeps a named item a quest needs, says so once, and drops the rest', () => {
    const auto = make({ items: ['rusty sword', 'quest token'] });
    wantedBy = (it) => (it.id === 1247 ? 'Smash' : null);
    const pack = carrying([item('quest token', { id: 1247 }), item('rusty sword')]);
    auto.onCharacter(pack);
    auto.onCharacter(pack);
    drain();
    expect(sent).toEqual(['drop rusty sword']);
    const why = t('automation.quests.stillNeeds', { quest: 'Smash', item: 'quest token' });
    expect(notices).toEqual([t('automation.drop.kept', { why })]);
    expect(decisions).toMatchObject([{ action: 'drop', acted: false }]);
  });

  it('drops it once the quest no longer needs it', () => {
    const auto = make({ items: ['quest token'] });
    wantedBy = () => 'Smash';
    auto.onCharacter(carrying([item('quest token')]));
    drain();
    // The positive control: it was kept, and said so.
    expect(notices).toHaveLength(1);
    expect(sent).toEqual([]);
    wantedBy = () => null;
    auto.onCharacter(carrying([item('quest token')]));
    drain();
    expect(sent).toEqual(['drop quest token']);
  });

  // The case above keeps the same token at the shipped switch: the positive control.
  it('drops it while a quest needs it with Keep Quest Items off', () => {
    const auto = make({ items: ['quest token'], keepQuestItems: false });
    wantedBy = () => 'Smash';
    auto.onCharacter(carrying([item('quest token')]));
    drain();
    expect(sent).toEqual(['drop quest token']);
    expect(notices).toEqual([]);
  });

  it('keeps a worthless item a quest needs', () => {
    const auto = make({ items: [], worthless: true });
    wantedBy = () => 'EvilQuest';
    auto.onCharacter(carrying([item('severed head', { source: 'hybrid', price: 0 })]));
    drain();
    expect(sent).toEqual([]);
    expect(decisions).toHaveLength(1);
  });
});
