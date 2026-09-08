import { useEffect, useRef } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { CharacterIdentity, ResetSignal } from '@shared/reset';
import type { ResetNotice } from '@shared/ipc';

export interface ResetPromptProps {
  /** What was noticed, and both characters. Null while nothing has been. */
  notice: ResetNotice | null;
  /** The name on the tab, which is the one thing that did not change. */
  characterName: string;
  /** Throws the old character's records away. */
  onForget(): void;
  /** Leaves them alone. Not asked again this session either way. */
  onKeep(): void;
}

/** One row of the diff: what it is called, and what each side says. */
function Row({
  label,
  before,
  after,
  changed
}: {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}): React.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd className={changed ? 'reset-was' : 'inert'}>{before}</dd>
      <dd className={changed ? 'reset-now' : 'inert'}>{after}</dd>
    </>
  );
}

function word(value: string | null): string {
  return value ?? '—';
}

function figure(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

/**
 * The client thinks this is not the same character, and is asking.
 *
 * Deleting the only copy of what somebody learned is not a decision to take
 * from a heuristic — the client cannot tell a reset from a realm that
 * renumbered its classes — so this is the whole of what the detection does:
 * show both characters side by side, name what was noticed, and offer two
 * buttons of which one does nothing.
 *
 * **Old on the left, new on the right**, as asked for, and a row is marked only
 * where the two disagree: the unchanged rows are context and must not compete
 * with the ones that are the reason this opened.
 *
 * **Keep is the safe answer and it is the default focus.** A destructive button
 * that has the caret when a dialog opens unasked is one press from a mistake,
 * and this dialog opens unasked by definition.
 */
export default function ResetPrompt({
  notice,
  characterName,
  onForget,
  onKeep
}: ResetPromptProps): React.JSX.Element | null {
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (notice === null) return;
    // After paint, so the surface exists to take it. The safe button, never
    // the destructive one.
    const id = window.requestAnimationFrame(() => keep.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [notice]);

  if (notice === null) return null;
  const { before, after, signals } = notice;
  const changed = new Set<ResetSignal>(signals);

  return (
    <div className="palette-scrim" role="presentation">
      <div
        aria-labelledby="reset-prompt-title"
        aria-modal="true"
        className="surface reset-prompt"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          // Escape is *keep*: the safe answer, which is what an unasked dialog
          // has to mean by a key somebody pressed to make it go away.
          onKeep();
        }}
        role="dialog"
      >
        <h2 id="reset-prompt-title">{t('reset.title', { name: characterName })}</h2>
        <p className="settings-warn">
          {t('reset.noticed', {
            signals: signals.map(signalWord).join(', ')
          })}
        </p>

        <dl className="readout reset-diff">
          <dt className="group" />
          <dd className="group reset-head">{t('reset.wasHeading', { at: whenOf(before) })}</dd>
          <dd className="group reset-head">{t('reset.nowHeading')}</dd>
          <Row
            after={word(after.race)}
            before={word(before.race)}
            changed={changed.has('race')}
            label={t('reset.race')}
          />
          <Row
            after={word(after.className)}
            before={word(before.className)}
            changed={changed.has('class')}
            label={t('reset.class')}
          />
          <Row
            after={figure(after.level)}
            before={figure(before.level)}
            changed={changed.has('level')}
            label={t('reset.level')}
          />
          <Row
            after={figure(after.exp)}
            before={figure(before.exp)}
            changed={changed.has('experience')}
            label={t('reset.exp')}
          />
        </dl>

        <p className="settings-note">{t('reset.whatGoes')}</p>

        <div className="reset-actions">
          <button
            className="quiet"
            onClick={onKeep}
            onMouseDown={keepFocus}
            ref={keep}
            type="button"
          >
            {t('reset.keep')}
          </button>
          <button className="danger" onClick={onForget} onMouseDown={keepFocus} type="button">
            {t('reset.forget')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One sentence per signal, as a switch of **literal** `t()` calls.
 *
 * Not a reason → key map, which is what `Reconnect.standDownNotice` records:
 * `i18n-coverage.test.ts` reads the literal after `t(` out of the source, and a
 * lookup is a dynamic call it fails the build for — rightly.
 */
function signalWord(signal: ResetSignal): string {
  switch (signal) {
    case 'race':
      return t('reset.signal.race');
    case 'class':
      return t('reset.signal.class');
    case 'level':
      return t('reset.signal.level');
    case 'experience':
      return t('reset.signal.experience');
  }
}

/** The record's own clock, so *was* is dated rather than merely earlier. */
function whenOf(identity: CharacterIdentity): string {
  return new Date(identity.at).toLocaleDateString();
}
