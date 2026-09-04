import { memo } from 'react';

import BentoCard from './BentoCard';
import { t } from '../lib/i18n';
import type { CharacterState } from '@shared/character';
import type { ConnectionState } from '@shared/types';

export interface StandbyCardProps {
  state: ConnectionState;
  character: CharacterState;
}

/** What the client is waiting for, said in the words a player would use. */
function standing(state: ConnectionState, character: CharacterState): string {
  switch (state.phase) {
    // Resolving and negotiating are still the dial in progress: a character
    // actively connecting must not read the same as one never asked to.
    case 'resolving':
    case 'connecting':
    case 'negotiating':
      return t('cards.standby.dialling');
    case 'closing':
      return t('cards.standby.hangingUp');
    case 'error':
      return state.detail ?? t('cards.standby.connectionFailed');
    case 'idle':
    case 'closed':
      return t('cards.standby.notConnected');
    case 'connected':
      // Connected but not in the realm: sitting at a prompt or a menu. The
      // client knows which, and saying so is the difference between "wait" and
      // "type something".
      if (character.phase === 'authenticating') return t('cards.standby.loginPrompt');
      return t('cards.standby.waitingForRealm');
    default: {
      // A phase added to ConnectionPhase must be named above, or the build
      // fails here — falling through to a generic offline hid `resolving`
      // and `negotiating` for as long as this switch existed.
      const unnamed: never = state.phase;
      void unnamed;
      return t('cards.realm.emptyOffline');
    }
  }
}

/**
 * The HUD's own resting state.
 *
 * The rail used to disappear entirely whenever a character was not in the
 * realm, and with two characters on screen that reads as damage: one has an
 * instrument beside it and the other has a blank column, and nothing on screen
 * says the difference is "this one is offline" rather than "this one is broken".
 *
 * So the rail is always there, and when there is nothing to read it says why
 * there is nothing to read. That also keeps the workspace one shape — the
 * console does not widen and re-wrap every time a character drops.
 */
function StandbyCard({ state, character }: StandbyCardProps) {
  return (
    <BentoCard className="standby-card" title={t('cards.standby.title')}>
      <p className="standby-what">{standing(state, character)}</p>
      {character.name && (
        <p className="standby-who">{t('cards.standby.lastKnownAs', { name: character.name })}</p>
      )}
      <p className="hint">{t('cards.standby.hint')}</p>
    </BentoCard>
  );
}

export default memo(StandbyCard);
