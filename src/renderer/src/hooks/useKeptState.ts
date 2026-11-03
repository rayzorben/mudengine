/**
 * `useState` whose value is kept in a character's slot (`lib/sessionMemory`),
 * so a card drawn again for that character opens on what it was left holding.
 *
 * Read when the slot is first seen and written after each commit. A slot that
 * changes under a live instance is read afresh before anything is written,
 * so one character's value is never written into another's slot.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { Kept } from '../lib/sessionMemory';

export function useKeptState<T>(slot: Kept<T>, fresh: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => slot.read() ?? fresh);
  const [owner, setOwner] = useState(slot);
  if (owner !== slot) {
    setOwner(slot);
    setValue(slot.read() ?? fresh);
  }
  useEffect(() => {
    if (owner === slot) slot.keep(value);
  }, [owner, slot, value]);
  return [value, setValue];
}
