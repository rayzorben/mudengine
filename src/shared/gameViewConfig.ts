/**
 * The game view's settings (todo 140): the console's dock and opacity, an
 * options-file block of its own, and the two HUD thresholds its steppers move.
 * Beside `config.ts` rather than in it, which composes them into `AppConfig`.
 */
import { isGameDock, type GameDock } from './gameMap';
import { fraction, isRecord } from './values';

/**
 * The game view's console (todo 140): where it docks when opened, and how
 * much of the map shows through it. The window's own picks, made on the
 * console's title bar, outrank these until the file changes.
 */
export interface GameViewConfig {
  dock: GameDock;
  /** How opaque the console's ground is, 0.2 to 1. */
  opacity: number;
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
    )
  };
}

export const DEFAULT_GAME_VIEW: GameViewConfig = { dock: 'bottom', opacity: 0.55 };

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
