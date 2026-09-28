/**
 * What the state can say about somebody, for `judgeRemote`, and what a refusal
 * says about the evidence it lacked: read by `Remotes` for an `@` command and
 * by `AutoJoin` for an invitation. Its own module so the one that composes the
 * other does not import it back.
 */
import { gangOnRoster, joinedTheParty, ownGang, type CharacterState } from '../../shared/character';
import type { RemoteEvidence, RemoteVerdict } from '../../shared/remotes';
import { t } from '../app/i18n';

/**
 * What the state can say about the asker, for `judgeRemote`.
 *
 * Two facts: the gang, and the party.
 *
 * The party used to be here as a **ground** — a reason somebody was allowed
 * every remote — and that is what was wrong with it: a party is a group anybody
 * can invite anybody into, so it was a permission anybody could grant
 * themselves by sending an invitation. It is back as a *list* of named commands
 * (2026-09-02), which is a different object; the note on `judgeRemote` has the
 * argument in full. What is read here is the half that keeps it honest:
 * **membership, never an invitation**. `invited` marks an offer nobody has
 * accepted, and a row carrying it is not a member — otherwise `invite` would be
 * the gesture that hands somebody the list.
 *
 * There is no *nobody has said* here, unlike the gang. The party roster is this
 * client's own maintained listing — `party` establishes it, and the `joins` and
 * `leaves` sentences the server volunteers keep it true — so a name that is not
 * on it is a name that is not in the party. A refusal on this ground says so in
 * those words (`notInParty`) rather than calling the asker a stranger, because
 * `party` is one command away from settling it.
 *
 * The gang is read off the **realm roster**, which is the one place the wire
 * states membership: a `who` row
 * names a gang behind its title, and a `look <player>` names it in
 * parentheses — this character's own row included, which is what makes a
 * comparison possible at all. The gangpath itself is deliberately not
 * evidence: this character's own `bg` comes back as a third-person line naming
 * itself, and an admin can ghost one.
 *
 * `null` is *nobody has said*, and it is kept apart from *no gang*: a row a
 * listing wrote in full and left without a gang has none, and a comparison
 * against it is a real `false`; a provisional row, or a name the roster has
 * not listed, is unknown, and `judgeRemote` reports the ground as unresolved
 * rather than refusing in silence. Case-insensitive on both names and the
 * gang, because the server is inconsistent about the first and a gang name is
 * typed by whoever founded it.
 */
export function evidenceAbout(from: string, state: CharacterState): RemoteEvidence {
  const own = ownGang(state);
  const theirs = gangOnRoster(state, from);
  const inGang =
    own === undefined || theirs === undefined
      ? null
      : own !== null && theirs !== null && own.toLowerCase() === theirs.toLowerCase();

  return { inGang, inParty: joinedTheParty(state, from) };
}

/**
 * The sentence a `not-granted` refusal ends with, naming the evidence it lacked.
 *
 * A gang grant that could not be evaluated is named, because the two reasons
 * somebody sees nothing happen are opposite: nothing grants this command to
 * anybody, or the gang grants it and this client cannot yet tell whether the
 * asker is in the gang. Saying "not granted" for the second is how a feature
 * gets reported as broken. The party clause is the same in the other
 * direction: the party grants it and the asker is not on the party list, a fact
 * one `party` away, and "not granted" would send the player looking through
 * permissions that are already right.
 */
export function unresolvedClauseOf(verdict: RemoteVerdict): string {
  if (verdict.allowed || verdict.because !== 'not-granted') return '';
  if (verdict.gangUnresolved) return t('automation.remotes.unresolvedGang');
  return verdict.notInParty ? t('automation.remotes.notInParty') : '';
}
