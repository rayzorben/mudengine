/**
 * The game view's switch and its console (todo 140): which interface the
 * window shows, where the console docks, how see-through it is, and whether it
 * is open.
 *
 * One interface or the other. The consoles never move: the game view restyles
 * the same `.terminal-stack` through the attributes and properties `appProps`
 * puts on `.app`, so no xterm is remounted. Shut, the console is its docked
 * self scaled down (`dockGeometry`), so the size sent over NAWS holds.
 *
 * Focus: in the game view it settles on the view's own command layer (`home`),
 * and the console has it only while open; Esc in the console shuts it, and a
 * click on the thumbnail opens it (user, 2026-10-14).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from 'react';

import { isGameDock, type GameDock } from '@shared/gameMap';
import type { GameViewConfig } from '@shared/gameViewConfig';
import type { TerminalPalette } from '@shared/themes';
import { dockGeometry } from '../lib/gameDock';
import { readStored, writeStored } from '../lib/storage';
import { useOverridablePreference } from './usePreference';

export type ViewMode = 'classic' | 'game';

const VIEW_KEY = 'mudengine.view';
/** How many frames the view waits for a console to draw before giving up on its cell. */
const SETTLE_FRAMES = 240;
const DOCK_KEY = 'mudengine.gameView.dock';
const OPACITY_KEY = 'mudengine.gameView.opacity';

/** The opacity as a whole percentage string, for the overridable preference. */
const isPercent = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{1,3}$/.test(value) &&
  Number(value) >= 20 &&
  Number(value) <= 100;

/** The console cell's width, untransformed, so a scaled thumbnail measures the same. */
function cellWidth(): number | null {
  const screen = document.querySelector<HTMLElement>(
    '.terminal-layer[data-shown="true"] .xterm-screen'
  );
  const cols = Number(screen?.closest<HTMLElement>('.xterm')?.dataset['cols']);
  if (!screen || !(cols > 0) || screen.offsetWidth === 0) return null;
  return screen.offsetWidth / cols;
}

export interface GameViewState {
  on: boolean;
  toggle(): void;
  dock: GameDock;
  setDock(dock: GameDock): void;
  /** 20 to 100. */
  opacity: number;
  setOpacity(percent: number): void;
  open: boolean;
  openConsole(): void;
  shutConsole(): void;
  /** The command layer's element; focus settles here while the console is shut. */
  home: RefObject<HTMLDivElement>;
  /** Puts focus on the command layer; false when the classic view or an open console has it. */
  takeFocus(): boolean;
  /** The console's palette as the view wants it: see-through over the map in the game view. */
  paint(palette: TerminalPalette): TerminalPalette;
  /** The attributes and properties `.app` wears. */
  appProps: { 'data-view'?: 'game'; 'data-console'?: 'open' | 'shut'; style?: CSSProperties };
}

/** The console's ground in the game view: none, so the map shows through the `--console-opacity` behind it. */
const SEE_THROUGH = 'transparent';

export function useGameView(
  configured: GameViewConfig,
  shownConsole: () => { focus(): void } | null,
  /** The shown console's columns as last reported: a refit is when its cell can be measured. */
  columns: number
): GameViewState {
  const focusConsole = useCallback(() => shownConsole()?.focus(), [shownConsole]);
  const [mode, setMode] = useState<ViewMode>(() =>
    readStored(
      VIEW_KEY,
      (stored) => (stored === 'game' ? 'game' : 'classic'),
      () => 'classic'
    )
  );
  const on = mode === 'game';
  const [dock, setDock] = useOverridablePreference(DOCK_KEY, configured.dock, isGameDock);
  const [percent, choosePercent] = useOverridablePreference(
    OPACITY_KEY,
    String(Math.round(configured.opacity * 100)),
    isPercent
  );
  const [open, setOpen] = useState(false);
  const home = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [cell, setCell] = useState<number | null>(null);

  const toggle = useCallback(() => {
    setMode((was) => {
      const next = was === 'game' ? 'classic' : 'game';
      writeStored(VIEW_KEY, next);
      return next;
    });
    setOpen(false);
  }, []);

  const openConsole = useCallback(() => {
    setOpen(true);
    window.requestAnimationFrame(focusConsole);
  }, [focusConsole]);
  const shutConsole = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => home.current?.focus());
  }, []);
  const takeFocus = useCallback((): boolean => {
    if (!on || open || !home.current) return false;
    home.current.focus();
    return true;
  }, [on, open]);

  // Into the game view, the command layer has the caret; out of it, the console.
  useEffect(() => {
    window.requestAnimationFrame(() => (on ? home.current?.focus() : focusConsole()));
  }, [on, focusConsole]);

  useEffect(() => {
    if (!on) return;
    const observer = new ResizeObserver(() => setCell(cellWidth()));
    let frame = 0;
    let tries = 0;
    /*
     * The console draws after the view comes up, so its cell is read each frame
     * until it has (at most `SETTLE_FRAMES`), then its screen is watched: a
     * refit or a font change moves the cell, and a dock move refits.
     */
    const settle = (): void => {
      const measured = cellWidth();
      setCell(measured);
      if (measured === null && tries < SETTLE_FRAMES) {
        tries += 1;
        frame = window.requestAnimationFrame(settle);
        return;
      }
      for (const screen of document.querySelectorAll('.terminal-layer .xterm-screen'))
        observer.observe(screen);
    };
    const measure = (): void => setBox({ width: window.innerWidth, height: window.innerHeight });
    measure();
    settle();
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [on, columns]);

  // A shut console never holds the caret: whatever hands it focus (a load, a
  // reconnect, a closing dialog), it settles on the command layer instead.
  useEffect(() => {
    if (!on || open) return;
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Element && event.target.closest('.terminal-cell'))
        home.current?.focus();
    };
    window.addEventListener('focusin', onFocus, true);
    if (document.activeElement?.closest('.terminal-cell')) home.current?.focus();
    return () => window.removeEventListener('focusin', onFocus, true);
  }, [on, open]);

  useEffect(() => {
    if (!on) return;
    // Esc in the open console shuts it: the key goes back to the map, not to the realm.
    const onKey = (event: KeyboardEvent): void => {
      if (!open || event.key !== 'Escape') return;
      if (!(event.target instanceof Element) || !event.target.closest('.terminal-cell')) return;
      event.preventDefault();
      event.stopPropagation();
      shutConsole();
    };
    // A press on the shut thumbnail opens it.
    const onPress = (event: PointerEvent): void => {
      if (open || !(event.target instanceof Element) || !event.target.closest('.terminal-stack'))
        return;
      event.preventDefault();
      openConsole();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPress, true);
    };
  }, [on, open, openConsole, shutConsole]);

  // One painted palette per palette, so the console is handed the same object until either changes.
  const painted = useRef(new WeakMap<TerminalPalette, TerminalPalette>());
  const paint = useCallback(
    (palette: TerminalPalette): TerminalPalette => {
      if (!on) return palette;
      const kept = painted.current.get(palette);
      if (kept) return kept;
      const made = { ...palette, background: SEE_THROUGH };
      painted.current.set(palette, made);
      return made;
    },
    [on]
  );

  const opacity = Number(percent);
  const setOpacity = useCallback((next: number) => choosePercent(String(next)), [choosePercent]);
  const appProps = useMemo((): GameViewState['appProps'] => {
    if (!on) return {};
    const geometry = dockGeometry(dock, box.width, box.height, cell);
    const shown = open ? geometry.open : geometry.thumb;
    return {
      'data-view': 'game',
      'data-console': open ? 'open' : 'shut',
      style: {
        '--console-left': `${shown.left}px`,
        '--console-top': `${shown.top}px`,
        '--console-width': `${shown.width}px`,
        '--console-height': `${shown.height}px`,
        '--console-fit-width': `${geometry.console.width}px`,
        '--console-fit-height': `${geometry.console.height}px`,
        '--console-scale': open ? 1 : geometry.scale,
        '--console-opacity': opacity / 100
      } as CSSProperties
    };
  }, [on, open, dock, box, cell, opacity]);

  return useMemo(
    () => ({
      on,
      toggle,
      dock,
      setDock,
      opacity,
      setOpacity,
      open,
      openConsole,
      shutConsole,
      home,
      takeFocus,
      paint,
      appProps
    }),
    [
      on,
      toggle,
      dock,
      setDock,
      opacity,
      setOpacity,
      open,
      openConsole,
      shutConsole,
      takeFocus,
      paint,
      appProps
    ]
  );
}
