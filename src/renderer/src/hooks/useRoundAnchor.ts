/**
 * The ring round the arena's beat on this window's clock (todo 154), held here
 * so an automation push that restates the same beat leaves `WorldCanvas`'s
 * props as they were and the map is not drawn again. Shown only while a fight
 * or a walk is going: the hand turns on a clock, which the game view keeps to
 * the moments the rounds decide something (`mudengine-ui` › parts/game.md).
 */
import { useEffect, useState } from 'react';

import type { RoundTiming } from '@shared/roundTiming';
import { anchorOf, type RoundAnchor } from '../lib/gameRounds';

export function useRoundAnchor(rounds: RoundTiming | null, going: boolean): RoundAnchor | null {
  const [anchor, setAnchor] = useState<RoundAnchor | null>(null);
  useEffect(() => setAnchor((held) => anchorOf(held, rounds, Date.now())), [rounds]);
  return going ? anchor : null;
}
