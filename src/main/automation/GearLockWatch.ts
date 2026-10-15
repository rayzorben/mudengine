/**
 * Says when a death holds the saved gear, and lets it go when the play
 * allowance (`movement.gearLockHours`) runs out with slots still waiting on
 * the corpse (todo 82). The locks themselves are the tracker's
 * (`shared/gearLocks.ts`); this only reads them off the state, decides the
 * timeout, and asks the tracker to release. Not under the automation switch:
 * it is bookkeeping for the saved gear, and sends nothing to the realm.
 */
import type { SessionModule } from './Module';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import type { NoticeSink } from '../../shared/decisionSettings';
import { allowanceLeft, expiredSlots, lockedSlots } from '../../shared/gearLocks';
import { playedFor } from '../../shared/tally';

export interface GearLockEvents {
  notice?: NoticeSink;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export class GearLockWatch implements SessionModule {
  /** The locks last said, by slot and death, so each death is said once. */
  private said = new Set<string>();

  constructor(
    private config: MovementConfig,
    /** Frees the slots in the tracker; whether any was held. */
    private readonly release: (slots: readonly string[], at: number) => boolean,
    private readonly events: GearLockEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: MovementConfig): void {
    this.config = config;
  }

  reset(): void {
    this.said = new Set();
  }

  onCharacter(state: CharacterState): void {
    const held = lockedSlots(state.loadout);
    if (held.length === 0) return;
    const allowance = this.config.gearLockHours * HOUR_MS;
    const now = this.now();
    const played = playedFor(state.tally, now);
    const expired = expiredSlots(state.loadout, played, allowance);
    if (expired.length > 0) {
      const slots = expired.map((worn) => worn.slot);
      if (this.release(slots, now) && allowance > 0) {
        this.events.notice?.(
          t('automation.gearLocks.released', { slots: slots.join(', ') }),
          'gear-lock-release'
        );
      }
      return;
    }
    const fresh = held.filter((worn) => !this.said.has(lockKey(worn.slot, worn.locked?.at)));
    if (fresh.length === 0) return;
    for (const worn of fresh) this.said.add(lockKey(worn.slot, worn.locked?.at));
    this.events.notice?.(
      t('automation.gearLocks.held', {
        slots: held.map((worn) => worn.slot).join(', '),
        minutes: Math.ceil((allowanceLeft(state.loadout, played, allowance) ?? 0) / MINUTE_MS)
      }),
      'gear-lock-release'
    );
  }
}

function lockKey(slot: string, at: number | undefined): string {
  return `${slot.toLowerCase()}@${at ?? ''}`;
}
