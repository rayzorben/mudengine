/**
 * Whether the character in the realm is still the one this client's records
 * are about. A deleted and remade character keeps its name, which is the
 * login, so the records kept against it may be about somebody gone. This
 * reports, once per session, with both characters and what was noticed; the
 * answer is the player's (`Invoke.forgetCharacter`). The remembered identity
 * moves on either way. See `mudengine-session` › *A character that is not the
 * same character is reported, never acted on*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SessionModule } from '../automation/Module';
import type { CharacterState } from '../../shared/character';
import type { CharacterRecord } from '../../shared/belongings';
import { carriedForward, identityOf, resetSignals } from '../../shared/reset';
import type { SessionSink } from './SessionSink';

export interface ResetWatchParts {
  readonly tracker: { readonly current: CharacterState };
  /** The record kept for this character now; a dial can hand the session another. */
  readonly record: () => Pick<CharacterRecord, 'recallIdentity' | 'rememberIdentity'>;
  readonly sink: Pick<SessionSink, 'notice' | 'reset'>;
}

export class ResetWatch implements SessionModule {
  /** Whether this session has already asked about a suspected reset. */
  private asked = false;

  constructor(private readonly parts: ResetWatchParts) {}

  /** The character as it stands, against the one the record remembers. */
  watch(): void {
    const state = this.parts.tracker.current;
    if (state.phase !== 'in-game') return;
    const now = identityOf(state, Date.now());
    if (now === null) return;

    const record = this.parts.record();
    const remembered = record.recallIdentity();
    // Moved on whatever happens next, so this asks once and the record stays
    // current for the session after it. A fact not known yet stays as kept.
    record.rememberIdentity(carriedForward(remembered, now));
    if (remembered === null || this.asked) return;

    const signals = resetSignals(remembered, now, tuning().session.resetExpDropShare);
    if (signals.length === 0) return;

    this.asked = true;
    this.parts.sink.notice(t('session.reset.noticed', { signals: signals.join(', ') }));
    this.parts.sink.reset?.({ signals, before: remembered, after: now });
  }

  /** A new dial is a new session to ask in. */
  reset(): void {
    this.asked = false;
  }
}
