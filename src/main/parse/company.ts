/**
 * Who else is here, as a memory: the registry of every other player this
 * character has met, kept beside the state and never in it (todo 730), the
 * realm's book it is seeded from and tells, and whose look is being read. Out
 * of `CharacterTracker` as its eighth cluster (`mudengine-wire` ›
 * `parts/tracker.md`). What a listing or a broadcast does to the state is
 * `presence.ts`'s, the registry's fold over each block `players.ts`'s; this
 * owns what both write into, and nothing it holds is published but by
 * identity (`players`).
 */
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import {
  absorbFacts,
  allOffline,
  NO_PLAYERS,
  observe,
  toFacts,
  type PlayerFacts,
  type PlayerRegistry,
  type RealmPlayers
} from '../../shared/players';
import { withOwnEquipment } from './inventory';
import { noteRemoteCall, noteRemoteClient, trackPlayers } from './players';
import {
  withDescription,
  withEquipment,
  withGangJoined,
  withGangLeft,
  withGangListing,
  withLookedAt,
  withRemoteVitals,
  type PresenceFold
} from './presence';

/** The realm's book, as far as company reads and writes it: seeded from, and told. */
type Book = Pick<RealmPlayers, 'recall' | 'remember'>;

/** What company reads and writes beyond the registry it keeps, handed in as `LedgerSources` are. */
interface CompanySources {
  /**
   * Whether the character stands in the realm, which alone lets a record reach
   * the book. Nothing at a login menu produces a player — but the book is
   * written to disk and read back by every character on the realm, and the one
   * place a password is typed is that menu, so the guard sits at the point of
   * capture rather than as a second redaction: the rule `WorldMemory` keeps
   * for the other realm-wide record.
   */
  inGame(): boolean;
  /** A kit named an item and its slot, so the realm's word for its `Worn` code is taught. */
  teachSlot(item: string, slot: string, at: number): void;
  /** This character's own kit, looked at: where the item sits, for the pack (`wornAt`). */
  rememberSlot(item: string, slot: string): void;
}

/**
 * Whether a name the server printed is this character's own.
 *
 * Compared against the name the *server* resolved — a look at `vae` answers
 * `[ Vaelor ]` — rather than against what was typed, so a prefix is not a
 * different person. False while nobody has said what this character is called,
 * which is the honest answer: unknown is not "yes".
 */
function isSelf(s: CharacterState, name: string | null): boolean {
  const own = s.name;
  return own !== null && name !== null && own.toLowerCase() === name.trim().toLowerCase();
}

/** The keys whose record `after` holds by a different identity than `before`. */
function changed(before: PlayerRegistry, after: PlayerRegistry): string[] {
  if (before === after) return [];
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

/**
 * A kit's rows that put an item in a slot. `<empty>` is a bare slot, not an
 * item (see `withEquipment`), and a charge count is not a slot (`Readied/79`).
 */
function slotsNamed(
  rows: Array<Record<string, string>> | undefined
): Array<{ item: string; slot: string }> {
  const named: Array<{ item: string; slot: string }> = [];
  for (const row of rows ?? []) {
    const item = row['item']?.trim();
    const slot = row['slot']?.trim().replace(/\/\d+$/, '');
    if (item && slot && item !== '<empty>') named.push({ item, slot });
  }
  return named;
}

/**
 * The other players: everything known about them, the realm's book it is told
 * to, and the look being read at one of them.
 *
 * Owns the registry and hands it out by identity — the same object until a
 * record in it changes (`observe`), which is what `Publisher.players` pushes
 * on. Handed what it may not own (`CompanySources`): the phase the book's
 * guard reads, and the pack's two slot memories a kit teaches.
 */
export class Company {
  /** Everything known about other players: beside the state, never in it. */
  private registry: PlayerRegistry;
  /** Whom the entry room showed before the first prompt, to tell the book then. */
  private readonly held = new Set<string>();
  /**
   * Whose `look` is currently being read, from the `[ Name ]` line that opens
   * one. The equipment block below it carries no name of its own, and the
   * server's spelling here is already resolved from whatever was typed.
   */
  private lookedAt: string | null = null;

  constructor(
    private book: Book,
    private readonly sources: CompanySources
  ) {
    this.registry = absorbFacts(NO_PLAYERS, book.recall());
  }

  /** The registry, the same object until a record in it changes (`observe`); pushed on its own. */
  get players(): PlayerRegistry {
    return this.registry;
  }

  /**
   * The realm the next connection dials, when it is not the character's own.
   *
   * A character can be dialled at a saved realm from the palette, and what is
   * learned there belongs to *that* realm's book. Takes effect at `reset()`,
   * which every connection runs: the registry is seeded from the new realm, and
   * what was seeded from the old one goes with the session it was seeded for.
   */
  useRealm(book: Book): void {
    this.book = book;
  }

  /**
   * A new session, not a new realm: what the realm knows about the other
   * players is seeded back in, everyone offline until this session sees them.
   * And a new session must not file an equipment block against whoever the
   * last one was looking at when the socket closed.
   */
  reset(): void {
    this.registry = absorbFacts(NO_PLAYERS, this.book.recall());
    this.lookedAt = null;
    this.held.clear();
  }

  /**
   * The character left the realm: everyone is marked offline and **nobody is
   * forgotten**. The roster is a listing about a realm this character has left,
   * so it goes with the state; the registry is what was learned about those
   * people, and "when did I last see them, and where" is a question asked
   * precisely about somebody who is no longer there. Clearing it here would
   * put the client back in the state the registry exists to end.
   */
  leaveRealm(): void {
    this.registry = allOffline(this.registry);
  }

  /** The character walked out to the menu: as `leaveRealm`, and the look being read goes too. */
  forget(): void {
    this.lookedAt = null;
    this.held.clear();
    this.leaveRealm();
  }

  /**
   * What another session on this realm learned, folded in.
   *
   * Returns whether anything changed, so the caller can republish. Never
   * written back: the book is where it came from, and a session that
   * remembered what it was just told would hand it straight back to every
   * other session, forever.
   */
  absorb(batch: readonly PlayerFacts[]): boolean {
    const players = absorbFacts(this.registry, batch);
    if (players === this.registry) return false;
    this.registry = players;
    return true;
  }

  /** One block's sightings, read off the state the reducer produced (`trackPlayers`). */
  track(block: Block, state: CharacterState, previous: CharacterState): void {
    this.registry = trackPlayers(this.registry, block, state, previous);
  }

  /**
   * Every record changed since `before` goes to the realm's book.
   *
   * By identity: `observe` returns the same record when nothing about it
   * changed, so a registry that differs names exactly the records worth telling
   * the realm about, and the walk is over the registry only on a block that
   * changed it. The book merges and decides for itself whether anything in the
   * record was news to the realm — a record that changed only in what is this
   * session's own (`inParty`, an `@` command) is not.
   *
   * The entry room after `E` prints before the first prompt, while the guard
   * still says no: who a completed room showed there is held and told once the
   * phase turns `in-game` (todo 748). Anything else from the menu is dropped.
   */
  remember(before: PlayerRegistry, roomCompleted = false): void {
    const after = this.registry;
    if (before === after && this.held.size === 0) return;
    if (!this.sources.inGame()) {
      if (roomCompleted) for (const key of changed(before, after)) this.held.add(key);
      return;
    }
    const told = new Set([...this.held, ...changed(before, after)]);
    this.held.clear();
    for (const key of told) {
      const record = after[key];
      if (record !== undefined) this.book.remember(toFacts(record));
    }
  }

  /**
   * Somebody sent an `@` command (`noteRemoteCall`). Kept here because the
   * registry is; `Remotes` proposes and never reaches into state itself.
   */
  noteRemoteCall(from: string, raw: string, at: number): boolean {
    return this.keep(noteRemoteCall(this.registry, from, raw, at));
  }

  /**
   * Which client another player answered `@version` with, or that this
   * client's extended remotes do not reach them (`noteRemoteClient`). Which
   * replies are read at all is the responder's decision — it reads one only
   * for a question it asked — and by now that has been settled.
   */
  noteRemoteClient(
    from: string,
    at: number,
    facts: { client?: string; extendedRemotes: 'yes' | 'no' }
  ): boolean {
    return this.keep(noteRemoteClient(this.registry, from, at, facts));
  }

  /**
   * Where another client said it was standing, from a `@where-room` answer.
   *
   * A **sighting**, and stamped as one: `lastRoomAt` is what the Player card
   * ages, and a peer's own word about where it is is exactly as good as seeing
   * them there. The map is not kept, because the registry has never had a
   * field for one — see `PlayerRecord.lastRoom`; the address is reported whole
   * by whoever asked.
   */
  noteRemoteRoom(from: string, room: number, name: string | null, at: number): boolean {
    const named = name === null ? {} : { lastRoomName: name };
    const where = { lastRoom: room, ...named, lastRoomAt: at, online: true };
    return this.keep(observe(this.registry, from, at, where));
  }

  /**
   * `player-look`: the `[ Name ] (Gang)` line that opens a look at somebody,
   * and the equipment block follows it. Held so that block is filed against
   * the name the *server* resolved rather than whatever was typed (see
   * `withEquipment`); the gang goes on the roster (`withLookedAt`).
   */
  lookOpened(
    s: CharacterState,
    name: string | undefined,
    gang: string | undefined
  ): CharacterState | null {
    this.lookedAt = name ?? null;
    return withLookedAt(s, name, gang);
  }

  /**
   * `player-described`: the sentence under that line, where the race and the
   * class are, filed against the name the *sentence* carries — the same name
   * as `lookedAt`, from the server. Skipped for this character's own look:
   * `trackPlayers` keeps everybody but self out of the registry, so a name in
   * the console does not open a panel about the person reading it, and this
   * character's own race and class are on the stat sheet.
   */
  described(
    s: CharacterState,
    name: string | undefined,
    clause: string | undefined,
    at: number
  ): null {
    if (isSelf(s, name ?? null)) return null;
    this.registry = withDescription(this.registry, name, clause, at);
    return null;
  }

  /**
   * `player-equipment`: the kit a look printed.
   *
   * Somebody else's kit names slots too, and a slot word is a fact about the
   * realm rather than about who is wearing it, so every block teaches the
   * table the character's own listing does — first, whoever it is about.
   *
   * A look at **this character** goes to the pack (`withOwnEquipment`), and
   * instead of the registry rather than as well: `trackPlayers` files
   * everybody the roster lists except self, and this path used to reach
   * `observe` directly, which put this character in the registry the moment it
   * looked at itself. The roster entry `player-look` made is right and stays.
   */
  equipment(
    s: CharacterState,
    rows: Array<Record<string, string>> | undefined,
    at: number
  ): CharacterState | null {
    const kit = slotsNamed(rows);
    for (const { item, slot } of kit) this.sources.teachSlot(item, slot, at);
    if (isSelf(s, this.lookedAt)) {
      for (const { item, slot } of kit) this.sources.rememberSlot(item, slot);
      return withOwnEquipment(s, rows);
    }
    this.registry = withEquipment(this.registry, this.lookedAt, rows, at);
    return null;
  }

  /** `gang-roster`: `bg`'s whole membership, online and off (`withGangListing`). */
  gangListed(
    s: CharacterState,
    gang: string | undefined,
    count: string | undefined,
    rows: Array<Record<string, string>> | undefined,
    at: number
  ): CharacterState | null {
    return this.fold(withGangListing(s, this.registry, gang, count, rows, at));
  }

  /** `gang-joined`: a permission, maintained between listings (`withGangJoined`). */
  gangJoined(s: CharacterState, name: string | undefined, at: number): CharacterState | null {
    return this.fold(withGangJoined(s, this.registry, name, at));
  }

  /** `gang-left`: the same broadcast the other way, for this character's gang only (`withGangLeft`). */
  gangLeft(
    s: CharacterState,
    name: string | undefined,
    gang: string | undefined,
    at: number
  ): CharacterState | null {
    return this.fold(withGangLeft(s, this.registry, name, gang, at));
  }

  /** A `conversation-*` line: another client's `@health` answer, if it is one (`withRemoteVitals`). */
  remoteVitals(
    s: CharacterState,
    name: string | undefined,
    message: string | undefined,
    at: number
  ): CharacterState | null {
    return this.fold(withRemoteVitals(s, this.registry, name, message, at));
  }

  /** A registry folded outside `apply`, kept and told to the book; whether it moved. */
  private keep(players: PlayerRegistry): boolean {
    const before = this.registry;
    this.registry = players;
    this.remember(before);
    return players !== before;
  }

  /** A presence fold's registry kept, and its state handed back to `reduce`. */
  private fold({ state, players }: PresenceFold): CharacterState | null {
    this.registry = players;
    return state;
  }
}
