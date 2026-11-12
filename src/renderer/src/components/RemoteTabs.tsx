/**
 * Sharing with you on the tab rail (todo 20261031-1156-01): each character
 * another player shares with this install, below its own characters and apart
 * from them, drawn as a tab is (health, level, room) from the sharer's sheet.
 * A sharer that gives remote control is pressed like any tab: it opens its
 * console over the pane of the character it is shared with (`via`), or brings
 * that console back if it was set aside, and its close ends the control. One
 * that shares no control is listed and says why it cannot be opened.
 */
import { memo, useEffect, useRef, useState } from 'react';

import HpTrack from './HpTrack';
import Icon from './Icon';
import { PictureBadge } from './CharacterBadge';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { remoteAside } from '../lib/remoteAside';
import type { RemoteCharacter } from '../lib/remoteCharacters';
import { figure, roomOf } from '../lib/sharedSheet';
import type { VitalThresholds } from '@shared/character';
import type { IpcApi, SessionId } from '@shared/ipc';
import { NO_PORTRAIT } from '@shared/portrait';
import { errorMessage } from '@shared/values';

export type RemoteTabsApi = Pick<IpcApi, 'controlOpen' | 'controlClose'>;

export interface RemoteTabsProps {
  api: RemoteTabsApi;
  remotes: readonly RemoteCharacter[];
  /** The panes showing their own console while they control a shared one (`remoteAside`). */
  aside: ReadonlySet<SessionId>;
  active: SessionId;
  stacked: boolean;
  hp: VitalThresholds;
  onSelect(session: SessionId): void;
}

function RemoteTabs({ api, remotes, aside, active, stacked, hp, onSelect }: RemoteTabsProps) {
  // Main's refusal stays under the section until the next press, or until nobody shares.
  const [refused, setRefused] = useState<string | null>(null);
  // Each press counted, so an answer to an earlier one cannot switch the pane after a later one.
  const presses = useRef(0);
  const empty = remotes.length === 0;
  useEffect(() => {
    if (empty) setRefused(null);
  }, [empty]);
  useEffect(
    () => () => {
      presses.current += 1;
    },
    []
  );
  if (empty) return null;

  const reveal = (via: SessionId): void => {
    remoteAside.set(via, false);
    onSelect(via);
  };
  const open = (remote: RemoteCharacter): void => {
    presses.current += 1;
    const press = presses.current;
    setRefused(null);
    if (remote.controlled) return reveal(remote.via);
    const answered = (refusal: string | null): void => {
      if (press !== presses.current) return;
      if (refusal === null) reveal(remote.via);
      else setRefused(refusal);
    };
    api
      .controlOpen(remote.via, remote.name)
      .then(answered, (error: unknown) => answered(errorMessage(error)));
  };
  const close = (remote: RemoteCharacter): void => {
    api.controlClose(remote.via).catch((error: unknown) => setRefused(errorMessage(error)));
  };

  return (
    <>
      <div className="remote-tabs-head" role="presentation">
        <Icon name="terminal" size={12} />
        {stacked && <span>{t('cards.players.shared.heading')}</span>}
      </div>
      {remotes.map((remote) => {
        const { name, sheet, control } = remote;
        const isActive = remote.controlled && remote.via === active && !aside.has(remote.via);
        const title = control
          ? t('tabs.shared.openTooltip', { name, via: remote.viaName })
          : t('tabs.shared.noControlTooltip', { name });
        return (
          <div
            aria-disabled={control ? undefined : true}
            aria-selected={isActive}
            className="tab remote-tab"
            data-active={isActive ? 'true' : 'false'}
            data-control={control ? 'true' : 'false'}
            data-remote-tab={name}
            key={remote.id}
            onClick={control ? () => open(remote) : undefined}
            onKeyDown={(event) => {
              if (!control || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              open(remote);
            }}
            onMouseDown={keepFocus}
            role="tab"
            tabIndex={control ? 0 : -1}
            title={title}
          >
            {stacked && (
              <PictureBadge
                className={sheet.className}
                name={name}
                portrait={NO_PORTRAIT}
                race={null}
              />
            )}
            <span className="who">
              <span className="name">{name}</span>
              {sheet.inCombat === true && (
                <span className="mark" data-level="info">
                  {t('tabs.tab.markFighting')}
                </span>
              )}
              <span className="on">{t('tabs.shared.via', { name: remote.viaName })}</span>
            </span>
            <span className="tab-controls">
              <HpTrack
                figures={stacked}
                hp={sheet.vitals?.hp ?? null}
                hpMax={sheet.vitals?.hpMax ?? null}
                thresholds={hp}
              />
              {stacked && (
                <span className="figures">
                  {t('cards.gang.levelShort', { level: figure(sheet.level) })}
                </span>
              )}
              {remote.controlled && (
                <button
                  aria-label={t('tabs.shared.closeAria', { name })}
                  className="close"
                  onClick={(event) => {
                    // Kept from the tab, so ending control leaves the pane as it is.
                    event.stopPropagation();
                    close(remote);
                  }}
                  onMouseDown={keepFocus}
                  title={t('tabs.shared.closeAria', { name })}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              )}
            </span>
            {stacked && <span className="where">{roomOf(sheet)}</span>}
          </div>
        );
      })}
      {refused !== null && (
        <p className="remote-tabs-refused settings-warn" role="status">
          {refused}
        </p>
      )}
    </>
  );
}

export default memo(RemoteTabs);
