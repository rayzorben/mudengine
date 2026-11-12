/**
 * Sharing with you on the tab rail (todo 20261031-1156-01): the characters
 * other players share with this install, below its own and apart from them.
 * One opened is a session of this client's like any other (`RemoteSessions`
 * in main), so its row is that session's tab: pressed it shows the character,
 * every card and the console its own, and its close ends the control. One
 * not opened yet is drawn from its sharer's sheet; pressed it is opened and
 * then shown, and one that gives no control is listed and says why it cannot
 * be.
 */
import { memo, useEffect, useRef, useState } from 'react';

import { PictureBadge } from './CharacterBadge';
import HpTrack from './HpTrack';
import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { openedAs, type RemoteCharacter } from '../lib/remoteCharacters';
import { figure, roomOf } from '../lib/sharedSheet';
import type { CharacterState, VitalThresholds } from '@shared/character';
import type { IpcApi, SessionId, SessionSummary } from '@shared/ipc';
import { remoteSessionId } from '@shared/peerRelay';
import { NO_PORTRAIT } from '@shared/portrait';
import { errorMessage } from '@shared/values';

export type RemoteTabsApi = Pick<IpcApi, 'controlOpen'>;

export interface RemoteTabsProps {
  api: RemoteTabsApi;
  /** The sharers, from their sheets. */
  sharers: readonly RemoteCharacter[];
  /** The roster's controlled characters (`SessionSummary.remote`). */
  opened: readonly SessionSummary[];
  /** Each session's state, as the rail holds it. */
  views: Readonly<Record<SessionId, { readonly character: CharacterState } | undefined>>;
  active: SessionId;
  stacked: boolean;
  hp: VitalThresholds;
  onSelect(session: SessionId): void;
  onClose(session: SessionId): void;
}

/** One row as the rail draws it, from a session's state or a sharer's sheet. */
interface Row {
  readonly key: string;
  readonly name: string;
  readonly viaName: string;
  readonly className: string | null;
  readonly race: string | null;
  readonly hp: number | null;
  readonly hpMax: number | null;
  readonly level: number | null;
  readonly room: string;
  readonly fighting: boolean;
  /** The session it is, once opened. */
  readonly session: SessionId | null;
  readonly control: boolean;
  readonly sharer: RemoteCharacter | null;
}

function openedRow(summary: SessionSummary, character: CharacterState | undefined): Row {
  return {
    key: summary.id,
    name: summary.name,
    viaName: summary.remote?.viaName ?? '',
    className: character?.className ?? null,
    race: character?.race ?? null,
    hp: character?.vitals.hp ?? null,
    hpMax: character?.vitals.hpMax ?? null,
    level: character?.progress.level ?? null,
    room: character?.room.name ?? t('cards.players.shared.roomUnknown'),
    fighting: character?.inCombat === true,
    session: summary.id,
    control: true,
    sharer: null
  };
}

function sharerRow(sharer: RemoteCharacter): Row {
  const { sheet } = sharer;
  return {
    key: sharer.id,
    name: sharer.name,
    viaName: sharer.viaName,
    className: sheet.className,
    race: null,
    hp: sheet.vitals?.hp ?? null,
    hpMax: sheet.vitals?.hpMax ?? null,
    level: sheet.level,
    room: roomOf(sheet),
    fighting: sheet.inCombat === true,
    session: null,
    control: sharer.control,
    sharer
  };
}

function RemoteTabs({
  api,
  sharers,
  opened,
  views,
  active,
  stacked,
  hp,
  onSelect,
  onClose
}: RemoteTabsProps) {
  // Main's refusal stays under the section until the next press, or until the list changes.
  const [refused, setRefused] = useState<string | null>(null);
  // The session asked for, shown once the roster carries it.
  const [awaited, setAwaited] = useState<SessionId | null>(null);
  // Each press counted, so an answer to an earlier one cannot switch the pane after a later one.
  const presses = useRef(0);
  const rows = [
    ...opened.map((summary) => openedRow(summary, views[summary.id]?.character)),
    ...sharers.filter((each) => openedAs(opened, each.name) === undefined).map(sharerRow)
  ];
  const empty = rows.length === 0;
  // A refusal is about the list as it was: once anybody comes, goes or is opened, it no longer holds.
  const listed = rows.map((row) => `${row.key}:${row.control ? 1 : 0}`).join('\n');
  useEffect(() => setRefused(null), [listed]);
  useEffect(() => {
    if (awaited === null || !opened.some((each) => each.id === awaited)) return;
    setAwaited(null);
    onSelect(awaited);
  }, [awaited, opened, onSelect]);
  useEffect(
    () => () => {
      presses.current += 1;
    },
    []
  );
  if (empty) return null;

  const press = (row: Row): void => {
    presses.current += 1;
    const asked = presses.current;
    setRefused(null);
    setAwaited(null);
    if (row.session !== null) return onSelect(row.session);
    const sharer = row.sharer;
    if (sharer === null || !sharer.control) return;
    const answered = (refusal: string | null): void => {
      if (asked !== presses.current) return;
      if (refusal === null) setAwaited(remoteSessionId(sharer.via, sharer.name));
      else setRefused(refusal);
    };
    api
      .controlOpen(sharer.via, sharer.name)
      .then(answered, (error: unknown) => answered(errorMessage(error)));
  };

  return (
    <>
      <div className="remote-tabs-head" role="presentation">
        <Icon name="terminal" size={12} />
        {stacked && <span>{t('cards.players.shared.heading')}</span>}
      </div>
      {rows.map((row) => {
        const isActive = row.session !== null && row.session === active;
        const title = row.control
          ? t('tabs.shared.openTooltip', { name: row.name, via: row.viaName })
          : t('tabs.shared.noControlTooltip', { name: row.name });
        return (
          <div
            aria-disabled={row.control ? undefined : true}
            aria-selected={isActive}
            className="tab remote-tab"
            data-accent="violet"
            data-active={isActive ? 'true' : 'false'}
            data-control={row.control ? 'true' : 'false'}
            data-opened={row.session === null ? 'false' : 'true'}
            data-remote-tab={row.name}
            key={row.key}
            onClick={row.control ? () => press(row) : undefined}
            onKeyDown={(event) => {
              if (!row.control || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              press(row);
            }}
            onMouseDown={keepFocus}
            role="tab"
            tabIndex={row.control ? 0 : -1}
            title={title}
          >
            {stacked && (
              <PictureBadge
                className={row.className}
                name={row.name}
                portrait={NO_PORTRAIT}
                race={row.race}
              />
            )}
            <span className="who">
              <span className="name">{row.name}</span>
              {row.fighting && (
                <span className="mark" data-level="info">
                  {t('tabs.tab.markFighting')}
                </span>
              )}
              <span className="on">{t('tabs.shared.via', { name: row.viaName })}</span>
            </span>
            <span className="tab-controls">
              <HpTrack figures={stacked} hp={row.hp} hpMax={row.hpMax} thresholds={hp} />
              {stacked && (
                <span className="figures">
                  {t('cards.gang.levelShort', { level: figure(row.level) })}
                </span>
              )}
              {row.session !== null && (
                <button
                  aria-label={t('tabs.shared.closeAria', { name: row.name })}
                  className="close"
                  onClick={(event) => {
                    // Kept from the tab, so ending control leaves the pane as it is.
                    event.stopPropagation();
                    if (row.session !== null) onClose(row.session);
                  }}
                  onMouseDown={keepFocus}
                  title={t('tabs.shared.closeAria', { name: row.name })}
                  type="button"
                >
                  <Icon name="close" />
                </button>
              )}
            </span>
            {stacked && <span className="where">{row.room}</span>}
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
