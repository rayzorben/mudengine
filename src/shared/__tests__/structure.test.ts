import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { importsOf, resolveImport, type Import } from './imports';
import { repoPath, sourceFiles } from './sources';

/**
 * The shape of the tree, held the way a closed union's two halves are: a
 * carve-out nobody measures grows back, and a dependency direction nobody
 * asserts holds by luck (`CLAUDE.md` › *SOLID and DRY*, S and D).
 *
 * Read as source text, as `ipc-wiring.test.ts` does, never imported; imports
 * through `./imports`, which follows an alias to the file it names.
 */
const ROOT = path.resolve('.');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const linesOf = (file: string): number => read(file).split('\n').length - 1;
const sources = (dir: string): string[] => sourceFiles(dir).map(repoPath).sort();

/**
 * Each file's ceiling, which is its size: a file that grows past it fails,
 * and one that shrinks fails until the literal is lowered to match, so the
 * carve-out that took the lines out keeps them out. Measured 2026-09-23 at
 * `a923404` (todo 701) and lowered by each of todos 702–741 since. The one
 * raise, Walker's by the line that imports its `SessionModule` contract
 * (702), was taken back by its carve-out (740).
 */
const CEILINGS: Readonly<Record<string, number>> = {
  'src/main/session/SessionManager.ts': 3854,
  'src/main/world/WorldGraph.ts': 2581,
  'src/main/parse/CharacterTracker.ts': 2540,
  'src/renderer/src/App.tsx': 1786,
  'src/main/automation/Walker.ts': 2039,
  'src/renderer/src/components/SettingsScreen.tsx': 1287,
  // Out of the screen whole (741), so it may not grow back into a monolith;
  // lowered by its login rows, shared with the realm's form (811), and by the
  // rest and meditate fields, shared with the options page (825).
  'src/renderer/src/components/CharacterForm.tsx': 1869
};

/**
 * Over the line below for a reason that is not a second concern. Each is a
 * claim with a date, and goes when the file falls back under the line.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'src/main/config/Migration.ts':
    'a one-shot ledger of file moves, each run once and never edited (2026-09-23)'
};

/** The size past which a file must be named above: the line the 2026-09-23 review drew. */
const NAMED_OVER = 4500;

describe('no file grows back', () => {
  it('holds every carved file at its ceiling', () => {
    const off = Object.entries(CEILINGS).flatMap(([file, ceiling]) => {
      const lines = linesOf(file);
      if (lines > ceiling) return [`${file}: ${lines} lines, ceiling ${ceiling}`];
      if (lines < ceiling)
        return [`${file}: ${lines} lines, ceiling ${ceiling}: lower it to ${lines}`];
      return [];
    });
    expect(off, off.join('\n')).toEqual([]);
  });

  it(`names every source over ${NAMED_OVER} lines, so an eighth monolith cannot start`, () => {
    const unnamed = sources('src')
      .filter((file) => !(file in CEILINGS) && !(file in EXEMPT))
      .map((file) => ({ file, lines: linesOf(file) }))
      .filter(({ lines }) => lines > NAMED_OVER)
      .map(
        ({ file, lines }) =>
          `${file}: ${lines} lines, over ${NAMED_OVER} with no ceiling or exemption`
      );
    expect(unnamed, unnamed.join('\n')).toEqual([]);
  });

  it('names only files that exist, and exempts only files over the line', () => {
    const gone = [...Object.keys(CEILINGS), ...Object.keys(EXEMPT)].filter(
      (file) => !fs.existsSync(path.join(ROOT, file))
    );
    expect(gone, `named but absent: ${gone.join(', ')}`).toEqual([]);
    const needless = Object.keys(EXEMPT).filter((file) => linesOf(file) <= NAMED_OVER);
    expect(needless, `exempt but under ${NAMED_OVER} lines: ${needless.join(', ')}`).toEqual([]);
  });
});

const into =
  (dir: string) =>
  (imp: Import): boolean =>
    imp.target.startsWith(`${dir}/`);
const describeImport = ({ from, target, typeOnly }: Import): string =>
  `${from} imports ${typeOnly ? 'type from ' : ''}${target}`;

describe('dependencies point down', () => {
  it('keeps src/shared/ free of anything outside itself, npm included', () => {
    const out = sources('src/shared')
      .flatMap(importsOf)
      .filter((imp) => !into('src/shared')(imp))
      .map(describeImport);
    expect(out, out.join('\n')).toEqual([]);
  });

  it('keeps parse/ from importing automation/ or session/', () => {
    const up = sources('src/main/parse')
      .flatMap(importsOf)
      .filter((imp) => into('src/main/automation')(imp) || into('src/main/session')(imp))
      .map(describeImport);
    expect(up, up.join('\n')).toEqual([]);
  });

  it('keeps automation/ and world/ from importing session/, import type included', () => {
    const up = [...sources('src/main/automation'), ...sources('src/main/world')]
      .flatMap(importsOf)
      .filter(into('src/main/session'))
      .map(describeImport);
    expect(up, up.join('\n')).toEqual([]);
  });

  /*
   * The router and its port read the realm through `RoomIndex` and never the
   * graph that composes it (todo 710), so the router can one day run where
   * the graph is not; the catalogue is read by both and reads neither (todo
   * 711); the quest planner reads the router and the catalogue and never the
   * graph (todo 712). Walked through every import, types included, because a
   * cycle through a third file is still a cycle.
   */
  const graph = 'src/main/world/WorldGraph.ts';
  const router = 'src/main/world/Router.ts';
  const catalogue = 'src/main/world/Catalogue.ts';
  const planner = 'src/main/world/QuestPlanner.ts';
  const pathTo = (from: string, to: string, seen = new Set<string>()): string[] | null => {
    if (from === to) return [from];
    if (seen.has(from) || !/\.tsx?$/.test(from) || !fs.existsSync(path.join(ROOT, from))) {
      return null;
    }
    seen.add(from);
    for (const { target } of importsOf(from)) {
      const rest = pathTo(target, to, seen);
      if (rest !== null) return [from, ...rest];
    }
    return null;
  };

  it('keeps the router from reaching the graph or the catalogue by any path', () => {
    for (const file of [router, 'src/main/world/RoomIndex.ts']) {
      for (const to of [graph, catalogue]) {
        expect(pathTo(file, to)?.join(' → ') ?? null, `${file} reaches ${to}`).toBeNull();
      }
    }
    // The walk does reach: the graph itself imports the router.
    expect(pathTo(graph, graph)).toEqual([graph]);
    expect(importsOf(graph).map((imp) => imp.target)).toContain(router);
  });

  it('keeps the catalogue from reaching the graph or the router by any path', () => {
    for (const to of [graph, router]) {
      expect(pathTo(catalogue, to)?.join(' → ') ?? null, `the catalogue reaches ${to}`).toBeNull();
    }
    // The walk does reach: out of the catalogue into what it reads, and the graph imports it.
    expect(pathTo(catalogue, 'src/shared/world.ts')).not.toBeNull();
    expect(importsOf(graph).map((imp) => imp.target)).toContain(catalogue);
  });

  it('keeps the quest planner from reaching the graph by any path', () => {
    for (const file of [planner, 'src/main/world/PlannerRooms.ts']) {
      expect(pathTo(file, graph)?.join(' → ') ?? null, `${file} reaches ${graph}`).toBeNull();
    }
    // The walk does reach: out of the planner into both units it reads, and the graph imports it.
    expect(pathTo(planner, router)).not.toBeNull();
    expect(pathTo(planner, catalogue)).not.toBeNull();
    expect(importsOf(graph).map((imp) => imp.target)).toContain(planner);
  });

  /*
   * The walk's units (todo 740) are composed by `Walker` and never reach back
   * into it, nor into the realm the walker deliberately does not know: the
   * world is `session/Travel.ts`'s and `Errands.ts`'s to adapt.
   */
  it('keeps the walk units from reaching the walker or the graph by any path', () => {
    const walker = 'src/main/automation/Walker.ts';
    const units = sources('src/main/automation/walk');
    for (const file of units) {
      for (const to of [walker, graph]) {
        expect(pathTo(file, to)?.join(' → ') ?? null, `${file} reaches ${to}`).toBeNull();
      }
    }
    // The walk does reach: the walker imports every unit.
    const imported = importsOf(walker).map((imp) => imp.target);
    expect(units.length).toBeGreaterThan(0);
    for (const file of units) expect(imported).toContain(file);
  });

  /*
   * The window's three state machines (todo 731) are composed by `App` and
   * never reach back into it. The views fold each fact through the alerts'
   * port and the alerts never read the views, so the raising cannot be folded
   * back into the reducer it feeds.
   */
  it('keeps the window hooks from reaching App, and the alerts from reaching the views', () => {
    const app = 'src/renderer/src/App.tsx';
    const hook = (name: string): string => `src/renderer/src/hooks/${name}.ts`;
    const [views, alerts, panes] = ['useSessionViews', 'useAlerts', 'usePanes'].map(hook);
    for (const file of [views!, alerts!, panes!]) {
      expect(pathTo(file, app)?.join(' → ') ?? null, `${file} reaches ${app}`).toBeNull();
    }
    expect(pathTo(alerts!, views!)?.join(' → ') ?? null, 'the alerts reach the views').toBeNull();
    // The walk does reach: App imports all three, and the views import the alerts' port.
    const imported = importsOf(app).map((imp) => imp.target);
    for (const file of [views!, alerts!, panes!]) expect(imported).toContain(file);
    expect(pathTo(views!, alerts!)).not.toBeNull();
  });

  /*
   * The palette's list and the modals (todo 732) are composed by `App` in the
   * same way, and never reach back into it: the list stays a pure function a
   * test can call, and each modal's state stays with the modal.
   */
  it('keeps the palette and the modals from reaching App', () => {
    const app = 'src/renderer/src/App.tsx';
    const units = [
      'src/renderer/src/lib/palette.ts',
      'src/renderer/src/components/SlideOuts.tsx',
      ...[
        'useCommandPalette',
        'useHomeBrowser',
        'useLoopsModal',
        'useRoutePanel',
        'useSearchBar',
        'useSettingsScreen',
        'useSlideOuts'
      ].map((name) => `src/renderer/src/hooks/${name}.ts`)
    ];
    for (const file of units) {
      expect(pathTo(file, app)?.join(' → ') ?? null, `${file} reaches ${app}`).toBeNull();
    }
    // The walk does reach: App imports every one of them.
    const imported = importsOf(app).map((imp) => imp.target);
    for (const file of units) expect(imported).toContain(file);
  });

  /*
   * The card switch, its context and the callback bank (todo 733) are
   * composed by `App` in the same way and never reach back into it.
   */
  it('keeps the card switch and the callback bank from reaching App', () => {
    const app = 'src/renderer/src/App.tsx';
    const units = [
      'src/renderer/src/components/CardSwitch.tsx',
      'src/renderer/src/components/PinnedFloats.tsx',
      'src/renderer/src/lib/cards.ts',
      'src/renderer/src/lib/paletteFind.ts',
      'src/renderer/src/lib/reference.ts',
      'src/renderer/src/lib/theme.ts',
      ...[
        'useCardChrome',
        'useCardContext',
        'useCardRenderers',
        'useConnection',
        'useDiagnosticFeeds',
        'useLoopBuilder',
        'useMovement',
        'useNameIndexes',
        'useNavigationVisible',
        'usePaneRanges',
        'useProfileReaders',
        'useRouteOpeners',
        'useShownRealm'
      ].map((name) => `src/renderer/src/hooks/${name}.ts`)
    ];
    for (const file of units) {
      expect(pathTo(file, app)?.join(' → ') ?? null, `${file} reaches ${app}`).toBeNull();
    }
    // The walk does reach: App imports each, the switch through its renderers,
    // the theme's port through the palette and the lookup's rows through its
    // query.
    const imported = importsOf(app).map((imp) => imp.target);
    const through: Readonly<Record<string, string>> = {
      'src/renderer/src/components/CardSwitch.tsx': 'src/renderer/src/hooks/useCardRenderers.ts',
      'src/renderer/src/lib/theme.ts': 'src/renderer/src/lib/palette.ts',
      'src/renderer/src/lib/reference.ts': 'src/renderer/src/lib/paletteFind.ts'
    };
    for (const file of units) {
      const via = through[file];
      if (via === undefined) expect(imported).toContain(file);
      else expect(importsOf(via).map((imp) => imp.target)).toContain(file);
    }
  });

  /*
   * `lib/` is what hooks and components are built on, testable without React
   * (todo 733): it imports no hook, a type included, so a port a hook and a
   * `lib/` module share is declared in `lib/`; and of a component it takes a
   * type (a prop's shape), never code.
   */
  it("keeps the renderer lib/ from importing a hook, or a component's code", () => {
    const up = sources('src/renderer/src/lib')
      .flatMap(importsOf)
      .filter(
        (imp) =>
          into('src/renderer/src/hooks')(imp) ||
          (into('src/renderer/src/components')(imp) && !imp.typeOnly)
      )
      .map(describeImport);
    expect(up, up.join('\n')).toEqual([]);
    // A component's type is seen as one, so the second half has something to pass.
    expect(importsOf('src/renderer/src/lib/palette.ts')).toContainEqual(
      expect.objectContaining({
        target: 'src/renderer/src/components/CommandPalette.tsx',
        typeOnly: true
      })
    );
    // The filter matches where there is something to match: App imports hooks.
    expect(importsOf('src/renderer/src/App.tsx').some(into('src/renderer/src/hooks'))).toBe(true);
    // And an import within lib/ resolves to its file, a type-only one included.
    expect(importsOf('src/renderer/src/lib/palette.ts')).toContainEqual(
      expect.objectContaining({ target: 'src/renderer/src/lib/cards.ts', typeOnly: false })
    );
    expect(importsOf('src/renderer/src/lib/palette.ts')).toContainEqual(
      expect.objectContaining({ target: 'src/renderer/src/lib/theme.ts', typeOnly: true })
    );
  });

  /*
   * The settings screen's forms and their model (todo 741) are composed by
   * `SettingsScreen` and never reach back into it: the screen owns the
   * histories, the saving and which character or realm is on screen, and a
   * form that read them would be the monolith again under another name.
   */
  it('keeps the settings forms and their model from reaching SettingsScreen', () => {
    const screen = 'src/renderer/src/components/SettingsScreen.tsx';
    const units = [
      'src/renderer/src/components/CharacterForm.tsx',
      'src/renderer/src/components/ServerForm.tsx',
      'src/renderer/src/components/PlayerGrants.tsx',
      'src/renderer/src/lib/characterForm.ts',
      'src/renderer/src/lib/serverForm.ts',
      'src/renderer/src/hooks/useCharacterRealm.ts'
    ];
    for (const file of units) {
      expect(pathTo(file, screen)?.join(' → ') ?? null, `${file} reaches ${screen}`).toBeNull();
    }
    // The walk does reach: out of the screen into every one of them.
    for (const file of units) expect(pathTo(screen, file)).not.toBeNull();
  });

  it('finds the imports it rules on, so an empty result means something', () => {
    // A type-only import is seen: the port `SplitMemory` implements, now beneath both layers.
    expect(importsOf('src/main/world/SplitMemory.ts')).toContainEqual(
      expect.objectContaining({ target: 'src/shared/memory.ts', typeOnly: true })
    );
    expect(sources('src/main/parse').flatMap(importsOf).some(into('src/shared'))).toBe(true);
    // The filter the session rule applies matches where there is something to match.
    expect(importsOf('src/main/client.ts').some(into('src/main/session'))).toBe(true);
    // An alias is followed to its file, not read as a package.
    expect(resolveImport('@main/session/SessionManager', 'src/main/automation/Walker.ts')).toBe(
      'src/main/session/SessionManager.ts'
    );
  });
});
