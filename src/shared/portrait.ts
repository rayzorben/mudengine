/**
 * A character's portrait from the art server (todo 20261019-0931-01): the
 * facts a request carries, what comes back, the port main draws through, and
 * what the character panel is told. The facts are the game's own words only:
 * the server refuses anything else, and takes no prompt text.
 */
import type { LookStat } from './lookBands';

export interface PortraitGear {
  /** The slot as the listing printed it: `Weapon Hand`. */
  slot: string;
  item: string;
}

/** Field names as the art server takes them; `class` is the server's word. */
export type PortraitFacts = {
  race: string;
  class: string;
  gender?: string;
  hair?: string;
  eyes?: string;
  gear: PortraitGear[];
} & Record<LookStat, string>;

export type PortraitResult =
  | { kind: 'picture'; bytes: Uint8Array; type: 'image/webp' | 'image/png' }
  /** The server said no to these facts, and why: a word it does not know. */
  | { kind: 'refused'; reason: string }
  /**
   * No answer, a broken one, the server down, or one of its limits for now (a 429 or a full
   * queue): asked again on the next entry. The reason is ours or its.
   */
  | { kind: 'unreachable'; reason: string }
  /** This build carries no build secret, so it cannot register. */
  | { kind: 'unavailable' };

/** What main draws portraits through; a fake server answers it in tests. */
export interface PortraitSource {
  portraitOf(facts: PortraitFacts, cancelled: () => boolean): Promise<PortraitResult>;
}

/** Why the panel shows what it shows. */
export type PortraitStatus =
  | { kind: 'drawn' }
  /** `art.enabled` is off. */
  | { kind: 'off' }
  | { kind: 'unavailable' }
  /** Race, class, stats, gear or the look at this character not read yet. */
  | { kind: 'incomplete' }
  /** Asked, and the server is drawing it. */
  | { kind: 'waiting' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable'; reason: string };

/** The last portrait drawn for this character (a `data:` URL) and why it is what it is. */
export interface PortraitView {
  picture: string | null;
  status: PortraitStatus;
}

/** What changed: the status, and the picture only when it is new. */
export type PortraitChange = { status: PortraitStatus; picture?: string | null };

/** The view after a change. */
export function withChange(view: PortraitView, change: PortraitChange): PortraitView {
  return {
    picture: change.picture === undefined ? view.picture : change.picture,
    status: change.status
  };
}

export const NO_PORTRAIT: PortraitView = { picture: null, status: { kind: 'incomplete' } };
