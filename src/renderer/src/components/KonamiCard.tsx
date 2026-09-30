import { memo, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { clock } from '../lib/clock';
import { t } from '../lib/i18n';
import type { AutomationSnapshot } from '@shared/automation';
import type { CharacterState } from '@shared/character';
import type { SessionId } from '@shared/ipc';

export interface KonamiCardProps extends CardChrome {
  automation: AutomationSnapshot;
  character: CharacterState;
  session?: SessionId;
}

function KonamiCard({ automation, character, session, ...chrome }: KonamiCardProps) {
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({});
  const konami = automation.konami;
  const active = Boolean(konami?.active);
  const paused = Boolean(konami?.paused);

  const togglePayload = (key: string): void => {
    setExpandedPayloads((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const badge = !active ? (
    <span className="chip off">{t('cards.konami.badge.off')}</span>
  ) : paused ? (
    <span className="chip warn">{t('cards.konami.badge.paused')}</span>
  ) : (
    <span className="chip on">{t('cards.konami.badge.active')}</span>
  );

  const title = konami?.providerName || t('cards.konami.title');

  return (
    <BentoCard
      {...chrome}
      badge={badge}
      className="automation-card konami-card"
      scroll
      title={title}
    >
      {!active ? (
        <div className="empty">{t('cards.konami.empty')}</div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              marginBottom: '10px',
              backgroundColor: 'var(--surface-2, rgba(255, 255, 255, 0.05))',
              borderRadius: '6px',
              border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.1))'
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-bright, #fff)' }}>
                {title}
              </div>
              <div style={{ fontSize: '11px', opacity: 0.75, marginTop: '2px' }}>
                {paused
                  ? 'Decisions paused — manual control'
                  : 'Autonomous 24/7 decision pipeline active'}
              </div>
            </div>
            <button
              type="button"
              className={`btn chip ${paused ? 'warn' : 'on'}`}
              style={{
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '12px',
                padding: '4px 12px',
                minWidth: '95px',
                textAlign: 'center'
              }}
              onClick={() => {
                if (session && window.mudengine?.toggleKonamiPause) {
                  void window.mudengine.toggleKonamiPause(session);
                }
              }}
            >
              {konami?.buttonLabel ?? (paused ? 'Resume' : 'Pause')}
            </button>
          </div>

          <div className="trace-heading">{t('cards.konami.headings.objectives')}</div>
          <div
            style={{
              fontSize: '11px',
              padding: '6px 10px',
              marginBottom: '10px',
              background: 'var(--surface-1, rgba(0, 0, 0, 0.2))',
              borderRadius: '4px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px'
            }}
          >
            <div style={{ color: 'var(--text-bright, #eee)' }}>
              🎯 {t('cards.konami.objectives.expGoal')}
            </div>
            <div style={{ color: 'var(--accent-ok, #4ade80)' }}>
              🛡️ {t('cards.konami.objectives.survivalInvariant')}
            </div>
          </div>

          <div className="trace-heading">{t('cards.konami.headings.tactics')}</div>
          <div
            style={{
              fontSize: '11px',
              padding: '6px 10px',
              marginBottom: '10px',
              background: 'var(--surface-1, rgba(0, 0, 0, 0.2))',
              borderRadius: '4px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}
          >
            {konami?.macroDirective && (
              <div>
                <span style={{ opacity: 0.6, marginRight: '6px' }}>Macro Directive:</span>
                <strong style={{ color: 'var(--accent-ok, #4ade80)' }}>
                  {konami.macroDirective}
                </strong>
                {konami?.macroReason && (
                  <div style={{ opacity: 0.75, fontSize: '10px', marginTop: '2px' }}>
                    {konami.macroReason}
                  </div>
                )}
              </div>
            )}

            <div>
              <span style={{ opacity: 0.6, marginRight: '6px' }}>Opener:</span>
              <strong style={{ color: 'var(--accent, #38bdf8)' }}>
                {konami?.nextOpener ?? 'Evaluated per engagement'}
              </strong>
              {konami?.nextOpenerReason && (
                <span style={{ opacity: 0.7, marginLeft: '6px' }}>({konami.nextOpenerReason})</span>
              )}
            </div>

            {konami?.roundTactic && (
              <div>
                <span style={{ opacity: 0.6, marginRight: '6px' }}>Round Tactic:</span>
                <span>{konami.roundTactic}</span>
              </div>
            )}

            {konami?.huntingTarget && (
              <div>
                <span style={{ opacity: 0.6, marginRight: '6px' }}>Target Lair:</span>
                <span style={{ color: 'var(--accent-ok, #4ade80)' }}>{konami.huntingTarget}</span>
              </div>
            )}

            <div>
              <span style={{ opacity: 0.6, marginRight: '6px' }}>Character:</span>
              <span>
                {character.name || 'Soul'} · Lv {character.progress.level}{' '}
                {character.className || 'Priest'} ({character.vitals.hp}/{character.vitals.hpMax} HP)
              </span>
            </div>
          </div>

          <div
            className="trace-heading"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>{t('cards.konami.headings.terminal')}</span>
            <span style={{ fontSize: '10px', opacity: 0.6, textTransform: 'none', fontWeight: 'normal' }}>
              Streaming Live I/O
            </span>
          </div>
          <div
            style={{
              backgroundColor: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: '6px',
              padding: '8px 10px',
              marginBottom: '10px',
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              fontSize: '11px',
              lineHeight: '1.4',
              maxHeight: '300px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px'
            }}
          >
            {!konami?.transactions || konami.transactions.length === 0 ? (
              <div style={{ color: '#8b949e', fontStyle: 'italic', padding: '6px 0' }}>
                Waiting for first autonomous decision transaction...
              </div>
            ) : (
              konami.transactions.map((tx) => (
                <div
                  key={tx.id}
                  style={{
                    borderBottom: '1px solid #21262d',
                    paddingBottom: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span style={{ color: '#8b949e', fontSize: '10px' }}>[{clock(tx.timestamp)}]</span>
                      <span
                        style={{
                          backgroundColor:
                            tx.type === 'macro' ? '#238636' : tx.type === 'opener' ? '#1f6feb' : '#8957e5',
                          color: '#fff',
                          padding: '1px 5px',
                          borderRadius: '3px',
                          fontSize: '9px',
                          fontWeight: 600,
                          textTransform: 'uppercase'
                        }}
                      >
                        {tx.type}
                      </span>
                      {tx.confidence !== undefined && (
                        <span style={{ color: '#58a6ff', fontSize: '10px' }}>
                          {Math.round(tx.confidence * 100)}% conf
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      {tx.feedback === 'correct' ? (
                        <span style={{ color: '#3fb950', fontSize: '10px', fontWeight: 600 }}>
                          ✓ Correct
                        </span>
                      ) : tx.feedback === 'incorrect' ? (
                        <span style={{ color: '#f85149', fontSize: '10px', fontWeight: 600 }}>
                          ✗ Incorrect
                        </span>
                      ) : (
                        session && (
                          <>
                            <button
                              type="button"
                              style={{
                                cursor: 'pointer',
                                background: 'rgba(46, 160, 67, 0.15)',
                                border: '1px solid #2ea043',
                                color: '#3fb950',
                                borderRadius: '3px',
                                padding: '1px 6px',
                                fontSize: '10px'
                              }}
                              onClick={() => {
                                if (window.mudengine?.submitKonamiFeedback) {
                                  void window.mudengine.submitKonamiFeedback(
                                    session,
                                    tx.id,
                                    'correct'
                                  );
                                }
                              }}
                              title="Reinforce decision as correct"
                            >
                              👍 Correct
                            </button>
                            <button
                              type="button"
                              style={{
                                cursor: 'pointer',
                                background: 'rgba(248, 81, 73, 0.15)',
                                border: '1px solid #f85149',
                                color: '#f85149',
                                borderRadius: '3px',
                                padding: '1px 6px',
                                fontSize: '10px'
                              }}
                              onClick={() => {
                                if (window.mudengine?.submitKonamiFeedback) {
                                  void window.mudengine.submitKonamiFeedback(
                                    session,
                                    tx.id,
                                    'incorrect',
                                    'Marked incorrect by player'
                                  );
                                }
                              }}
                              title="Mark incorrect to disallow target and critique future prompts"
                            >
                              👎 Incorrect
                            </button>
                          </>
                        )
                      )}
                    </div>
                  </div>

                  <div style={{ color: '#58a6ff' }}>
                    <span style={{ opacity: 0.7 }}>&gt;&gt;&gt; [REQUEST] </span>
                    <span>{tx.requestSummary}</span>
                    {tx.requestDetail && (
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#8b949e',
                          cursor: 'pointer',
                          fontSize: '10px',
                          marginLeft: '6px',
                          textDecoration: 'underline'
                        }}
                        onClick={() => togglePayload(`${tx.id}-req`)}
                      >
                        {expandedPayloads[`${tx.id}-req`] ? 'hide payload' : 'show payload'}
                      </button>
                    )}
                  </div>
                  {expandedPayloads[`${tx.id}-req`] && tx.requestDetail && (
                    <pre
                      style={{
                        margin: '4px 0',
                        padding: '6px',
                        background: '#161b22',
                        borderRadius: '4px',
                        fontSize: '10px',
                        overflowX: 'auto',
                        color: '#c9d1d9',
                        whiteSpace: 'pre-wrap'
                      }}
                    >
                      {tx.requestDetail}
                    </pre>
                  )}

                  <div style={{ color: '#3fb950' }}>
                    <span style={{ opacity: 0.7 }}>&lt;&lt;&lt; [RESPONSE] </span>
                    <span>{tx.responseSummary}</span>
                    {tx.responseDetail && (
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#8b949e',
                          cursor: 'pointer',
                          fontSize: '10px',
                          marginLeft: '6px',
                          textDecoration: 'underline'
                        }}
                        onClick={() => togglePayload(`${tx.id}-resp`)}
                      >
                        {expandedPayloads[`${tx.id}-resp`] ? 'hide raw' : 'show raw'}
                      </button>
                    )}
                  </div>
                  {expandedPayloads[`${tx.id}-resp`] && tx.responseDetail && (
                    <pre
                      style={{
                        margin: '4px 0',
                        padding: '6px',
                        background: '#161b22',
                        borderRadius: '4px',
                        fontSize: '10px',
                        overflowX: 'auto',
                        color: '#7ee787',
                        whiteSpace: 'pre-wrap'
                      }}
                    >
                      {tx.responseDetail}
                    </pre>
                  )}

                  <div style={{ color: '#d29922' }}>
                    <span style={{ opacity: 0.7 }}>=== [INTERPRETATION] </span>
                    <span>{tx.interpretation}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          {konami?.decisions && konami.decisions.length > 0 && (
            <>
              <div className="trace-heading">{t('cards.konami.headings.trace')}</div>
              <div className="trace">
                {konami.decisions.slice(0, 10).map((d, index) => (
                  <div className="row" key={`${d.timestamp}-${index}`}>
                    <span className="trace-at">{clock(d.timestamp)}</span>
                    <span className="trace-priority" style={{ textTransform: 'uppercase' }}>
                      {d.type}
                    </span>
                    <span className="trace-command">{d.action}</span>
                    <span className="trace-reason">{d.reason ?? ''}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </BentoCard>
  );
}

export default memo(KonamiCard);
