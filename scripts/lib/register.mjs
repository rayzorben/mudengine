/**
 * What `node --import` loads to run a script against the TypeScript sources.
 *
 * `tsx` for the `.ts` imports, then `yaml-hook.mjs` for the one `.yaml`
 * import the main process makes (see that file). One entry point rather than
 * two `--import` flags per script, so the next hook the sources need goes here
 * and not into twenty lines of `package.json`.
 */
import { registerHooks } from 'node:module';
import 'tsx';

import { load } from './yaml-hook.mjs';

registerHooks({ load });
