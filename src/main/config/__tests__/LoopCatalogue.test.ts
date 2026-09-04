import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LoopCatalogue } from '../LoopCatalogue';

/** The shipped shelf, at the path main builds from `resourcesDir()`. */
const SHIPPED = path.resolve('resources/loops/megamud.yaml');

/**
 * The catalogue of shipped loops.
 *
 * Half of these are about the *file being there and being right*, which is not
 * a thing unit tests usually assert — but this one is data the application
 * ships and a screen offers, and the failure if it is missing or malformed is
 * an empty picker that looks exactly like a feature nobody built. The realm
 * data is announced at startup for the same reason.
 */
describe('the loops the client ships', () => {
  const catalogue = new LoopCatalogue(SHIPPED).all();

  it('is shipped, and is a substantial shelf', () => {
    expect(fs.existsSync(SHIPPED)).toBe(true);
    // 420 at the time of writing, from MegaMUD's 488 recorded paths. Asserted
    // as a floor rather than a figure: a rebuild against better realm data
    // should be free to recover some of the 68 that are dropped.
    expect(catalogue.length).toBeGreaterThan(400);
  });

  it('is packaged rather than left in the source tree', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    const rules = manifest['build']['extraResources'];
    const fromResources = rules.find((rule: { from: string }) => rule.from === 'resources');
    expect(fromResources, 'nothing ships resources/ at all').toBeDefined();
    // Everything under `resources/` ships except what is explicitly withheld —
    // the user's own files. A pattern that withheld the shelf would leave every
    // packaged build with an empty picker and no error anywhere.
    const withheld: string[] = fromResources.filter.filter((rule: string) => rule.startsWith('!'));
    expect(withheld.filter((rule) => rule.includes('loop'))).toEqual([]);
  });

  /*
   * A name is a loop's address: the palette starts one by name, `loopNamed`
   * finds it by name, a profile lists them by name and the picker ticks them by
   * name. Two spelled the same means one of them can never be run — which is
   * exactly what shipped until `build:loops` learned to number them.
   */
  it('gives every loop a name of its own', () => {
    const names = new Set(catalogue.map((loop) => loop.name));
    expect(names.size).toBe(catalogue.length);
  });

  it('gives every loop somewhere to go', () => {
    const short = catalogue.filter((loop) => loop.stops.length < 2);
    expect(short, 'a loop with one stop is a place to stand').toEqual([]);
    const nameless = catalogue.filter((loop) => loop.name.trim().length === 0);
    expect(nameless).toEqual([]);
  });

  /*
   * The stops carry `map/room` because a name alone is ambiguous — thirteen
   * rooms are called Town Gates — and a loop resolved to the wrong one walks
   * a character somewhere nobody chose.
   */
  it('settles every stop with coordinates', () => {
    const vague = catalogue
      .flatMap((loop) => loop.stops)
      .filter((stop) => !/\s\d{1,3}\/\d{1,6}$/.test(stop.room));
    expect(vague).toEqual([]);
  });

  it('reads the file once and keeps it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-loops-'));
    const file = path.join(dir, 'loops.yaml');
    fs.writeFileSync(file, "loops:\n  - name: one\n    stops: ['A 1/1', 'B 1/2']\n", 'utf8');
    const shelf = new LoopCatalogue(file);
    expect(shelf.all()).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
    // The file is inside the application and cannot change while the client
    // runs, so a second read would be a query per keystroke in a search field.
    expect(shelf.all()).toHaveLength(1);
  });
});

/*
 * The shelf is a convenience, and a convenience that throws at the window that
 * asked for it is worse than one that is empty: a loop is still four lines of
 * YAML anybody can write by hand.
 */
describe('a shelf that cannot be read', () => {
  it('is empty rather than an exception, when the file is not there', () => {
    expect(new LoopCatalogue('/nowhere/at/all/megamud.yaml').all()).toEqual([]);
  });

  it('is empty rather than an exception, when the file is not YAML', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-loops-'));
    const file = path.join(dir, 'broken.yaml');
    fs.writeFileSync(file, 'loops:\n  - name: [unclosed\n', 'utf8');
    expect(new LoopCatalogue(file).all()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* A shipped file gone wrong loses the entries that are wrong, not the shelf:
     `asLoops` drops what it cannot read and keeps the rest. */
  it('keeps the loops that are still readable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-loops-'));
    const file = path.join(dir, 'partial.yaml');
    fs.writeFileSync(
      file,
      "loops:\n  - name: ''\n    stops: ['A 1/1']\n  - name: real\n    stops: ['A 1/1', 'B 1/2']\n",
      'utf8'
    );
    expect(new LoopCatalogue(file).all().map((loop) => loop.name)).toEqual(['real']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
