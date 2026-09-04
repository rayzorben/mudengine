/**
 * What this client calls itself when another client asks.
 *
 * `@version` is answered `{mudengine 0.5.0}` in the shape MegaMUD answers
 * `{MegaMMUD 2.1}` (captured live, 2026-08-29): the client's name and its
 * version, one space between. Read from the package rather than restated —
 * a version typed twice is a version that drifts.
 */
import pkg from '../../../package.json';

export const CLIENT_NAME = 'mudengine';
export const CLIENT_VERSION: string = pkg.version;
