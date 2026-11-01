/**
 * A track filled to a share of its whole, as a CSS width: the Gear card's
 * budget and spend meters and the pack's load bar. Empty where the whole is
 * nothing, and never past the end.
 */
import { share } from '@shared/tally';

export function widthOf(part: number, whole: number): string {
  return `${Math.min(100, (share(part, whole) ?? 0) * 100)}%`;
}
