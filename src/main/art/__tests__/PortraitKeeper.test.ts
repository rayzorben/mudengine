import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PortraitKeeper } from '../PortraitKeeper';
import { lastPortraitAt, PictureCache } from '../pictureCache';
import { factsHash, portraitFactsOf } from '../portraitFacts';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { PortraitChange, PortraitFacts, PortraitResult } from '../../../shared/portrait';

const PICTURE = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9]);

/** Probe on orohost as `st`, `i` and the look read him (todo 20261019-0931-01). */
const PROBE: CharacterState = {
  ...structuredClone(EMPTY_CHARACTER),
  phase: 'in-game',
  name: 'Probe',
  race: 'Gnome',
  className: 'Priest',
  appearance: { gender: 'male', hair: { none: true }, eyes: 'black' },
  progress: {
    ...EMPTY_CHARACTER.progress,
    health: 60,
    strength: 62,
    agility: 55,
    charm: 34,
    intellect: 51,
    willpower: 74
  },
  inventory: {
    ...EMPTY_CHARACTER.inventory,
    listedAt: 1,
    items: [
      { name: 'quarterstaff', slot: 'Weapon Hand', equipped: true, charges: null, source: 'wire' },
      { name: 'torch', slot: 'Readied', equipped: true, charges: 40, source: 'wire' },
      { name: 'padded helm', slot: null, equipped: false, charges: null, source: 'wire' },
      {
        name: 'silver ring',
        slot: 'Finger',
        slotSource: 'realm',
        equipped: true,
        charges: null,
        source: 'wire'
      }
    ]
  }
} as CharacterState;

describe('what a portrait request says', () => {
  it('names the race, class, bands, looks and printed slots, and nothing else', () => {
    expect(portraitFactsOf(PROBE)).toEqual({
      race: 'Gnome',
      class: 'Priest',
      gender: 'male',
      hair: 'no',
      eyes: 'black',
      health: 'stout',
      strength: 'well built',
      agility: 'cautiously',
      charm: 'hostile and rather unappealing',
      intellect: 'intelligent',
      willpower: 'has a worldly air',
      stats: { health: 60, strength: 62, agility: 55, charm: 34, intellect: 51, willpower: 74 },
      gear: [{ slot: 'Weapon Hand', item: 'quarterstaff' }]
    });
  });

  it('leaves out what the look did not say', () => {
    const facts = portraitFactsOf({
      ...PROBE,
      appearance: { gender: null, hair: null, eyes: null }
    });
    expect(facts).not.toHaveProperty('gender');
    expect(facts).not.toHaveProperty('hair');
    expect(facts).not.toHaveProperty('eyes');
  });

  it('is not complete before the look, the inventory or every stat', () => {
    expect(portraitFactsOf({ ...PROBE, appearance: null })).toBeNull();
    expect(
      portraitFactsOf({ ...PROBE, inventory: { ...PROBE.inventory, listedAt: null } })
    ).toBeNull();
    expect(portraitFactsOf({ ...PROBE, progress: { ...PROBE.progress, charm: null } })).toBeNull();
  });

  it('names a trained stat point as new facts, though its phrase is unchanged', () => {
    const a = portraitFactsOf(PROBE)!;
    const b = portraitFactsOf({ ...PROBE, progress: { ...PROBE.progress, strength: 63 } })!;
    expect(b.strength).toBe(a.strength);
    expect(factsHash(b)).not.toBe(factsHash(a));
  });

  it('names one set of facts one way, whatever order the gear came in', () => {
    const a = portraitFactsOf(PROBE)!;
    const b: PortraitFacts = { ...a, gear: [...a.gear].reverse() };
    expect(factsHash(a)).toBe(factsHash({ ...b, gear: [...b.gear].reverse() }));
    expect(factsHash(a)).not.toBe(factsHash({ ...a, eyes: 'hazel' }));
  });
});

describe('when a portrait is asked for', () => {
  let dir: string;
  let asked: PortraitFacts[];
  let published: PortraitChange[];
  let said: string[];
  let enabled: boolean;
  let answer: PortraitResult;

  /**
   * Each keeper writes into its own test's lists. A keeper still finishing a draw after its test
   * ended (its folder already removed) would otherwise say its ENOENT into the next test's list.
   */
  const keeper = () => {
    const [ownAsked, ownPublished, ownSaid] = [asked, published, said];
    return new PortraitKeeper({
      source: {
        portraitOf: async (facts) => {
          ownAsked.push(facts);
          return answer;
        }
      },
      cache: new PictureCache(path.join(dir, 'portraits'), () => 10),
      last: lastPortraitAt(path.join(dir, 'portrait', 'probe.json')),
      enabled: () => enabled,
      publish: (view) => ownPublished.push(view),
      say: (message) => ownSaid.push(message)
    });
  };
  /**
   * Polls `done` and fails the test after four seconds, inside vitest's default five. One second
   * was too short for the disk under the full suite's load.
   */
  const until = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error('waited four seconds for the keeper');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const drawn = (one: PortraitKeeper) => () => one.current().status.kind === 'drawn';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-'));
    asked = [];
    published = [];
    said = [];
    enabled = true;
    answer = { kind: 'picture', bytes: PICTURE, type: 'image/webp' };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('asks once when the facts first complete, and not for the HP', async () => {
    const one = keeper();
    one.observe({ ...PROBE, appearance: null });
    expect(one.current().status).toEqual({ kind: 'incomplete' });
    one.observe(PROBE);
    one.observe({ ...PROBE, vitals: { ...PROBE.vitals, hp: 12 } });
    await until(drawn(one));
    expect(asked).toHaveLength(1);
    expect(one.current().picture).toMatch(/^data:image\/webp;base64,/);
    one.dispose();
  });

  it('asks nothing for a panel that opens', async () => {
    const first = keeper();
    first.observe(PROBE);
    await until(drawn(first));
    await until(() => fs.existsSync(path.join(dir, 'portrait', 'probe.json')));
    // A second launch's panel, open before any state: the kept portrait, and no ask.
    const opened = keeper();
    await until(() => opened.current().picture !== null);
    expect(asked).toHaveLength(1);
  });

  it('asks nothing after a restart with the same facts', async () => {
    const first = keeper();
    first.observe(PROBE);
    await until(drawn(first));
    const again = keeper();
    again.observe(PROBE);
    await until(drawn(again));
    expect(asked).toHaveLength(1);
  });

  it('asks again when what is worn changes', async () => {
    const one = keeper();
    one.observe(PROBE);
    await until(() => asked.length === 1 && drawn(one)());
    one.observe({
      ...PROBE,
      inventory: {
        ...PROBE.inventory,
        items: PROBE.inventory.items.map((item) =>
          item.name === 'padded helm' ? { ...item, slot: 'Head', equipped: true } : item
        )
      }
    });
    await until(() => asked.length === 2);
    expect(asked[1]!.gear).toContainEqual({ slot: 'Head', item: 'padded helm' });
    await until(drawn(one));
  });

  it('says a refusal once and does not ask again for the same facts', async () => {
    answer = { kind: 'refused', reason: 'race: not a value the game offers' };
    const one = keeper();
    one.observe(PROBE);
    await until(() => one.current().status.kind === 'refused');
    one.observe({ ...PROBE, progress: { ...PROBE.progress } });
    // The positive control: a change the keeper does ask for, after the one it must not.
    one.observe({ ...PROBE, appearance: { gender: 'male', hair: { none: true }, eyes: 'hazel' } });
    await until(() => asked.length === 2);
    expect(asked[1]!.eyes).toBe('hazel');
    expect(said[0]).toBe('race: not a value the game offers');
    await until(() => said.length === 2);
  });

  it('asks again on the next entry when the server did not answer, and not before', async () => {
    answer = { kind: 'unreachable', reason: 'the art server did not answer' };
    const one = keeper();
    one.observe(PROBE);
    await until(() => one.current().status.kind === 'unreachable');
    answer = { kind: 'picture', bytes: PICTURE, type: 'image/webp' };
    one.observe({ ...PROBE, progress: { ...PROBE.progress } });
    one.observe({ ...PROBE, phase: 'authenticating' });
    one.observe(PROBE);
    await until(drawn(one));
    expect(asked).toHaveLength(2);
  });

  it('pushes the picture once, and a status alone after', async () => {
    const one = keeper();
    one.observe(PROBE);
    await until(drawn(one));
    const pictures = published.filter((change) => change.picture !== undefined);
    expect(pictures).toHaveLength(1);
  });

  it('asks nothing while portraits are off', async () => {
    enabled = false;
    const one = keeper();
    one.observe(PROBE);
    expect(one.current().status).toEqual({ kind: 'off' });
    enabled = true;
    one.observe({ ...PROBE });
    one.observe({ ...PROBE, progress: { ...PROBE.progress } });
    await until(drawn(one));
    expect(asked).toHaveLength(1);
  });
});
