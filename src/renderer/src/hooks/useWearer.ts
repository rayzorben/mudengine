/**
 * Who the realm thinks this character is, for deciding what it may wear or
 * use: the pack's wear control and the Room card's floor marks read the same
 * answer (todo 146). `UNKNOWN_WEARER` until asked, and on a failed lookup.
 */
import { useEffect, useState } from 'react';
import { ownAlignment, type CharacterState } from '@shared/character';
import { UNKNOWN_WEARER, type Wearer } from '@shared/gear';

export function useWearer(
  character: CharacterState,
  loadWearer: (() => Promise<Wearer>) | undefined
): Wearer {
  const [wearer, setWearer] = useState<Wearer>(UNKNOWN_WEARER);
  /*
   * Asked when the facts that decide it move, not on every character push.
   * Race, class and level arrive together off the stat sheet and change a
   * handful of times in a session; the character object is replaced on every
   * status line, and keying on the words keeps a fight from asking main the
   * same question several times a second.
   */
  const identity = [
    character.race,
    character.className,
    character.progress.level,
    character.progress.strength,
    ownAlignment(character)
  ]
    .map((part) => part ?? '')
    .join('\u0000');
  useEffect(() => {
    if (!loadWearer) {
      setWearer(UNKNOWN_WEARER);
      return;
    }
    let live = true;
    void loadWearer()
      .then((found) => {
        if (live) setWearer(found);
      })
      .catch((error: unknown) => {
        // Unknown, loudly, and unknown is the answer that refuses nothing.
        if (live) {
          console.error('wearer lookup failed', error);
          setWearer(UNKNOWN_WEARER);
        }
      });
    return () => {
      live = false;
    };
  }, [loadWearer, identity]);
  return wearer;
}
