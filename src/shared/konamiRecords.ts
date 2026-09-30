/**
 * What the planner keeps and writes down: each decision whole (todo 56), the
 * death and stuck logs (57, 58), and what the Konami card is shown (59).
 */
import type { KonamiAsk, KonamiPlan, KonamiTrigger } from './konami';
import type { KonamiBrief } from './konamiBrief';

/** What became of a decision. `applied` until one of the others lands. */
export type KonamiOutcome = 'applied' | 'done' | 'refused' | 'replaced' | 'failed';

/** One ask of the provider, whole: what was sent, what came back, what was made of it. */
export interface KonamiDecision {
  id: string;
  at: number;
  trigger: KonamiTrigger;
  provider: string;
  model: string | null;
  brief: KonamiBrief;
  questions: KonamiAsk['questions'];
  /** The reply as the provider sent it, before it was parsed. */
  raw: unknown;
  plan: KonamiPlan | null;
  /** Why no plan came of it: no reply, a reply that did not answer, a timeout. */
  refusal: string | null;
  outcome: KonamiOutcome;
  outcomeWhy: string | null;
  settledAt: number | null;
}

export type KonamiIncidentKind = 'death' | 'stuck';

/**
 * Where the planner's records go: the decision log and the incident folders.
 * An interface so the planner does no file handling of its own; the session
 * layer knows where the character's directory is.
 */
export interface KonamiRecords {
  /** Appends one line of JSON to the decision log. */
  journal(line: string): void;
  /** Writes one folder of files; the folder's path, or null where it could not be written. */
  incident(
    kind: KonamiIncidentKind,
    at: number,
    files: Readonly<Record<string, string>>
  ): string | null;
  /** The newest `lines` lines the session printed, colour codes removed. */
  recentLines(lines: number): string;
}

/** One blow on the character, as the death log lists it. */
export interface KonamiBlow {
  at: number;
  /** Who landed it, where the line names one; null for a trap or a spell nobody cast. */
  from: string | null;
  damage: number;
  text: string;
}

/** A decision as the card lists it. */
export interface KonamiDecisionRow {
  id: string;
  at: number;
  trigger: KonamiTrigger;
  plan: KonamiPlan | null;
  refusal: string | null;
  outcome: KonamiOutcome;
  outcomeWhy: string | null;
}

export interface KonamiIncidentRow {
  kind: KonamiIncidentKind;
  at: number;
  path: string | null;
}

/** What the Konami card is shown. */
export interface KonamiSnapshot {
  /** `automation.superKonamiMode`. */
  on: boolean;
  paused: boolean;
  /** The provider's name once loaded, else null with `refusal` saying why. */
  provider: string | null;
  asking: boolean;
  /** Waiting to be asked, and why, until the character is free. */
  pending: KonamiTrigger | null;
  refusal: string | null;
  plan: KonamiPlan | null;
  /** Newest first. */
  decisions: KonamiDecisionRow[];
  incidents: KonamiIncidentRow[];
}

export const EMPTY_KONAMI: KonamiSnapshot = {
  on: false,
  paused: false,
  provider: null,
  asking: false,
  pending: null,
  refusal: null,
  plan: null,
  decisions: [],
  incidents: []
};
