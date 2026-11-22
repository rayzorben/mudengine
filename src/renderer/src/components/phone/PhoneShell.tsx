/**
 * The phone shell: the interface a small touch window shows in place of the
 * desktop layout. Five tabs (Terminal, Chat, Pack, Loops, Map) under a
 * vitals header, a floating tab capsule, and a command capsule on the two
 * tabs that talk to the game. The consoles stay mounted under it, as under the
 * game view, so no session is reopened and the size sent to the server holds.
 *
 * With a keyboard up the shell is the height still visible, the tab capsule
 * is gone and the header is one line: the command field rests on the keys.
 * Every command goes through the same `input` the console's keys do.
 */
import { memo, useCallback, useState } from 'react';

import type { FoundRoom } from '@shared/destinations';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { MapLoader } from '@shared/map';
import type { WorldRoom } from '@shared/world';
import type { LoopsModalState } from '../../hooks/useLoopsModal';
import { useKeyboardHeight } from '../../hooks/useKeyboardHeight';
import type { SessionView } from '../../hooks/useSessionViews';
import { t } from '../../lib/i18n';
import type { LoopChoice, LoopDestination } from '../../lib/loops';
import { walkTo } from '../../lib/walkTo';
import { PHONE_TABS, type PhoneTab } from '../../lib/phone';
import { PackBody } from '../game/PackPanel';
import PhoneChat from './PhoneChat';
import PhoneDock from './PhoneDock';
import PhoneHeader from './PhoneHeader';
import PhoneLoops from './PhoneLoops';
import PhoneMap from './PhoneMap';
import PhoneTerminal from './PhoneTerminal';

export interface PhoneShellProps {
  api: Pick<IpcApi, 'input' | 'stopMoving' | 'routeTo' | 'walkRoute'>;
  session: SessionId;
  view: SessionView;
  loops: Pick<LoopsModalState, 'rows' | 'loading' | 'load'>;
  chooseLoop(choice: LoopChoice, destination: LoopDestination): void;
  loadMap: MapLoader;
  searchRooms(query: string): Promise<FoundRoom[]>;
  /** The route panel, on a room a walk cannot start on its own. */
  openRouteOn(room: WorldRoom, search: null): void;
}

const TAB_ICONS: Record<PhoneTab, string> = {
  terminal: '⌨',
  chat: '💬',
  pack: '🎒',
  loops: '↻',
  map: '⌖'
};

function PhoneShell({
  api,
  session,
  view,
  loops,
  chooseLoop,
  loadMap,
  searchRooms,
  openRouteOn
}: PhoneShellProps) {
  const [tab, setTab] = useState<PhoneTab>('terminal');
  const keyboard = useKeyboardHeight();
  const send = useCallback((line: string) => void api.input(session, `${line}\r`), [api, session]);
  const stop = useCallback(() => void api.stopMoving(session), [api, session]);
  const goTo = useCallback(
    (room: WorldRoom) => walkTo(room, { api, session, openRouteOn }),
    [api, session, openRouteOn]
  );
  const toTerminal = useCallback(() => setTab('terminal'), []);
  const { character } = view;
  return (
    <div
      className="phone-shell"
      data-keyboard={keyboard.up ? 'up' : undefined}
      data-tab={tab}
      style={{ height: keyboard.height }}
    >
      <PhoneHeader character={character} compact={keyboard.up} />
      <main className="phone-page">
        {tab === 'terminal' && <PhoneTerminal lines={view.lines} />}
        {tab === 'chat' && <PhoneChat self={character.name} talk={view.talk} />}
        {tab === 'pack' && (
          <div className="phone-pack">
            <PackBody character={character} />
          </div>
        )}
        {tab === 'loops' && (
          <PhoneLoops
            choose={chooseLoop}
            load={loops.load}
            loading={loops.loading}
            progress={view.loop}
            rows={loops.rows}
            stop={stop}
          />
        )}
        {tab === 'map' && (
          <PhoneMap
            character={character}
            goTo={goTo}
            load={loadMap}
            onChosen={toTerminal}
            search={searchRooms}
            step={send}
          />
        )}
      </main>
      {(tab === 'terminal' || tab === 'chat') && <PhoneDock send={send} talking={tab === 'chat'} />}
      {!keyboard.up && (
        <nav aria-label={t('phone.nav.aria')} className="phone-nav phone-glass">
          {PHONE_TABS.map((one) => (
            <button
              aria-current={one === tab ? 'page' : undefined}
              key={one}
              onClick={() => setTab(one)}
              type="button"
            >
              <span aria-hidden="true">{TAB_ICONS[one]}</span>
              {one === tab && <span>{TAB_LABELS[one]}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

const TAB_LABELS: Record<PhoneTab, string> = {
  terminal: t('phone.tab.terminal'),
  chat: t('phone.tab.chat'),
  pack: t('phone.tab.pack'),
  loops: t('phone.tab.loops'),
  map: t('phone.tab.map')
};

export default memo(PhoneShell);
