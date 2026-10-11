import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { Recovery } from '../Recovery';
import { RestSpell, type RestSpellSources } from '../RestSpell';
import { t } from '../../app/i18n';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { MAGERY } from '../../../shared/prowess';
import type { WorldSpell } from '../../../shared/world';

const automation = (restSpell: string): AutomationConfig => ({
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 },
  health: { ...DEFAULT_CONFIG.automation.health, restBelow: 0.5, restTo: 0.7, restSpell }
});

// Rapid healing: +100% `HPRegen` (ability 123) for 60 effect ticks, 8 mana.
const SPELLS: Record<string, WorldSpell> = {
  rhel: {
    id: 1,
    name: 'rapid healing',
    short: 'rhel',
    mana: 8,
    duration: 60,
    abilities: [[123, 100]]
  },
  bles: { id: 2, name: 'bless', short: 'bles', mana: 4, duration: 60, abilities: [[22, 5]] }
};
const realmSpell = (name: string): WorldSpell | null =>
  Object.values(SPELLS).find((spell) => spell.short === name || spell.name === name) ?? null;

const sources = (notices: string[]): RestSpellSources => ({
  realmSpell,
  realmClass: () => ({
    combat: 2,
    magery: 2,
    crits: 0,
    mageryType: MAGERY.priest,
    family: 'greatermud'
  }),
  speed: () => 1,
  notice: (message) => notices.push(message)
});

/** Level 20, health 60: a rest tick of 9, 18 with rapid healing up. */
function hurt(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 50, hpMax: 200, mana: 40, manaMax: 40 },
    progress: { ...base.progress, level: 20, health: 60, willpower: 60 },
    ...over
  };
}

let sent: string[];
let notices: string[];
let queue: CommandQueue;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

function build(spell: string): Recovery {
  const config = automation(spell);
  queue = new CommandQueue(config, { send: (command) => sent.push(command) });
  const restSpell = new RestSpell(config, queue, sources(notices));
  return new Recovery(config, queue, {
    beforeRest: (state, restTo) => restSpell.beforeRest(state, restTo)
  });
}

describe('the regeneration spell before a rest', () => {
  it('goes out ahead of the rest it shortens, in the same band', () => {
    build('rhel').onCharacter(hurt());
    expect(sent).toEqual(['rhel', 'rest']);
  });

  it('is not cast again while it is up', () => {
    const buffs = [{ spell: 'rapid healing', by: null, appliedAt: 0 }];
    build('rhel').onCharacter(hurt({ buffs }));
    expect(sent).toEqual(['rest']);
  });

  it('refuses a spell that shortens nothing, and says so once', () => {
    const recovery = build('bles');
    recovery.onCharacter(hurt());
    expect(sent).toEqual(['rest']);
    expect(notices).toEqual([t('automation.recovery.restSpellSavesNothing', { spell: 'bles' })]);
    vi.advanceTimersByTime(60_000);
    recovery.onCharacter(hurt());
    expect(notices).toHaveLength(1);
  });

  it('casts nothing with no spell named, and never to a character already down', () => {
    build('').onCharacter(hurt());
    expect(sent).toEqual(['rest']);
    queue.dispose();
    sent = [];
    const down = hurt();
    build('rhel').onCharacter({ ...down, vitals: { ...down.vitals, resting: true } });
    expect(sent).toEqual([]);
  });
});
