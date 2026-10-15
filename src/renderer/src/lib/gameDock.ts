/**
 * Where the game view's console sits (todo 140): docked bottom, left, right or
 * floating when opened, and a live thumbnail in the corner when shut.
 *
 * The thumbnail is the docked console scaled down, never resized, so the size
 * that goes out over NAWS is the docked one in both states, and a dock is never
 * narrower than 80 columns while the window allows it. Pure, so the suite holds
 * both; the pixels are the prototype's, agreed with the user on 2026-10-14.
 */
import type { GameDock } from '@shared/gameMap';
import { t } from './i18n';

/** The columns a dock keeps while the window has room for them. */
export const DOCK_MIN_COLUMNS = 80;
/** The xterm's own padding either side of its grid, in px. */
export const DOCK_PADDING = 24;
/** The console's title bar, above it when open, in px. */
export const DOCK_BAR = 38;
/** The thumbnail's box, in px. */
export const THUMB = { width: 400, height: 190, right: 20, bottom: 22 } as const;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockGeometry {
  /** The open console's box, title bar included. */
  open: Box;
  /** The console's own size in both states: what the terminal is fitted to. */
  console: { width: number; height: number };
  /** The shut thumbnail's box. */
  thumb: Box;
  /** How much the thumbnail scales the console: about 80 columns across its width. */
  scale: number;
}

/**
 * The dock's boxes for a window of `width` by `height` px, with a console cell
 * `cell` px wide (null before a console has drawn).
 */
export function dockGeometry(
  dock: GameDock,
  width: number,
  height: number,
  cell: number | null
): DockGeometry {
  const gutter = 16;
  const top = 70;
  const fullWidth = Math.max(0, width - gutter * 2);
  const least = cell === null ? 0 : Math.ceil(DOCK_MIN_COLUMNS * cell + DOCK_PADDING);
  const fit = (wanted: number): number => Math.min(fullWidth, Math.max(least, wanted));
  let open: Box;
  switch (dock) {
    case 'bottom': {
      const tall = Math.round(Math.min(height * 0.4, 420));
      open = { left: gutter, top: height - gutter - tall, width: fullWidth, height: tall };
      break;
    }
    case 'left':
    case 'right': {
      const wide = fit(Math.round(Math.min(560, width * 0.42)));
      open = {
        left: dock === 'left' ? gutter : width - gutter - wide,
        top,
        width: wide,
        height: Math.max(0, height - top - gutter)
      };
      break;
    }
    case 'float': {
      const wide = fit(Math.round(Math.min(1040, width - 40)));
      const tall = Math.round(Math.min(height * 0.62, 620));
      open = {
        left: Math.round((width - wide) / 2),
        top: height - 96 - tall,
        width: wide,
        height: tall
      };
      break;
    }
    default: {
      const never: never = dock;
      return never;
    }
  }
  const console = { width: open.width, height: Math.max(0, open.height - DOCK_BAR) };
  const thumb = {
    left: width - THUMB.right - THUMB.width,
    top: height - THUMB.bottom - THUMB.height,
    width: THUMB.width,
    height: THUMB.height
  };
  const across = cell === null ? console.width : DOCK_MIN_COLUMNS * cell + DOCK_PADDING;
  const scale = Math.min(0.75, Math.max(0.3, THUMB.width / Math.max(1, across)));
  return { open, console, thumb, scale };
}

/** What each dock is called, on the console's bar and the settings page. */
export function dockLabel(dock: GameDock): string {
  switch (dock) {
    case 'bottom':
      return t('game.console.bottom');
    case 'float':
      return t('game.console.float');
    case 'left':
      return t('game.console.left');
    case 'right':
      return t('game.console.right');
    default: {
      const never: never = dock;
      return never;
    }
  }
}
