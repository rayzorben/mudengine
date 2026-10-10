import { useEffect, useRef, useState } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { CashRunState } from '../hooks/useTripDialogs';
import { CASH_RUN_FULL, type CashRunFull, type CashRunToken } from '@shared/cashRun';
import { DENOMINATIONS, type Denomination } from '@shared/character';
import type { IpcApi, ProfileSummary } from '@shared/ipc';

export interface CashRunDialogProps {
  api: Pick<IpcApi, 'listLoops' | 'cashRunTokens' | 'startCashRun'>;
  cash: CashRunState;
  /** For the name of the character the dialog was opened for. */
  profiles: readonly Pick<ProfileSummary, 'id' | 'name'>[];
}

/**
 * Cash run: the loop, the coins to collect, the tokens to use in the order
 * picked, and how full counts as full. The loops are the character's own and
 * the tokens what it carries, both asked of main as the dialog opens. Starting
 * it hands the character to `CashRun`; Stop ends it.
 */
export default function CashRunDialog({
  api,
  cash,
  profiles
}: CashRunDialogProps): React.JSX.Element | null {
  const { session, close } = cash;
  const [loops, setLoops] = useState<string[] | null>(null);
  const [offered, setOffered] = useState<CashRunToken[] | null>(null);
  const [loop, setLoop] = useState('');
  const [coins, setCoins] = useState<Denomination[]>([...DENOMINATIONS]);
  const [tokens, setTokens] = useState<number[]>([]);
  const [full, setFull] = useState<CashRunFull>('heavy');
  const [refused, setRefused] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (session === null) return;
    let current = true;
    setRefused(null);
    setTokens([]);
    void Promise.all([api.listLoops(session), api.cashRunTokens(session)]).then(
      ([listed, carried]) => {
        if (!current) return;
        const names = listed.map((entry) => entry.name);
        setLoops(names);
        setLoop((chosen) => (names.includes(chosen) ? chosen : (names[0] ?? '')));
        setOffered(carried);
        window.requestAnimationFrame(() => first.current?.focus());
      }
    );
    return () => {
      current = false;
    };
  }, [api, session]);

  if (session === null) return null;
  const name = profiles.find((profile) => profile.id === session)?.name ?? session;
  const ready = loop.length > 0 && coins.length > 0 && tokens.length > 0;
  const start = (): void => {
    void api.startCashRun(session, { loop, coins, tokens, full }).then((why) => {
      if (why === null) close();
      else setRefused(why);
    });
  };
  const toggleToken = (item: number): void =>
    setTokens((picked) =>
      picked.includes(item) ? picked.filter((each) => each !== item) : [...picked, item]
    );

  return (
    <div className="palette-scrim" role="presentation">
      <div
        aria-labelledby="cash-run-title"
        aria-modal="true"
        className="surface reset-prompt"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          close();
        }}
        role="dialog"
      >
        <h2 id="cash-run-title">{t('cashRun.title', { name })}</h2>
        <label className="card-settings-field">
          <span>{t('cashRun.loop')}</span>
          <select
            disabled={loops === null || loops.length === 0}
            onChange={(event) => setLoop(event.target.value)}
            ref={first}
            value={loop}
          >
            {(loops ?? []).map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </select>
        </label>
        {loops !== null && loops.length === 0 && (
          <p className="settings-warn">{t('cashRun.noLoops')}</p>
        )}
        <div className="card-settings-field">
          <span>{t('cashRun.coins')}</span>
          <div className="chip-row">
            {DENOMINATIONS.map((coin) => {
              const on = coins.includes(coin);
              return (
                <button
                  aria-pressed={on}
                  className="chip pick"
                  key={coin}
                  onClick={() =>
                    setCoins(
                      on
                        ? coins.filter((each) => each !== coin)
                        : DENOMINATIONS.filter((each) => each === coin || coins.includes(each))
                    )
                  }
                  onMouseDown={keepFocus}
                  type="button"
                >
                  {coin}
                </button>
              );
            })}
          </div>
        </div>
        <div className="card-settings-field">
          <span>{t('cashRun.tokens')}</span>
          {offered !== null && offered.length === 0 && (
            <p className="settings-warn">{t('cashRun.noTokens')}</p>
          )}
          <div className="chip-row">
            {(offered ?? []).map((token) => {
              const at = tokens.indexOf(token.item);
              return (
                <button
                  aria-pressed={at >= 0}
                  className="chip pick"
                  key={token.item}
                  onClick={() => toggleToken(token.item)}
                  onMouseDown={keepFocus}
                  title={
                    token.fare === null
                      ? t('cashRun.tokenFree', { lands: token.lands })
                      : t('cashRun.tokenFare', {
                          lands: token.lands,
                          fare: token.fare.toLocaleString()
                        })
                  }
                  type="button"
                >
                  {at >= 0
                    ? t('cashRun.tokenOrder', { order: at + 1, token: token.name })
                    : token.name}
                </button>
              );
            })}
          </div>
        </div>
        <div className="card-settings-field">
          <span>{t('cashRun.full')}</span>
          <div className="chip-row">
            {CASH_RUN_FULL.map((grade) => (
              <button
                aria-pressed={full === grade}
                className="chip pick"
                key={grade}
                onClick={() => setFull(grade)}
                onMouseDown={keepFocus}
                type="button"
              >
                {grade === 'medium' ? t('cashRun.fullMedium') : t('cashRun.fullHeavy')}
              </button>
            ))}
          </div>
        </div>
        <p className="settings-note">{t('cashRun.whatHappens')}</p>
        {refused !== null && <p className="settings-warn">{refused}</p>}
        <div className="reset-actions">
          <button className="quiet" onClick={close} onMouseDown={keepFocus} type="button">
            {t('cashRun.cancel')}
          </button>
          <button disabled={!ready} onClick={start} onMouseDown={keepFocus} type="button">
            {t('cashRun.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
