import { describe, expect, it } from 'vitest';
import { wireItem, type ItemEntity } from '../entities';
import { UNKNOWN_WEARER, type Wearer } from '../gear';
import type { UiLookup } from '../i18n';
import { canUse } from '../canUse';

const t: UiLookup = (key) => key;

const warrior: Wearer = {
  ...UNKNOWN_WEARER,
  classId: 1,
  raceId: 1,
  level: 10,
  alignment: 'Neutral',
  weaponType: 8,
  armourType: 9,
  antiMagic: false,
  classNames: { 1: 'Warrior', 7: 'Druid', 8: 'Bard' }
};

/** A realm row on the floor: the name, its id and what the realm says. */
const row = (name: string, over: Partial<ItemEntity>): ItemEntity => ({
  ...wireItem(name),
  source: 'mdb',
  id: 1,
  ...over
});

describe('whether this character may use a thing on the floor', () => {
  it('rules out a flask its class may not use, though it has no slot', () => {
    // Paradigm `small glass flask`: type 10, no Worn slot, ClassRest Druid and Bard.
    const flask = row('small glass flask', { classes: [7, 8], kind: 'drink' });
    expect(canUse(flask, warrior, t).state).toBe('blocked');
    expect(canUse(flask, { ...warrior, classId: 7 }, t).state).toBe('usable');
  });

  it('says unknown, not usable, while the stats have not shown the class', () => {
    const flask = row('small glass flask', { classes: [7, 8] });
    expect(canUse(flask, UNKNOWN_WEARER, t)).toEqual({
      state: 'unknown',
      label: 'rewrites.floor.unreadCharacter'
    });
  });

  it('calls a thing with no restriction usable whatever is unread', () => {
    expect(canUse(row('bone key', {}), UNKNOWN_WEARER, t).state).toBe('usable');
  });

  it('says unknown for a name the world database lacks', () => {
    expect(canUse(wireItem('bone charm'), warrior, t).state).toBe('unknown');
  });

  it('says unknown where the rows sharing a name disagree, blocked where they all refuse', () => {
    const open = {};
    const druids = { classes: [7] };
    const mixed = row('silver ring', { ids: [1, 2], variants: [open, druids] });
    expect(canUse(mixed, warrior, t).label).toBe('rewrites.floor.sharedName');
    const refused = row('silver ring', { ids: [1, 2], variants: [druids, { classes: [8] }] });
    expect(canUse(refused, warrior, t).state).toBe('blocked');
    // Usable for a druid under both rows: the variants agree for that wearer.
    expect(canUse(mixed, { ...warrior, classId: 7 }, t).state).toBe('usable');
  });
});
