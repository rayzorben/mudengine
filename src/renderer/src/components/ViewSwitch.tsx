import { memo } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface ViewSwitchProps {
  /** Whether the game view is the one shown; the button offers the other. */
  game: boolean;
  onToggle(): void;
  /** The chrome it sits in: `chip` on the rail head, `gv-chip` on the player bar. */
  className: string;
}

/**
 * The button between the game view and the classic one (todo 04), the same
 * switch as the palette's `game-view`. A press never takes the caret: the view
 * that comes up places it (`useGameView`).
 */
function ViewSwitch({ game, onToggle, className }: ViewSwitchProps) {
  const label = game ? t('palette.view.classicViewLabel') : t('palette.view.gameViewLabel');
  return (
    <button
      aria-label={label}
      className={className}
      data-action="switch-view"
      onClick={onToggle}
      onMouseDown={keepFocus}
      title={label}
      type="button"
    >
      <Icon name={game ? 'columns' : 'route'} />
      <span>{label}</span>
    </button>
  );
}

export default memo(ViewSwitch);
