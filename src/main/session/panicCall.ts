/**
 * `@panic!`, said by a leader about to leave its party behind on low health
 * (todo 61). MegaMUD's manual (`idh_remotecontrol.htm`): *Sent by the party
 * leader as they are about to teleport or hangup due to low HP's. Allows party
 * followers to do the same*; `megamud.exe` formats it `%s@panic!`. Here the
 * one way a leader leaves its party on low health is `FleeGoto`'s teleport, so
 * that is the only caller. A walked escape takes the party with it
 * (`Exits.SuccessMoveThroughExit`), so it says nothing.
 *
 * Said in the room: the members being left are the ones standing in it, and
 * the say's broken stealth no longer matters to a character teleporting out.
 */
import { t } from '../app/i18n';
import type { Intent } from '../automation/CommandQueue';
import { inAParty, type CharacterState } from '../../shared/character';
import type { PartyConfig } from '../../shared/config';

/** The say, or null where there is nobody to tell or the player said not to. */
export function panicCall(
  state: CharacterState,
  party: Pick<PartyConfig, 'sayPanic'>,
  why: string,
  stillWanted: () => boolean
): Intent | null {
  if (!party.sayPanic || state.party.following !== null || !inAParty(state)) return null;
  return {
    command: '.@panic!',
    priority: 'emergency',
    coalesceKey: 'escape:panic',
    reason: t('session.safety.panicReason', { why }),
    decision: 'panic-call',
    stillWanted
  };
}
