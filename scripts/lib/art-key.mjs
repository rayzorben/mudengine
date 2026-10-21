/**
 * The art server's secret as an image build reads it: `ART_BUILD_SECRET`,
 * trimmed the way `electron.vite.config.ts` trims it, and the fingerprint the
 * Dockerfile keys its build layer on (a build secret is not part of the layer
 * cache key). Used by `scripts/docker.mjs`, `deploy/oci.sh` and `release.yml`.
 * Run directly it prints the fingerprint, or nothing when the secret is unset.
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** The secret from the environment, or `null` when unset or blank. */
export function artSecret(env = process.env) {
  const secret = env['ART_BUILD_SECRET']?.trim() ?? '';
  return secret.length > 0 ? secret : null;
}

/** The first 12 hex of the secret's sha256, or `''` without one. */
export function artKeyId(env = process.env) {
  const secret = artSecret(env);
  return secret === null ? '' : createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

// Run directly, prints the fingerprint for a shell (`deploy/oci.sh`, `release.yml`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(artKeyId());
}
