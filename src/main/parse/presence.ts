/**
 * Who else is here, as pure folds, `state in → state out`: the roster, the
 * party, the gang and the numbers another client quotes. Out of
 * `CharacterTracker` on 2026-08-29 as a file move, since none of it reads a
 * tracker field. Re-reading the room against a fresh roster asks the realm,
 * so it is the room's (`RoomTracker.rereadOccupants`) and `withRoster` hands
 * it the roster. A fold that writes the registry takes it beside the state
 * and hands both halves back (`PresenceFold`) to `Company` (`company.ts`),
 * which keeps it. A listing replaces and a broadcast maintains, and a party
 * of one is no party: `mudengine-wire` › `parts/character.md`.
 */
import {
  ALIGNMENTS,
  NO_PARTY,
  ownGang,
  partyActivity,
  type Adventurer,
  type Alignment,
  type CharacterState,
  type PartyActivity,
  type PartyMember,
  type RoomOccupant
} from '../../shared/character';
import { parseRemoteReply } from '../../shared/remotes';
import { observe, type PlayerRegistry, type WornItem } from '../../shared/players';
import { figure } from '../../shared/values';

/**
 * A fold that writes the registry as well as the state: `state` null where the
 * state did not move, `players` the same registry where no record did.
 */
export interface PresenceFold {
  state: CharacterState | null;
  players: PlayerRegistry;
}

/** The listing's alignment column, or null for anything unrecognised. */
function isAlignment(value: string | undefined): value is Alignment {
  return value !== undefined && (ALIGNMENTS as readonly string[]).includes(value);
}

/** `62%` as a fraction in [0, 1]; null when the listing printed none. */
export function percent(value: string | undefined): number | null {
  const parsed = figure(value);
  return parsed === null ? null : Math.min(1, Math.max(0, parsed / 100));
}

/**
 * A member the announcements added: a name, and nothing a listing would have
 * said. They keep the roster *approximately* true between listings, the way
 * arrival broadcasts keep the realm roster true, but carry no health — so a
 * member added this way has none until the next `party`. Null is the honest
 * answer and the card says so.
 */
export function member(name: string, over: Partial<PartyMember> = {}): PartyMember {
  return {
    name,
    className: null,
    health: null,
    mana: null,
    rank: null,
    activity: null,
    invited: false,
    vitals: null,
    ...over
  };
}

/** `Frontrank`, `Midrank`, `Backrank` — MajorMUD has the middle one. */
export function rankOf(value: string | undefined): 'front' | 'mid' | 'back' | null {
  if (value === undefined) return null;
  const word = value.toLowerCase();
  if (word.startsWith('front')) return 'front';
  if (word.startsWith('mid')) return 'mid';
  if (word.startsWith('back')) return 'back';
  return null;
}

/**
 * A gang column's value: the name, or null for none. `None` reads as none on
 * the strength of one row — `Strider  Heretic Infidel  Neutral  None`,
 * captures/013 — where a gang genuinely called None would be a stranger claim
 * than a column printing its empty word; a claim from one capture, and said so.
 */
export function gangOf(value: string | undefined): string | null {
  const gang = value?.trim() ?? '';
  return gang.length === 0 || gang === 'None' ? null : gang;
}

/**
 * The roster a `who` listing states, every row kept whole. On a PvP realm the
 * name is the least useful field; what the realm thinks of somebody is what
 * the listing is for.
 */
export function rosterFrom(rows: Array<Record<string, string>> | undefined): Adventurer[] {
  return (rows ?? [])
    .map((row): Adventurer | null => {
      const name = row['name'];
      if (!name) return null;
      const alignment = row['alignment'];
      return {
        name,
        alignment: isAlignment(alignment) ? alignment : null,
        title: row['title']?.trim() || null,
        flags: row['flags']?.trim() || null,
        // `None` is read as no gang; see `gangOf` for the one row that says so.
        gang: gangOf(row['gang']),
        provisional: false
      };
    })
    .filter((entry): entry is Adventurer => entry !== null);
}

/**
 * A `who` listing: authoritative, so it replaces the roster outright rather
 * than merging — somebody absent from it has left. The room's occupants are
 * re-read against the new roster too (`reread`, the room's: it asks the realm
 * table), because `Also here:` routinely arrives before the first listing. A
 * listing that read no row changes nothing, and is not asked to.
 */
export function withRoster(
  s: CharacterState,
  rows: Array<Record<string, string>> | undefined,
  reread: (roster: Adventurer[]) => RoomOccupant[]
): CharacterState | null {
  const roster = rosterFrom(rows);
  if (roster.length === 0) return null;
  return { ...s, online: roster, room: { ...s.room, occupants: reread(roster) } };
}

/**
 * `<name> just entered the Realm.` — realm-wide, and **not** room occupancy:
 * `room.occupants` comes from `Also here:` and nothing else, and somebody
 * entering the realm put in this room is how a client decides to run from a
 * person on the other side of the map. Provisional: the announcement carries
 * a name and no alignment, and an alignment is not guessed at.
 */
export function withArrival(s: CharacterState, name: string | undefined): CharacterState | null {
  if (!name || s.online.some((entry) => entry.name === name)) return null;
  return {
    ...s,
    online: [
      ...s.online,
      { name, alignment: null, title: null, flags: null, gang: null, provisional: true }
    ]
  };
}

/**
 * `look <player>` names their gang, or prints none. The roster is where the
 * fact lives, because that is where the `who` listing puts it and where
 * `Remotes` reads it. Somebody the roster has not listed is added
 * provisionally — they are standing here, which is more than an arrival
 * broadcast says, and less than a listing.
 */
export function withLookedAt(
  s: CharacterState,
  name: string | undefined,
  printedGang: string | undefined
): CharacterState | null {
  if (!name) return null;
  const gang = printedGang?.trim() || null;
  const index = s.online.findIndex((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (index === -1) {
    return {
      ...s,
      online: [
        ...s.online,
        { name, alignment: null, title: null, flags: null, gang, provisional: true }
      ]
    };
  }
  if (s.online[index]!.gang === gang) return null;
  const online = s.online.slice();
  online[index] = { ...online[index]!, gang };
  return { ...s, online };
}

/**
 * The races the realm ships whose name is two words.
 *
 * Thirteen races are in the realm data and exactly one of them — `Gaunt One` —
 * has a space in it. That single exception is why the race/class boundary in a
 * gang row cannot be found by counting words: `28 Half-Ogre Mystic` and
 * `12 Gaunt One Druid` have the same shape and different splits, and a rule
 * that took the first word as the race would file a Druid as a member of the
 * race `Gaunt` with the class `One Druid`.
 *
 * Listed rather than derived because the parser has no realm database to ask —
 * `resources/world/` ships rooms and nothing else. It is the smallest true
 * statement that makes the split unambiguous, and a race added by a derivative
 * realm falls through to the one-word reading, which is right for every other
 * race in the table.
 *
 * **An exemption with a date on it.** Read from the `Races` table of
 * `mdb/data-Paradigm-1.9-TEST.mdb` on 2026-08-29: thirteen races, of which
 * `Gaunt One` is the only one containing a space. The way out is `build:world`
 * emitting the race list the way it already emits the mob and item indexes, at
 * which point this becomes derived rather than asserted; until a realm turns up
 * with a second two-word race there is nothing to derive it for.
 */
const TWO_WORD_RACES: readonly string[] = ['Gaunt One'];

/**
 * `<race> <class>` from a gang row, split.
 *
 * Returns nulls rather than guessing when the pair is a single word: a row
 * this client cannot read is a row it says nothing about, which is the whole
 * of the "refuse rather than guess" rule applied to two fields nobody can
 * check. A wrong class here would be drawn on a card as fact.
 */
export function raceAndClass(pair: string | undefined): {
  race: string | null;
  className: string | null;
} {
  const text = pair?.trim() ?? '';
  /*
   * The two-word race is tested first and *without* requiring a class after
   * it. A bare `Gaunt One` matched no two-word race when the test demanded a
   * trailing space, fell through to the one-word split, and produced the race
   * `Gaunt` of class `One` — two invented facts from a row stating neither,
   * which is precisely what this function refuses to do.
   */
  const two = TWO_WORD_RACES.find((race) => text === race || text.startsWith(`${race} `));
  if (two !== undefined) {
    const rest = text.slice(two.length).trim();
    return rest.length === 0 ? { race: null, className: null } : { race: two, className: rest };
  }
  const at = text.indexOf(' ');
  if (at === -1) return { race: null, className: null };
  return { race: text.slice(0, at), className: text.slice(at + 1).trim() };
}

/**
 * `<race> <class>` read off the **end** of a look description's opening clause.
 *
 * `raceAndClass` above splits a gang row's column, where the pair is the whole
 * field and the race comes first. Here the pair is the tail of `massive,
 * muscular Nekojin Ranger`, with one or two adjectives in front of it that are
 * realm-flavoured prose and are not worth listing — so it is read from the far
 * end instead: the last word is the class, and the word before it is the race
 * unless the two before it spell one of the two-word races.
 *
 * The same refusal as its sibling. Fewer than two words left after the class is
 * a clause that did not come out the way the frame says, and a class taken from
 * it would be a race drawn on a card as a class.
 */
export function raceAndClassAtEnd(clause: string | undefined): {
  race: string | null;
  className: string | null;
} {
  const words = (clause ?? '')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length < 3) return { race: null, className: null };
  const className = words[words.length - 1]!;
  const rest = words.slice(0, -1);
  const two = rest.slice(-2).join(' ');
  if (TWO_WORD_RACES.includes(two)) return { race: two, className };
  return { race: rest[rest.length - 1]!, className };
}

/**
 * The description sentence a look prints, filed against the person it names.
 *
 * It lands in the **registry** and not on the roster, for `withGangListing`'s
 * reason: a race and a class are facts about a person that outlive any listing,
 * and the roster is replaced wholesale by the next `who`. Until this, the two
 * were knowable only for a member of this character's own gang — everybody else
 * was a name and a rank title forever.
 *
 * The sentence names the player itself, so nothing is filed against the name
 * that was *typed*: `l trick` prints `Trickster is a …`, and the server's
 * spelling is the one that matches a roster row.
 */
export function withDescription(
  players: PlayerRegistry,
  name: string | undefined,
  clause: string | undefined,
  at: number
): PlayerRegistry {
  if (!name) return players;
  const { race, className } = raceAndClassAtEnd(clause);
  if (race === null || className === null) return players;
  return observe(players, name, at, { race, className });
}

/**
 * The gang listing `bg` prints: every member, online and off.
 *
 * **The one listing that states a membership rather than a presence.** `who`
 * says who is logged in, so a gang member who is not is unrepresented in it —
 * there is no row to read and no absence to notice. This enumerates the gang
 * record itself, which is what makes an offline member knowable at all, and it
 * is the only place another player's level, race and class appear.
 *
 * Everything lands in the **registry**, not on the roster. The roster is who is
 * in the realm now and is replaced wholesale by the next `who`; these are facts
 * about people that outlive any listing — two of the three never change — and
 * putting an offline member on `online` would be stating they are logged in.
 *
 * `online` is written from the row's own field either way: the listing is
 * authoritative about the gang, so a row without `- Online` is somebody this
 * client should stop believing is present, and one with it is a sighting.
 */
export function withGangListing(
  s: CharacterState,
  registry: PlayerRegistry,
  gang: string | undefined,
  count: string | undefined,
  rows: Array<Record<string, string>> | undefined,
  at: number
): PresenceFold {
  const named = gang?.trim() || null;
  /*
   * The header's count against the rows that parsed.
   *
   * The server builds the count by incrementing alongside each row it emits,
   * so the two are the same number by construction and any gap is a row this
   * client could not read. That makes it a pure parse-failure signal, and the
   * place a parse failure is answered in this project is the capture harness —
   * `capture:analyse` reports what the classifier could not understand, and a
   * short gang listing shows up there as the unread row itself.
   *
   * It is kept on the state rather than dropped so the card can say the listing
   * was short instead of quietly drawing fewer members than the gang has: a
   * listing that lost a row and said nothing is exactly the silent-shrink
   * failure the party roster already has scar tissue from.
   */
  const expected = figure(count);
  const read = (rows ?? []).length;
  const short = expected !== null && expected !== read ? expected : null;
  let players = registry;
  for (const row of rows ?? []) {
    /*
     * Filed under the **first name alone**, which is the whole of a player's
     * identity on this server: `GMUDServer.GetPlayers` matches a typed name
     * against `plyr.Name` and never looks at `LastName`, so `Soul Guardian` is
     * addressed, telepathed and looked at as `Soul`. Every other listing this
     * client reads does the same — `rosterFrom` keeps `name` and drops `last`.
     *
     * Joining the two here filed one person under two keys: the `who` listing
     * wrote `soul` and this wrote `soul guardian`, and the Gang card drew them
     * as two members. That is exactly the duplicate `playerKey` exists to
     * prevent, and it is why a surname is display text rather than identity.
     */
    const name = row['name'];
    if (!name) continue;
    const { race, className } = raceAndClass(row['who']);
    players = observe(players, name, at, {
      gang: named,
      online: row['online'] !== undefined,
      // `null` where the row could not be read, never a zero: see `PlayerRecord`.
      level: figure(row['level']),
      race,
      className,
      // The listing is authoritative about the gang, so a member it prints
      // without a rank word is an ordinary member rather than one it did not
      // mention — `null` here replaces a stale `Leader` from an older listing.
      gangRank: row['rank'] ?? null
    });
  }
  if (players === registry && s.gangListing?.short === short && s.gangListing?.gang === named) {
    return { state: null, players };
  }
  return { state: { ...s, gangListing: { gang: named, expected: read, short, at } }, players };
}

/**
 * `gb` answered by a character in no gang. It settles the one thing the Gang
 * card cannot otherwise distinguish: `ownGang` is `undefined` while nobody has
 * said and `null` for a stated absence, and the difference is what the card
 * draws as "type who" versus "there is nothing to configure". A `who` row
 * settles it too, but this arrives first.
 */
export function withNoGang(s: CharacterState, at: number): CharacterState | null {
  return s.gangListing?.gang === null
    ? null
    : { ...s, gangListing: { gang: null, expected: 0, short: null, at } };
}

/**
 * `<name> just joined your gang.` — sent to every member of that gang.
 *
 * The gang is not named because it cannot be anything else: the server sends
 * this only to the members of the gang being joined (`JoinCommand.cs:95`), so
 * the gang is this character's own.
 *
 * **This is a permission change, not just a listing change.** The gang grant in
 * `automation.remotes` answers `@` commands for whoever shares this character's
 * gang, and membership is read from the roster and the registry — so until this
 * lands, somebody who has just joined is not yet answered and somebody who has
 * just left still is. Waiting for the next `who` means a permission that
 * outlives the thing it was granted for.
 *
 * Written to **both** places membership is read from, because they are read by
 * different consumers: `Remotes` and the Gang card go through the roster and
 * the registry respectively, and updating one would leave the card and the gate
 * disagreeing about who is in the gang.
 */
export function withGangJoined(
  s: CharacterState,
  players: PlayerRegistry,
  name: string | undefined,
  at: number
): PresenceFold {
  const gang = ownGang(s);
  // Nothing has said which gang this character is in, so nothing can be said
  // about somebody joining it. `undefined` here is not `null`: see `ownGang`.
  if (!name || gang === undefined || gang === null) return { state: null, players };
  return withGangMembership(s, players, name, gang, at);
}

/**
 * `<name> has left <gang>.` — the same broadcast, in the other direction.
 *
 * The gang **is** named here, and it is checked rather than trusted: the line's
 * shape is `<word> has left <anything>.`, which is loose enough to match prose
 * on a realm this client has not seen. A line naming a gang this character is
 * not in is not about this character's gang, so it is refused — the same
 * "refuse rather than guess" the room resolver applies to an ambiguous room.
 */
export function withGangLeft(
  s: CharacterState,
  players: PlayerRegistry,
  name: string | undefined,
  named: string | undefined,
  at: number
): PresenceFold {
  const gang = ownGang(s);
  if (!name || gang === undefined || gang === null) return { state: null, players };
  if (named === undefined || named.trim().toLowerCase() !== gang.toLowerCase()) {
    return { state: null, players };
  }
  return withGangMembership(s, players, name, null, at);
}

/**
 * One person's gang membership, in the roster and the registry at once.
 *
 * `null` for a departure, which is the *stated* absence `observe` distinguishes
 * from `undefined`: it replaces whatever the last listing said rather than
 * leaving it, and that replacement is what revokes the gang grant.
 */
function withGangMembership(
  s: CharacterState,
  registry: PlayerRegistry,
  name: string,
  gang: string | null,
  at: number
): PresenceFold {
  const players = observe(registry, name, at, { gang });

  const index = s.online.findIndex((entry) => entry.name.toLowerCase() === name.toLowerCase());
  let online = s.online;
  if (index !== -1 && s.online[index]!.gang !== gang) {
    online = s.online.slice();
    online[index] = { ...online[index]!, gang };
  }

  return { state: online === s.online ? null : { ...s, online }, players };
}

/**
 * The equipment block from a `look` at somebody, filed against them.
 *
 * The name comes from the `[ Name ] (Gang)` line the server prints immediately
 * above it, which `Company` holds — not from the look queue. The two would
 * usually agree and the printed one is better: it is what the *server* decided
 * the typed name meant, so an abbreviation, a name modifier and an ambiguous
 * target are all already resolved by the only party entitled to resolve them.
 *
 * A look with no such line before it is refused rather than guessed at: an
 * equipment block filed against the wrong person is a decision about what
 * somebody can hit you with, made from another player's kit.
 */
export function withEquipment(
  players: PlayerRegistry,
  name: string | null,
  rows: Array<Record<string, string>> | undefined,
  at: number
): PlayerRegistry {
  if (name === null) return players;
  const worn: WornItem[] = [];
  for (const row of rows ?? []) {
    const item = row['item']?.trim();
    const slot = row['slot']?.trim();
    if (!item || !slot) continue;
    /*
     * `<empty>` is GreaterMUD saying the slot is bare. It prints all eighteen
     * slots every time and marks the unused ones; MajorMUD says the same thing
     * by omitting the row, and the corpus contains no `<empty>` at all — so
     * this is a live-only spelling of an absence the other realm expresses by
     * silence. Kept as an item it read as a *worn* item called `<empty>`,
     * which put eighteen of them on the card for somebody wearing nothing and
     * buried the one real item among them.
     */
    if (item === '<empty>') continue;
    worn.push({ name: item, slot });
  }
  /*
   * An empty block is a real answer — somebody wearing nothing — and is kept as
   * an empty list rather than as null, which means nobody has looked. The two
   * draw differently and the difference is the whole of the absence rule.
   */
  return observe(players, name, at, { equipment: worn, equipmentAt: at });
}

/** `just left the Realm` / `just disconnected`: off the roster, and only the roster. */
export function withoutPlayer(s: CharacterState, name: string | undefined): CharacterState | null {
  if (!name || !s.online.some((entry) => entry.name === name)) return null;
  return { ...s, online: s.online.filter((entry) => entry.name !== name) };
}

/**
 * The party listing, or the one-row listing a lone character gets: the one
 * place another character's health is visible, for a command rather than a
 * second connection. Authoritative, so it replaces what was there: somebody
 * absent from it has left.
 *
 * A party of one is no party and the client reports none — except while an
 * invitation is out, which is the moment the player is watching for an
 * answer. The absolute figures another client answered with survive a listing:
 * a percentage does not contradict a pair of numbers, it is coarser than one.
 */
export function withPartyListing(
  s: CharacterState,
  rows: Array<Record<string, string>> | undefined,
  alone: boolean
): CharacterState | null {
  const members = (rows ?? [])
    .map((row): PartyMember | null => {
      const name = row['name'];
      if (!name) return null;
      return {
        name,
        className: row['class']?.trim() || null,
        health: percent(row['health']),
        mana: percent(row['mana']),
        rank: rankOf(row['rank']),
        activity: partyActivity(row['flag']),
        invited: row['invited'] !== undefined,
        vitals: s.party.members.find((held) => held.name === name)?.vitals ?? null
      };
    })
    .filter((entry): entry is PartyMember => entry !== null);
  const pending = members.some((entry) => entry.invited);
  if (alone || (!pending && members.length <= 1)) {
    return { ...s, party: NO_PARTY };
  }
  return { ...s, party: { ...s.party, members } };
}

/**
 * Another client's `{HP=…}` answer, on any conversation channel: a quotation
 * that lands in the registry and, when the speaker is in the party, on their
 * row — the numbers, and the percentage they imply — and touches nothing else.
 *
 * `Syntax telepaths: {HP=4434/4434,MA=516/516}` (captures/123) and
 * `/Sackhunter {HP=600/600}` (captures/055): the only thing on this server
 * that states another character's numbers rather than a percentage, for a
 * telepath rather than a command from the budget walking and fighting spend.
 *
 * **Kept for anybody, and put on the Party card only for a member.** The two
 * are different questions and used to be conflated: a reply from a stranger
 * was dropped entirely, because the only place to put it was the party roster,
 * and inventing a member out of a chat message would put somebody on the Party
 * card who never joined. The registry is not the roster, so the numbers are
 * kept there for everybody and the roster is touched only for a member.
 */
export function withRemoteVitals(
  s: CharacterState,
  registry: PlayerRegistry,
  who: string | undefined,
  message: string | undefined,
  at: number
): PresenceFold {
  if (who === undefined || message === undefined) return { state: null, players: registry };
  const reply = parseRemoteReply(message);
  if (reply === null || reply.kind !== 'vitals') return { state: null, players: registry };

  const vitals = { hp: reply.hp, hpMax: reply.hpMax, mana: reply.mana, manaMax: reply.manaMax };
  const players = observe(registry, who, at, { vitals, vitalsAt: at, online: true });

  const index = s.party.members.findIndex((held) => held.name.toLowerCase() === who.toLowerCase());
  if (index === -1) return { state: null, players };

  const members = s.party.members.map((held, position) =>
    position === index
      ? {
          ...held,
          vitals,
          health: reply.hpMax > 0 ? reply.hp / reply.hpMax : held.health,
          mana:
            reply.mana !== null && reply.manaMax !== null && reply.manaMax > 0
              ? reply.mana / reply.manaMax
              : held.mana
        }
      : held
  );
  return { state: { ...s, party: { ...s.party, members } }, players };
}

/** `You are following <leader>.` */
export function withFollowing(
  s: CharacterState,
  leader: string | undefined
): CharacterState | null {
  return leader ? { ...s, party: { ...s.party, following: leader } } : null;
}

/**
 * An invitation this character sent: on the card from the moment it goes,
 * under its own heading.
 *
 * `invite` offers and `join` accepts, so this is not a party yet — but it is
 * the moment the player is watching for an answer, and the card had nothing to
 * say about it: the invitee appeared only once they accepted, and the listing
 * in between was read as a party of one. `withJoined` turns the same entry
 * into a member and `withLeft` takes it off when the offer is withdrawn.
 *
 * The outgoing sentence only. The incoming one names a `leader` — the person
 * who invited *this* character — and being invited is not being in a party:
 * nothing has been accepted, and the roster that would say so is the leader's.
 */
export function withInvited(s: CharacterState, player: string | undefined): CharacterState | null {
  if (!player || s.party.members.some((entry) => entry.name === player)) return null;
  return {
    ...s,
    party: { ...s.party, members: [...s.party.members, member(player, { invited: true })] }
  };
}

/** Somebody joined: the leader this character now follows, or a member whose invitation was answered. */
export function withJoined(
  s: CharacterState,
  leader: string | undefined,
  player: string | undefined
): CharacterState | null {
  if (leader) return { ...s, party: { ...s.party, following: leader } };
  if (!player) return null;
  const known = s.party.members.find((entry) => entry.name === player);
  if (known) {
    if (!known.invited) return null;
    return {
      ...s,
      party: {
        ...s.party,
        members: s.party.members.map((entry) =>
          entry.name === player ? { ...entry, invited: false } : entry
        )
      }
    };
  }
  return { ...s, party: { ...s.party, members: [...s.party.members, member(player)] } };
}

/** Somebody left — the leader, which ends the party, or one member. */
export function withLeft(
  s: CharacterState,
  leaderLeft: boolean,
  player: string | undefined
): CharacterState | null {
  if (leaderLeft) return { ...s, party: NO_PARTY };
  if (!player) return null;
  const members = s.party.members.filter((entry) => entry.name !== player);
  const pending = members.some((entry) => entry.invited);
  return { ...s, party: !pending && members.length <= 1 ? NO_PARTY : { ...s.party, members } };
}

/** A rank announcement; the player defaults to this character where the line names none. */
export function withRank(
  s: CharacterState,
  player: string | undefined,
  printedRank: string | undefined
): CharacterState | null {
  const rank = rankOf(printedRank);
  if (!player || rank === null) return null;
  return {
    ...s,
    party: {
      ...s.party,
      members: s.party.members.map((entry) => (entry.name === player ? { ...entry, rank } : entry))
    }
  };
}

/**
 * `<player> stops to rest.` / `kneels to meditate`: the flag between listings,
 * for a member — the sentence is said about anybody in the room. **Nothing
 * says a rest has ended**, on the wire or in 214 captures, so only a listing
 * clears it: the safe direction, since a member believed to be resting is one
 * this client will not assume has answered.
 */
export function withResting(
  s: CharacterState,
  player: string | undefined,
  verb: string | undefined
): CharacterState | null {
  if (!player) return null;
  const activity: PartyActivity =
    verb === 'kneels to meditate' ? { state: 'meditating' } : { state: 'resting' };
  if (!s.party.members.some((entry) => entry.name === player)) return null;
  return {
    ...s,
    party: {
      ...s.party,
      members: s.party.members.map((entry) =>
        entry.name === player ? { ...entry, activity } : entry
      )
    }
  };
}
