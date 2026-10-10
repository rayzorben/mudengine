import { useEffect, useState } from 'react';

import type { QuestRunProgress } from '@shared/quests';
import { errorMessage } from '@shared/values';

/**
 * The Run it press for one step, as the plan's head and a quest tile both draw
 * it. Main refuses out loud with a sentence (the switch is off, a route is
 * walking), and it is drawn beside the button because the person is looking
 * at the button. Cleared by the next press and by the run starting.
 */
export function useRunPress(
  onRun: ((block: number) => Promise<string | null>) | null,
  target: number | null,
  run: QuestRunProgress | null
): {
  refused: string | null;
  starting: boolean;
  /** This step's run is the one main carries, under way or ended. */
  mine: boolean;
  running: boolean;
  press(): void;
} {
  const [refused, setRefused] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const mine = target !== null && run !== null && run.block === target && run.status !== 'idle';
  const running = mine && run?.status === 'running';
  useEffect(() => {
    if (running) setRefused(null);
  }, [running]);
  const press = (): void => {
    if (onRun === null || target === null || starting) return;
    setStarting(true);
    setRefused(null);
    void onRun(target)
      .then((answer) => setRefused(answer))
      .catch((error: unknown) => setRefused(errorMessage(error)))
      .finally(() => setStarting(false));
  };
  return { refused, starting, mine, running, press };
}
