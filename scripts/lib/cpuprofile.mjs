/**
 * Reads a V8 `.cpuprofile` and says where the window's time went.
 *
 * Two attributions, because two questions get asked of a profile:
 *
 * - **By source file**, through the bundle's sourcemap. The renderer ships as
 *   one chunk, and React's and xterm's own builds arrive pre-minified, so a
 *   function *name* says nothing about whose code it is — `Ni` is React's
 *   `beginWork` and `t.write` is xterm's. The sourcemap does: a sample is
 *   React's, xterm's, or `src/renderer/src/components/TabRail.tsx`'s.
 * - **By component**, walking each sample's stack from the leaf towards the
 *   root and stopping at the first frame that is one of this client's own
 *   components. React calls a component's function directly, so everything
 *   under that frame — hooks, memo bodies, `t()` lookups — is that
 *   component's cost, and everything above it is React's bookkeeping for it.
 *
 * Self time is attributed the way DevTools attributes it: sample *i* lasts
 * until sample *i + 1*, so its duration is `timeDeltas[i + 1]`.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * A `(line, column) → original source path` function over the bundle's map,
 * or `null` when the map is missing or the mapping library is not installed —
 * the analysis then falls back to names, and says so.
 *
 * `@jridgewell/trace-mapping` is what Vite itself resolves maps with, so it is
 * always in `node_modules` on a tree that can build; it is reached through
 * `createRequire` because it is a transitive dependency rather than one this
 * repository declares.
 */
export function loadMapper(mapFile) {
  if (!fs.existsSync(mapFile)) return null;
  try {
    const require = createRequire(import.meta.url);
    const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');
    const map = new TraceMap(JSON.parse(fs.readFileSync(mapFile, 'utf8')));
    const cache = new Map();
    return (line, column) => {
      const key = `${line}:${column}`;
      if (cache.has(key)) return cache.get(key);
      const found = originalPositionFor(map, { line, column });
      const source = found.source ?? null;
      cache.set(key, source);
      return source;
    };
  } catch {
    return null;
  }
}

/** The bucket a source path falls in: a library, or a file of this client's. */
export function categoryOf(source, functionName) {
  if (functionName === '(garbage collector)') return 'gc';
  if (functionName === '(idle)') return 'idle';
  if (functionName === '(program)') return 'program';
  if (functionName === '(root)') return 'root';
  if (!source) return 'unmapped';
  const s = source.replace(/\\/g, '/');
  if (/node_modules\/react-dom\//.test(s)) return 'react-dom';
  if (/node_modules\/react\//.test(s) || /node_modules\/scheduler\//.test(s)) return 'react';
  if (/node_modules\/@xterm\//.test(s)) return 'xterm';
  const own = /(?:^|\/)src\/(renderer\/src|shared)\/(.*)$/.exec(s);
  if (own) return `${own[1] === 'shared' ? 'shared' : 'ui'}/${own[2]}`;
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(s);
  if (pkg) return `pkg:${pkg[1]}`;
  return `other:${s}`;
}

/** Whether a source path is one of this client's React components. */
function isComponentSource(source) {
  return (
    typeof source === 'string' &&
    /src\/renderer\/src\/(components\/[^/]+\.tsx|App\.tsx)$/.test(source.replace(/\\/g, '/'))
  );
}

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * The analysis. Every duration is in milliseconds.
 *
 * `busyMs` is everything that is not `(idle)`: what the main thread was
 * actually doing, which is the number that decides whether a keystroke had to
 * wait. `byCategory` is inclusive — a sample inside a component inside React
 * counts for both — so the rows do not sum to the total, and are not meant to.
 * `selfByCategory` does sum, and is where the time was *spent* rather than
 * *caused*.
 */
export function analyse(profile, { mapper = null } = {}) {
  const nodes = new Map();
  const parentOf = new Map();
  for (const node of profile.nodes) {
    nodes.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }

  const describe = new Map();
  const describeNode = (node) => {
    const cached = describe.get(node.id);
    if (cached) return cached;
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    // `.cpuprofile` positions are zero-based; a sourcemap query is one-based
    // for the line and zero-based for the column.
    const source =
      mapper && url && !functionName.startsWith('(')
        ? mapper(lineNumber + 1, columnNumber)
        : null;
    const category = categoryOf(source, functionName);
    const short = source ? source.replace(/^.*\/(src\/|node_modules\/)/, '$1') : url ? 'bundle' : '';
    const info = {
      name: functionName || '(anonymous)',
      source,
      category,
      label: `${functionName || '(anonymous)'} ${short ? `[${short}:${lineNumber + 1}]` : ''}`.trim(),
      component:
        isComponentSource(source) && functionName && /^[A-Z]/.test(functionName)
          ? functionName
          : null
    };
    describe.set(node.id, info);
    return info;
  };

  const selfByNode = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let totalUs = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const dur = Math.max(0, deltas[i + 1] ?? 0);
    totalUs += dur;
    selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + dur);
  }

  const selfByCategory = new Map();
  const selfByFunction = new Map();
  const inclusiveByCategory = new Map();
  const byComponent = new Map();
  let idleUs = 0;

  const add = (map, key, us) => map.set(key, (map.get(key) ?? 0) + us);

  for (const [id, us] of selfByNode) {
    const node = nodes.get(id);
    if (!node) continue;
    const leaf = describeNode(node);
    if (leaf.category === 'idle') idleUs += us;
    add(selfByCategory, leaf.category, us);
    add(selfByFunction, leaf.label, us);

    // Inclusive: every distinct category on the stack gets the sample once,
    // and the sample is attributed to the nearest component below React.
    const seen = new Set();
    let component = null;
    for (let at = id; at !== undefined; at = parentOf.get(at)) {
      const info = describeNode(nodes.get(at));
      if (!seen.has(info.category)) {
        seen.add(info.category);
        add(inclusiveByCategory, info.category, us);
      }
      if (component === null && info.component) component = info.component;
    }
    if (component !== null) add(byComponent, component, us);
  }

  const ms = (us) => Math.round(us / 100) / 10;
  const rows = (map, limit) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key, us]) => ({ key, ms: ms(us) }));

  return {
    totalMs: ms(totalUs),
    busyMs: ms(totalUs - idleUs),
    mapped: mapper !== null,
    selfByCategory: rows(selfByCategory, 40),
    inclusiveByCategory: rows(inclusiveByCategory, 40),
    byComponent: rows(byComponent, 25),
    topSelf: rows(selfByFunction, 30)
  };
}

/** Percentiles over a list of numbers, for a table. */
export function spread(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0
  };
}
