import { describe, expect, it } from 'vitest';

import { asPeerKey, asPeerSheet, PEER_SHEET_VERSION, peerKeyText } from '../peers';

const key = { realm: 'paramud.mudinfo.net:2323/Paradigm', name: 'Brakkle' };

const vitals = {
  hp: 80,
  mana: 12,
  manaType: 'MA',
  hpMax: 100,
  manaMax: 40,
  resting: false,
  meditating: false
};

/** A sheet as this build sends it, every field filled. */
const whole = {
  v: PEER_SHEET_VERSION,
  className: 'Priest',
  vitals,
  afflictions: {
    blind: 'no',
    poisoned: 'yes',
    diseased: 'no',
    held: 'no',
    confused: 'unknown',
    afraid: 'no'
  },
  buffs: [{ spell: 'bless', by: null, appliedAt: 1000 }],
  inCombat: true,
  stealth: 'sneaking',
  level: 12,
  exp: 40_000,
  expNeeded: 52_000,
  room: {
    map: 1,
    number: 2,
    name: 'Town Square',
    candidates: [{ map: 1, room: 2, name: 'Town Square', chosen: true }]
  },
  leader: 'Rayzor'
};

describe('peer keys', () => {
  it('reads a key, and refuses one with no realm or a padded name', () => {
    expect(asPeerKey(key)).toEqual(key);
    expect(asPeerKey({ name: 'Brakkle' })).toBeNull();
    expect(asPeerKey({ ...key, name: ' Brakkle' })).toBeNull();
  });

  it('keys a character without case, and never across realms', () => {
    expect(peerKeyText(key)).toBe(peerKeyText({ ...key, name: 'brakkle' }));
    expect(peerKeyText(key)).not.toBe(peerKeyText({ ...key, realm: 'orohost:2427' }));
  });
});

describe('a sheet read field by field', () => {
  it('reads a whole sheet as it was sent', () => {
    expect(asPeerSheet(whole)).toEqual(whole);
  });

  it("reads an older build's sheet with what it lacks as null", () => {
    const older = { v: 1, vitals, level: 12 };
    const sheet = asPeerSheet(older);
    expect(sheet?.vitals).toEqual(vitals);
    expect(sheet?.level).toBe(12);
    expect(sheet?.afflictions).toBeNull();
    expect(sheet?.room).toBeNull();
    expect(sheet?.leader).toBeNull();
  });

  it('reads a condition an older build lacks as unknown, never as no', () => {
    const { afraid: _afraid, ...older } = whole.afflictions;
    expect(asPeerSheet({ ...whole, afflictions: older })?.afflictions?.afraid).toBe('unknown');
  });

  it('ignores a field this build does not know', () => {
    expect(asPeerSheet({ ...whole, weather: 'rain' })).toEqual(whole);
  });

  it('refuses a field of the wrong type alone', () => {
    const sheet = asPeerSheet({ ...whole, vitals: { ...vitals, hp: 'lots' }, level: '12' });
    expect(sheet?.vitals).toBeNull();
    expect(sheet?.level).toBeNull();
    // The rest still reads: the control for the two refusals.
    expect(sheet?.room).toEqual(whole.room);
    expect(sheet?.afflictions).toEqual(whole.afflictions);
  });

  it('refuses a buff list with one buff that does not read, rather than drop the buff', () => {
    const buffs = [...whole.buffs, { spell: 7 }];
    expect(asPeerSheet({ ...whole, buffs })?.buffs).toBeNull();
  });

  it('refuses a sheet of a later version, or no version', () => {
    expect(asPeerSheet({ ...whole, v: PEER_SHEET_VERSION + 1 })).toBeNull();
    expect(asPeerSheet({ ...whole, v: undefined })).toBeNull();
    expect(asPeerSheet([whole])).toBeNull();
  });
});
