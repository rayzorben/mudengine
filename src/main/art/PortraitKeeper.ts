/**
 * One character's portrait (todo 20261019-0931-01): asked for once, the first
 * time its facts are complete, and after that only when they change, never
 * on a clock and never because the panel opened. The last one is kept on disk
 * and shown from there on the next launch before anything is read. One ask is
 * in flight at a time; facts that changed meanwhile are asked for after it.
 */
import type { CharacterState } from '../../shared/character';
import {
  NO_PORTRAIT,
  type PortraitChange,
  type PortraitFacts,
  type PortraitSource,
  type PortraitStatus,
  type PortraitView
} from '../../shared/portrait';
import { errorMessage } from '../../shared/values';
import { AskLedger } from './AskLedger';
import { dataUrlOf, type LastPortrait, type Picture, type PictureCache } from './pictureCache';
import { factsHash, portraitFactsOf } from './portraitFacts';

export interface PortraitKeeperDeps {
  source: PortraitSource;
  cache: PictureCache;
  last: LastPortrait;
  /** `art.enabled`, read through. */
  enabled(): boolean;
  /** The view changed: to the windows, the picture only when it is new. */
  publish(change: PortraitChange): void;
  /** A refusal or a failure, said once for each set of facts. */
  say(message: string): void;
}

export class PortraitKeeper {
  private view: PortraitView = NO_PORTRAIT;
  /** The bytes behind `view.picture`, for a save. */
  private shown: Picture | null = null;
  /** The facts each ask was for, and which the server did not answer. */
  private readonly ledger = new AskLedger();
  private inFlight = false;
  private latest: CharacterState | null = null;
  /** The parts of the state the facts are made of, as last seen, so a line that moved none of them costs nothing. */
  private seen: readonly unknown[] = [];
  private disposed = false;

  constructor(private readonly deps: PortraitKeeperDeps) {
    void this.showLast();
  }

  current(): PortraitView {
    return this.view;
  }

  /** The picture shown, as drawn, or null before one. */
  picture(): Picture | null {
    return this.shown;
  }

  observe(state: CharacterState): void {
    const entered = this.ledger.entered(state.phase);
    const parts = [
      entered,
      this.deps.enabled(),
      state.race,
      state.className,
      state.appearance,
      state.progress,
      state.inventory.items,
      state.inventory.listedAt
    ];
    if (parts.length === this.seen.length && parts.every((part, at) => part === this.seen[at])) {
      return;
    }
    this.seen = parts;
    this.latest = state;
    this.consider();
  }

  dispose(): void {
    this.disposed = true;
  }

  private consider(): void {
    const state = this.latest;
    if (state === null || this.inFlight || this.disposed) return;
    if (!this.deps.enabled()) {
      // Turned back on, the same facts may be asked again.
      this.ledger.clear();
      this.status({ kind: 'off' });
      return;
    }
    const facts = portraitFactsOf(state);
    if (facts === null) {
      this.status({ kind: 'incomplete' });
      return;
    }
    const hash = factsHash(facts);
    if (this.ledger.has(hash)) return;
    this.ledger.begin(hash);
    this.inFlight = true;
    void this.draw(hash, () => this.pictureFor(facts, hash)).finally(() => {
      this.inFlight = false;
      this.consider();
    });
  }

  /** The kept picture for these facts, else the server's. */
  private async pictureFor(facts: PortraitFacts, hash: string): Promise<Picture | PortraitStatus> {
    const kept = await this.deps.cache.get(hash);
    if (kept !== null) return kept;
    this.status({ kind: 'waiting' });
    const result = await this.deps.source.portraitOf(facts, () => this.disposed);
    if (result.kind === 'picture') {
      const picture = { bytes: result.bytes, type: result.type };
      await this.deps.cache.put(hash, picture);
      return picture;
    }
    if (result.kind !== 'unavailable') this.deps.say(result.reason);
    return result;
  }

  private async draw(hash: string, get: () => Promise<Picture | PortraitStatus>): Promise<void> {
    try {
      const got = await get();
      if (this.disposed) return;
      if ('bytes' in got) {
        this.show(got);
        await this.deps.last.write(hash);
      } else {
        if (got.kind === 'unreachable') this.ledger.failed(hash);
        this.status(got);
      }
    } catch (error) {
      // The disk, not the server: said, and asked again on the next entry.
      const reason = errorMessage(error);
      this.deps.say(reason);
      this.ledger.failed(hash);
      this.status({ kind: 'unreachable', reason });
    }
  }

  private async showLast(): Promise<void> {
    try {
      const hash = await this.deps.last.read();
      const kept = hash === null ? null : await this.deps.cache.get(hash);
      // A portrait drawn this session is newer than the one the last launch left.
      if (kept !== null && this.view.picture === null && !this.disposed) this.show(kept, false);
    } catch (error) {
      this.deps.say(errorMessage(error));
    }
  }

  private show(picture: Picture, drawn = true): void {
    this.shown = picture;
    const status: PortraitStatus = drawn ? { kind: 'drawn' } : this.view.status;
    this.set({ picture: dataUrlOf(picture), status });
  }

  private status(status: PortraitStatus): void {
    this.set({ picture: this.view.picture, status });
  }

  private set(view: PortraitView): void {
    const newPicture = view.picture !== this.view.picture;
    if (!newPicture && sameStatus(view.status, this.view.status)) return;
    this.view = view;
    // A status alone is a few bytes; the picture is most of a megabyte, sent once.
    this.deps.publish(newPicture ? view : { status: view.status });
  }
}

function sameStatus(a: PortraitStatus, b: PortraitStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
