/**
 * The art server's secret as an image build reads it: `ART_BUILD_SECRET`, or
 * else the file `secretFile()` names, trimmed, and the fingerprint the Dockerfile
 * keys its build layer on (a build secret is not part of the layer cache key).
 * The file is how a laptop keeps it across shells and a reset shell config.
 * Used by `electron.vite.config.ts`, `scripts/docker.mjs`, `deploy/oci.sh` and
 * `release.yml`. Run directly it prints the fingerprint, or nothing without a
 * secret; `--secret` and `--file` are below.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runDirectly } from './run-directly.mjs';

/**
 * Where a machine keeps the secret: `ART_BUILD_SECRET_FILE`, or a folder of
 * its own under the config root. Not the client's user-data folder, whose
 * existence the first run reads.
 */
export function secretFile(env = process.env) {
  const named = env['ART_BUILD_SECRET_FILE']?.trim();
  if (named) return named;
  const config = env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return join(config, 'mudengine-build', 'art-secret');
}

function fromFile(env) {
  try {
    return readFileSync(secretFile(env), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw new Error(`could not read the art secret from ${secretFile(env)}: ${error.message}`, {
      cause: error
    });
  }
}

/** The secret from the environment, else the file, or `null` when both are unset or blank. */
export function artSecret(env = process.env) {
  const secret = env['ART_BUILD_SECRET']?.trim() || fromFile(env).trim();
  return secret.length > 0 ? secret : null;
}

/** The first 12 hex of the secret's sha256, or `''` without one. */
export function artKeyId(env = process.env) {
  const secret = artSecret(env);
  return secret === null ? '' : createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

// Run directly, prints the fingerprint for a shell (`deploy/oci.sh`, `release.yml`),
// with `--secret` the secret for `deploy/oci.sh` to pipe over ssh, or with
// `--file` where the secret file is looked for.
if (runDirectly(import.meta.url)) {
  const mode = process.argv[2];
  console.log(
    mode === '--secret' ? (artSecret() ?? '') : mode === '--file' ? secretFile() : artKeyId()
  );
}
