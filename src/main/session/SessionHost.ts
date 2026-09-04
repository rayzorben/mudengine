/**
 * Every loaded session, and the per-character machinery around each one.
 *
 * `src/main/index.ts` used to hold `session`, `log` and `capture` as three
 * module-level singletons, which is the shape that made one character the only
 * possible number. This owns a map of them instead, keyed by session id, and is
 * the only thing that creates or destroys one.
 *
 * Three rules it exists to keep (docs/profiles.md §4):
 *
 * - **A session belongs to the app, not to a window.** Nothing here is reached
 *   from a window lifecycle; closing a window must never disconnect a
 *   character, and only `disposeAll` on quit ends anything.
 * - **One session per profile.** `ensure` returns the existing slot rather than
 *   building a second — the same character logged in twice is never useful and
 *   the server drops one of them.
 * - **Everything it publishes is addressed.** The sink closes over the slot's
 *   id, so a session physically cannot emit an unaddressed fact.
 *
 * The realm graph is passed in and shared: 55,806 rooms are parsed once and are
 * immutable afterwards, and the per-session state pathfinding needs is passed
 * per query rather than held per graph.
 */
import { Backscroll } from './Backscroll';
import { SessionCapture } from './SessionCapture';
import { SessionLog } from './SessionLog';
import { Reconnect } from './Reconnect';
import { BUSY_PHASES, SessionManager, type RealmMemory } from './SessionManager';
import type { InternalConfig } from '../../shared/internal';
import type { WorldGraph } from '../world/WorldGraph';
import type { MobLore } from '../../shared/lore';
import type { FightSink } from '../../shared/fights';
import {
  Push,
  type Addressed,
  type Notice,
  type SessionId,
  type SessionSummary
} from '../../shared/ipc';
import type { AppConfig } from '../../shared/config';
import type { ConnectionState, ConnectionTarget } from '../../shared/types';
import type { RealmPlayers } from '../../shared/players';
import type { RealmDestinations } from '../world/DestinationBook';
import type { BelongingsSink } from '../../shared/belongings';
import type { TalkSink } from './TalkLog';

export interface SessionSlot {
  readonly id: SessionId;
  readonly manager: SessionManager;
  /** What a terminal needs to catch up when it attaches. See `Backscroll`. */
  readonly backscroll: Backscroll;
  /**
   * Dialling this character back when a connection is *lost*. See `Reconnect`.
   *
   * Per slot rather than per host: the ladder, the address and the outage's
   * clock are all facts about one character's connection, and four characters
   * on a link that dropped are four outages that each end when their own does.
   */
  readonly reconnect: Reconnect;
  log: SessionLog | null;
  capture: SessionCapture | null;
  /** The last character name published, so the roster is republished on change. */
  named: string | null;
}

export interface SessionHostOptions {
  /**
   * The realm *this character* plays against.
   *
   * Read through rather than captured, and per session rather than global: the
   * client ships one realm and anybody on a derivative has their own, so two
   * characters on two realms is the ordinary case this exists for. A route
   * planned against the wrong realm sends a character somewhere that does not
   * exist.
   */
  worldFor(id: SessionId): WorldGraph | undefined;
  /**
   * What is known about the monsters on *this character's* realm.
   *
   * Per session for the same reason the realm is: two characters on two realms
   * is the ordinary case, and a giant rat's health on one says nothing about a
   * giant rat's health on the other.
   */
  loreFor(id: SessionId): MobLore;
  /**
   * Where what *this character* learns about the realm is kept.
   *
   * Per character, not per realm, unlike the monster lore beside it — and the
   * difference is the point. How much health a giant rat has is a fact about
   * the world that any character may as well have learned; that somebody found
   * a way down a cliff is a fact about where that character has *been*.
   */
  memoryFor(id: SessionId): RealmMemory | undefined;
  /**
   * Where this character's fights are written down.
   *
   * Per character, like the memory beside it and for the same reason: what a
   * fight cost depends on the level, the class and the gear of the character
   * that fought it, and mixing two of them into one file makes both unusable.
   */
  fightsFor(id: SessionId): FightSink;
  /**
   * Where this character's conversation is written down, and read back from.
   *
   * Per character, like the fights: whom Rand talks to is not whom Probe
   * does, and a telepath belongs on exactly one Talk card. See `TalkLog`.
   */
  talkFor(id: SessionId): TalkSink;
  /**
   * What is known about the other players on *this character's* realm.
   *
   * Per realm, like the lore, and keyed by the address dialled: what Soul
   * wears is a fact about Soul, and every character on the realm shares it —
   * live, and across restarts. See `PlayerBook`.
   */
  playersFor(id: SessionId): RealmPlayers;
  /**
   * Where this character's realm has been walked to.
   *
   * Per realm like the lore — and keyed on the realm *file* rather than on the
   * address dialled, unlike `playersFor`: a destination is a room **id**, and
   * an id only means a place within the data that defines it. See
   * `DestinationBook`.
   */
  destinationsFor(id: SessionId): RealmDestinations;
  /**
   * The same, for the address a session is about to dial. A character can be
   * dialled at a saved realm other than its own from the palette, and what it
   * learns there is that realm's; `connect` re-keys the session with this.
   */
  playersAt(target: ConnectionTarget): RealmPlayers;
  /**
   * Where *this character's own* record is kept — what each bank holds and what
   * was in each worn slot — for the address it is about to dial.
   *
   * Per character **and** per realm, which no other record here is. Neither
   * fact is shared the way the lore and the player book are — Rand's savings
   * are not Probe's, and neither is the kit on Rand's back — and neither is
   * portable the way the memory is, because the vault and the slots both
   * belong to the server. So both keys are needed, and `connect` is where the
   * second one is known.
   */
  belongingsAt(id: SessionId, target: ConnectionTarget): BelongingsSink;
  /**
   * A session has just established a socket.
   *
   * Reported because of a platform behaviour rather than a domain one: opening
   * a connection is the moment the main process stops acting on `SIGTERM`, and
   * `src/main/index.ts` takes the signal back. Optional, because nothing in a
   * test needs it and nothing here depends on it happening.
   */
  onConnected?(): void;
  /**
   * Republishes the character roster.
   *
   * A callback rather than a `toAll(Push.sessions, …)` from here, because the
   * roster is the one thing that genuinely **differs per window**: which
   * characters exist is the same everywhere, and which of them a given window
   * has *tabs* for is not. Broadcasting the full list would put a tab for a
   * popped-out character back in the window it left.
   */
  publishRoster(): void;
  /**
   * The options *this character* runs under.
   *
   * Per session, not global, because a profile is an overlay: a healer and a
   * warrior do not want the same standing rules, and a class with no mana wants
   * no mana bar. Read fresh every time, so a hot-reloaded options file — or an
   * edited profile — is never stale.
   */
  configFor: (id: SessionId) => AppConfig;
  /**
   * Whether *this character* wants a lost connection dialled back.
   *
   * Read through rather than captured, like `configFor` and for the same
   * reason: profiles are watched, so switching it off has to reach a session
   * that is already counting down.
   *
   * A character with no profile file answers `false`. That is the session
   * whose file went while its socket was up — it is on its way out and stays
   * only until it is idle (docs/profiles.md), so dialling it back is the one
   * thing that would keep it.
   */
  autoReconnect: (id: SessionId) => boolean;
  /**
   * The client's own settings — which of its commands stay out of the
   * console. One file for every session, read fresh like the options are.
   */
  internal: () => InternalConfig;
  /** How a session should be shown in a tab rail. */
  label: (id: SessionId) => { name: string; server: string; accent: string };
  logDirectory: () => string;
  /** The byte stream: routed only to windows showing this session. */
  toAttached: <T>(channel: string, message: Addressed<T>) => void;
  /**
   * The per-line diagnostics feed: attached windows that asked for it.
   *
   * `Push.line` fires at stream rate and only the Stream card reads it, which
   * is hidden by default — so the common case must not pay a serialisation per
   * framed line. A window opening the card catches up with `Invoke.getLines`.
   */
  toDiagnostics: <T>(channel: string, message: Addressed<T>) => void;
  /** Coalesced facts: routed to every window, which may render a tab for it. */
  toAll: (channel: string, payload: unknown) => void;
  notice: (notice: Notice) => void;
}

export class SessionHost {
  private readonly slots = new Map<SessionId, SessionSlot>();

  constructor(private readonly options: SessionHostOptions) {}

  get ids(): SessionId[] {
    return [...this.slots.keys()];
  }

  has(id: SessionId): boolean {
    return this.slots.has(id);
  }

  get(id: SessionId): SessionSlot | undefined {
    return this.slots.get(id);
  }

  /** What a window needs to draw its tab rail. */
  get summaries(): SessionSummary[] {
    return [...this.slots.values()].map((slot) => {
      const { name, server, accent } = this.options.label(slot.id);
      return {
        id: slot.id,
        name,
        server,
        accent,
        state: slot.manager.state,
        retrying: slot.reconnect.pending
      };
    });
  }

  /** The slot for an id, created if this is the first time it is asked for. */
  ensure(id: SessionId): SessionSlot {
    const existing = this.slots.get(id);
    if (existing) return existing;

    const config = this.options.configFor(id);

    /*
     * Built before the manager, because the sink below closes over it. It needs
     * only the id: where to dial and whether to bother are both read at the
     * point of use, so nothing here pins a value the player can still change.
     */
    const reconnect = new Reconnect({
      enabled: () => this.options.autoReconnect(id),
      // `dial` rather than `connect`, deliberately: `connect` calls a scheduled
      // retry off, and a retry calling itself off is a ladder with one rung.
      dial: (target) => this.dial(this.ensure(id), target),
      // The rail draws it and the tab's dial acts on it, so a retry armed or
      // called off is a roster change like any other.
      changed: () => this.options.publishRoster(),
      notice: (message) => this.options.notice({ session: id, message })
    });

    /*
     * The sink closes over `id`, which is the whole point: a session has no way
     * to publish something that does not say which character it came from.
     *
     * It also closes over `slot`, declared below it: the manager and the slot
     * need each other, and the closures are the side of that cycle that can
     * wait. None of them runs until bytes arrive or a command goes out, and
     * neither can happen before `connect` — so the manager is built first and
     * the slot is then built complete, rather than mutating a hole in it
     * through a cast.
     */
    const manager = new SessionManager(
      {
        /*
         * Straight to the capture and nowhere else. Raw bytes are for
         * after-the-fact analysis, not for anything on the paint path.
         */
        bytes: (payload) => slot.capture?.bytes(payload),
        /*
         * The whole decoded stream, for the records: what the server said.
         * The log and the capture are what a disagreement is settled from,
         * and a line the console chose not to show still happened.
         */
        decoded: (text) => {
          slot.log?.write(text);
          slot.capture?.text(text);
        },
        /*
         * What the console shows, for the console — and for the backscroll,
         * because the backscroll is replayed *into* the console on attach
         * and must be what it would have painted.
         */
        data: (chunk) => {
          slot.backscroll.write(chunk.text);
          this.options.toAttached(Push.data, { session: id, payload: chunk });
        },
        line: (line) => {
          // The capture is a record and gets every line; the push is a paint
          // concern and goes only where something is showing it.
          slot.capture?.line(line);
          this.options.toDiagnostics(Push.line, { session: id, payload: line });
        },
        block: (block) => {
          this.options.toAll(Push.block, { session: id, payload: block });
          // What was said outlives the socket: the Talk card's history is
          // written down and seeded back into the next attach's snapshot.
          if (block.domain === 'conversation') this.options.talkFor(id).append(block);
        },
        character: (state) => {
          this.options.toAll(Push.character, { session: id, payload: state });
          /*
           * A tab is named after the character, and the realm does not say who
           * that is until the stat sheet arrives. Without this the rail keeps
           * showing the profile's filename for the whole session and only
           * corrects itself on the next connection change.
           */
          if (state.name !== slot.named) {
            slot.named = state.name;
            this.options.publishRoster();
          }
        },
        walk: (progress) => this.options.toAll(Push.walk, { session: id, payload: progress }),
        // Where a walk was headed. Nothing is pushed to a window: the palette
        // asks for the recent list when somebody types, so a record kept on
        // every leg of a loop would be a push per step for a list nobody has
        // open.
        destination: (room, name) => this.options.destinationsFor(id).remember({ id: room, name }),
        loop: (progress) => this.options.toAll(Push.loop, { session: id, payload: progress }),
        automation: (snapshot) =>
          this.options.toAll(Push.automation, { session: id, payload: snapshot }),
        state: (state) => {
          this.options.toAll(Push.state, { session: id, payload: state });
          // The tab rail renders connection phase, so the roster changes too.
          this.options.publishRoster();
          // And a socket that has just been established is the measured moment
          // this process stops answering SIGTERM. See `keepSignalsWorking`.
          if (state.phase === 'connected') this.options.onConnected?.();
          // Where a lost connection would be dialled back to, and whether it
          // had lasted long enough to count as settled.
          reconnect.observe(state);
        },
        // A socket that went without this client asking. Only these are ever
        // dialled again — see `Reconnect` for what the other closes are.
        dropped: (why) => reconnect.lost(why),
        telnet: (event) => this.options.toAll(Push.telnet, { session: id, payload: event }),
        notice: (message) => this.options.notice({ session: id, message }),
        learned: (discoveries) =>
          this.options.toAll(Push.learned, { session: id, payload: discoveries }),
        command: (command, source) => slot.capture?.out(command, source)
      },
      this.options.worldFor(id),
      config.automation,
      config.connection.login,
      this.options.loreFor(id),
      this.options.memoryFor(id),
      this.options.fightsFor(id),
      this.options.playersFor(id)
    );

    manager.configureInternal(this.options.internal());
    const slot: SessionSlot = {
      id,
      manager,
      backscroll: new Backscroll(),
      reconnect,
      log: null,
      capture: null,
      named: null
    };
    this.slots.set(id, slot);
    /*
     * Warm the conversation log now, while nothing is being parsed: it reads
     * and prunes its file when it is constructed, and left to the lazy path
     * that work would land on the first conversation block — the parse path,
     * which is the one place a file read does not belong.
     */
    this.options.talkFor(id);
    this.options.publishRoster();
    return slot;
  }

  /**
   * Dials a session, opening its log and capture first.
   *
   * Only the in-flight phases are refused. Connecting while *connected* is a
   * legitimate way to switch servers, and the palette offers it; refusing a
   * second attempt while one is still in flight is what stops a call arriving
   * mid-handshake from killing a connection that was seconds from succeeding.
   */
  async connect(id: SessionId, target: ConnectionTarget): Promise<ConnectionState> {
    const slot = this.ensure(id);
    /*
     * A dial somebody asked for supersedes one that was scheduled. Without
     * this, pressing Connect during a retry's wait leaves the timer armed, and
     * it fires into a connection that is already up — tearing down the socket
     * the player just made.
     */
    slot.reconnect.cancel();
    return this.dial(slot, target);
  }

  /**
   * The dial itself, with no opinion about what asked for it.
   *
   * Split from `connect` so `Reconnect` can reach it: everything about
   * rotating the log and the capture and re-keying the realm records is the
   * same for a retry, and only calling a *scheduled* dial off is not.
   */
  private async dial(slot: SessionSlot, target: ConnectionTarget): Promise<ConnectionState> {
    const id = slot.id;

    if (BUSY_PHASES.has(slot.manager.state.phase)) {
      this.options.notice({
        session: id,
        message: 'Already connecting; ignoring the second attempt.'
      });
      return slot.manager.state;
    }

    const config = this.options.configFor(id);
    const directory = this.options.logDirectory();
    const problem = (message: string): void => this.options.notice({ session: id, message });

    // A fresh file per connection, so a reconnect does not interleave two
    // sessions into one log.
    if (config.logging.capture) {
      slot.capture ??= new SessionCapture({
        directory,
        maxBytes: config.logging.maxBytes,
        onProblem: problem,
        // Said when the file exists, not when the dial went out: a retry that
        // never connects creates no capture and should announce none.
        onOpened: (file) => problem(`Capturing this session to ${file}`)
      });
      slot.capture.open(target, undefined, id);
    } else {
      // Not awaited: see `SessionCapture.close`. What is deferred here is the
      // tail of a development recording that is off by default.
      void slot.capture?.close();
      slot.capture = null;
    }

    if (config.logging.enabled) {
      slot.log ??= new SessionLog({
        directory,
        maxBytes: config.logging.maxBytes,
        onProblem: problem
      });
      slot.log.open(target, undefined, id);
    } else {
      void slot.log?.close();
      slot.log = null;
    }

    // Keyed on where this connection actually goes, not where the character's
    // file says it lives: the two differ when a saved realm is dialled ad hoc.
    slot.manager.useRealm(this.options.playersAt(target), this.options.belongingsAt(id, target));
    return slot.manager.connect(target);
  }

  /**
   * Re-reads every session's options after the file or a profile changed.
   *
   * Each session asks for its own, because two characters can now disagree
   * about what a rule set or a vitals threshold should be.
   */
  reconfigure(): void {
    for (const slot of this.slots.values()) {
      const config = this.options.configFor(slot.id);
      slot.manager.configure(config.automation, config.connection.login);
      slot.manager.configureInternal(this.options.internal());
    }
  }

  /**
   * The player's own disconnect.
   *
   * Through here rather than straight at the manager, because pressing
   * Disconnect has to call a scheduled redial off as well. A character sitting
   * at `closed` with a retry pending has nothing for `SessionManager.disconnect`
   * to close, so without this the button would look like it did nothing and
   * the timer would dial straight back in — and it is the one way somebody can
   * say *stop trying*.
   */
  disconnect(id: SessionId): ConnectionState | null {
    const slot = this.slots.get(id);
    if (!slot) return null;
    slot.reconnect.cancel();
    return slot.manager.disconnect();
  }

  /** Disconnects and forgets one session. Its profile file is untouched. */
  remove(id: SessionId): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    // Before the manager: disposing it closes the socket, and a timer still
    // armed on a slot that has left the map would dial a session nobody owns.
    slot.reconnect.dispose();
    slot.manager.dispose();
    void slot.log?.close();
    void slot.capture?.close();
    this.slots.delete(id);
    this.options.publishRoster();
  }

  /** Quitting. The only thing that ends a session other than an explicit unload. */
  disposeAll(): void {
    for (const id of [...this.slots.keys()]) this.remove(id);
  }

  /** Whether any character is still connected, for the quit confirmation. */
  get connectedIds(): SessionId[] {
    return [...this.slots.values()]
      .filter((slot) => slot.manager.state.phase === 'connected')
      .map((slot) => slot.id);
  }
}
