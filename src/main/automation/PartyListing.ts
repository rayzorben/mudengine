/**
 * MegaMUD's *Par Frequency* and *Send PAR After Combat Round* (todo 831): the
 * party listing asked for on a clock while in a party, every `party.parSeconds`
 * in a fight and twice that out of one, and after each combat round when
 * `party.parAfterRound` says so, and by the round under `party.parEveryRounds`,
 * sooner the more health a member has lost since the last one
 * (`roundsUntilPar`). The listing is what keeps each member's health current,
 * which `party.waitBelow`, `manageParty` and a party heal read. Under the same
 * key as the ask a party change makes, so the two are one `par`. See
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import {
  fightIsRunning,
  inAParty,
  joinedMembers,
  type CharacterState
} from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind } from '../../shared/decisionSettings';
import type { CommandQueue, Intent } from './CommandQueue';

/** Every ask for the party listing shares it, so asks that meet in the queue are one `par`. */
export const PARTY_LISTING_KEY = 'probe:party';

/** One `par`, under the party-change ask's key and word, so every ask for the listing is one. */
export function partyListingIntent(config: AutomationConfig, decision: DecisionKind): Intent {
  return {
    command: config.onPartyChange || 'par',
    priority: 'probe',
    coalesceKey: PARTY_LISTING_KEY,
    reason: t('automation.routines.reasonPar'),
    decision
  };
}

/**
 * How many rounds after the last listing the next is asked for: `every` with
 * nothing lost, one round sooner per `atLoss / every` of the most any member
 * has lost since, and on the next round from `atLoss` on.
 */
export function roundsUntilPar(every: number, lost: number, atLoss: number): number {
  const share = atLoss > 0 ? Math.min(1, Math.max(0, lost) / atLoss) : 1;
  // A hair under, so a share read off two shares (`1 - 0.9`) lands where it reads.
  return Math.max(1, Math.ceil(every * (1 - share) - 1e-9));
}

export class PartyListing {
  private askedAt: number | null = null;
  private roundsSince = 0;
  /** Each member's health when the listing was last asked for, by lower-cased name. */
  private healthAtAsk = new Map<string, number>();

  constructor(
    private readonly queue: CommandQueue,
    private readonly config: () => AutomationConfig,
    private readonly now: () => number = () => Date.now()
  ) {}

  onCharacter(state: CharacterState): void {
    const seconds = this.config().party.parSeconds;
    if (seconds <= 0 || !inAParty(state)) return;
    const period = seconds * 1000 * (fightIsRunning(state) ? 1 : 2);
    if (this.askedAt !== null && this.now() - this.askedAt < period) return;
    this.ask(state);
  }

  /** A combat round has come round. */
  afterRound(state: CharacterState): void {
    if (!inAParty(state)) return;
    const { parAfterRound, parEveryRounds, parAtLoss } = this.config().party;
    if (parAfterRound) return this.ask(state);
    if (parEveryRounds <= 0) return;
    this.roundsSince += 1;
    const due = roundsUntilPar(parEveryRounds, this.lost(state), parAtLoss);
    if (this.roundsSince >= due) this.ask(state);
  }

  reset(): void {
    this.askedAt = null;
    this.roundsSince = 0;
    this.healthAtAsk = new Map();
  }

  /** The most of its bar any member has lost since the listing was last asked for. */
  private lost(state: CharacterState): number {
    let most = 0;
    for (const member of joinedMembers(state)) {
      if (member.health === null) continue;
      const before = this.healthAtAsk.get(member.name.toLowerCase()) ?? member.health;
      most = Math.max(most, before - member.health);
    }
    return most;
  }

  private ask(state: CharacterState): void {
    if (!this.config().enabled) return;
    this.askedAt = this.now();
    this.roundsSince = 0;
    this.healthAtAsk = new Map(
      joinedMembers(state).flatMap((member) =>
        member.health === null ? [] : [[member.name.toLowerCase(), member.health] as const]
      )
    );
    this.queue.enqueue(partyListingIntent(this.config(), 'party-listing-clock'));
  }
}
