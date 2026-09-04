import Icon, { type IconName } from './Icon';
import Popup, { type MenuAnchor } from './Popup';

export interface MenuItem {
  label: string;
  run(): void;
  /**
   * The glyph in front of the label.
   *
   * Required rather than optional. A menu where some rows carry one and some do
   * not is worse than a menu with none: the labels stop starting in the same
   * column, and the straight edge the eye was running down is the thing that
   * made the icons worth adding.
   */
  icon: IconName;
  /** Costs something, and says so: closing a character, not copying text. */
  danger?: boolean;
  /**
   * Offered, but not available right now — Copy with nothing selected.
   *
   * The rule elsewhere is that an entry which does nothing is worse than one
   * that is not offered, and that still holds for an entry that would never
   * work: the tab menu omits "Edit" for a character with no file. This is the
   * other case. Copy is available *most* of the time, and a menu whose entries
   * come and go is one nobody can learn the shape of — so it stays, greyed,
   * which also answers "why did nothing happen" before it is asked.
   */
  disabled?: boolean;
}

export interface PopupMenuProps {
  at: MenuAnchor;
  items: MenuItem[];
  onDismiss(): void;
}

/**
 * A popup menu: a tab's kebab, the terminal's right-click, a card's copy menu.
 *
 * Everything about *being* a popup — the portal, the measure-then-clamp, the
 * focus latch, Escape, the click-away and the scroll rule — is `Popup`, which
 * the card settings panel comes out of too. What is left here is what makes a
 * menu a menu: a row per action, each with its glyph.
 */
export default function PopupMenu({ at, items, onDismiss }: PopupMenuProps) {
  return (
    <Popup at={at} className="popup-menu" onDismiss={onDismiss} role="menu">
      {items.map((item, index) => (
        <button
          className="entry"
          data-danger={item.danger === true ? 'true' : undefined}
          disabled={item.disabled === true}
          // Keyed by position, not label: two entries may share a word, and the
          // list is fixed for the life of the menu, so the index is its identity.
          key={index}
          onClick={item.run}
          role="menuitem"
          type="button"
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
    </Popup>
  );
}
