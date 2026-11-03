/**
 * A name as the control that opens its card: the one way a list, a card or a
 * panel prints an item, monster, spell, class, race, player or room. See
 * `mudengine-ui` › *A name is a control everywhere it is printed*.
 */
import type { ReactNode } from 'react';

import type { CharacterState } from '@shared/character';
import type { PlayerRegistry } from '@shared/players';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { isKnownPlayer, PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';

/** The reference panel for a realm name: item, monster, spell, class or race. */
export type Inspect = (name: string, anchor: HTMLElement) => void;

/** Who is a person, and the Player flyout that opens for one. */
export interface PersonOpener {
  players: PlayerRegistry;
  character: Pick<CharacterState, 'online'>;
  onSelect(name: string, anchor: PopoverAnchor): void;
}

/**
 * A known player opens the Player flyout; any other name opens the realm's
 * answer; with neither opener in hand it is text. `children` is what is drawn
 * where it is not the bare name (a count, a label).
 */
export default function EntityName({
  name,
  className,
  inspect,
  person,
  children
}: {
  name: string;
  /** The owning surface's cell class; `lookup` is added to a control. */
  className?: string;
  inspect?: Inspect | null;
  person?: PersonOpener | null;
  children?: ReactNode;
}): React.JSX.Element {
  const cell = className ?? '';
  if (person && isKnownPlayer(person.players, person.character, name)) {
    return <PlayerName className={cell} name={name} onSelect={person.onSelect} />;
  }
  if (!inspect) return <span className={cell || undefined}>{children ?? name}</span>;
  return (
    <button
      className={cell ? `${cell} lookup` : 'lookup'}
      data-entity="realm"
      onClick={(event) => inspect(name, event.currentTarget)}
      onMouseDown={keepFocus}
      title={t('entity.lookupTooltip')}
      type="button"
    >
      {children ?? name}
    </button>
  );
}

/**
 * A room by its `map/room` address, opening its panel: the route panel
 * (`goToRoom`) on a card, the quick view (`peekRoom`) inside one. Text where
 * the address is unknown or the surface cannot open one (a pinned float).
 */
export function RoomName({
  room,
  children,
  className,
  open,
  title
}: {
  room: string | null;
  children: ReactNode;
  className?: string;
  open: ((room: string, at: HTMLElement) => void) | null | undefined;
  /** The hover; null for none where the click opens the quick view, which is its own answer. */
  title?: string | null;
}): React.JSX.Element {
  if (room === null || !open) return <span className={className}>{children}</span>;
  return (
    <button
      className={className ? `${className} lookup` : 'lookup'}
      data-entity="room"
      onClick={(event) => open(room, event.currentTarget)}
      onMouseDown={keepFocus}
      title={title === undefined ? t('entity.goToRoomTooltip', { room }) : (title ?? undefined)}
      type="button"
    >
      {children}
    </button>
  );
}
