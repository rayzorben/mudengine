import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RealmLore, realmKey } from '../RealmLore';
import type { WorldGraph } from '../WorldGraph';
import { mobNameCandidates } from '../../../shared/mobs';
import { SpellMessageBook } from '../../../shared/spell-messages';

/** The two rows this realm names. */
const rows: Record<string, { name: string; hp: number; span?: [number, number] }> = {
  'giant rat': { name: 'giant rat', hp: 12 },
  'giant rat king': { name: 'giant rat king', hp: 120 },
  cocoon: { name: 'cocoon', hp: 250, span: [100, 250] }
};

/**
 * A realm that names two monsters. Only the two name accessors are reached for
 * here, so a stub is honest rather than lazy: standing up 55,806 rooms to ask what a giant rat
 * is worth would be testing the file loader again. It undoes a name modifier
 * with the shared rule rather than a second copy of it — what is being checked
 * on this side is *which* accessor the lore asks.
 *
 * Two accessors and one answer: `maximumFor` asks `mobAt`, because the room a
 * monster is standing in resolves a name holding several of the realm's rows
 * to one of them and a bar drawn against the fold's high end is drawn against
 * the wrong row wherever it does; `learnedFor` asks `mobAsPrinted`, because
 * folding a character's fights is a question about spelling and not about
 * where anybody is standing. The stub ignores the room, which is what a name
 * holding one row does too.
 */
const named = (name: string) =>
  mobNameCandidates(name)
    .map((candidate) => rows[candidate])
    .find((row) => row !== undefined);
const world = { mobAt: named, mobAsPrinted: named } as unknown as WorldGraph;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-lore-'));
  file = path.join(dir, 'mob-lore.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes eagerly, which is what a test wants and a fight does not. */
const store = (notify?: (message: string) => void): RealmLore =>
  new RealmLore({ file, saveDelayMs: 0, ...(notify ? { notify } : {}) });

/*
 * And the regeneration figure is asked the same way (2026-09-10). The two are
 * read together in one estimate — `combat.healthFor` corrects a maximum by
 * what the monster healed back — so a maximum from row 224 corrected by row
 * 2204's regeneration is a bar drawn from two different monsters. `gnoll
 * scout` folds to 168 a tick; row 224's own figure is 8.
 */
describe('the two halves of the health estimate ask the same question', () => {
  const byRoom = {
    mobAt: (name: string, from: string | null) =>
      name !== 'gnoll scout'
        ? undefined
        : from === '1/1'
          ? { hp: 100, regen: 8 }
          : { hp: 830, regen: 168 },
    mobAsPrinted: () => undefined
  } as unknown as WorldGraph;

  it('resolves the regeneration by the room, as the maximum beside it is', () => {
    const lore = store().forRealm('gmud.sqlite', byRoom);
    expect(lore.regenFor('gnoll scout', '1/1')).toBe(8);
    // No room, or one that cannot tell the rows apart: the fold, as before.
    expect(lore.regenFor('gnoll scout')).toBe(168);
    expect(lore.maximumFor('gnoll scout', '1/1').max).toBe(100);
  });
});

describe('what is known about a monster', () => {
  it('answers from the realm data where the realm speaks', () => {
    const lore = store().forRealm('gmud.sqlite', world);
    expect(lore.maximumFor('The Giant Rat')).toEqual({ max: 12, source: 'realm', span: null });
  });

  /*
   * The wire prints `large giant rat`; the `Monsters` row is `giant rat`. A
   * modifier is common on the live realm, so an exact lookup here would fall
   * through to what fighting has taught for most monsters — a tally and no bar
   * for something the shipped realm knows the number for.
   */
  it('sees through the modifier the server hangs off a name', () => {
    const lore = store().forRealm('gmud.sqlite', world);
    expect(lore.maximumFor('large giant rat')).toEqual({ max: 12, source: 'realm', span: null });
  });

  /* The realm is exact; learning is a bound. A bound never outranks a number. */
  it('lets the realm data outrank anything fighting taught', () => {
    const lore = store().forRealm('gmud.sqlite', world);
    lore.observe('giant rat', { damage: 400, killed: true, at: 1 });
    expect(lore.maximumFor('giant rat').source).toBe('realm');
    expect(lore.maximumFor('giant rat').max).toBe(12);
  });

  it('carries the span for a name the realm data is unsure about', () => {
    const lore = store().forRealm('gmud.sqlite', world);
    expect(lore.maximumFor('cocoon').span).toEqual([100, 250]);
  });

  /*
   * The common case on any realm this client does not ship. Nothing knows, and
   * saying so is what stops a bar being drawn against a number nobody has.
   */
  it('knows nothing about a monster nothing has taught it', () => {
    const lore = store().forRealm('gmud.sqlite', world);
    expect(lore.maximumFor('grue')).toEqual({ max: null, source: null, span: null });
  });

  it('answers from what fighting taught, once something has died', () => {
    const lore = store().forRealm('gmud.sqlite', world);
    lore.observe('grue', { damage: 300, killed: false, at: 1 });
    // Still standing after 300 is a floor, not a maximum, and not a bar.
    expect(lore.maximumFor('grue').max).toBeNull();
    lore.observe('grue', { damage: 420, killed: true, at: 2 });
    expect(lore.maximumFor('grue')).toEqual({ max: 420, source: 'learned', span: null });
  });
});

describe('keeping what was learned', () => {
  it('writes what it learned and reads it back', () => {
    const first = store();
    first.forRealm('gmud.sqlite', world).observe('grue', { damage: 420, killed: true, at: 2 });
    first.flush();

    expect(store().forRealm('gmud.sqlite', world).maximumFor('grue').max).toBe(420);
  });

  /*
   * How much health a giant rat has is a fact about the *world*. Four
   * characters on one realm share what any of them learns; a character that
   * switches realms does not carry the old realm's monsters with it.
   */
  it('keeps one realm’s monsters out of another’s', () => {
    const lore = store();
    lore.forRealm('gmud.sqlite', world).observe('grue', { damage: 420, killed: true, at: 2 });
    lore.flush();

    const reopened = store();
    expect(reopened.forRealm('gmud.sqlite', undefined).maximumFor('grue').max).toBe(420);
    expect(reopened.forRealm('paradigm.mdb', undefined).maximumFor('grue').max).toBeNull();
  });

  it('does not touch the disk when nothing was learned', () => {
    const lore = store();
    const realm = lore.forRealm('gmud.sqlite', world);
    realm.observe('grue', { damage: 300, killed: false, at: 2 });
    lore.flush();
    const stamp = fs.statSync(file).mtimeMs;

    // A lower floor than the one already recorded teaches nothing, so there is
    // nothing to write — `learn` returns its input and identity decides.
    realm.observe('grue', { damage: 100, killed: false, at: 3 });
    lore.flush();
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
  });

  /*
   * It is somebody's file and it could have been edited. Starting again from
   * empty would silently discard everything a hundred fights taught, so
   * learning is suspended and said out loud instead — the alternative is a
   * client that quietly stopped learning.
   */
  it('refuses to overwrite a file it cannot parse, and says so', () => {
    fs.writeFileSync(file, '{ this is not json');
    const said: string[] = [];
    const lore = store((message) => said.push(message));

    lore.forRealm('gmud.sqlite', world).observe('grue', { damage: 420, killed: true, at: 2 });
    lore.flush();

    expect(said.join(' ')).toContain('will not parse');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ this is not json');
  });

  it('ignores an entry with nothing usable in it', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 1, realms: { 'gmud.sqlite': { grue: {}, ghost: { kill: 'lots' } } } })
    );
    const lore = store().forRealm('gmud.sqlite', world);
    expect(lore.maximumFor('grue').max).toBeNull();
    expect(lore.maximumFor('ghost').max).toBeNull();
  });

  it('starts from nothing when there is no file yet', () => {
    expect(store().forRealm('gmud.sqlite', world).maximumFor('grue').max).toBeNull();
  });
});

/* The key becomes a filename's worth of characters and nothing else: a realm
   named after a path must not be able to grow keys that are really paths. */
describe('how a monster dies', () => {
  it('learns the sentence once, says so, persists it and answers it back', () => {
    const said: string[] = [];
    const realm = store((message) => said.push(message));
    const lore = realm.forRealm('gmud.sqlite', undefined);
    lore.observeDeath?.('The Mutant', 'The mutant sighs softy, and dies!', 5);
    lore.observeDeath?.('mutant', 'The mutant sighs softy, and dies!', 9);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('mutant');
    expect(lore.deathOf?.('The mutant sighs softy, and dies!')).toBe('mutant');
    expect(lore.deathOf?.('The mutant growls.')).toBeNull();

    realm.flush();
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'mob-lore.json'), 'utf8'));
    expect(file.deaths[realmKey('gmud.sqlite')]['mutant']).toEqual({
      text: 'The mutant sighs softy, and dies!',
      at: 5
    });

    const again = store().forRealm('gmud.sqlite', undefined);
    expect(again.deathOf?.('The mutant sighs softy, and dies!')).toBe('mutant');
    // Another realm learned nothing.
    expect(
      store().forRealm('paradigm.sqlite', undefined).deathOf?.('The mutant sighs softy, and dies!')
    ).toBeNull();
  });
});

describe('the key a realm’s monsters are stored under', () => {
  it('reduces anything to a plain name', () => {
    expect(realmKey('GMUD 2023.sqlite')).toBe('gmud-2023.sqlite');
    expect(realmKey('../../etc/passwd')).toBe('etc-passwd');
    expect(realmKey('   ')).toBe('unknown');
  });
});

describe('the record, whole, for a card', () => {
  /* `maximumFor` is the decision and prefers the realm; this is what fighting
     taught, kept even where the realm speaks -- "seen to survive 20 against a
     realm figure of 12" is the sentence that decides whether to trust the bar. */
  it('is null before anything is learned, and the entry afterwards, realm figure or not', () => {
    const lore = store().forRealm(realmKey('test'), world);
    expect(lore.learnedFor('giant rat')).toBeNull();
    lore.observe('giant rat', { damage: 20, killed: false, at: 1 });
    lore.observe('giant rat', { damage: 14, killed: true, at: 2 });
    expect(lore.learnedFor('giant rat')).toMatchObject({ kill: 14, survived: 20, kills: 1 });
    expect(lore.maximumFor('giant rat')).toMatchObject({ max: 12, source: 'realm' });
  });

  /* `observe` files under the printed name, modifier and all; the card asks by
     the table's bare name. The record has to be reachable from the bare name or
     the fights with a `small` one are evidence nothing can read. */
  it('gathers every printed spelling that resolves to the asked name', () => {
    const lore = store().forRealm(realmKey('test'), world);
    lore.observe('small giant rat', { damage: 9, killed: true, at: 1 });
    lore.observe('giant rat', { damage: 30, killed: false, at: 2 });
    lore.observe('large giant rat', { damage: 11, killed: true, at: 3 });
    expect(lore.learnedFor('giant rat')).toEqual({ kill: 9, survived: 30, kills: 2, at: 3 });
    // Asked with a modifier, it is the same realm monster, and answers as one.
    expect(lore.learnedFor('small giant rat')).toMatchObject({ kill: 9, kills: 2 });
    expect(lore.learnedFor('cave bear')).toBeNull();
    // A rat king the realm names is its own monster: first hit, not any rung.
    lore.observe('giant rat king', { damage: 200, killed: false, at: 4 });
    expect(lore.learnedFor('giant rat')).toMatchObject({ kills: 2, survived: 30 });
    expect(lore.learnedFor('giant rat king')).toMatchObject({ survived: 200, kills: 0 });
  });
});

/*
 * The slot half: what listings have printed for each `Worn` code, per realm,
 * kept in the same file as the monsters and read back the same way.
 */
describe('what the listing calls a worn slot', () => {
  it('answers the word once a listing has taught the code, and persists it', () => {
    const first = store();
    const lore = first.forRealm('Test Realm', world);
    expect(lore.slotWordsFor(5)).toEqual([]);
    lore.observeSlot(5, 'Feet', 1_000);
    expect(lore.slotWordsFor(5)).toEqual(['Feet']);
    first.save();

    const again = store().forRealm('Test Realm', world);
    expect(again.slotWordsFor(5)).toEqual(['Feet']);
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      slots: Record<string, Record<string, { words: string[] }>>;
    };
    expect(written.slots['test-realm']?.['5']?.words).toEqual(['Feet']);
  });

  /*
   * Both words are kept and neither is the answer. The caller reads the length:
   * one word is the server's, several is a code that does not decide the word
   * on this realm, and none at all is what lets the realm file's own reading
   * stand in (`CharacterTracker.slotOf`).
   */
  it('keeps both words for one code rather than choosing', () => {
    const lore = store().forRealm('Test Realm', world);
    lore.observeSlot(5, 'Feet', 1_000);
    lore.observeSlot(5, 'Boots', 1_001);
    expect(lore.slotWordsFor(5)).toEqual(['Boots', 'Feet']);
  });

  it('keeps one realm’s words out of another’s', () => {
    const one = store();
    one.forRealm('One', world).observeSlot(2, 'Head', 1_000);
    expect(one.forRealm('Two', world).slotWordsFor(2)).toEqual([]);
  });

  it('does not touch the disk for a word it already knows', () => {
    const lore = store();
    const view = lore.forRealm('Test Realm', world);
    view.observeSlot(5, 'Feet', 1_000);
    lore.save();
    const before = fs.statSync(file).mtimeMs;
    const size = fs.statSync(file).size;
    view.observeSlot(5, 'Feet', 2_000);
    lore.save();
    expect(fs.statSync(file).size).toBe(size);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});

/*
 * What the wire teaches about a spell's sentences is kept per realm beside
 * the monster health, and said out loud each time, because a persisted
 * sentence that ends a shield is a decision somebody must be able to read.
 */
describe('the spell sentences a realm taught', () => {
  const shipped = SpellMessageBook.fromRows([
    { spell: 'bless', start: 'You feel lucky!', stop: 'The effects of bless wear off!' }
  ]);

  it('learns where the shipped table is silent, persists, and reads back', () => {
    const said: string[] = [];
    const realm = store((message) => said.push(message));
    const lore = realm.spellsFor('gmud.sqlite', shipped);
    lore.learn('strange glow', 'start', 'You shimmer with a strange light.', 5);
    lore.learn('strange glow', 'stop', 'The strange light fades.', 65);
    // The shipped table already speaks for bless.
    lore.learn('bless', 'stop', 'You feel less lucky.', 70);
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('strange glow');
    expect(said[0]).toContain('You shimmer with a strange light.');

    expect(lore.match('You shimmer with a strange light.')).toEqual({
      starts: ['strange glow'],
      stops: []
    });
    expect(lore.match('You feel lucky!')?.starts).toEqual(['bless']);
    expect(lore.stopOf('bless')).toBe('The effects of bless wear off!');

    realm.flush();
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'mob-lore.json'), 'utf8'));
    expect(file.spells[realmKey('gmud.sqlite')]['strange glow']).toEqual({
      start: { text: 'You shimmer with a strange light.', at: 5 },
      stop: { text: 'The strange light fades.', at: 65 }
    });

    const again = store().spellsFor('gmud.sqlite', shipped);
    expect(again.startOf('strange glow')).toBe('You shimmer with a strange light.');
    expect(again.stopOf('strange glow')).toBe('The strange light fades.');
    // Another realm learned nothing.
    expect(store().spellsFor('paradigm.sqlite', shipped).startOf('strange glow')).toBeNull();
  });

  it('takes a lesson back, and says so', () => {
    const said: string[] = [];
    const realm = store((message) => said.push(message));
    const lore = realm.spellsFor('gmud.sqlite', shipped);
    lore.learn('strange glow', 'start', 'You shimmer with a strange light.', 5);
    lore.learn('strange glow', 'stop', 'The room grows quiet.', 65);
    lore.unlearn('strange glow', 'stop');
    lore.unlearn('strange glow', 'stop');
    expect(said).toHaveLength(3);
    expect(said[2]).toContain('The room grows quiet.');
    expect(lore.stopOf('strange glow')).toBeNull();
    expect(lore.startOf('strange glow')).toBe('You shimmer with a strange light.');

    realm.flush();
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'mob-lore.json'), 'utf8'));
    expect(file.spells[realmKey('gmud.sqlite')]['strange glow']).toEqual({
      start: { text: 'You shimmer with a strange light.', at: 5 }
    });
  });
});

/*
 * What a realm works out about a spell it cannot name — todo 00, 2026-09-12.
 * Kept beside the monster health for the same reason: what a monster's spell
 * does is a fact about the world, not about whoever it landed on.
 */
describe('the effects a realm could not name', () => {
  const shipped = SpellMessageBook.fromRows([
    { spell: 'bless', start: 'You feel lucky!', stop: 'The effects of bless wear off!' }
  ]);

  it('remembers the sheet’s verdict and what the effect turned out to cause', () => {
    const said: string[] = [];
    const realm = store((message) => said.push(message));
    const effects = realm.spellsFor('gmud.sqlite', shipped).effects;

    expect(effects.seen('You are enveloped in a green jelly!')).toBeNull();
    effects.lasting('You are enveloped in a green jelly!', 'yes', 5);
    effects.causes('You are enveloped in a green jelly!', 'poisoned', 'suspected');
    effects.causes('You are enveloped in a green jelly!', 'poisoned', 'confirmed');
    // A verdict is reached once: the confirmed reading is not walked back.
    effects.causes('You are enveloped in a green jelly!', 'poisoned', 'suspected');
    // And a sentence the sheet declined is written down as the refusal it is.
    effects.lasting('You are poisoned!', 'no', 9);
    expect(said).toHaveLength(4);
    expect(said[3]).toContain('You are poisoned!');

    expect(effects.seen('  You  are enveloped in a GREEN jelly!  ')).toEqual({
      text: 'You are enveloped in a green jelly!',
      at: 5,
      lasting: 'yes',
      causes: { poisoned: 'confirmed' }
    });

    realm.flush();
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'mob-lore.json'), 'utf8'));
    expect(file.effects[realmKey('gmud.sqlite')]).toEqual({
      'you are enveloped in a green jelly!': {
        text: 'You are enveloped in a green jelly!',
        at: 5,
        lasting: 'yes',
        causes: { poisoned: 'confirmed' }
      },
      'you are poisoned!': { text: 'You are poisoned!', at: 9, lasting: 'no' }
    });

    const again = store().spellsFor('gmud.sqlite', shipped).effects;
    expect(again.seen('You are poisoned!')?.lasting).toBe('no');
    // Another realm worked nothing out.
    expect(
      store().spellsFor('paradigm.sqlite', shipped).effects.seen('You are poisoned!')
    ).toBeNull();
  });

  it('drops a cause the wire contradicted rather than weakening it', () => {
    const realm = store();
    const effects = realm.spellsFor('gmud.sqlite', shipped).effects;
    effects.lasting('You are covered in acid!', 'yes', 1);
    effects.causes('You are covered in acid!', 'blind', 'suspected');
    effects.causes('You are covered in acid!', 'blind', null);
    expect(effects.seen('You are covered in acid!')?.causes).toBeUndefined();
  });

  it('records nothing against a sentence the sheet has not vouched for', () => {
    const realm = store();
    const effects = realm.spellsFor('gmud.sqlite', shipped).effects;
    effects.causes('You are poisoned!', 'poisoned', 'suspected');
    expect(effects.seen('You are poisoned!')).toBeNull();
  });
});
