/**
 * Following, back from this character's own hangup: the leader the record
 * carried (`PartyRejoin.owedLeader`) is asked to take it back on the first
 * room read after the dial, `@invite` when `Also here:` lists them and
 * `@comeback` when it does not (the user, 2026-11-13: Yang came back in the
 * Dragon Nest with Nito gone and stood until `/nito @comeback` was typed).
 * Once a connection, under the master switch alone, as the rejoin's `join` is
 * (`AutoJoin`); `Remotes.ask` upgrades `@comeback` for a leader on this client.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { inAParty, standingHere, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { NoticeSink } from '../../shared/decisionSettings';
import { REJOIN, type PartyRejoin } from './PartyRejoin';

export interface RejoinAskEvents {
  notice?: NoticeSink;
  /** Telepath the leader; whether the queue took it. */
  ask(leader: string, name: 'invite' | 'comeback', state: CharacterState): boolean;
}

export class RejoinAsk {
  /** No room read since the dial: the first one decides whether the leader is asked. */
  private armed = true;

  constructor(
    private config: AutomationConfig,
    private readonly rejoin: Pick<PartyRejoin, 'owedLeader'>,
    private readonly events: RejoinAskEvents
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  reset(): void {
    this.armed = true;
  }

  onCharacter(state: CharacterState): void {
    // A remembered room has a name and no `Also here:` the server printed.
    if (!this.armed || state.room.name === null || state.room.resolvedBy === 'remembered') return;
    this.armed = false;
    const leader = this.rejoin.owedLeader;
    if (leader === null || state.party.following !== null || inAParty(state)) return;
    if (!this.config.enabled) {
      this.events.notice?.(t('automation.party.askSwitchedOff', { leader }), REJOIN);
      return;
    }
    const here = standingHere(state).has(leader.toLowerCase());
    if (!this.events.ask(leader, here ? 'invite' : 'comeback', state)) return;
    const said = here
      ? t('automation.party.askInvite', { leader })
      : t('automation.party.askComeback', { leader });
    this.events.notice?.(said, REJOIN);
  }
}
