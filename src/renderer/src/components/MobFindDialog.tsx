import { useEffect, useRef, useState } from 'react';

import { clockText } from '../lib/clockText';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';
import type { MobFindState } from '../hooks/useMobFind';
import type { IpcApi, ProfileSummary } from '@shared/ipc';
import type { MobFindPreview } from '@shared/mobFind';

export interface MobFindDialogProps {
  api: Pick<IpcApi, 'previewMobFind' | 'findMob'>;
  find: MobFindState;
  /** For the name of the character the dialog was opened for. */
  profiles: readonly Pick<ProfileSummary, 'id' | 'name'>[];
}

/**
 * Find a monster: its name, typed or carried in from a palette row. What the
 * find would walk is asked of main as the name changes (`MobFinder.preview`),
 * paced as the room search is, so the lairs, the walking and the rooms left
 * out are on the dialog before anything is sent. Starting it hands the
 * character to `MobFinder`; Stop ends it.
 */
export default function MobFindDialog({
  api,
  find,
  profiles
}: MobFindDialogProps): React.JSX.Element | null {
  const { session, close } = find;
  const [name, setName] = useState(find.name);
  const [preview, setPreview] = useState<MobFindPreview | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (session === null) return;
    setName(find.name);
    setRefused(null);
    const id = window.requestAnimationFrame(() => first.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [session, find.name]);

  useEffect(() => {
    if (session === null) return;
    const asked = name.trim();
    if (asked.length < tuning().roomSearchMinChars) {
      setPreview(null);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      void api.previewMobFind(session, asked).then((answer) => {
        if (current) setPreview(answer);
      });
    }, tuning().roomSearchDebounceMs);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, session, name]);

  if (session === null) return null;
  const found = preview !== null && !('refused' in preview) ? preview : null;
  const who = profiles.find((profile) => profile.id === session)?.name ?? session;
  const start = (): void => {
    void api.findMob(session, name.trim()).then((why) => {
      if (why === null) close();
      else setRefused(why);
    });
  };

  return (
    <div className="palette-scrim" role="presentation">
      <div
        aria-labelledby="mob-find-title"
        aria-modal="true"
        className="surface reset-prompt"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && found !== null) {
            event.preventDefault();
            start();
            return;
          }
          if (event.key !== 'Escape') return;
          event.preventDefault();
          close();
        }}
        role="dialog"
      >
        <h2 id="mob-find-title">{t('mobFind.title', { name: who })}</h2>
        <label className="card-settings-field">
          <span>{t('mobFind.monster')}</span>
          <input
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            placeholder={t('mobFind.placeholder')}
            ref={first}
            spellCheck={false}
            type="text"
            value={name}
          />
        </label>
        <p aria-live="polite" className="settings-note">
          {name.trim().length < tuning().roomSearchMinChars
            ? t('mobFind.typeOne')
            : preview === null
              ? t('mobFind.measuring')
              : found === null
                ? t('mobFind.none', { why: 'refused' in preview ? preview.refused : '' })
                : t('mobFind.plan', {
                    mob: found.mob,
                    clock: clockText(found.regenHours * 3600),
                    rooms: found.rooms.length,
                    steps: found.steps
                  })}
        </p>
        {found !== null && (
          <p className="settings-note">{t('mobFind.rooms', { rooms: found.rooms.join(', ') })}</p>
        )}
        {found !== null && found.unreached.length > 0 && (
          <p className="settings-warn">
            {t('mobFind.unreached', { rooms: found.unreached.join(', ') })}
          </p>
        )}
        {found?.combatOff === true && <p className="settings-warn">{t('mobFind.combatOff')}</p>}
        <p className="settings-note">{t('mobFind.whatHappens')}</p>
        {refused !== null && <p className="settings-warn">{refused}</p>}
        <div className="reset-actions">
          <button className="quiet" onClick={close} onMouseDown={keepFocus} type="button">
            {t('mobFind.cancel')}
          </button>
          <button disabled={found === null} onClick={start} onMouseDown={keepFocus} type="button">
            {t('mobFind.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
