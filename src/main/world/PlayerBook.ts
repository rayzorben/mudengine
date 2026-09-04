import fs from 'node:fs';
import path from 'node:path';

import {
  mergeFacts,
  playerKey,
  readFacts,
  sameFacts,
  toFacts,
  type PlayerFacts,
  type RealmPlayers
} from '../../shared/players';
import type { ConnectionTarget } from '../../shared/types';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { realmKey } from './RealmLore';
import { tuning } from '../app/tuning';

/**
 * What this client knows about the other players on each realm.
 *
 * The registry on `CharacterState.players` used to die with the session, on
 * the reasoning that the server says everything in it again for free. It does
 * not: `look <player>` is the only source of what somebody wears and it costs
 * a command each time, and the Worn tab said *nobody has looked at Soul yet*
 * about a player who had been looked at the evening before — in another
 * session, by another character. This is the file that stops that.
 *
 * **Keyed by realm, not by character**, for the reason `RealmLore` is: what
 * Soul wears is a fact about Soul, and four characters on one realm should not
 * each have to look. The realm is the **address dialled** (`realmAddress`) and
 * not the world file — Soul on GreaterMUD is not Soul on a MajorMUD board that
 * happens to ship the same map data, and two server entries that dial one
 * address are one realm.
 *
 * **Only facts about the player are here** (`PlayerFacts`); what is about one
 * character's dealings with them — whether *this* session has seen them
 * online, whether they are in *this* party, the `@` commands they sent *this*
 * character — stays with the session. `src/shared/players.ts` states the split.
 *
 * **Shared live, not just across restarts.** Every session on a realm holds a
 * view (`forRealm`); a record one session remembers reaches the others in the
 * same turn of the event loop, coalesced — a `who` that changes thirty records
 * is one call, not thirty — so the tab for one character says what the realm
 * knows and not what its own socket happened to see. Listeners fold the batch
 * in and never remember it back: the book already holds it, and that is what
 * keeps two sessions from echoing one fact between them forever.
 *
 * **Writes are lazy and never block the parse path.** `remember` is called from
 * inside block handling; it mutates memory and schedules a save. And a record
 * that moved only its sighting clock schedules nothing and tells nobody — see
 * `sameFacts` — or a party listing would rewrite this file every few seconds.
 *
 * The address is the whole of the identity, which is a choice with one known
 * edge: a board that fronts several games behind one address and different
 * menu steps would share one book. `docs/terminology.md` defines a realm by its
 * address, menus and name; only the address is stable enough to key a file on,
 * and the second sanctioned target (`bbs.bearfather.net:23`) fronts one game.
 * `realmKey` also collapses `.`, `-` and `_` alike, so two addresses differing
 * only in those would share a key — accepted, because no real pair does.
 */
export interface PlayerBookOptions {
  /** Where the file lives. Created on demand. */
  file: string;
  /** How long to wait before writing after a change. */
  saveDelayMs?: number;
  /** Reported when the file cannot be read or written. Never silent. */
  notify?(message: string): void;
}

interface PlayerFile {
  v: number;
  /** Keyed by realm, then by the lower-cased name, so one file serves every realm played. */
  realms: Record<string, Record<string, PlayerFacts>>;
}

type Listener = (batch: readonly PlayerFacts[]) => void;

/**
 * The realm a target dials, as the book keys it: `orohost:2427`.
 *
 * Lower-cased because hostnames are, and trimmed because the profile's is what
 * somebody typed. `realmKey` then reduces it to a plain name inside the file.
 */
export function realmAddress(target: Pick<ConnectionTarget, 'host' | 'port'>): string {
  return `${target.host.trim().toLowerCase()}:${target.port}`;
}

export class PlayerBook {
  private readonly realms = new Map<string, Map<string, PlayerFacts>>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /** What changed since the listeners were last told, per realm. */
  private readonly pending = new Map<string, Map<string, PlayerFacts>>();
  private notifying = false;
  private timer: NodeJS.Timeout | null = null;
  /** Something learned is not on disk yet, and a save is scheduled. */
  private dirty = false;
  /** Only sighting clocks moved: written with the next save or on quit, never scheduled for. */
  private stale = false;
  private loaded = false;
  /** When a book that could not read its file may try again. */
  private retryAt = 0;
  /** True once the file was found unreadable or unparseable; nothing is written over it. */
  private suspended = false;

  constructor(private readonly options: PlayerBookOptions) {}

  /**
   * The view one realm sees.
   *
   * A narrow object rather than this one, for the reason `RealmLore.forRealm`
   * is: a session asks about the players on *its* realm and must not be able to
   * ask about a realm, which is the door through which one realm's players
   * would be read against another's.
   */
  forRealm(realm: string): RealmPlayers {
    const key = realmKey(realm);
    return {
      recall: () => this.recall(key),
      remember: (facts) => this.remember(key, facts),
      subscribe: (listener) => this.subscribe(key, listener)
    };
  }

  /* --------------------------------------------------------------- reads */

  private recall(realm: string): readonly PlayerFacts[] {
    this.load();
    return [...(this.realms.get(realm)?.values() ?? [])];
  }

  /* -------------------------------------------------------------- writes */

  private remember(realm: string, facts: PlayerFacts): void {
    const key = playerKey(facts.name);
    if (key.length === 0) return;
    this.load();

    let table = this.realms.get(realm);
    if (!table) {
      table = new Map();
      this.realms.set(realm, table);
    }

    const before = table.get(key);
    // `mergeFacts` returns its input when nothing was news, so identity is
    // what decides whether the disk, and the other sessions, need telling.
    const after = before === undefined ? toFacts(facts) : mergeFacts(before, facts);
    if (after === before) return;

    table.set(key, after);
    if (table.size > tuning().records.maxPlayers) evictOldest(table, key);

    /*
     * A record that moved only its sighting clock is kept — it is what "last
     * online" is answered from after a restart — but is news to nobody. The
     * clock moves on every fold, so a party listing or a `who` would otherwise
     * rewrite the file and push every other character's whole state every few
     * seconds; and the other sessions see the same broadcasts anyway. It lands
     * on disk with the next real change, or at quit.
     */
    if (before !== undefined && sameFacts(before, after)) {
      this.stale = true;
      return;
    }

    let changed = this.pending.get(realm);
    if (!changed) {
      changed = new Map();
      this.pending.set(realm, changed);
    }
    changed.set(key, after);
    this.schedule();
    this.queueNotify();
  }

  private subscribe(realm: string, listener: Listener): () => void {
    let set = this.listeners.get(realm);
    if (!set) {
      set = new Set();
      this.listeners.set(realm, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      // Only the set this closure was made for: a stale unsubscribe called
      // after the realm's set was emptied and remade must not take the new
      // set — and every listener in it — away with it.
      if (set.size === 0 && this.listeners.get(realm) === set) this.listeners.delete(realm);
    };
  }

  /**
   * Tells every view on a realm what changed, once the current turn is over.
   *
   * A microtask rather than a call from inside `remember`, so that a listing
   * which changes thirty records costs the other sessions one fold and one
   * republish rather than thirty — and so that no session's state is being
   * read by another while its own `apply` is still on the stack.
   */
  private queueNotify(): void {
    if (this.notifying) return;
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      const batches = [...this.pending];
      this.pending.clear();
      for (const [realm, changed] of batches) {
        const listeners = this.listeners.get(realm);
        if (!listeners || changed.size === 0) continue;
        const batch = [...changed.values()];
        // A copy, so a listener unsubscribing mid-batch does not skip its neighbour.
        for (const listener of [...listeners]) listener(batch);
      }
    });
  }

  /* ------------------------------------------------------------ the file */

  /**
   * Read once, on the first question asked.
   *
   * Lazily, and a file that will not parse is reported where somebody is
   * playing rather than during startup, when the terminal is not yet listening.
   */
  private load(): void {
    if (this.loaded || Date.now() < this.retryAt) return;
    this.loaded = true;

    let raw: string;
    try {
      raw = fs.readFileSync(this.options.file, 'utf8');
    } catch (error) {
      // Absent is the ordinary case and is not worth a word. Anything else is
      // a file that must not be written over: it may be the only copy.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.suspend(
        t('notices.world.players.readError', {
          file: this.options.file,
          message: errorMessage(error)
        })
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Kept, not replaced: it is the only copy of what every character on
      // the realm has seen, and it could have been edited.
      this.suspend(
        t('notices.world.players.parseSuspended', {
          fileName: path.basename(this.options.file),
          message: errorMessage(error)
        })
      );
      return;
    }

    this.suspended = false;
    this.retryAt = 0;
    // Learned while the disk was refused, and never written: now that the
    // file reads, what it says is folded in *under* what was learned since
    // and the lot is scheduled — nothing seen during the suspension is lost.
    const learnedMeanwhile = [...this.realms.values()].some((table) => table.size > 0);

    const file = parsed as Partial<PlayerFile>;
    for (const [realm, entries] of Object.entries(file.realms ?? {})) {
      if (typeof entries !== 'object' || entries === null) continue;
      const key = realmKey(realm);
      let table = this.realms.get(key);
      if (!table) {
        table = new Map();
        this.realms.set(key, table);
      }
      for (const value of Object.values(entries)) {
        // Filed under the name inside the record, not the file's key: the key
        // is derived from the name and a hand-edited file may disagree.
        const facts = readFacts(value);
        if (!facts) continue;
        const name = playerKey(facts.name);
        const held = table.get(name);
        table.set(name, held === undefined ? facts : mergeFacts(facts, held));
      }
    }
    if (learnedMeanwhile) this.schedule();
  }

  /**
   * Refuses the disk until the file is fixed or removed, and says so once.
   *
   * Sharing between live sessions goes on in memory. Retried on a later
   * question — so fixing the file resumes without a restart — but not on
   * every question: `remember` asks once per changed record, and a `who` that
   * changes thirty rows must not be thirty synchronous reads of a file that is
   * known to be bad, inside block handling.
   */
  private suspend(message: string): void {
    this.loaded = false;
    this.retryAt = Date.now() + tuning().records.playersRetryMs;
    if (this.suspended) return;
    this.suspended = true;
    this.options.notify?.(message);
  }

  private schedule(): void {
    if (this.suspended || this.timer !== null) return;
    this.dirty = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, this.options.saveDelayMs ?? tuning().records.playersSaveDelayMs);
    // Never a reason to hold the process open: `flush` on quit is what lands
    // the last few seconds.
    this.timer.unref?.();
  }

  /**
   * Writes what is known. Temp file and rename, like every other file this
   * client owns — a crash mid-write must not leave a half-written file that
   * then refuses to parse and suspends the book for good.
   */
  save(): void {
    if (this.suspended || (!this.dirty && !this.stale)) return;
    this.dirty = false;
    this.stale = false;

    const realms: PlayerFile['realms'] = {};
    for (const [realm, table] of this.realms) {
      if (table.size === 0) continue;
      realms[realm] = Object.fromEntries([...table].sort(([a], [b]) => (a < b ? -1 : 1)));
    }

    const temporary = `${this.options.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
      fs.writeFileSync(
        temporary,
        `${JSON.stringify({ v: 1, realms } satisfies PlayerFile, null, 2)}\n`
      );
      fs.renameSync(temporary, this.options.file);
    } catch (error) {
      this.dirty = true;
      this.options.notify?.(
        t('notices.world.players.writeError', {
          file: this.options.file,
          message: errorMessage(error)
        })
      );
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing useful to do about a temp file that will not go away, and
        // failing here would replace a warning with a crash.
      }
    }
  }

  /** Writes anything outstanding and stops the timer. Called on quit. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }
}

/** The player not seen for longest goes — never the one just written. */
function evictOldest(table: Map<string, PlayerFacts>, keep: string): void {
  let oldest: string | null = null;
  let at = Infinity;
  for (const [key, facts] of table) {
    if (key !== keep && facts.lastSeen < at) {
      oldest = key;
      at = facts.lastSeen;
    }
  }
  if (oldest !== null) table.delete(oldest);
}
