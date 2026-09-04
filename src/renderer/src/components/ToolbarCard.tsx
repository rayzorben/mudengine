import { useRef, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import Icon from './Icon';
import PopupMenu from './PopupMenu';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { toolbarButtons, type ToolbarButton, type ToolbarSubject } from '../lib/toolbar';

export interface ToolbarCardProps extends CardChrome {
  subject: ToolbarSubject;
  /**
   * Which buttons are on the row, and the control that moves one on or off.
   *
   * `pinnedButtons`, not `pinned`: `CardChrome.pinned` already means *this
   * float stays in view whichever character is shown*, and two different
   * pins on one component is how a control ends up wired to the wrong one.
   */
  pinnedButtons: ReadonlySet<string>;
  onPinButton(id: string): void;
}

/**
 * One row of glyphs: what this character is doing on its own, and the dial.
 *
 * A card like every other — it can sit on the rail, be dragged over the
 * console or be docked in a strip — but it ships **docked above the console**,
 * where a toolbar belongs and where it costs one row rather than a rail slot.
 * The strips overlay the console rather than taking rows from it, so a toolbar
 * appearing does not resize the terminal, which would go out over NAWS.
 *
 * ## Every button is a toggle, and the state is the character's own file
 *
 * Pressing a switch writes one boolean into that character's YAML through
 * `SettingsEditor`, comments intact, and the config store's poll brings it
 * back half a second later — the path the Gang card's permission grid already
 * takes. There is no second, session-scoped copy of "is auto-combat on": two
 * places that can answer the same question eventually disagree, and the one
 * somebody reads is whichever is wrong.
 *
 * That also means a toolbar press survives a restart, which for the master
 * switch is the whole point: somebody who turned automation off before going
 * to bed did not mean *until the next launch*.
 *
 * ## The row is curated, and the kebab is where
 *
 * There are more buttons than a row, so the row is what somebody keeps to hand
 * and the `...` at the end is the rest — every button there is, with a check
 * against the ones on the row. `internal.yaml` states the row a fresh client
 * draws; a click deviates from it, remembered per client.
 *
 * The order is fixed whether or not a button is pinned, so unpinning one never
 * moves another out from under the pointer.
 */
export default function ToolbarCard({
  subject,
  pinnedButtons,
  onPinButton,
  ...chrome
}: ToolbarCardProps) {
  const all = toolbarButtons(subject);
  const shown = all.filter((button) => pinnedButtons.has(button.id));
  const kebab = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);

  return (
    <BentoCard {...chrome} className="toolbar-card" title={t('cards.toolbar.title')}>
      <div className="toolbar-row" role="toolbar" aria-label={t('cards.toolbar.title')}>
        {shown.length === 0 ? (
          /*
           * A row somebody has emptied says so and says how to undo it — the
           * same rule a narrowed table follows. Without this the toolbar is a
           * blank strip with a kebab on the end and nothing to say it is not
           * broken.
           */
          <span className="empty">{t('cards.toolbar.emptyRow')}</span>
        ) : (
          shown.map((button) => <ToolbarKey button={button} key={button.id} />)
        )}
        <button
          aria-expanded={menu}
          aria-haspopup="menu"
          className="toolbar-key toolbar-more"
          onClick={() => setMenu((open) => !open)}
          onMouseDown={keepFocus}
          ref={kebab}
          title={t('cards.toolbar.pickButtons')}
          type="button"
        >
          <Icon name="more" />
          <span className="sr-only">{t('cards.toolbar.pickButtons')}</span>
        </button>
      </div>

      {menu && kebab.current && (
        <PopupMenu
          at={kebab.current}
          items={all.map((button) => ({
            /*
             * The pin state is in the *label* rather than in a separate
             * control, because this menu has one job. The palette's rows are
             * commands with a pin at the end; here the row **is** the pin.
             */
            label: pinnedButtons.has(button.id)
              ? t('cards.toolbar.unpin', { label: button.label })
              : t('cards.toolbar.pin', { label: button.label }),
            icon: button.icon,
            run: () => onPinButton(button.id)
          }))}
          onDismiss={() => {
            setMenu(false);
            chrome.returnFocus?.();
          }}
        />
      )}
    </BentoCard>
  );
}

/**
 * One square glyph.
 *
 * `aria-pressed` rather than a class alone: the lit state is the whole message
 * of this control, and somebody who cannot see the tone still has to be told
 * whether their character is fighting on its own. The transport buttons are
 * not toggles and say so by carrying no pressed state.
 */
function ToolbarKey({ button }: { button: ToolbarButton }) {
  const toggle = button.id !== 'loop:stop' && button.id !== 'walk:stop';
  return (
    <button
      aria-pressed={toggle ? button.on : undefined}
      className={`toolbar-key${button.on ? ' on' : ''}`}
      disabled={button.disabled === true}
      onClick={button.run}
      // Clicked, never typed into: refusing the mouse's attempt to park the
      // caret leaves the keyboard in the game, where a player needs it.
      onMouseDown={keepFocus}
      title={button.label}
      type="button"
    >
      <Icon name={button.icon} />
      <span className="sr-only">{button.label}</span>
    </button>
  );
}
