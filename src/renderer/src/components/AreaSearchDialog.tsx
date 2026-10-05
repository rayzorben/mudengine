import { useEffect, useRef, useState } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { AreaSearchState } from '../hooks/useAreaSearch';
import type { AreaSearchPreview } from '@shared/areaSearch';
import type { IpcApi, ProfileSummary } from '@shared/ipc';

export interface AreaSearchDialogProps {
  api: Pick<IpcApi, 'previewAreaSearch' | 'searchArea'>;
  area: AreaSearchState;
  /** For the name of the character the dialog was opened for. */
  profiles: readonly Pick<ProfileSummary, 'id' | 'name'>[];
}

/**
 * Search the area: how many steps out from where the character stands, and
 * how many times each room is searched. What that walks is asked of main as
 * the steps change (`AreaSearch.preview`), so the rooms, the walking and the
 * rooms left out are on the dialog before anything is sent. Starting it hands
 * the character to `AreaSearch`; the toolbar's stop ends it.
 */
export default function AreaSearchDialog({
  api,
  area,
  profiles
}: AreaSearchDialogProps): React.JSX.Element | null {
  const { session, figures, choose, close } = area;
  const [preview, setPreview] = useState<AreaSearchPreview | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const radius = figures?.radius ?? null;

  useEffect(() => {
    if (session === null) return;
    const id = window.requestAnimationFrame(() => first.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [session]);

  useEffect(() => {
    if (session === null) return;
    let current = true;
    setRefused(null);
    void api.previewAreaSearch(session, radius).then((answer) => {
      if (current) setPreview(answer);
    });
    return () => {
      current = false;
    };
  }, [api, session, radius]);

  if (session === null) return null;
  const chosen = figures ?? {
    radius: preview?.firstRadius ?? 1,
    searches: preview?.firstSearches ?? 1
  };
  const plan = preview?.plan ?? null;
  const found = plan !== null && !('refused' in plan) ? plan : null;
  const name = profiles.find((profile) => profile.id === session)?.name ?? session;
  const start = (): void => {
    void api.searchArea(session, chosen.radius, chosen.searches).then((why) => {
      if (why === null) close();
      else setRefused(why);
    });
  };
  const leftOut =
    found === null
      ? []
      : [
          {
            id: 'lose',
            rooms: found.lose,
            say: (rooms: string) => t('areaSearch.leftLose', { rooms })
          },
          {
            id: 'unread',
            rooms: found.unread,
            say: (rooms: string) => t('areaSearch.leftUnread', { rooms })
          },
          {
            id: 'behind',
            rooms: found.behind,
            say: (rooms: string) => t('areaSearch.leftBehind', { rooms })
          },
          {
            id: 'stranded',
            rooms: found.stranded,
            say: (rooms: string) => t('areaSearch.leftStranded', { rooms })
          }
        ].filter((each) => each.rooms.length > 0);

  return (
    <div className="palette-scrim" role="presentation">
      <div
        aria-labelledby="area-search-title"
        aria-modal="true"
        className="surface reset-prompt"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          close();
        }}
        role="dialog"
      >
        <h2 id="area-search-title">{t('areaSearch.title', { name })}</h2>
        <label className="card-settings-field">
          <span>{t('areaSearch.radius', { steps: chosen.radius })}</span>
          <input
            disabled={preview === null}
            max={preview?.maxRadius ?? chosen.radius}
            min={1}
            onChange={(event) => choose({ ...chosen, radius: Number(event.target.value) })}
            ref={first}
            type="range"
            value={chosen.radius}
          />
        </label>
        <label className="card-settings-field">
          <span>
            {chosen.searches === 1
              ? t('areaSearch.searches.one')
              : t('areaSearch.searches.many', { searches: chosen.searches })}
          </span>
          <input
            disabled={preview === null}
            max={preview?.maxSearches ?? chosen.searches}
            min={1}
            onChange={(event) => choose({ ...chosen, searches: Number(event.target.value) })}
            type="range"
            value={chosen.searches}
          />
        </label>
        <p aria-live="polite" className="settings-note">
          {plan === null
            ? t('areaSearch.measuring')
            : found === null
              ? t('areaSearch.none', { why: 'refused' in plan ? plan.refused : '' })
              : t('areaSearch.plan', { rooms: found.rooms, steps: found.steps })}
        </p>
        {leftOut.map(({ id, rooms, say }) => (
          <p className="settings-warn" key={id}>
            {say(rooms.join(', '))}
          </p>
        ))}
        {preview?.combatOff === true && (
          <p className="settings-warn">{t('areaSearch.combatOff')}</p>
        )}
        <p className="settings-note">{t('areaSearch.whatHappens')}</p>
        {refused !== null && <p className="settings-warn">{refused}</p>}
        <div className="reset-actions">
          <button className="quiet" onClick={close} onMouseDown={keepFocus} type="button">
            {t('areaSearch.cancel')}
          </button>
          <button
            disabled={found === null || found.rooms === 0}
            onClick={start}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('areaSearch.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
