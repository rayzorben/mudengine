/**
 * A character's Ed25519 key pair for each realm it shares on (todo
 * 20261031-1156-01, decided 2026-11-02): made the first time a share needs
 * it, kept in `<home>/peer-keys/<id>.json` readable by this user only, and
 * never printed, sent or exported. The public half is what another player
 * pins; a new owner of the name has another install and another key, so the
 * pin no longer matches. Not a `CHARACTER_RECORDS` record, since those travel
 * with an exported character and this one stays with the install.
 */
import fs from 'node:fs';

import type { Ed25519Pair } from '../../node/ed25519';
import { isPublicKey } from '../../shared/peerWire';
import { errorMessage, isRecord } from '../../shared/values';
import { writeWhole } from '../app/writeWhole';

/** A private key's 32 bytes as base64url. */
const PRIVATE_KEY = /^[A-Za-z0-9_-]{43}$/;

export interface PeerKeyStore {
  /** The pair for `realm`, made and written the first time it is asked for. */
  pairFor(realm: string): Promise<Ed25519Pair>;
}

function asPair(value: unknown): Ed25519Pair | null {
  if (!isRecord(value)) return null;
  const { publicKey, privateKey } = value;
  if (!isPublicKey(publicKey) || typeof privateKey !== 'string' || !PRIVATE_KEY.test(privateKey)) {
    return null;
  }
  return { publicKey, privateKey };
}

/**
 * The store over one character's file. A file that is there and does not
 * read is refused rather than written over: a new pair would end every share
 * pinned to the old one.
 */
export function peerKeysAt(file: string, make: () => Ed25519Pair): PeerKeyStore {
  /** Each pair read or made, by realm, once the file has been read. */
  let held: Promise<Map<string, Ed25519Pair>> | null = null;
  /** Writes in order, so two realms' first shares cannot lose one another's pair. */
  let writing: Promise<void> = Promise.resolve();

  const read = async (): Promise<Map<string, Ed25519Pair>> => {
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw new Error(`${file} could not be read: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file} is not JSON, so no key is made over it: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) throw new Error(`${file} holds no keys, so no key is made over it`);
    const pairs = new Map<string, Ed25519Pair>();
    for (const [realm, value] of Object.entries(parsed)) {
      const pair = asPair(value);
      if (pair === null) throw new Error(`${file} has a key for ${realm} that does not read`);
      pairs.set(realm, pair);
    }
    return pairs;
  };

  return {
    async pairFor(realm) {
      held ??= read().catch((error: unknown) => {
        // Read again next time: the file may be fixed by hand.
        held = null;
        throw error;
      });
      const pairs = await held;
      const kept = pairs.get(realm);
      if (kept !== undefined) return kept;
      const pair = make();
      pairs.set(realm, pair);
      const text = JSON.stringify(Object.fromEntries(pairs));
      const written = writing.then(() => writeWhole(file, text, 0o600));
      writing = written.catch(() => undefined);
      try {
        await written;
      } catch (error) {
        pairs.delete(realm);
        throw new Error(
          `the key for ${realm} could not be kept in ${file}: ${errorMessage(error)}`
        );
      }
      return pair;
    }
  };
}
