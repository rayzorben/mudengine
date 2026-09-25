/**
 * What a typed argument reaches in the room, and what an outbound command
 * aims at: the one reading the tracker's engagement queue and `AutoCombat`
 * both ask, so the two cannot disagree about whether a command was an attack.
 *
 * Out of `CharacterTracker` (todo 816), which kept the occupant rule private.
 * The rules: `mudengine-wire` › `parts/combat.md` › *An engagement answers the
 * oldest attack still owed one*.
 */
import { ATTACK_COMMANDS, commandOf } from './commands';
import type { CharacterState, RoomOccupant } from './character';
import type { CastableSpell } from './spellcraft';
import { mobKey, nameAnswersTo, type WorldSpell } from './world';

/**
 * The occupant a typed argument reaches, in the spelling the room printed.
 *
 * The server resolves a command's argument against the room, so the client
 * has to as well or it files facts about `du` while the card is showing
 * `practice dummy`. `nameAnswersTo` is the rule, read out of the server's own
 * `Misc.IsMatch`.
 *
 * **Exact wins outright.** The C# compares `==` first at every call site and
 * *clears* the candidates it had already accumulated, so a room holding both
 * `rat` and `giant rat` resolves a typed `rat` to `rat` — even though
 * `giant rat` also answers to it and may be listed first.
 *
 * Null when nothing answers: the typed text is then kept as the player wrote
 * it, because the server has confirmed the thing exists and a listing this
 * client has not seen is not a reason to invent a different name.
 */
export function occupantNamed(occupants: readonly RoomOccupant[], typed: string): string | null {
  const key = mobKey(typed);
  if (key.length === 0) return null;
  const exact = occupants.find((who) => mobKey(who.name) === key);
  if (exact) return exact.name;

  const matched = occupants.filter((who) => nameAnswersTo(mobKey(who.name), key));
  if (matched.length === 0) return null;

  /*
   * `LookCommand` collapses an ambiguity by *kind* before it gives up:
   * exactly one matching player wins outright, else exactly one matching
   * monster. Anything else is `Please be more specific.` and no answer.
   *
   * This client only cares about the monster, but the player branch has to
   * be modelled or the wrong one is picked: a room with the player `Ratface`
   * and one `giant rat` resolves a typed `rat` to **the player**, and a look
   * at a player prints no wound sentence at all. Binding the rat there would
   * leave a look queued against a sentence that never comes, which the next
   * wound line would then answer — one monster's condition on another's bar.
   */
  const players = matched.filter((who) => who.kind === 'player');
  if (players.length === 1) return players[0]?.name ?? null;
  const mobs = matched.filter((who) => who.kind === 'mob');
  if (mobs.length === 1) return mobs[0]?.name ?? null;
  /*
   * Genuinely ambiguous, or ambiguous only because this client cannot tell
   * what a name is (`kind` is `unknown` for a capitalised stranger). Either
   * way the server is about to refuse, and `target-ambiguous` will drop the
   * queue entry. Returning the first match would name a monster the answer
   * is not about.
   */
  return null;
}

/**
 * The spell's word and the text a command casts at, when it is a cast — `''`
 * for a bare one — or null for a command that casts nothing.
 *
 * Two spellings reach the server's cast, and both are read: `c <word> …`
 * (`CastCommand.cs:80-90`) and the spell's own word as the command
 * (`Player.cs:1853-1864`), which is how every cast this client makes goes out
 * (`castWord`). The table is consulted first there, so a word it claims is
 * never a spell.
 */
export function castAimedAt(
  command: string,
  spellbook: readonly CastableSpell[] | null,
  realmSpell: (word: string) => WorldSpell | null
): { word: string; aimed: string } | null {
  const named = commandOf(command);
  if (named !== null && named !== 'Cast') return null;
  const words = command.trim().split(/\s+/);
  const [word, ...aimed] = named === 'Cast' ? words.slice(1) : words;
  if (word === undefined || word.length === 0) return null;
  if (named === null && !isSpellWord(word, spellbook, realmSpell)) return null;
  return { word, aimed: aimed.join(' ') };
}

/**
 * Whether the character's book calls `word` a spell, or, the book unread, the
 * realm's row answers to it. The server keys `KnownSpells` by `ShortName`, and
 * the conversion omits a short that is the name itself (`harm`).
 */
function isSpellWord(
  word: string,
  spellbook: readonly CastableSpell[] | null,
  realmSpell: (word: string) => WorldSpell | null
): boolean {
  const needle = word.toLowerCase();
  if (spellbook !== null) {
    return spellbook.some((spell) => (spell.short ?? spell.name).toLowerCase() === needle);
  }
  const row = realmSpell(needle);
  return row !== null && (row.short ?? row.name).toLowerCase() === needle;
}

/**
 * What an outbound command owes the next `*Combat Engaged*`: the argument it
 * aims at, null for a bare attack verb, or undefined for a command that
 * engages nothing.
 *
 * An attack verb always owes one (`AttackCommand.cs:405`). **So does a cast at
 * a monster standing here** (todo 816): a combat spell breaks the fight it is
 * cast into and engages its target (`Player.cs:6043-6188`; GreaterMUD wire,
 * vaelor2 2026-09-01: `harm k` answered `*Combat Off*`, `*Combat Engaged*`,
 * then `You cast harm at tall kobold thief` twice a round, unasked). Only at a
 * monster: `mihe Kill` heals a player and engages nothing, and a bare cast
 * names nobody to bind. A cast that engages nothing after all — an instant
 * spell, which the realm's table cannot tell apart — is let go as a refused
 * attack is (`OwedAttacks`).
 */
export function attackAim(
  command: string,
  state: Pick<CharacterState, 'room' | 'spellbook'>,
  realmSpell: (word: string) => WorldSpell | null
): string | null | undefined {
  const named = commandOf(command);
  if (named !== null && ATTACK_COMMANDS.has(named)) {
    const trimmed = command.trim();
    const space = trimmed.indexOf(' ');
    const argument = space < 0 ? '' : trimmed.slice(space + 1).trim();
    return argument.length > 0 ? argument : null;
  }
  const aimed = castAimedAt(command, state.spellbook, realmSpell)?.aimed ?? '';
  if (aimed.length === 0) return undefined;
  const occupants = state.room.occupants;
  const reached = occupantNamed(occupants, aimed);
  return occupants.some((who) => who.kind === 'mob' && who.name === reached) ? aimed : undefined;
}
