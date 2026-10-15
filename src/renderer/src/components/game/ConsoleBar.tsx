/**
 * The game view console's title bar (todo 140): where it docks when open, how
 * opaque its ground is, and that Esc goes back to the map. Shut, a badge on
 * the thumbnail says a click or `i` opens it. Both sit over the console's own
 * box, which `useGameView` places through `.app`'s properties.
 */
import { memo } from 'react';

import { GAME_DOCKS } from '@shared/gameMap';
import { dockLabel } from '../../lib/gameDock';
import type { GameViewState } from '../../hooks/useGameView';
import { t } from '../../lib/i18n';

type ConsoleBarProps = Pick<GameViewState, 'open' | 'dock' | 'setDock' | 'opacity' | 'setOpacity'>;

function ConsoleBar({ open, dock, setDock, opacity, setOpacity }: ConsoleBarProps) {
  if (!open)
    return (
      <div aria-hidden="true" className="gv-console-badge">
        {t('game.console.badge')} <span>{t('game.console.badgeHint')}</span>
      </div>
    );
  return (
    <div className="gv-console-bar" data-owns-keys="true">
      <b>{t('game.console.title')}</b>
      <div aria-label={t('game.console.dockAria')} className="gv-segments" role="group">
        {GAME_DOCKS.map((one) => (
          <button aria-pressed={one === dock} key={one} onClick={() => setDock(one)} type="button">
            {dockLabel(one)}
          </button>
        ))}
      </div>
      <label>
        {t('game.console.opacity')}
        <input
          max={100}
          min={20}
          onChange={(event) => setOpacity(Number(event.currentTarget.value))}
          step={5}
          type="range"
          value={opacity}
        />
      </label>
      <span className="gv-grow" />
      <span>
        <kbd>esc</kbd> {t('game.console.back')}
      </span>
    </div>
  );
}

export default memo(ConsoleBar);
