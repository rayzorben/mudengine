import { t } from '../lib/i18n';
import { ownAlignment, type CharacterState } from '@shared/character';
import { attacksOnSight } from '@shared/mobs';
import type { RowPeace } from '@shared/mobRules';
import { rowPeaceIn, type RoomVerdict } from '@shared/verdict';
import { mobKey } from '@shared/world';

/** The chip's word for each claim a row can make; a `Record`, so a new claim must be worded. */
const PEACE_CHIP: Record<RowPeace, () => string> = {
  friend: () => t('cards.room.occupant.rowFriendChip'),
  'not-hostile': () => t('cards.room.occupant.rowNotHostileChip')
};

/**
 * The character's own row saying a monster does not attack first (todo 818),
 * drawn beside the realm's disposition rather than instead of it: the Room
 * card's `hostile` chip stays the realm's, and this says the automation is
 * following the row, and where the two disagree. Nothing where no row claims.
 * Names are matched by `mobKey`, since the fight and the room may spell one
 * monster differently.
 */
export default function RowPeaceChip({
  name,
  character,
  verdict
}: {
  name: string;
  character: CharacterState;
  verdict: RoomVerdict;
}): React.JSX.Element | null {
  const peace = rowPeaceIn(verdict, name);
  if (peace === null) return null;
  const key = mobKey(name);
  const who = character.room.occupants.find((occupant) => mobKey(occupant.name) === key);
  const realmHostile =
    who !== undefined && attacksOnSight(who.disposition, ownAlignment(character)) === true;
  return (
    <span
      className="chip quiet"
      title={
        realmHostile
          ? t('cards.room.occupant.rowOverRealm', { target: name })
          : t('cards.room.occupant.rowSays', { target: name })
      }
    >
      {PEACE_CHIP[peace]()}
    </span>
  );
}
