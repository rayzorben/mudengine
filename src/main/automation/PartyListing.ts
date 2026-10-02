/**
 * MegaMUD's *Par Frequency* and *Send PAR After Combat Round* (todo 831): the
 * party listing asked for on a clock while in a party, every
 * `party.parSeconds` in a fight and twice that out of one, and after each
 * combat round when `party.parAfterRound` says so. The listing is what keeps
 * each member's health current, which `party.waitBelow` and a party heal
 * read. Under the same key as the ask a party change makes, so the two are one
 * `par`. See `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { fightIsRunning, inAParty, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { CommandQueue, Intent } from './CommandQueue';

/** Every ask for the party listing shares it, so asks that meet in the queue are one `par`. */
export const PARTY_LISTING_KEY = 'probe:party';

/** One `par`, under the party-change ask's key and word, so every ask for the listing is one. */
export function partyListingIntent(config: AutomationConfig): Intent {
  return {
    command: config.onPartyChange || 'par',
    priority: 'probe',
    coalesceKey: PARTY_LISTING_KEY,
    reason: t('automation.routines.reasonPar')
  };
}

export class PartyListing {
  private askedAt: number | null = null;

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
    this.ask();
  }

  /** A combat round has come round. */
  afterRound(state: CharacterState): void {
    if (this.config().party.parAfterRound && inAParty(state)) this.ask();
  }

  reset(): void {
    this.askedAt = null;
  }

  private ask(): void {
    if (!this.config().enabled) return;
    this.askedAt = this.now();
    this.queue.enqueue(partyListingIntent(this.config()));
  }
}
