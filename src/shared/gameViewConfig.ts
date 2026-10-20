/**
 * The game view's settings (todo 140): the console's dock and opacity, an
 * options-file block of its own, and the two HUD thresholds its steppers move.
 * Beside `config.ts` rather than in it, which composes them into `AppConfig`.
 */
import { isGameDock, type GameDock } from './gameMap';
import { bool, fraction, isRecord } from './values';

/**
 * The game view's console (todo 140): where it docks when opened, and how
 * much of the map shows through it. The window's own picks, made on the
 * console's title bar, outrank these until the file changes.
 */
export interface GameViewConfig {
  dock: GameDock;
  /** How opaque the console's ground is, 0.2 to 1. */
  opacity: number;
  /**
   * How much bigger the arena grows in a fight, one of `COMBAT_ZOOMS`: 0 is off
   * (the default), 0.1 to 0.9 grows it that share (todo 20261019-1358-01).
   */
  combatZoom: number;
  /** Whether the tutorial opens the first time the game view comes up in a launch. */
  tutorial: boolean;
}

/** The combat zooms offered: off, then 10% to 90% bigger in tenths. */
export const COMBAT_ZOOMS: readonly number[] = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** The largest of them. */
export const COMBAT_ZOOM_MOST = Math.max(...COMBAT_ZOOMS);

/** The offered zoom nearest a figure, so a hand-written 0.33 reads as 0.3 and 2 as 0.9. */
export function asCombatZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_GAME_VIEW.combatZoom;
  return COMBAT_ZOOMS.reduce((best, one) =>
    Math.abs(one - value) < Math.abs(best - value) ? one : best
  );
}

/** The least the console's ground may be: below it the text is lost in the map. */
export const GAME_VIEW_OPACITY_FLOOR = 0.2;

export function normalizeGameView(raw: unknown): GameViewConfig {
  const block = isRecord(raw) ? raw : {};
  return {
    dock: isGameDock(block['dock']) ? block['dock'] : DEFAULT_GAME_VIEW.dock,
    opacity: Math.max(
      GAME_VIEW_OPACITY_FLOOR,
      fraction(block['opacity'], DEFAULT_GAME_VIEW.opacity)
    ),
    combatZoom: asCombatZoom(block['combatZoom']),
    tutorial: bool(block['tutorial'], DEFAULT_GAME_VIEW.tutorial)
  };
}

export const DEFAULT_GAME_VIEW: GameViewConfig = {
  dock: 'bottom',
  opacity: 0.55,
  combatZoom: 0,
  tutorial: true
};

/**
 * The two thresholds the game view steps from its HUD (todo 140), by their
 * path under `automation`: Run below this share of health, Rest below this.
 * Both are fractions of maximum health.
 */
export const HUD_THRESHOLDS = {
  run: ['safety', 'retreat', 'belowHealth'],
  rest: ['health', 'restBelow']
} as const satisfies Record<string, readonly string[]>;

export type HudThreshold = keyof typeof HUD_THRESHOLDS;

/** A threshold's name off the wire, or null. */
export function asHudThreshold(value: unknown): HudThreshold | null {
  return typeof value === 'string' && Object.hasOwn(HUD_THRESHOLDS, value)
    ? (value as HudThreshold)
    : null;
}
