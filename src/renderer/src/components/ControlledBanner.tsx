/**
 * The banner over a character's console while another player controls it
 * (todo 20261031-1156-01), with Stop, which ends their control at once and
 * keeps it ended until the player turns Allow Remote Control off and on.
 */
import { memo } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface ControlledBannerProps {
  /** The players controlling the character; nothing is drawn for none. */
  by: readonly string[];
  onStop(): void;
}

function ControlledBanner({ by, onStop }: ControlledBannerProps) {
  if (by.length === 0) return null;
  return (
    <section
      aria-label={t('remote.controlledAria')}
      className="quest-banner peer-banner"
      data-status="stopped"
      role="status"
    >
      <div className="quest-banner-head">
        <Icon name="terminal" size={14} />
        <span className="quest-banner-title">
          {t('remote.controlledBy', { name: by.join(', ') })}
        </span>
        <button
          className="quest-plan-btn quest-banner-stop"
          onClick={onStop}
          onMouseDown={keepFocus}
          title={t('remote.stopControlTitle')}
          type="button"
        >
          {t('remote.stopControl')}
        </button>
      </div>
    </section>
  );
}

export default memo(ControlledBanner);
