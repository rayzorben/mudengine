/**
 * Whether a module was run with `node <file>` rather than imported. Real paths
 * on both sides: Node resolves the module through a symlinked checkout
 * (`~/code` → Dropbox) but leaves `argv[1]` as typed, so a plain comparison
 * says "imported" and the shell gets nothing.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Pass the caller's `import.meta.url`. */
export function runDirectly(moduleUrl) {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
