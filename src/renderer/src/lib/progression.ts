/**
 * The progression's three words (`mudengine-ui` › *What is left is the
 * loudest thing*): where a step stands against the one in hand.
 */
export type Progress = 'done' | 'now' | 'left';

export function progressAt(index: number, at: number): Progress {
  return index < at ? 'done' : index === at ? 'now' : 'left';
}
