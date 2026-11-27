/**
 * The Sell face's channels: its rows, the plan for what was picked, the run
 * and its stop. The picks are parsed at the boundary (`asSellPicks`); a run
 * plans again from where the character stands, never walking the plan the
 * card was shown.
 */
import type { SellRun } from '../automation/SellRun';
import type { Transport } from '../host/Host';
import { Invoke, type SessionId } from '../../shared/ipc';
import { asSellPicks, type SellChoice } from '../../shared/sellRun';
import { t } from './i18n';

export interface SellHandlerDeps {
  transport: Pick<Transport, 'handle'>;
  /** The character's sell run, or undefined where the session is not loaded. */
  sale(session: SessionId): Pick<SellRun, 'choices' | 'plan' | 'start' | 'stop'> | undefined;
}

export function handleSelling({ transport, sale }: SellHandlerDeps): void {
  const { handle } = transport;

  handle(Invoke.sellChoices, (_caller, session: SessionId): SellChoice[] => {
    return sale(session)?.choices() ?? [];
  });
  handle(Invoke.sellPlan, (_caller, session: SessionId, picks: unknown) => {
    // Parsed at the boundary: the plan is a sweep per round and an A* per leg.
    const parsed = asSellPicks(picks);
    if (parsed === null) return null;
    return sale(session)?.plan(parsed) ?? null;
  });
  handle(Invoke.sellRun, (_caller, session: SessionId, picks: unknown) => {
    const parsed = asSellPicks(picks);
    if (parsed === null) return t('automation.sellRun.refusalUnreadable');
    return sale(session)?.start(parsed) ?? t('automation.hostTrip.refusalNotInRealm');
  });
  handle(Invoke.sellStop, (_caller, session: SessionId) => {
    sale(session)?.stop();
  });
}
