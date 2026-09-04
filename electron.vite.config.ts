import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const shared = resolve('src/shared');

/**
 * Bundled rather than externalised.
 *
 * Electron's ESM loader cannot pre-parse an external dependency of either
 * shape from the built main chunk. `yaml` fails with a TypeError inside
 * `cjsPreparseModuleExports` before any of our code runs; `mdb-reader` is
 * `"type": "module"` and died with *"require() of ES Module … not
 * supported"* the moment anybody chose an Access realm — which read as the
 * client refusing their database, and left them on the shipped realm.
 *
 * Both are pure JavaScript with no native component, so inlining them costs a
 * few kilobytes and removes the runtime resolution entirely.
 */
const BUNDLED = ['yaml', 'mdb-reader'];

/**
 * Comments do not ship.
 *
 * The main and preload chunks are not minified by default, so every comment in
 * `src/` went into `app.asar` verbatim — and in this repository the comments
 * are the documentation: the evidence for a pattern is the *capture*, pasted in
 * beside it. Which meant a released build carried live `who` and party
 * listings naming this developer's characters and other real players, and the
 * hostname of a private server, in a file handed to strangers. Found by
 * grepping the built `app.asar` for a character name on 2026-09-02.
 *
 * **`build.minify` is the lever, not the `esbuild` block.** Two settings were
 * tried and measured before this one: `legalComments: 'none'` governs only
 * licence banners, and `esbuild.minifyWhitespace` is ignored — Vite's `esbuild`
 * options configure the per-module *transform*, and minification is a separate
 * step it does not reach. Both built clean and both still shipped every one of
 * those listings, which is why the measurement is written down here: the way to
 * check this is to grep the built `out/main/index.js`, not to read the config.
 *
 * **`minifyIdentifiers` and `minifySyntax` stay off, and that is not a
 * preference — it is what the smoke harness measured.** Letting esbuild rename
 * identifiers in the window broke the client: 8 checks failed and the run hung,
 * against 663 of 663 passing on the same tree with minification off (2026-09-02,
 * two runs in worktrees differing in this file alone). The tab showed the name
 * the *server* gave rather than the one the profile gives, the diagnostics cards
 * came up visible, the theme was not remembered and the terminal's search found
 * nothing. Renaming is not safe here and the reason has not been chased down;
 * whitespace alone is, and whitespace alone is what removes a comment.
 *
 * Keeping the names has a second payment: a stack trace out of a packaged build
 * still says `CommandQueue` and `resolveProfile` rather than `t` and `e`. This
 * client's console output is how it explains itself (`notice()` writes to
 * stdout for exactly that reason).
 *
 * What is saved anyway is real: main 1,619 kB → 954 kB, the window's script
 * 2,012 kB → 1,381 kB and its stylesheet 217 kB → 81 kB. About 1.4 MB of prose
 * was in every install.
 *
 * Licence notices ride with the distribution rather than inside the
 * executable: the two dependencies actually bundled are `yaml` (ISC) and
 * `mdb-reader` (MIT), and the repository ships its own LICENCE.
 *
 * It is a *build* setting rather than an instruction to write fewer comments.
 * The alternative was editing ninety comments to launder the evidence out of
 * them, which would cost the thing that makes them worth having.
 */
const stripComments = {
  esbuild: { minifyIdentifiers: false, minifySyntax: false, legalComments: 'none' }
} as const;

/**
 * The 500 kB chunk warning is a web-delivery heuristic, and this is not a web
 * target.
 *
 * Vite's default exists because half a megabyte of JavaScript over a slow
 * network is a multi-second stall before anything renders. Nothing here
 * crosses a network: `src/main/index.ts` calls `loadFile()` on
 * `out/renderer/index.html`, whose single `<script>` is a relative path read
 * off the local disk, and main and preload are read by Electron's own loader.
 * So both remedies the warning suggests buy nothing they are offered for —
 * `manualChunks` splits a transfer that never happens, and dynamic `import()`
 * defers parse cost rather than removing it, for a window that uses the
 * terminal, the rail and the cards on its first frame regardless.
 *
 * The limit is raised to make the warning mean something, not to silence it.
 * One that fires on every build forever is one nobody reads, and build output
 * is where a genuine size regression shows up first — a dependency bundled by
 * accident, or the comment stripping above coming undone, which last time was
 * 1.4 MB of prose carrying a private hostname into every install. Main and the
 * window get about half again what they measure today (967 kB and 1,385 kB on
 * 2026-09-03), so ordinary growth is quiet and a doubling still speaks up.
 * Preload's is not scaled from its 7 kB: it is the security boundary and has
 * no business growing at all, so 100 kB reads as *something is wrong here*.
 */
const CHUNK_LIMIT_KB = { main: 1400, preload: 100, renderer: 2000 } as const;

export default defineConfig({
  main: {
    ...stripComments,
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED })],
    resolve: { alias: { '@shared': shared, '@main': resolve('src/main') } },
    build: {
      minify: 'esbuild',
      chunkSizeWarningLimit: CHUNK_LIMIT_KB.main,
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    ...stripComments,
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      minify: 'esbuild',
      chunkSizeWarningLimit: CHUNK_LIMIT_KB.preload,
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    ...stripComments,
    root: resolve('src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@shared': shared, '@renderer': resolve('src/renderer/src') } },
    build: {
      minify: 'esbuild',
      chunkSizeWarningLimit: CHUNK_LIMIT_KB.renderer,
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
});
