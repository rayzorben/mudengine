/**
 * What is known about the other people in the realm, kept between sightings.
 *
 * ## The gap this fills
 *
 * Everything the client knew about another player was **ephemeral and scattered
 * across three places that each forget**: `online` is replaced wholesale by the
 * next `who`, `room.occupants` by the next `Also here:`, and `party.members` by
 * the next party listing. So a person who walked out of the room was, a
 * heartbeat later, somebody this client had never heard of — their alignment
 * gone with the room, the `{HP=…}` they answered a minute ago gone with the
 * party, and nothing at all recording that they had been seen.
 *
 * That is why `@seen` is in the refused column of `todo-megamud-commands.md`
 * ("nothing records where somebody was last seen") and why §4 could not build a
 * per-player permission gate: there was no player to hang one on.
 *
 * This is that record. One entry per name, accumulated from blocks the
 * classifier already produces — **nothing here asks the server for anything**.
 * A `who` costs a command from the same budget walking and fighting spend from,
 * and the whole point of the roster's design is that the broadcasts maintain it
 * for free; this keeps what those broadcasts already said.
 *
 * ## There is no inventory here, and that is a fact about the server
 *
 * "Everything known about a player" naturally suggests their pack, and the
 * honest answer is that **nothing on this server volunteers another player's
 * inventory**. There is no command for it and no broadcast carries it; what a
 * client could assemble is what somebody is seen to pick up in the same room,
 * which is a floor so far below the truth that showing it as "what they have"
 * would be worse than showing nothing. A field was declared here and rendered
 * on the card before anything produced it — a row guarded by a condition that
 * was always false — and it was removed rather than left waiting for a
 * producer nobody could write.
 *
 * ## Every field is nullable and absence is never rendered as zero
 *
 * The standing rule, and it bites hardest here because most of this record is
 * unknown most of the time. A player seen once in a corridor has a name, a room
 * and nothing else. `health: null` is *"they have never told us"* and must never
 * draw as an empty bar — that is a readout claiming somebody is nearly dead.
 *
 * ## Facts about the player are the realm's, and they are kept
 *
 * This registry once died with the session, on the reasoning that the server
 * says everything in it again for free. It does not: `look <player>` is the
 * only source of what somebody wears and it costs a command each time, and the
 * Worn tab said *nobody has looked at Soul yet* about a player who had been
 * looked at the evening before — in another session, by another character.
 *
 * So the record is split by what each half is a fact *about*:
 *
 * - **`PlayerFacts` are about the player** — kit, gang, title, level, race,
 *   class, where and when they were last seen, the vitals they quoted — and
 *   belong to the *realm*: Soul's armour is the same armour whichever character
 *   looked. `PlayerBook` (main) keeps them realm-wide, seeds them into every
 *   fresh session on that realm, and passes what one live session learns to
 *   the others as it happens.
 * - **The rest is about this character's dealings with them** — `online` as
 *   *this* session has seen it, `inParty`, the `@` commands they sent *this*
 *   character, the listing's status letter — and stays with the session.
 *
 * The realm is the *address dialled*, not the world file: Soul on GreaterMUD is
 * not Soul on a MajorMUD board that happens to ship the same map data, and two
 * server entries that dial one address are one realm. The trust settings in
 * `automation.remotes` still live in the options file: a record of what was
 * seen and a decision somebody made are different failure domains and do not
 * share a file.
 *
 * Dependency-free, like everything in `shared/`.
 */

// From `./alignment` and deliberately not from `./character`: importing a
// value from there while it imports `NO_PLAYERS` from here is the cycle that
// left `EMPTY_CHARACTER.players` undefined. See `./alignment`.
import { ALIGNMENTS, type Alignment } from './alignment';
import type { ItemEntity, PlayerEntity } from './entities';

/**
 * Everything known about one other player.
 *
 * **The vitals are a quotation with a time on it, not a reading.** They arrive
 * only when that player's own client answers `@health`, which happens at a
 * moment somebody chose; five minutes later they are history, and a bar drawn
 * from them without the timestamp beside it is a client reporting a number it
 * has no reason to believe. `vitalsAt` is what makes it honest, and it is
 * non-null exactly when `vitals` is.
 */
export interface PlayerRecord {
  /** As the server spells it. The lower-cased form is the key; this is for reading. */
  name: string;
  alignment: Alignment | null;
  /** The class-and-rank string a `who` listing carries, e.g. `Apprentice`. */
  title: string | null;
  /** Trailing status letters the listing carries, e.g. `S` for sleeping. */
  flags: string | null;
  /** Their gang, as a `who` row or a `look` at them named it. Null when nothing has. */
  gang: string | null;
  /**
   * Their level, race and class — from the gang listing `bg` prints, the only
   * place on the wire that states any of the three about somebody else.
   *
   * Kept permanently rather than refreshed, because two of them never change
   * and the third only ever rises. `who` cannot supply them: its row carries a
   * *rank title*, and a rank title is not a class — one capture has a character
   * whose `who` row reads `Monk` and whose description reads `Mystic`, and
   * `Monk` is not a class the realm data contains at all.
   *
   * Null is *nobody has said*, never a default. A gang member the listing has
   * not been asked about is unknown, and a card drawing that as level 0 of no
   * race would be stating something the client has never been told.
   */
  level: number | null;
  race: string | null;
  className: string | null;
  /**
   * Their standing in their gang — `Leader`, `Captain`, `Lieutenant` — as the
   * gang listing's own word, or null where it printed none (an ordinary member)
   * and where no listing has been read.
   *
   * The listing's word rather than a rank of this client's own: `GangMemberRank`
   * has four values and nothing on the wire says what any of them *grant*, so
   * the word is carried and no authority is claimed for it.
   */
  gangRank: string | null;
  /**
   * What they were wearing when a character on this realm last looked at them,
   * and when.
   *
   * **Worn kit, not a pack.** `look <player>` prints an equipment block — one
   * line per slot — and that is the whole of what this server volunteers about
   * another player's belongings. What is *carried* is not on the wire at any
   * price, which is why a field for it was declared here once, rendered on the
   * card, and removed again: it was a row guarded by a condition that could
   * never be true. This is named for what it is so nobody tries to fill it in.
   *
   * Kept with a time because it is a sighting rather than a reading: somebody
   * changes armour, and a list drawn without saying when it was true invites a
   * decision about a fight against kit they took off an hour ago.
   */
  equipment: readonly WornItem[] | null;
  equipmentAt: number | null;
  /**
   * The room they were last seen in, by number, and null when they have been
   * seen only somewhere this client could not resolve.
   */
  lastRoom: number | null;
  /** The room's name as it read at the time — kept because a number names nothing. */
  lastRoomName: string | null;
  /**
   * When they were last seen *in a room* — standing in this character's, or
   * swinging at it — and null while every sighting has been placeless.
   *
   * Kept apart from `lastSeen` because the two answer different questions. A
   * telepath proves somebody is logged in and says nothing about where they
   * are; a card that stamped "last seen" from it would put a fresh time beside
   * a stale room and invite a walk to where they no longer stand. This is the
   * time the room beside it was true.
   */
  lastRoomAt: number | null;
  /**
   * When they were last observed at all, however faintly — a line of chat, a
   * `who`, a party listing — and, once they have gone, when they went. It is
   * what "last online" is answered from: `online` says whether the answer is
   * *now*, and this says when it stopped being.
   */
  lastSeen: number;
  /** True while this client believes they are logged in. */
  online: boolean;
  /** The absolute figures, from an `@health` answer, or null if never answered. */
  vitals: PlayerVitals | null;
  /** When those figures arrived. Non-null exactly when `vitals` is. */
  vitalsAt: number | null;
  /** True while they are in this character's party. */
  inParty: boolean;
  /** Times they have sent an `@` command, trusted or not. */
  commandsSent: number;
  /** The last `@` command they sent, for the card to show, or null. */
  lastCommand: string | null;
  /** When that command arrived. Non-null exactly when `lastCommand` is. */
  lastCommandAt: number | null;
}

/** One line of another player's equipment block: what, and where it sits. */
export interface WornItem {
  name: string;
  /** `Torso`, `Finger`, `Readied` — the server's own word for the slot. */
  slot: string;
}

export interface PlayerVitals {
  hp: number;
  hpMax: number;
  mana: number | null;
  manaMax: number | null;
}

/**
 * The half of a record that is a fact about the *player*: what one realm's book
 * keeps and every session on that realm shares. See the module header for the
 * split. `flags`, `online`, `inParty` and the `@` command tally are deliberately
 * not here — each is about one character's dealings with them.
 */
export type PlayerFacts = Pick<
  PlayerRecord,
  | 'name'
  | 'alignment'
  | 'title'
  | 'gang'
  | 'level'
  | 'race'
  | 'className'
  | 'gangRank'
  | 'equipment'
  | 'equipmentAt'
  | 'lastRoom'
  | 'lastRoomName'
  | 'lastRoomAt'
  | 'lastSeen'
  | 'vitals'
  | 'vitalsAt'
>;

/**
 * What one realm knows about its players, as a session sees it.
 *
 * An interface for the reason `MobLore` is one: `CharacterTracker` is the parse
 * path and depends on the question, not on the file behind the answer. The
 * implementation is `PlayerBook` in `src/main/world/`.
 */
export interface RealmPlayers {
  /** Every record the realm holds, for seeding a fresh session's registry. */
  recall(): readonly PlayerFacts[];
  /**
   * One record a session holds, folded into the realm's. Persisted lazily;
   * nothing in the parse path blocks on a write. A record that moved only its
   * sighting clock is kept, written with the next real change or on quit, and
   * told to nobody — see `sameFacts`.
   */
  remember(facts: PlayerFacts): void;
  /**
   * Told what the realm learned — from any session on it, this one included —
   * coalesced to one call per turn of the event loop. Returns the unsubscribe.
   * A listener folds the batch in and never `remember`s it back: the book
   * already holds it, and that is what keeps two sessions from echoing one
   * fact between them forever.
   */
  subscribe(listener: (batch: readonly PlayerFacts[]) => void): () => void;
}

/** A realm that holds nothing and keeps nothing: every test, and a session with no realm. */
export const NO_REALM_PLAYERS: RealmPlayers = {
  recall: () => [],
  remember: () => {},
  subscribe: () => () => {}
};

/**
 * The whole registry: one record per player, keyed by the **lower-cased** name.
 *
 * Lower-cased because the server is not consistent about case — a name arrives
 * capitalised in a `who` listing and as typed in a telepath — and two records
 * for one person is the failure this whole module exists to prevent.
 */
export type PlayerRegistry = Readonly<Record<string, PlayerRecord>>;

export const NO_PLAYERS: PlayerRegistry = {};

/** The key a name is filed under. One function, so nothing files under another. */
export function playerKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The pronoun the realm writes where a name would go, and which is nobody.
 *
 * `You say "fast"` names the person reading it, and a pattern that captured it
 * as a speaker filed a *player called `You`* here — with a record, a last-seen
 * clock and an offline chip, clickable from the Talk card and from the console.
 * Reported 2026-09-02, screenshot and all.
 *
 * The pattern is fixed at the source (`patterns.ts` reads a self `say` with no
 * `player` group at all, the shape `You yell` already had). This is the second
 * half, and it is here rather than only there because the registry is
 * **persisted**: a book written before that fix holds the row, and a guard on
 * the one funnel every sighting goes through is what stops it coming back. It
 * is the realm's own word, so it stays in code with the rest of the vocabulary
 * rendered as itself.
 */
const NOBODY = 'you';

/**
 * Whether this name is the realm's pronoun rather than somebody.
 *
 * Not exported: its two callers are both in this file, and `noUnusedLocals`
 * does not catch an export nothing imports — so a public one would be a door
 * onto a private rule with nobody on the other side of it.
 */
function isNobody(name: string): boolean {
  return playerKey(name) === NOBODY;
}

/**
 * A record for somebody nothing is known about yet.
 *
 * Everything unknown, which is the honest starting point: a name in a room is a
 * name in a room, and the fields below it are what later sightings fill in.
 */
export function newPlayer(name: string, at: number): PlayerRecord {
  return {
    name: name.trim(),
    alignment: null,
    title: null,
    flags: null,
    gang: null,
    level: null,
    race: null,
    className: null,
    gangRank: null,
    equipment: null,
    equipmentAt: null,
    lastRoom: null,
    lastRoomName: null,
    lastRoomAt: null,
    lastSeen: at,
    online: true,
    vitals: null,
    vitalsAt: null,
    inParty: false,
    commandsSent: 0,
    lastCommand: null,
    lastCommandAt: null
  };
}

/**
 * Fold one observation into the registry, returning a new one.
 *
 * Immutable, and it returns the **same object** when nothing changed, so a
 * caller can use identity to decide whether to republish. That is not a
 * micro-optimisation: the registry rides on every state push, and a new object
 * per line of chat would redraw every card in the client on somebody else's
 * conversation.
 *
 * **A later sighting never erases an earlier fact with an absence.** A player
 * seen in a room tells us where they are and nothing about their alignment, so
 * a `null` alignment in an update is *"this sighting did not say"* and leaves
 * whatever the last `who` established. Only an explicit value replaces one.
 * Without that rule every room the character walks through would blank the
 * roster's own knowledge, one name at a time.
 */
export function observe(
  registry: PlayerRegistry,
  name: string,
  at: number,
  facts: Partial<Omit<PlayerRecord, 'name' | 'lastSeen'>> = {}
): PlayerRegistry {
  const key = playerKey(name);
  // Nothing is filed under nothing, and nothing is filed under the pronoun:
  // see `isNobody`. One funnel, so no caller can reintroduce either.
  if (key.length === 0 || key === NOBODY) return registry;

  const before = registry[key];
  const base = before ?? newPlayer(name, at);
  const after: PlayerRecord = {
    ...base,
    // The server's own spelling, refreshed: a name first learned lower-cased
    // from a telepath reads properly once a listing states it.
    name: name.trim() || base.name,
    lastSeen: at,
    ...definedOnly(facts)
  };

  return same(before, after) ? registry : { ...registry, [key]: after };
}

/**
 * Drop the keys whose value is `undefined`, keeping the ones explicitly `null`.
 *
 * The distinction is the whole of the rule above. `{alignment: undefined}` is a
 * sighting that did not mention alignment; `{alignment: null}` is one that says
 * it is not known — and only the second should overwrite.
 */
function definedOnly<T extends object>(facts: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value !== undefined) out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

/**
 * Whether an update is worth republishing.
 *
 * `lastSeen` is deliberately **not** compared: it moves on every line somebody
 * speaks, and treating a clock tick as a change would republish the whole
 * registry per line of chat — the thing the identity return above exists to
 * avoid. A record whose only difference is when it was last seen is the same
 * record for every purpose a card or a rule has.
 *
 * `lastRoomAt` *is* compared, and the two clocks differ in what moves them.
 * `trackPlayers` stamps it only from a block that changed the occupant list or
 * landed a blow — blocks that republish the whole state regardless — so
 * comparing it costs nothing extra, while not comparing it would leave the
 * Player flyout ageing "last seen" on somebody standing in the same room until an
 * unrelated field happened to change in the same fold. That is the
 * correct-by-accident shape this file has been bitten by once already, at
 * `vitalsAt`.
 */
function same(before: PlayerRecord | undefined, after: PlayerRecord): boolean {
  if (before === undefined) return false;
  return (
    before.name === after.name &&
    before.alignment === after.alignment &&
    before.title === after.title &&
    before.flags === after.flags &&
    before.gang === after.gang &&
    before.level === after.level &&
    before.race === after.race &&
    before.className === after.className &&
    before.gangRank === after.gangRank &&
    sameEquipment(before.equipment, after.equipment) &&
    before.lastRoom === after.lastRoom &&
    before.lastRoomName === after.lastRoomName &&
    before.lastRoomAt === after.lastRoomAt &&
    before.online === after.online &&
    before.inParty === after.inParty &&
    before.commandsSent === after.commandsSent &&
    before.lastCommand === after.lastCommand &&
    sameVitals(before.vitals, after.vitals)
  );
}

/**
 * Two equipment lists, compared by content.
 *
 * By content rather than by identity because a fresh list arrives on every
 * look, and a look at somebody who has changed nothing must not republish the
 * registry — the same rule `same()` keeps for every other field, and the reason
 * `observe` returns its input unchanged.
 */
function sameEquipment(a: readonly WornItem[] | null, b: readonly WornItem[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((item, at) => item.name === b[at]?.name && item.slot === b[at]?.slot);
}

function sameVitals(a: PlayerVitals | null, b: PlayerVitals | null): boolean {
  if (a === null || b === null) return a === b;
  return a.hp === b.hp && a.hpMax === b.hpMax && a.mana === b.mana && a.manaMax === b.manaMax;
}

/**
 * Note that a player has left the realm.
 *
 * **The record stays and is marked offline**, rather than being deleted. That
 * is the point of the module: somebody who logged off an hour ago is exactly
 * who "when did I last see them, and where" is asked about, and a registry that
 * forgot them on departure would answer nothing — which is the state the client
 * was already in.
 */
export function markOffline(registry: PlayerRegistry, name: string, at: number): PlayerRegistry {
  const key = playerKey(name);
  const before = registry[key];
  if (before === undefined || !before.online) return registry;
  return { ...registry, [key]: { ...before, online: false, lastSeen: at } };
}

/**
 * Everything known, newest sighting first.
 *
 * Sorted here rather than in the card so the ordering is one decision: online
 * before offline, because who is *here* is the question being asked, and by
 * recency within each, because the rest is history.
 */
export function knownPlayers(registry: PlayerRegistry): PlayerRecord[] {
  return Object.values(registry).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  });
}

/**
 * Mark offline everybody a fresh `who` listing did not name.
 *
 * The other half of *a listing is authoritative*: the roster on
 * `CharacterState` has always been replaced outright by one, on the reasoning
 * that somebody absent from it has left, and this is the registry hearing the
 * same sentence. Without it a record only ever went offline from the two
 * departure broadcasts, so anybody who logged off while this character was at
 * a menu — or before the session began at all — stayed online for ever, and
 * the Realm card and the Player flyout disagreed about the same person.
 *
 * **`lastSeen` is left exactly where it was**, which is `allOffline`'s rule and
 * for its reason: a listing that does not name somebody is not a sighting of
 * them, and stamping it now would answer *when did I last see them* with the
 * moment the client noticed they were gone. That is the one number the card
 * exists to show.
 *
 * `listed` is keyed the way the registry is — lower-cased names — so the caller
 * builds it with `playerKey`, not with whatever case the wire used.
 */
export function offlineUnlisted(
  registry: PlayerRegistry,
  listed: ReadonlySet<string>
): PlayerRegistry {
  const entries = Object.entries(registry);
  if (!entries.some(([key, record]) => record.online && !listed.has(key))) return registry;
  return Object.fromEntries(
    entries.map(([key, record]) => [
      key,
      record.online && !listed.has(key) ? { ...record, online: false } : record
    ])
  );
}

/**
 * Mark every record offline, for a socket that has closed.
 *
 * Nobody is dropped: see `markOffline`. `lastSeen` is deliberately left where
 * it was — a character leaving the realm is not a sighting of anybody, and
 * moving every timestamp to the moment of a disconnect would say everyone was
 * seen at once, erasing the ordering the card is sorted by.
 */
export function allOffline(registry: PlayerRegistry, _at: number): PlayerRegistry {
  const entries = Object.entries(registry);
  if (!entries.some(([, record]) => record.online)) return registry;
  return Object.fromEntries(
    entries.map(([key, record]) => [key, record.online ? { ...record, online: false } : record])
  );
}

/* ------------------------------------------------------------ the realm's half */

/** The facts alone, out of a record — what goes to the realm's book. */
export function toFacts(record: PlayerFacts): PlayerFacts {
  return {
    name: record.name,
    alignment: record.alignment,
    title: record.title,
    gang: record.gang,
    level: record.level,
    race: record.race,
    className: record.className,
    gangRank: record.gangRank,
    equipment: record.equipment,
    equipmentAt: record.equipmentAt,
    lastRoom: record.lastRoom,
    lastRoomName: record.lastRoomName,
    lastRoomAt: record.lastRoomAt,
    lastSeen: record.lastSeen,
    vitals: record.vitals,
    vitalsAt: record.vitalsAt
  };
}

/**
 * Fold what the realm knows about somebody into a record, field by field.
 *
 * Returns `base` itself when nothing is newer, so identity decides whether a
 * store is dirty or a state is worth republishing — the rule `observe` keeps.
 *
 * - **A group with a time on it moves together, and only forwards.** Kit and
 *   when it was seen, a quotation and its time, a room and when they stood in
 *   it: the later-stamped side wins whole, and a side with no stamp never wins
 *   — an equipment list from nowhen is not a sighting.
 * - **A field with no time takes the side seen more recently**, where both
 *   speak. A title changes as somebody levels and a gang can be left, so
 *   between two claims the fresher is the better one — and it is a choice
 *   between two things the server stated, never an invention.
 * - **Null never overwrites.** Every field is "nobody has said" until said, and
 *   a record that has not heard somebody's alignment must not blank one that
 *   has.
 *
 * Generic so the session-only fields of a `PlayerRecord` ride through untouched:
 * whether *this* session has seen them online is not the realm's to say.
 */
export function mergeFacts<T extends PlayerFacts>(base: T, incoming: PlayerFacts): T {
  const newer = incoming.lastSeen >= base.lastSeen;
  const pick = <V>(mine: V | null, theirs: V | null): V | null =>
    theirs === null || theirs === mine ? mine : mine === null || newer ? theirs : mine;
  const later = (theirs: number | null, mine: number | null): boolean =>
    theirs !== null && (mine === null || theirs > mine);

  const kit = later(incoming.equipmentAt, base.equipmentAt);
  const quoted = later(incoming.vitalsAt, base.vitalsAt);
  const placed = later(incoming.lastRoomAt, base.lastRoomAt);
  const after: T = {
    ...base,
    // The server's spelling, from whichever side heard it last.
    name: newer && incoming.name.trim().length > 0 ? incoming.name : base.name,
    alignment: pick(base.alignment, incoming.alignment),
    title: pick(base.title, incoming.title),
    gang: pick(base.gang, incoming.gang),
    level: pick(base.level, incoming.level),
    race: pick(base.race, incoming.race),
    className: pick(base.className, incoming.className),
    gangRank: pick(base.gangRank, incoming.gangRank),
    equipment: kit ? incoming.equipment : base.equipment,
    equipmentAt: kit ? incoming.equipmentAt : base.equipmentAt,
    vitals: quoted ? incoming.vitals : base.vitals,
    vitalsAt: quoted ? incoming.vitalsAt : base.vitalsAt,
    lastRoom: placed ? incoming.lastRoom : base.lastRoom,
    lastRoomName: placed ? incoming.lastRoomName : base.lastRoomName,
    lastRoomAt: placed ? incoming.lastRoomAt : base.lastRoomAt,
    lastSeen: Math.max(base.lastSeen, incoming.lastSeen)
  };
  return sameFacts(base, after) && after.lastSeen === base.lastSeen ? base : after;
}

/**
 * Two sets of facts, compared by content and **not** by `lastSeen` — the rule
 * `same` keeps, for the reason it gives: the sighting clock moves on every fold,
 * and a record that differs only in *when* is the same record for every purpose
 * a card has. The realm's book keeps the later time (`mergeFacts` returns a
 * fresh record for it) but treats it as nothing to write for or tell anyone
 * about — a party listing that moved thirty clocks would otherwise rewrite the
 * file and push every other character's whole state, every few seconds.
 */
export function sameFacts(a: PlayerFacts, b: PlayerFacts): boolean {
  return (
    a.name === b.name &&
    a.alignment === b.alignment &&
    a.title === b.title &&
    a.gang === b.gang &&
    a.level === b.level &&
    a.race === b.race &&
    a.className === b.className &&
    a.gangRank === b.gangRank &&
    sameEquipment(a.equipment, b.equipment) &&
    a.equipmentAt === b.equipmentAt &&
    sameVitals(a.vitals, b.vitals) &&
    a.vitalsAt === b.vitalsAt &&
    a.lastRoom === b.lastRoom &&
    a.lastRoomName === b.lastRoomName &&
    a.lastRoomAt === b.lastRoomAt
  );
}

/**
 * Fold what the realm knows into a session's registry.
 *
 * Somebody the session has never met is entered **offline and in no party**:
 * the book says they exist and what they wore, and nothing about whether they
 * are in the realm right now — that is this session's to find out. Somebody it
 * has met keeps every session-only field and takes the newer facts. Returns the
 * same registry when nothing changed, as `observe` does.
 */
export function absorbFacts(
  registry: PlayerRegistry,
  batch: readonly PlayerFacts[]
): PlayerRegistry {
  let next = registry;
  for (const facts of batch) {
    const key = playerKey(facts.name);
    if (key.length === 0) continue;
    const before = next[key];
    const base: PlayerRecord = before ?? {
      ...newPlayer(facts.name, facts.lastSeen),
      online: false
    };
    const after = mergeFacts(base, facts);
    if (before !== undefined && after === before) continue;
    next = { ...next, [key]: after };
  }
  return next;
}

/**
 * One record read back from disk, or null when it names nobody.
 *
 * Parsed, not trusted: the file is where anything may have edited it. Every
 * field is checked and an unusable one becomes null rather than a guess — an
 * alignment the realm does not have is unknown, a kit with no time on it is not
 * a sighting, and nothing is ever coerced to zero.
 */
export function readFacts(value: unknown): PlayerFacts | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (name.length === 0) return null;
  /*
   * And a book written before the pronoun was refused is read without it, so
   * the file heals itself on the next save rather than carrying a player
   * called `You` for as long as the realm exists. `isNobody` has the story.
   */
  if (isNobody(name)) return null;

  const text = (field: unknown): string | null =>
    typeof field === 'string' && field.trim().length > 0 ? field : null;
  const stamp = (field: unknown): number | null =>
    typeof field === 'number' && Number.isFinite(field) && field > 0 ? field : null;
  const whole = (field: unknown): number | null =>
    typeof field === 'number' && Number.isInteger(field) && field > 0 ? field : null;

  const equipmentAt = stamp(record['equipmentAt']);
  const equipment = equipmentAt === null ? null : readWorn(record['equipment']);
  const vitalsAt = stamp(record['vitalsAt']);
  const vitals = vitalsAt === null ? null : readVitals(record['vitals']);
  const alignment = record['alignment'];

  return {
    name,
    alignment: ALIGNMENTS.find((known) => known === alignment) ?? null,
    title: text(record['title']),
    gang: text(record['gang']),
    level: whole(record['level']),
    race: text(record['race']),
    className: text(record['className']),
    gangRank: text(record['gangRank']),
    equipment,
    equipmentAt: equipment === null ? null : equipmentAt,
    vitals,
    vitalsAt: vitals === null ? null : vitalsAt,
    lastRoom: whole(record['lastRoom']),
    lastRoomName: text(record['lastRoomName']),
    lastRoomAt: stamp(record['lastRoomAt']),
    lastSeen: stamp(record['lastSeen']) ?? 0
  };
}

/** The list, or null when it is not one. Empty is a real answer: wearing nothing. */
function readWorn(value: unknown): WornItem[] | null {
  if (!Array.isArray(value)) return null;
  const worn: WornItem[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, slot } = item as Record<string, unknown>;
    if (
      typeof name === 'string' &&
      typeof slot === 'string' &&
      name.length > 0 &&
      slot.length > 0
    ) {
      worn.push({ name, slot });
    }
  }
  return worn;
}

function readVitals(value: unknown): PlayerVitals | null {
  if (typeof value !== 'object' || value === null) return null;
  const { hp, hpMax, mana, manaMax } = value as Record<string, unknown>;
  const figure = (field: unknown): number | null =>
    typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : null;
  const health = figure(hp);
  const healthMax = figure(hpMax);
  if (health === null || healthMax === null) return null;
  return { hp: health, hpMax: healthMax, mana: figure(mana), manaMax: figure(manaMax) };
}

/**
 * A `PlayerEntity` from what the realm's record and the roster know.
 *
 * The record is the durable half — alignment, gang, level, race, class, what a
 * `look` showed them wearing — and the roster row is *now*: whether they are
 * in the realm and what the listing's flags said this time. One projection so
 * the Room card, the Realm card and the party cannot disagree about somebody;
 * holding four shapes for one person is how they came to.
 *
 * `equip` hydrates the worn kit, and is a parameter rather than an import
 * because resolving an item name asks the realm graph, which is main's — and
 * `src/shared/` is dependency-free by rule. Without one the kit still crosses,
 * as wire-only entities: a name and a slot is what a `look` printed, and that
 * is worth showing whether or not the realm can price it.
 */
export function playerEntity(
  name: string,
  sources: {
    record?: PlayerRecord | null;
    /** The `who` row, where this character is in the realm now. */
    roster?: {
      alignment: Alignment | null;
      title: string | null;
      flags: string | null;
      gang: string | null;
    } | null;
    /** The listing's own annotations for this sighting. */
    hidden?: boolean;
    free?: boolean;
    inParty?: boolean;
    partyRank?: 'front' | 'mid' | 'back' | null;
    equip?: (item: WornItem) => ItemEntity;
    now?: number;
  } = {}
): PlayerEntity {
  const { record, roster } = sources;
  const worn = record?.equipment ?? null;
  return {
    name: record?.name ?? name,
    // `book` is somebody the realm remembers; `wire` is somebody in front of
    // you. A roster row settles it, because that is the listing saying so.
    source: roster !== null && roster !== undefined ? 'wire' : 'book',
    // The roster is *this* listing and the record is everything ever learned,
    // so the roster leads and the record fills the gaps — never the reverse,
    // or a stale alignment would outrank the one on screen.
    alignment: roster?.alignment ?? record?.alignment ?? null,
    title: roster?.title ?? record?.title ?? null,
    flags: roster?.flags ?? record?.flags ?? null,
    gang: roster?.gang ?? record?.gang ?? null,
    gangRank: record?.gangRank ?? null,
    level: record?.level ?? null,
    race: record?.race ?? null,
    className: record?.className ?? null,
    equipment:
      worn === null
        ? []
        : worn.map((item) =>
            sources.equip === undefined
              ? {
                  name: item.name,
                  source: 'wire' as const,
                  slot: item.slot,
                  equipped: true,
                  charges: null
                }
              : sources.equip(item)
          ),
    equipmentAt: record?.equipmentAt ?? null,
    hidden: sources.hidden ?? false,
    free: sources.free ?? false,
    inParty: sources.inParty ?? record?.inParty ?? false,
    partyRank: sources.partyRank ?? null,
    vitals: record?.vitals ?? null,
    online: record?.online ?? roster !== null,
    lastSeen: record?.lastSeen ?? sources.now ?? 0,
    lastRoom: record?.lastRoom ?? null,
    lastRoomName: record?.lastRoomName ?? null
  };
}
