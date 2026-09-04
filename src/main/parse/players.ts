/**
 * Folding what the wire says about other players into the registry.
 *
 * `state in -> state out`, twelve lines of it pure: this depends on none of
 * `CharacterTracker`'s private fields and is called from one place, `apply`,
 * *after* the reducer has run. That placement is the whole design.
 *
 * ## Why it reads the state rather than the 74 cases
 *
 * The obvious build is a line in each case that mentions a player — the roster
 * case, the occupants case, the party case, five conversation cases, the combat
 * cases. That is a dozen edits inside the file `TODO.md` already calls a god
 * object, in a `switch` whose 74 cases are first-match-wins and order-dependent,
 * and every one of them a place a later case could forget.
 *
 * The reducer has already done the parsing. `state.online` *is* the roster it
 * read, `state.room.occupants` *is* who it placed in the room. So this reads
 * the state the reducer produced and folds the differences in — one seam, no
 * new order dependency, and testable against a literal `CharacterState` with no
 * tracker at all.
 *
 * The one thing state cannot carry is what only the *block* says: who spoke,
 * and who left. Those are read from the block directly, which is why this takes
 * both.
 *
 * ## Why it also takes the state *before* the block
 *
 * `room.occupants` is persistent state, not block data: it survives until the
 * next listing, and this runs on every block — including the ones the reducer
 * declined. A sighting *timestamp* written from it on every pass would move on
 * every line the server printed while somebody shared the room, and a moved
 * timestamp is a changed record, so the registry would republish per line of
 * combat text — the exact cost `observe`'s identity return exists to prevent,
 * at a higher rate than the chat case it was built for. So the time somebody
 * was seen in the room is stamped only when *this* block replaced the occupant
 * list: a listing, an arrival, a departure. That is the difference the reducer
 * produced, read the same way everything else here is.
 */

import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import {
  markOffline,
  observe,
  offlineUnlisted,
  playerKey,
  type PlayerRecord,
  type PlayerRegistry
} from '../../shared/players';

/**
 * Chat that names a live person, and the ones that do not.
 *
 * `conversation-yell` names a *direction* rather than a player, and the receipt
 * lines (`--- Telepath Sent to X ---`) are this character's own outbound half.
 * Neither is a sighting of anybody.
 */
const SPOKEN = new Set<string>([
  'conversation-telepath',
  'conversation-directed',
  'conversation-local',
  'conversation-gossip',
  'conversation-broadcast',
  'conversation-auction',
  'conversation-gangpath'
]);

/**
 * Fold one block, and the state it produced, into the registry.
 *
 * Returns the **same registry** when nothing changed, so `apply` can use
 * identity to decide whether anything is worth republishing — see `observe`.
 */
export function trackPlayers(
  registry: PlayerRegistry,
  block: Block,
  state: CharacterState,
  previous: CharacterState
): PlayerRegistry {
  let next = registry;
  const at = block.at;
  const self = state.name?.toLowerCase() ?? null;
  /** This character is not one of the other players. */
  const other = (name: string): boolean => name.trim().length > 0 && name.toLowerCase() !== self;

  /*
   * A departure marks the record offline and keeps it. Somebody who logged off
   * an hour ago is exactly who "when did I last see them" is asked about.
   */
  if (block.type === 'player-exits' || block.type === 'player-disconnects') {
    const name = block.groups['player'];
    return name ? markOffline(next, name, at) : next;
  }

  /**
   * Names the realm has listed as players, which is the only authority here.
   *
   * Keyed with `playerKey`, the registry's own filing, because `offlineUnlisted`
   * compares against registry keys — a set built with a second spelling of
   * lower-casing is the duplicate-key bug this module exists to prevent, in the
   * one place where getting it wrong marks a live player offline.
   */
  const listed = new Set(state.online.map((entry) => playerKey(entry.name)));

  /*
   * The roster is authoritative for the fields it carries, so it is folded
   * whole rather than only where it differs — a listing is what establishes an
   * alignment, and an alignment is what decides whether somebody is dangerous.
   *
   * **Except presence, on the block where a gang listing just spoke.** This
   * runs on the *same* block the reducer did, and `state.online` is the roster
   * as it stood — which is stale by design between `who` listings, since a
   * departure this client missed leaves the entry sitting there. A `bg` listing
   * states presence for every member explicitly, so folding `online: true` over
   * it reverted the one field it was read for, within the same `apply`: a
   * member the listing had just said was *offline* was reported online again
   * before anything could see otherwise.
   *
   * That is unknown answered with the reassuring value, which is the direction
   * this project refuses. The rest of the roster's fields are still folded —
   * only the claim the listing already settled is left alone.
   */
  const presenceSettled = block.type === 'gang-roster';
  for (const entry of state.online) {
    if (!other(entry.name)) continue;
    next = observe(next, entry.name, at, {
      /*
       * A provisional entry comes from an arrival broadcast, which carries no
       * alignment — `undefined` leaves whatever a listing already established
       * rather than blanking it. That distinction is the rule `observe`
       * documents, and this is the case it exists for: without it, every
       * arrival broadcast would erase the roster's own knowledge one name at a
       * time.
       */
      alignment: entry.provisional ? undefined : entry.alignment,
      title: entry.provisional ? undefined : entry.title,
      flags: entry.provisional ? undefined : entry.flags,
      // A look can name a gang on somebody a listing has not reached yet; a
      // provisional row that names none has simply not said.
      gang: entry.provisional ? (entry.gang ?? undefined) : entry.gang,
      online: presenceSettled ? undefined : true
    });
  }

  /*
   * And the other half of *authoritative*: a `who` listing says who is **not**
   * online as surely as it says who is.
   *
   * The roster itself has always been replaced outright by a listing — the
   * tracker's own comment says *somebody absent from it has left* — and the
   * registry was the one place that never heard it. It learned departures only
   * from the two broadcasts, so somebody who logged off while this character
   * was at a menu, disconnected, or left before this session started stayed
   * marked online for ever, and the Realm card and the Player flyout disagreed
   * about the same person.
   *
   * **Only on the listing block.** `state.online` is stale by design between
   * listings — that is what the broadcasts are for — so sweeping on every
   * block would mark somebody offline for the crime of not having been in the
   * last `who`. The walk of the registry costs what `partyLeavers` costs and
   * runs about as often.
   *
   * Placed **before** the room and party folds, which run in this same pass
   * and mark their own people online again: somebody standing in this room is
   * present-tense evidence that outranks a listing which may not show them.
   *
   * `lastSeen` is untouched — `offlineUnlisted` has that argument.
   */
  if (block.type === 'who-list') next = offlineUnlisted(next, listed);

  /*
   * Who is in the room, and *where* the room is. This and the combat sighting
   * below are the only things that ever fill `lastRoom` and stamp `lastRoomAt`,
   * because they are the only sightings with a place attached: a telepath
   * reaches across the realm and says nothing about where its sender is
   * standing.
   *
   * The time is stamped only when the reducer replaced the occupant list on
   * this block — see the module docblock. `undefined` otherwise leaves the
   * stamp from the block that did, and a record somehow placed without one
   * takes this block's time rather than showing a room with no time beside it.
   */
  const relisted = state.room.occupants !== previous.room.occupants;
  for (const occupant of state.room.occupants) {
    if (occupant.kind !== 'player' || !other(occupant.name)) continue;
    const held = next[occupant.name.toLowerCase()];
    next = observe(next, occupant.name, at, {
      lastRoom: state.room.number,
      lastRoomName: state.room.name,
      lastRoomAt: relisted || held?.lastRoomAt == null ? at : undefined,
      online: true
    });
  }

  /*
   * Party membership, and the absolute figures when a member's own client has
   * answered `@health`. `vitals` is `undefined` rather than `null` when a
   * member has not answered, so a party listing does not erase an answer given
   * a minute ago — the same rule as the alignment above.
   */
  for (const member of state.party.members) {
    if (!other(member.name)) continue;
    /*
     * `vitalsAt` is passed only when the figures are **new**, never on every
     * listing that repeats them.
     *
     * A party listing arrives far more often than an `@health` answer, and
     * stamping it with the current block's time on each one would age a
     * five-minute-old quotation back to "just now" — the exact lie `vitalsAt`
     * exists to prevent. Relying on `observe`'s identity return to discard the
     * write would be correct only by accident of an unrelated optimisation, and
     * would start moving the moment `same()` gained a field.
     */
    const held = next[member.name.toLowerCase()];
    const fresh =
      member.vitals !== null &&
      (held?.vitals == null ||
        held.vitals.hp !== member.vitals.hp ||
        held.vitals.hpMax !== member.vitals.hpMax ||
        held.vitals.mana !== member.vitals.mana ||
        held.vitals.manaMax !== member.vitals.manaMax);

    next = observe(next, member.name, at, {
      inParty: true,
      online: true,
      vitals: member.vitals ?? undefined,
      vitalsAt: fresh ? at : undefined
    });
  }

  /*
   * Somebody who has left the party is still a player worth knowing about, so
   * the flag is cleared rather than the record dropped.
   *
   * **Only when the party has actually changed shape**, not on every block. The
   * sweep is O(registry) and the registry grows for the whole session, so
   * running it per block made every line of somebody else's chat cost a walk of
   * every name ever seen. `partySize` is carried in the fold and compared
   * first: a listing that repeats the same members does no work at all.
   */
  const stale = partyLeavers(next, state);
  for (const record of stale) {
    next = observe(next, record.name, record.lastSeen, { inParty: false });
  }

  // Speaking is a sighting: it proves they are logged in, and nothing else.
  if (SPOKEN.has(block.type)) {
    const from = block.groups['player'];
    const message = block.groups['message'];
    // A receipt line names a player and carries no message; it is our own half.
    if (from && message !== undefined && other(from)) {
      next = observe(next, from, at, { online: true });
    }
  }

  /*
   * Being attacked by a *person* is a sighting, and the sharpest kind: they are
   * in this room, now.
   *
   * **Only for a name the realm has listed as a player.** `combat.attackers`
   * holds whatever is swinging, monsters included — the tracker filters it with
   * `mobKey` elsewhere for exactly that reason — so trusting it put `orc rogue`
   * and `giant rat` in the registry as people. That was caught by looking at
   * the card in `npm run smoke`, not by a unit test, because every test here
   * fed it names that happened to be players.
   *
   * The roster is the authority, as it is for the Alerts card's decision that a
   * player attacking is critical and a monster is not: a name with no listing
   * behind it is as likely to be a quest NPC as a person, and inventing a
   * player out of a monster is what this whole card must not do.
   */
  for (const attacker of state.combat.attackers) {
    if (!other(attacker)) continue;
    if (!listed.has(attacker.toLowerCase())) continue;
    /*
     * Stamped with the last blow rather than this block's time, for the reason
     * the room sighting gives: `attackers` persists for the whole fight, and
     * the fight is proved live by its blows, not by whatever line happens to
     * arrive while it is on. `lastBlowAt` moves only when the reducer saw a
     * blow, which is a block that republishes the state anyway.
     */
    next = observe(next, attacker, at, {
      lastRoom: state.room.number,
      lastRoomName: state.room.name,
      lastRoomAt: state.combat.lastBlowAt ?? at,
      online: true
    });
  }

  return next;
}

/**
 * Records flagged as being in the party that the party no longer holds.
 *
 * Walks the registry only when the flags and the roster disagree in *count*,
 * which is cheap to establish and true only when somebody has actually joined
 * or left. Returns an array rather than mutating so the caller keeps the single
 * `observe` path — one place decides what counts as a change.
 */
function partyLeavers(registry: PlayerRegistry, state: CharacterState): PlayerRecord[] {
  const members = new Set(state.party.members.map((member) => member.name.toLowerCase()));
  let flagged = 0;
  for (const key of Object.keys(registry)) {
    if (registry[key]!.inParty) flagged += 1;
  }
  /*
   * The registry's own count includes this character only if it were ever
   * filed, which it never is, so the two counts agree exactly while nobody has
   * left. A mismatch is the only thing that justifies the walk below.
   */
  if (flagged === members.size) return [];
  return Object.entries(registry)
    .filter(([key, record]) => record.inParty && !members.has(key))
    .map(([, record]) => record);
}

/**
 * Note that somebody sent an `@` command, whether or not it was answered.
 *
 * Kept for the same reason a refusal is said out loud: a stranger repeatedly
 * trying to drive this character is a thing its owner should be able to see
 * having happened, and a count they have to catch in the notices as they scroll
 * past is one nobody sees. Called from `Remotes`, on every command that
 * parses — refused ones included, which are the ones worth counting.
 */
export function noteRemoteCall(
  registry: PlayerRegistry,
  from: string,
  raw: string,
  at: number
): PlayerRegistry {
  const key = from.trim().toLowerCase();
  const before = registry[key];
  return observe(registry, from, at, {
    commandsSent: (before?.commandsSent ?? 0) + 1,
    lastCommand: raw,
    lastCommandAt: at,
    online: true
  });
}
