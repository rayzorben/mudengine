import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Belongings, peekSpellbook } from '../Belongings';
import type { BankBalance } from '../../../shared/character';

let dir = '';
let file = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-vaults-'));
  file = path.join(dir, 'vaults', 'vaelor.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const REALM = 'orohost:2427';

const balance = (over: Partial<BankBalance> = {}): BankBalance => ({
  shop: 8,
  name: 'Bank of Godfrey',
  copper: 310_335,
  at: 1_700_000_000_000,
  ...over
});

const read = (): { version: number; realm: string; banks: BankBalance[] } =>
  JSON.parse(fs.readFileSync(file, 'utf8'));

describe('what the banks told this character', () => {
  it('keeps a balance and writes it where it was told to', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberBanks([balance()]);
    book.close();

    expect(read()).toMatchObject({ version: 1, realm: REALM });
    expect(read().banks).toEqual([balance()]);
  });

  it('hands it back to the next session, with the time it was stated', () => {
    const first = new Belongings({ file, realm: REALM });
    first.rememberBanks([balance()]);
    first.close();

    const second = new Belongings({ file, realm: REALM });
    expect(second.recallBanks()).toEqual([balance()]);
  });

  /*
   * The whole point of the file. A vault answers only for the counter the
   * character is standing at, so a balance read in Godfrey is unreadable again
   * until somebody walks back — and the card that exists to say how much there
   * is and where was empty on every launch until they did.
   */
  it('keeps every vault, not only the one last asked', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberBanks([balance(), balance({ shop: 12, name: 'Bank of Silverwood', copper: 40 })]);
    book.close();

    expect(new Belongings({ file, realm: REALM }).recallBanks()).toHaveLength(2);
  });

  /*
   * `at` moves on every `bank` whether the figure did or not, and a re-read
   * that said the same number is not a reason to touch a disk from the thread
   * that is framing bytes.
   */
  it('does not write again for a re-read that said the same figure', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberBanks([balance()]);
    book.close();
    const first = fs.statSync(file).mtimeMs;

    book.rememberBanks([balance({ at: 1_700_000_600_000 })]);
    book.close();
    expect(fs.statSync(file).mtimeMs).toBe(first);
  });

  it('writes when the figure actually moves', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberBanks([balance()]);
    book.close();

    book.rememberBanks([balance({ copper: 310_325 })]);
    book.close();
    expect(read().banks[0]?.copper).toBe(310_325);
  });

  /*
   * A vault is the server's. A character dialled at a saved realm from the
   * palette must not be shown the savings it has somewhere else — and the
   * shop id that keys a balance names a different place on a different realm.
   */
  it('will not hand one realm the balances banked on another', () => {
    const first = new Belongings({ file, realm: REALM });
    first.rememberBanks([balance()]);
    first.close();

    const elsewhere = new Belongings({ file, realm: 'bbs.bearfather.net:23' });
    expect(elsewhere.recallBanks()).toEqual([]);
  });

  /* Kept and ignored, not deleted: somebody who dials back gets it back. */
  it('leaves the other realm file alone rather than emptying it', () => {
    const first = new Belongings({ file, realm: REALM });
    first.rememberBanks([balance()]);
    first.close();

    const elsewhere = new Belongings({ file, realm: 'bbs.bearfather.net:23' });
    elsewhere.rememberBanks([balance({ shop: 3, name: 'Somewhere Else', copper: 5 })]);
    elsewhere.close();

    expect(new Belongings({ file, realm: REALM }).recallBanks()).toEqual([balance()]);
  });

  /*
   * This is the only copy of what the banks said. A parse failure is not
   * permission to overwrite it with an empty list on the next deposit — and it
   * is said out loud, because a client that silently forgets money is worse
   * than one that says it cannot read the file.
   */
  it('reports an unreadable file and writes nothing over it', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');
    const said: string[] = [];

    const book = new Belongings({ file, realm: REALM, notify: (m: string) => said.push(m) });
    expect(said).toHaveLength(1);
    expect(book.recallBanks()).toEqual([]);

    book.rememberBanks([balance()]);
    book.close();
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('refuses a file whose entries are not balances, and says so', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, realm: REALM, banks: [{ name: 'Bank of Godfrey' }] }),
      'utf8'
    );
    const said: string[] = [];

    expect(
      new Belongings({ file, realm: REALM, notify: (m: string) => said.push(m) }).recallBanks()
    ).toEqual([]);
    expect(said).toHaveLength(1);
  });

  /* Nothing kept is not nothing banked, and a missing file is the first case. */
  it('starts empty and silent when there is no file yet', () => {
    const said: string[] = [];
    const book = new Belongings({ file, realm: REALM, notify: (m: string) => said.push(m) });
    expect(book.recallBanks()).toEqual([]);
    expect(said).toEqual([]);
  });

  /*
   * The caller hands over the array that is on `CharacterState`. A store
   * holding a reference into live state would write whatever that state became
   * between the change and the deferred save.
   */
  it('copies what it is handed rather than aliasing live state', () => {
    const banks = [balance()];
    const book = new Belongings({ file, realm: REALM });
    book.rememberBanks(banks);

    const held = banks[0];
    if (held) held.copper = 1;
    book.close();

    expect(read().banks[0]?.copper).toBe(310_335);
  });

  it('is safe to close twice', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberBanks([balance()]);
    book.close();
    expect(() => book.close()).not.toThrow();
  });
});

describe('what this character had on', () => {
  const helm = { slot: 'Head', item: 'padded helm', at: 1_700_000_000_000 };

  it('keeps a loadout and hands it back to the next session', () => {
    const first = new Belongings({ file, realm: REALM });
    first.rememberLoadout([helm]);
    first.close();

    expect(new Belongings({ file, realm: REALM }).recallLoadout()).toEqual([helm]);
  });

  /* One file, both facts: they are the same kind of thing about the same
     character and there is no reason for two. */
  it('shares one file with the balances', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberBanks([balance()]);
    book.rememberLoadout([helm]);
    book.close();

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.banks).toHaveLength(1);
    expect(written.loadout).toEqual([helm]);
  });

  /*
   * A record written before the loadout was kept has no key for it. Read as
   * "nothing known" rather than refused: the balances in the same file are
   * still the only copy of what the banks said, and throwing them away over a
   * key that did not exist yet is the pre-v1 rule read backwards.
   */
  it('reads a file written before the loadout was kept', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, realm: REALM, banks: [balance()] }),
      'utf8'
    );
    const book = new Belongings({ file, realm: REALM });
    expect(book.recallLoadout()).toEqual([]);
    expect(book.recallBanks()).toHaveLength(1);
  });

  it('refuses a loadout whose entries are not slots, and says so', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, realm: REALM, banks: [], loadout: [{ slot: 'Head' }] }),
      'utf8'
    );
    const said: string[] = [];
    const book = new Belongings({ file, realm: REALM, notify: (m: string) => said.push(m) });
    expect(book.recallLoadout()).toEqual([]);
    expect(said).toHaveLength(1);
  });

  /* A listing restates every slot on every `i`. */
  it('does not write again for a listing that named the same kit', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberLoadout([helm]);
    book.close();
    const first = fs.statSync(file).mtimeMs;

    book.rememberLoadout([{ ...helm, at: helm.at + 60_000 }]);
    book.close();
    expect(fs.statSync(file).mtimeMs).toBe(first);
  });

  it('writes when the kit in a slot actually changes', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberLoadout([helm]);
    book.close();

    book.rememberLoadout([{ ...helm, item: 'iron helm' }]);
    book.close();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).loadout[0].item).toBe('iron helm');
  });

  /* A kit is the server's, exactly as a vault is. */
  it('will not hand one realm the kit worn on another', () => {
    const first = new Belongings({ file, realm: REALM });
    first.rememberLoadout([helm]);
    first.close();

    expect(new Belongings({ file, realm: 'bbs.bearfather.net:23' }).recallLoadout()).toEqual([]);
  });
});

/*
 * The spellbook and the measured durations, kept beside the balances: what
 * the `sp`/`pow` listing said this character knows, and how long its own
 * casts were observed to last.
 */
describe('what this character knows how to cast', () => {
  const swan = { name: 'way of the swan', short: 'swan', level: 2, cost: 1 };

  it('keeps the book, and hands it to the next session', () => {
    const first = new Belongings({ file, realm: REALM });
    first.rememberSpellbook([swan]);
    first.close();

    const second = new Belongings({ file, realm: REALM });
    expect(second.recallSpellbook()).toEqual([swan]);
  });

  it('answers null while nothing has been read — never an empty book', () => {
    const book = new Belongings({ file, realm: REALM });
    expect(book.recallSpellbook()).toBeNull();
    // A file written with no book keeps the distinction on disk too.
    book.rememberBanks([balance()]);
    book.close();
    const reopened = new Belongings({ file, realm: REALM });
    expect(reopened.recallSpellbook()).toBeNull();
  });

  it('keeps a read-but-empty book as empty, which is a different fact', () => {
    const first = new Belongings({ file, realm: REALM });
    first.rememberSpellbook([]);
    first.close();
    expect(new Belongings({ file, realm: REALM }).recallSpellbook()).toEqual([]);
  });

  it('keeps the newest measured duration per spell, rounded to seconds', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberSpellDuration('Bless', 99.6);
    book.rememberSpellDuration('bless', 120);
    book.rememberSpellDuration('bless', -5);
    book.rememberSpellDuration('  ', 30);
    book.close();

    const next = new Belongings({ file, realm: REALM });
    expect(next.recallSpellDurations()).toEqual({ bless: 120 });
  });

  it("ignores another realm's record, like the balances", () => {
    const home = new Belongings({ file, realm: REALM });
    home.rememberSpellbook([swan]);
    home.close();
    const away = new Belongings({ file, realm: 'elsewhere:23' });
    expect(away.recallSpellbook()).toBeNull();
  });

  it('peeks the book read-only for the settings screen, and answers null for everything null means', () => {
    const book = new Belongings({ file, realm: REALM });
    book.rememberSpellbook([swan]);
    book.close();

    expect(peekSpellbook(file, REALM)).toEqual([swan]);
    // The wrong realm, a missing file and an unreadable one all widen to
    // "not read yet" rather than narrowing to "knows nothing".
    expect(peekSpellbook(file, 'elsewhere:23')).toBeNull();
    expect(peekSpellbook(path.join(dir, 'nowhere.json'), REALM)).toBeNull();
    fs.writeFileSync(file, 'not json', 'utf8');
    expect(peekSpellbook(file, REALM)).toBeNull();
  });
});

/*
 * The ability listing, kept beside the balances (2026-09-07, todo 07).
 *
 * The argument for keeping it is the one the balances already won: nothing on
 * the wire reports a quest counter moving, so the figure is only ever as fresh
 * as the last `abil` — and `at` is what makes drawing it honest rather than
 * what makes keeping it wrong.
 */
describe('what abil last summed', () => {
  const sums = { sums: { 126: 6, 2: 560 }, complete: true, at: 1_757_000_000_000 };

  it('starts null, because never read is not "the realm counts none"', () => {
    expect(new Belongings({ file, realm: REALM }).recallAbilities()).toBeNull();
  });

  it('survives a restart with the clock it was read on', () => {
    const store = new Belongings({ file, realm: REALM });
    store.rememberAbilities(sums);
    store.close();
    expect(new Belongings({ file, realm: REALM }).recallAbilities()).toEqual(sums);
  });

  it('is not written while it has never been read, so the absence round-trips', () => {
    const store = new Belongings({ file, realm: REALM });
    // Something else has to move, or nothing is written at all.
    store.rememberLoadout([{ slot: 'Head', item: 'a leather cap', at: 1 }]);
    store.close();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).abilities).toBeUndefined();
    expect(new Belongings({ file, realm: REALM }).recallAbilities()).toBeNull();
  });

  it('holds its own copy, so live state moving does not rewrite the record', () => {
    const store = new Belongings({ file, realm: REALM });
    const live = { sums: { 126: 6 }, complete: true, at: 1 };
    store.rememberAbilities(live);
    live.sums[126] = 99;
    store.close();
    expect(new Belongings({ file, realm: REALM }).recallAbilities()?.sums[126]).toBe(6);
  });

  it('is ignored with the rest of the file when the realm changed', () => {
    const home = new Belongings({ file, realm: REALM });
    home.rememberAbilities(sums);
    home.close();
    expect(new Belongings({ file, realm: 'elsewhere:23' }).recallAbilities()).toBeNull();
  });

  it('refuses a row with no `complete` flag, which is what decides an absent id', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        realm: REALM,
        banks: [],
        abilities: { sums: { 126: 6 }, at: 1 }
      }),
      'utf8'
    );
    const store = new Belongings({ file, realm: REALM });
    // The whole file is refused, not the one key: a record missing the flag
    // that says whether zero means zero is half a fact presented as a whole.
    expect(store.recallAbilities()).toBeNull();
    expect(store.recallBanks()).toEqual([]);
  });
});

/*
 * Who this character was, and throwing the record away when it is not them.
 *
 * The identity is kept for one purpose — noticing that a player deleted a
 * character and made a new one on the same login — and `forget` is the one
 * destructive call on this seam, reached only from a player answering.
 */
describe('who the record is about', () => {
  const identity = {
    race: 'Human',
    className: 'Battlemage',
    level: 34,
    exp: 1_000_000,
    at: 1_757_000_000_000
  };

  it('starts null: an empty record has nothing to disagree with', () => {
    expect(new Belongings({ file, realm: REALM }).recallIdentity()).toBeNull();
  });

  it('survives a restart', () => {
    const store = new Belongings({ file, realm: REALM });
    store.rememberIdentity(identity);
    store.close();
    expect(new Belongings({ file, realm: REALM }).recallIdentity()).toEqual(identity);
  });

  it('keeps an unknown as unknown rather than as a value', () => {
    const store = new Belongings({ file, realm: REALM });
    store.rememberIdentity({ ...identity, race: null, exp: null });
    store.close();
    const back = new Belongings({ file, realm: REALM }).recallIdentity();
    expect(back?.race).toBeNull();
    expect(back?.exp).toBeNull();
  });

  it('refuses a record with no clock, which could not be aged', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        realm: REALM,
        banks: [],
        identity: { race: 'Human', className: null, level: null, exp: null }
      }),
      'utf8'
    );
    expect(new Belongings({ file, realm: REALM }).recallIdentity()).toBeNull();
  });

  it('throws the whole record away at the word, and only what is about a character', () => {
    const store = new Belongings({ file, realm: REALM });
    store.rememberIdentity(identity);
    store.rememberLoadout([{ slot: 'Head', item: 'a leather cap', at: 1 }]);
    store.rememberAbilities({ sums: { 126: 6 }, complete: true, at: 1 });
    expect(store.forget()).toBe(true);
    store.close();

    const back = new Belongings({ file, realm: REALM });
    expect(back.recallIdentity()).toBeNull();
    expect(back.recallLoadout()).toEqual([]);
    expect(back.recallAbilities()).toBeNull();
    expect(back.recallSpellbook()).toBeNull();
    expect(back.recallBanks()).toEqual([]);
  });

  it('refuses to forget a record it could not read', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json', 'utf8');
    const store = new Belongings({ file, realm: REALM });
    // Suspended: the file is the only copy of something this build cannot read,
    // and overwriting it with an empty record is what the suspension prevents.
    expect(store.forget()).toBe(false);
    store.close();
    expect(fs.readFileSync(file, 'utf8')).toBe('not json');
  });
});
