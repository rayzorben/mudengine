/**
 * Who a blow line says is fighting whom, past this character's own fight: the
 * attacker it names, held to what the client can vouch for (`vouchedFor`,
 * then `swingingAtMe` for the loose miss frame), and what a party member or a
 * stranger was seen fighting (`engagedBy`, `threatenedBy`, `claimedBy`) — pure
 * folds the blow cases in `CharacterTracker.reduce` call. Out of the tracker
 * with todo 723; `mudengine-wire` › `parts/combat.md`.
 */
import { ownAlignment, type CharacterState } from '../../shared/character';
import { attacksOnSight } from '../../shared/mobs';
import { mobKey } from '../../shared/world';

/**
 * The attacker a combat line names, held to what the client can vouch for.
 *
 * A name the room or the realm resolved is taken as read. One the classifier
 * guessed from grammar — the leading capitalised word of a line with no
 * article — is taken only if the realm roster, this room or the party already
 * knows it: `Rend surprise chops you` names a player the `who` listing has,
 * while `Acid burns you for 1 damage!` (captured live, `npm run probe:stealth`)
 * names nobody, and a blow from nobody is counted and attributed to no one
 * rather than putting "Acid" in `attackers` for a rule to swing at.
 */
export function vouchedFor(
  s: CharacterState,
  g: Readonly<Record<string, string>>
): string | undefined {
  const attacker = g['attacker'];
  if (attacker === undefined || g['guessed'] !== 'attacker') return attacker;
  const key = attacker.toLowerCase();
  const known =
    s.online.some((entry) => entry.name.toLowerCase() === key) ||
    s.room.occupants.some((who) => who.name.toLowerCase() === key) ||
    s.party.members.some((member) => member.name.toLowerCase() === key);
  return known ? attacker : undefined;
}

/**
 * The attacker `vouchedFor` let through, held to *whether the realm says it
 * would swing at all*.
 *
 * Only for the loose miss frame. `mob-hits` carries ` for <n> damage!` and
 * is a blow beyond argument; `mob-misses` is `^The …you….` — deliberately
 * generous, because a monster's miss text is realm data and the shipped
 * realm ships 482 templates naming `you`, only 29 of which say ` at you`.
 * That frame is also the shape of an ordinary sentence about somebody
 * standing in the room.
 *
 * **Reported 2026-09-06 (todo 00), and the cost was not the one the frame's
 * own note predicted.** `ask wound mission` at the Temple Healer answered
 * `The wounded messenger looks you up and down.`; it classified as a miss,
 * `wounded messenger` was in `Also here:` so `nameInMessage` named it, and
 * auto-combat's retaliation — the one path that ignores `engage`, the
 * disposition and the ten evil points, because *something is already
 * swinging* — sent `aa wounded messenger` twice at a Lawful Good quest NPC.
 * `patterns.ts` says a false match costs "a bumped round clock and blow
 * count with **no attacker**, because nothing here names one"; that is true
 * of `The gods have punished you appropriately.`, whose subject is not in
 * the room, and false of every sentence about an occupant.
 *
 * So the realm's own answer to *would this have opened a fight* is asked
 * before a miss is booked as one. Three deliberate narrownesses:
 *
 * - **Only where the realm is sure.** `attacksOnSight` answers `null` for a
 *   monster it cannot place and for an alignment-dependent one before a
 *   `who` has said where this character stands, and `null` keeps the
 *   attribution — unknown is never the reassuring answer.
 * - **Never once provoked.** A passive monster fights back, so a name this
 *   character is already fighting, or that is already on `attackers`, is
 *   taken at its word.
 * - **A blow still counts.** The round clock and the blow count move with no
 *   attacker, which is exactly the cost the frame's note claims — and a
 *   monster that really is swinging is filed by its first landed blow, one
 *   round later. Dropping the attribution is recoverable; ten evil points
 *   charged to the character are not.
 */
export function swingingAtMe(s: CharacterState, attacker: string | undefined): string | undefined {
  if (attacker === undefined) return undefined;
  const key = mobKey(attacker);
  // Already in this fight, either way round: taken at its word.
  if (mobKey(s.combat.target ?? '') === key) return attacker;
  if (s.combat.attackers.some((name) => mobKey(name) === key)) return attacker;

  const who = s.room.occupants.find((entry) => mobKey(entry.name) === key);
  // Not a monster the room has placed — a player, an `unknown`, or somebody
  // no listing has named. None of those is the realm's to answer for.
  if (who === undefined || who.kind !== 'mob') return attacker;
  return attacksOnSight(who.disposition, ownAlignment(s)) === false ? undefined : attacker;
}

/**
 * A party member was seen hitting, missing or opening on something: what they
 * are fighting, for `automation.party.assistLeader`. Only a member — anybody
 * else's fight is a fact about the room and nothing more — and only a target
 * that is not this character and not a person, because a leader swinging at a
 * player is not a fight this client joins. Null when nothing changed.
 */
export function engagedBy(
  s: CharacterState,
  attacker: string | undefined,
  target: string | undefined,
  at: number
): CharacterState | null {
  if (!attacker || !target || /^you$/i.test(attacker) || /^you$/i.test(target)) return null;
  // Every monster at once is no one target to assist on: the last one stands.
  if (isAreaTarget(target)) return null;
  const who = attacker.trim();
  const member = s.party.members.find((entry) => entry.name.toLowerCase() === who.toLowerCase());
  if (!member || member.invited) return null;
  const mob = target.trim().replace(/[.!]+$/, '');
  if (
    s.room.occupants.some(
      (there) => there.kind === 'player' && there.name.toLowerCase() === mob.toLowerCase()
    )
  ) {
    return null;
  }
  const held = s.party.engaged[member.name];
  if (held && held.target === mob && held.at === at) return null;
  return {
    ...s,
    party: { ...s.party, engaged: { ...s.party.engaged, [member.name]: { target: mob, at } } }
  };
}

/**
 * Somebody **outside the party** was seen hitting, missing or opening on a
 * monster: that monster is spoken for, which is the fact `combat.joinFights`
 * (MegaMUD's *PoliteAttacks*) reads before opening on it.
 *
 * The same volunteered sentences `engagedBy` reads, for everybody `engagedBy`
 * ignores. Never this character, never a party member (theirs is `engaged`,
 * and joining a member's fight is assisting), and never anything the room
 * lists as a monster — a monster's blow on a monster is a fight between two
 * things nobody owns. The target is never a person: a player being hit is
 * that player's PvP fight, not a claim. An attacker the room has *not* listed
 * still claims: the sentence names a capitalised somebody swinging at a
 * monster, and the cost of reading a named NPC as a person is a fight
 * politely not joined, where the cost of the other error is stealing a kill.
 * Keyed by `mobKey` of the monster with its article dropped, as
 * `player-misses` already spells it. Null when nothing changed.
 */
export function claimedBy(
  s: CharacterState,
  attacker: string | undefined,
  target: string | undefined,
  at: number
): CharacterState | null {
  if (!attacker || !target || /^you$/i.test(attacker) || /^you$/i.test(target)) return null;
  const who = attacker.trim().replace(/^(?:The|A|An) /, '');
  const own = s.name?.toLowerCase() ?? null;
  if (own !== null && who.toLowerCase() === own) return null;
  if (s.party.members.some((entry) => entry.name.toLowerCase() === who.toLowerCase())) return null;
  const listed = s.room.occupants.find((there) => there.name.toLowerCase() === who.toLowerCase());
  if (listed !== undefined && listed.kind === 'mob') return null;
  if (isAreaTarget(target)) {
    // Every monster the room lists is theirs at once.
    const claimed = s.room.occupants
      .filter((there) => there.kind === 'mob')
      .reduce<CharacterState>((was, there) => claim(was, who, there.name, at) ?? was, s);
    return claimed === s ? null : claimed;
  }
  const mob = target
    .trim()
    .replace(/^(?:The|A|An) /, '')
    .replace(/[.!]+$/, '');
  if (
    s.room.occupants.some(
      (there) => there.kind === 'player' && there.name.toLowerCase() === mob.toLowerCase()
    )
  ) {
    return null;
  }
  return claim(s, who, mob, at);
}

/** One monster spoken for by `who`; null when that is already the record. */
function claim(s: CharacterState, who: string, mob: string, at: number): CharacterState | null {
  const key = mobKey(mob);
  const held = s.combat.claimed[key];
  if (held && held.by === who && held.at === at) return null;
  return {
    ...s,
    combat: { ...s.combat, claimed: { ...s.combat.claimed, [key]: { by: who, at } } }
  };
}

/**
 * An area attack's target, `<Name> moves to attack everyone in the room.`
 * (`Player.cs:6169`, `Spell.cs:2131`; wire, Killa in
 * `logs/2026-09-13_22-38-55_festus`): every monster the room lists, never a
 * monster named for the phrase (todo 747).
 */
function isAreaTarget(target: string): boolean {
  return /^everyone in the room[.!]?$/i.test(target.trim());
}

/**
 * Something was seen hitting, missing or opening on a party member: the fight
 * brought *to* the party, for `automation.party.defendParty`. The same
 * volunteered sentences `engagedBy` reads, the other way round — and a member
 * being pummelled without swinging back, which `engaged` never records, is
 * exactly the case defending exists for. Never a player on either end: a
 * person attacking a member is that member's PvP fight, and a member's own
 * swing is `engagedBy`'s fact. Null when nothing changed.
 */
export function threatenedBy(
  s: CharacterState,
  attacker: string | undefined,
  target: string | undefined,
  at: number
): CharacterState | null {
  if (!attacker || !target || /^you$/i.test(attacker) || /^you$/i.test(target)) return null;
  const who = target.trim().replace(/[.!]+$/, '');
  const member = s.party.members.find((entry) => entry.name.toLowerCase() === who.toLowerCase());
  if (!member || member.invited) return null;
  const mob = attacker.trim();
  if (
    s.room.occupants.some(
      (there) => there.kind === 'player' && there.name.toLowerCase() === mob.toLowerCase()
    ) ||
    s.party.members.some((entry) => entry.name.toLowerCase() === mob.toLowerCase())
  ) {
    return null;
  }
  const held = s.party.threatened[member.name];
  if (held && held.target === mob && held.at === at) return null;
  return {
    ...s,
    party: {
      ...s.party,
      threatened: { ...s.party.threatened, [member.name]: { target: mob, at } }
    }
  };
}
