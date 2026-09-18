import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  asRealmFamily,
  familiesDisagree,
  familyOfBuild,
  familyToldBy,
  isEmptyBuild,
  readRealmBuild,
  REALM_FAMILIES,
  REALM_FAMILY_LABEL,
  type RealmBuild
} from '../realm';
import type { Block } from '../blocks';

/**
 * A realm family is a **closed union with three halves**:
 *
 * 1. the `RealmFamily` type, which is what a calculator will branch on;
 * 2. `REALM_FAMILIES`, which is what `asRealmFamily` accepts off a file;
 * 3. `REALM_FAMILY_LABEL`, which is what a person is shown.
 *
 * A family in the type and not in the list type-checks, then fails to *load* —
 * the header's family is dropped by the parser and the only symptom is
 * arithmetic that quietly never branches, which is the exact failure
 * `guard-fields.test.ts` exists for and the exact failure this seam was built
 * before the arithmetic to avoid. The type is erased at runtime, so it is read
 * out of its own source rather than restated here.
 */
function unionMembers(): string[] {
  const source = fs.readFileSync(path.resolve('src/shared/realm.ts'), 'utf8');
  const start = source.indexOf('export type RealmFamily =');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([\w-]+)'/g)].map((match) => match[1]!);
}

function block(type: Block['type'], groups: Record<string, string> = {}): Block {
  return {
    seq: 1,
    at: 0,
    type,
    domain: 'status',
    groups,
    text: '',
    terminator: 'newline',
    confidence: 1
  };
}

const GMUD: RealmBuild = {
  nmr: 'v1.8.2',
  data: 'v1.11p',
  date: '9/2/2023',
  time: '10:24:09 AM',
  custom: 'Gmud 1.6 Final',
  legit: 0,
  updateUrl: 'http://www.mudinfo.net/mmudexp.php'
};

describe('realm families', () => {
  const declared = unionMembers();

  it('declares, accepts and labels exactly the same set', () => {
    expect(declared).toEqual(['greatermud', 'majormud']);
    expect([...REALM_FAMILIES].sort()).toEqual([...declared].sort());
    expect(Object.keys(REALM_FAMILY_LABEL).sort()).toEqual([...declared].sort());
  });

  it('parses a family rather than casting one', () => {
    expect(asRealmFamily('greatermud')).toBe('greatermud');
    // MudPlay's own words for the two, which are deliberately not these.
    expect(asRealmFamily('Stock')).toBeNull();
    expect(asRealmFamily('ParaMud')).toBeNull();
    expect(asRealmFamily(2)).toBeNull();
    expect(asRealmFamily(undefined)).toBeNull();
  });
});

describe('the family a database states', () => {
  it('reads the shipped realm as GreaterMUD, from Custom', () => {
    expect(familyOfBuild(GMUD)).toBe('greatermud');
  });

  it('never reads Legit, which the server source does not have', () => {
    // MudPlay's rule is `Legit == 2` -> GreaterMUD. The shipped GreaterMUD
    // database says 0, so a client branching on it would call this realm the
    // other family; `Legit` appears nowhere in the server's own source.
    expect(familyOfBuild({ ...GMUD, custom: null, legit: 2 })).toBeNull();
    expect(familyOfBuild({ ...GMUD, custom: 'Gmud 1.6 Final', legit: 2 })).toBe('greatermud');
  });

  it('refuses a distribution that names neither lineage', () => {
    expect(familyOfBuild({ ...GMUD, custom: "somebody's edit" })).toBeNull();
    expect(familyOfBuild({ ...GMUD, custom: '' })).toBeNull();
    expect(familyOfBuild(null)).toBeNull();
  });

  it('reads the other lineage by any of its names', () => {
    for (const custom of ['PMud 1.2', 'Paradigm', 'ParaMUD final', 'MajorMUD 1.11p']) {
      expect(familyOfBuild({ ...GMUD, custom })).toBe('majormud');
    }
  });

  it('reads the stock data set, which calls itself Default, as MajorMUD', () => {
    // `mdb/majormud-v1.11p.zip`, read 2026-09-07: the unmodified v1.11p data
    // names no lineage in words, and it is the lineage everything else forked.
    expect(familyOfBuild({ ...GMUD, data: 'v1.11p', custom: 'Default', legit: 1 })).toBe(
      'majormud'
    );
    // Whole, not a prefix: a derivative that edits the file renames it.
    expect(familyOfBuild({ ...GMUD, custom: 'Default plus my edits' })).toBeNull();
  });
});

describe('the Info record read back off a header', () => {
  it('round-trips what the conversion wrote', () => {
    expect(readRealmBuild({ ...GMUD })).toEqual(GMUD);
  });

  it('drops a field of the wrong shape rather than the record', () => {
    const read = readRealmBuild({ ...GMUD, legit: 'nought', nmr: 7 });
    expect(read?.legit).toBeNull();
    expect(read?.nmr).toBeNull();
    expect(read?.custom).toBe('Gmud 1.6 Final');
  });

  it('reads a record that says nothing as absent', () => {
    expect(readRealmBuild({})).toBeNull();
    expect(readRealmBuild({ custom: '   ' })).toBeNull();
    expect(readRealmBuild(null)).toBeNull();
    expect(readRealmBuild('Gmud')).toBeNull();
    expect(isEmptyBuild({ ...GMUD, legit: null })).toBe(false);
  });
});

describe('the family the wire states', () => {
  it('reads a printed experience table as the MajorMUD lineage', () => {
    expect(familyToldBy(block('user-experience-table'))).toEqual({
      family: 'majormud',
      tell: 'experience-table'
    });
  });

  it("reads rm's coordinates as GreaterMUD", () => {
    expect(familyToldBy(block('user-profile', { map: '1', room: '2147' }))).toEqual({
      family: 'greatermud',
      tell: 'locate-answered'
    });
  });

  it('does not read pro’s other heading as anything', () => {
    // `Recent Deaths:` matches the same block type and carries no coordinates,
    // which is why the groups are tested rather than the type.
    expect(familyToldBy(block('user-profile'))).toBeNull();
  });

  it('reads a GreaterMUD-only command said out loud as the MajorMUD lineage', () => {
    for (const message of ['rm', 'room', 'ab', 'deaths']) {
      // Every spelling, because the word is resolved through the realm's own
      // table rather than compared as text — `rm`, `roo` and `room` are one
      // command to the server.
      expect(familyToldBy(block('command-not-understood', { message })), message).toEqual({
        family: 'majormud',
        tell: 'gmud-command-spoken'
      });
    }
    // A command both lineages have says nothing: every realm refuses words it
    // does not have, and this one is not one of them.
    expect(familyToldBy(block('command-not-understood', { message: 'gold' }))).toBeNull();
    /*
     * And a word the table does not have at all says nothing either. A text
     * exit is room data — `go manhole` is missing from every realm's command
     * table by construction — so refusing one is not evidence of a lineage.
     */
    expect(familyToldBy(block('command-not-understood', { message: 'go manhole' }))).toBeNull();
  });

  /*
   * How the MajorMUD lineage actually refuses a word it does not have —
   * measured on bbs.bearfather.net 2026-09-05 (majorMUD v1.11p-WG3NT), where
   * `rm` came back `Your command had no effect.` privately, twice, and was
   * never spoken in the room. docs/game-behaviour.md had read GreaterMUD's
   * `You say "<command>"` onto the other lineage.
   */
  it('reads a GreaterMUD-only command refused as the MajorMUD lineage', () => {
    const refusal = block('command-no-effect');
    expect(familyToldBy(refusal, 'rm')).toEqual({
      family: 'majormud',
      tell: 'gmud-command-refused'
    });
    expect(familyToldBy(refusal, 'ab')).toMatchObject({ family: 'majormud' });

    /*
     * And `pro` is **not** one of them, which is the correction the session
     * that measured all this paid for. MajorMUD answers `pro` in full and
     * simply puts no `Location:` in the answer, so the *type* is no tell and
     * only the groups are — see the `user-profile` case above.
     */
    expect(familyToldBy(refusal, 'pro')).toBeNull();
    expect(familyToldBy(block('command-not-understood', { message: 'pro' }))).toBeNull();

    /*
     * And the limit that makes it safe. The same sentence answers a word the
     * realm *does* have that did nothing — `med` for a class with no mana,
     * measured — so only a command whose absence separates the lineages says
     * anything about which lineage this is.
     */
    expect(familyToldBy(refusal, 'med')).toBeNull();
    expect(familyToldBy(refusal, 'st')).toBeNull();
    // And the sentence names nothing, so with no echo behind it there is no
    // command to judge.
    expect(familyToldBy(refusal)).toBeNull();
  });

  it('concludes nothing from an ordinary block', () => {
    expect(familyToldBy(block('user-experience'))).toBeNull();
    expect(familyToldBy(block('status-line'))).toBeNull();
  });
});

describe('the two families are kept apart', () => {
  it('is the shipped configuration, and it disagrees', () => {
    // A Paradigm-built world file is the map for a GreaterMUD default realm.
    expect(familiesDisagree({ data: 'majormud', server: 'greatermud' })).toBe(true);
  });

  it('never disagrees with an unknown', () => {
    expect(familiesDisagree({ data: null, server: 'greatermud' })).toBe(false);
    expect(familiesDisagree({ data: 'majormud', server: null })).toBe(false);
    expect(familiesDisagree({ data: null, server: null })).toBe(false);
    expect(familiesDisagree({ data: 'majormud', server: 'majormud' })).toBe(false);
  });
});
