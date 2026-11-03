/**
 * Which key holds each character's name, kept in `/data/claims.json`, written
 * whole and readable by the gateway's user only. The first key to answer for
 * a name holds it; another key is refused while it does, so nobody can play
 * receiver under a name its owner is using. A name its key has not claimed
 * for `claimIdleMs` passes to the next key that answers for it: a character
 * deleted and made again by somebody else. The only state the gateway keeps
 * across a restart.
 */
import fs from 'node:fs';

import { writeWhole } from '../node/writeWhole';
import { asPeerKey, peerKeyText, type PeerKey } from '../shared/peers';
import { isPublicKey } from '../shared/peerWire';
import { errorMessage, isRecord } from '../shared/values';

interface Pin {
  readonly peer: PeerKey;
  readonly key: string;
  /** When this key last answered for the name. */
  readonly seen: number;
}

/**
 * `new` and `moved` are the name passing to this key, `same` is the key that
 * holds it, `held` another key holding it, and `full` no room for a new name.
 */
export type ClaimAnswer = 'new' | 'same' | 'moved' | 'held' | 'full';

const FILE_VERSION = 1;

function asPin(value: unknown): Pin | null {
  if (!isRecord(value)) return null;
  const peer = asPeerKey(value['peer']);
  const { key, seen } = value;
  if (peer === null || !isPublicKey(key) || typeof seen !== 'number') return null;
  return { peer, key, seen };
}

export interface ClaimBookDeps {
  idleMs: number;
  mostPins: number;
  now(): number;
  log(line: string): void;
}

export class ClaimBook {
  private readonly pins = new Map<string, Pin>();
  /** One write at a time; a change made during one is written by the next. */
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(
    private readonly file: string,
    private readonly deps: ClaimBookDeps
  ) {}

  /**
   * The book on disk, or an empty one where there is no file yet. A file that
   * does not parse stops the gateway: starting empty would let any key take
   * every name.
   */
  static async open(file: string, deps: ClaimBookDeps): Promise<ClaimBook> {
    const book = new ClaimBook(file, deps);
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return book;
      throw new Error(`${file} could not be read: ${errorMessage(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file} is not JSON: ${errorMessage(error)}`, { cause: error });
    }
    if (!isRecord(parsed) || parsed['v'] !== FILE_VERSION || !Array.isArray(parsed['pins'])) {
      throw new Error(`${file} is not a claims file of version ${FILE_VERSION}`);
    }
    let skipped = 0;
    for (const each of parsed['pins']) {
      const pin = asPin(each);
      if (pin === null) skipped += 1;
      else book.pins.set(peerKeyText(pin.peer), pin);
    }
    deps.log(`claims: ${book.pins.size} names read from ${file}`);
    if (skipped > 0)
      deps.log(`claims: ${skipped} entries in ${file} did not read and were left out`);
    return book;
  }

  /** Answer for `peer` with `key`, already proved to be held, and pin it where it may. */
  claim(peer: PeerKey, key: string): ClaimAnswer {
    const id = peerKeyText(peer);
    const now = this.deps.now();
    const pin = this.pins.get(id);
    let answer: ClaimAnswer;
    if (pin === undefined) answer = this.pins.size >= this.deps.mostPins ? 'full' : 'new';
    else if (pin.key === key) answer = 'same';
    else answer = now - pin.seen >= this.deps.idleMs ? 'moved' : 'held';
    if (answer === 'held' || answer === 'full') return answer;
    this.pins.delete(id);
    this.pins.set(id, { peer, key, seen: now });
    this.save();
    return answer;
  }

  /** Every write asked for so far, done. */
  async settle(): Promise<void> {
    await this.writing;
  }

  private save(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      this.dirty = false;
      const text = JSON.stringify({ v: FILE_VERSION, pins: [...this.pins.values()] });
      try {
        await writeWhole(this.file, text, 0o600);
      } catch (error) {
        this.deps.log(`claims: ${this.file} could not be written: ${errorMessage(error)}`);
      }
    });
  }
}
