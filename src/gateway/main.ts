/**
 * The peer gateway (todo 20261031-1156-01), its own program in its own
 * container on the OCI host (`deploy/gateway.sh`), built to
 * `out/gateway/main.mjs` by `scripts/build-gateway.mjs`. It reads the build
 * secret from `<data>/build-secret` and keeps name claims in
 * `<data>/claims.json`; everything else is in memory and goes with a restart,
 * after which every install registers and claims again.
 *
 *   PEER_DATA   the data directory (`/data`)
 *   PEER_HOST   the address to listen on (`0.0.0.0` in the container)
 *   PEER_PORT   the port (8192)
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { verifyEd25519 } from '../node/ed25519';
import { errorMessage } from '../shared/values';
import { ClaimBook } from './ClaimBook';
import { GATEWAY_LIMITS } from './limits';
import { createGateway } from './server';

const log = (line: string): void => {
  console.log(`${new Date().toISOString()} ${line}`);
};

async function start(): Promise<void> {
  const data = process.env['PEER_DATA'] ?? '/data';
  const host = process.env['PEER_HOST'] ?? '0.0.0.0';
  const port = Number(process.env['PEER_PORT'] ?? '8192');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PEER_PORT ${process.env['PEER_PORT'] ?? ''} is not a port`);
  }
  const secretFile = path.join(data, 'build-secret');
  const buildSecret = (await fs.promises.readFile(secretFile, 'utf8')).trim();
  if (buildSecret.length === 0) throw new Error(`${secretFile} is empty`);

  const claims = await ClaimBook.open(path.join(data, 'claims.json'), {
    idleMs: GATEWAY_LIMITS.claimIdleMs,
    mostPins: GATEWAY_LIMITS.mostPins,
    now: Date.now,
    log
  });
  const gateway = createGateway({
    buildSecret,
    claims,
    verify: verifyEd25519,
    limits: GATEWAY_LIMITS,
    now: Date.now,
    random: (bytes) => randomBytes(bytes).toString('hex'),
    log
  });
  const listening = await gateway.listen(port, host);
  log(`peer gateway listening on ${host}:${listening}`);

  const stop = (signal: string): void => {
    log(`${signal}: stopping`);
    gateway
      .close()
      .then(() => claims.settle())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log(`stopping failed: ${errorMessage(error)}`);
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

/*
 * A fault no socket contained is said and the gateway keeps serving: every
 * install's shares go through this one process, as four characters go
 * through the client's main (`guardTheProcess`).
 */
process.on('uncaughtException', (error) => {
  log(`a fault no socket contained: ${error.stack ?? errorMessage(error)}`);
});
process.on('unhandledRejection', (reason) => {
  log(`a promise nothing awaited failed: ${errorMessage(reason)}`);
});

start().catch((error: unknown) => {
  log(`the gateway could not start: ${errorMessage(error)}`);
  process.exit(1);
});
