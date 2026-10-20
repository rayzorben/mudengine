/**
 * The game view's tutorial: six pages over the map, each a picture and a few
 * lines, with "Show this tutorial on startup" at the foot (`useGameTutorial`
 * decides when it opens). The arrow keys and Enter turn the pages; Esc or ×
 * closes it. It holds the caret while open and keeps its keys from the
 * command layer, so a letter read here is never sent to the realm.
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { CLIENT_KEYS } from '@shared/keys';
import type { GameTutorial as Tutorial } from '../../hooks/useGameTutorial';
import { GAME_KEYS } from '../../lib/gameCommands';
import { t } from '../../lib/i18n';
import { clientChord } from '../../lib/platform';
import { progressAt } from '../../lib/progression';
import TutorialScenes, { type TutorialScene } from './TutorialScenes';

const PAGES: ReadonlyArray<{ scene: TutorialScene; title: string; body: string; aside?: string }> =
  [
    {
      scene: 'map',
      title: t('game.tutorial.map.title'),
      body: t('game.tutorial.map.body'),
      aside: t('game.tutorial.map.viewSwitch')
    },
    { scene: 'keys', title: t('game.tutorial.keys.title'), body: t('game.tutorial.keys.body') },
    {
      scene: 'moving',
      title: t('game.tutorial.moving.title'),
      body: t('game.tutorial.moving.body')
    },
    {
      scene: 'console',
      title: t('game.tutorial.console.title'),
      body: t('game.tutorial.console.body')
    },
    {
      scene: 'panels',
      title: t('game.tutorial.panels.title'),
      body: t('game.tutorial.panels.body')
    },
    { scene: 'fight', title: t('game.tutorial.fight.title'), body: t('game.tutorial.fight.body') }
  ];

function GameTutorial({
  tutorial,
  onClosed
}: {
  tutorial: Tutorial;
  /** After it closes: the caret goes back to the command layer. */
  onClosed(): void;
}) {
  const [at, setAt] = useState(0);
  const home = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = home.current;
    dialog?.focus();
    // The view puts the caret on its command layer a frame after it comes up; it stays here.
    const keep = (event: FocusEvent): void => {
      if (dialog && event.target instanceof Element && !dialog.contains(event.target))
        if (event.target.closest('.gv-root')) dialog.focus();
    };
    window.addEventListener('focusin', keep, true);
    return () => window.removeEventListener('focusin', keep, true);
  }, []);
  const last = at === PAGES.length - 1;
  const page = PAGES[at]!;
  const close = (): void => {
    tutorial.close();
    onClosed();
  };
  const turn = (by: number): void =>
    setAt((was) => Math.max(0, Math.min(PAGES.length - 1, was + by)));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // Nothing read here reaches the command layer under it.
    event.stopPropagation();
    if (event.target instanceof HTMLInputElement && event.key === ' ') return;
    switch (event.key) {
      case GAME_KEYS.back:
        event.preventDefault();
        close();
        return;
      case 'ArrowRight':
        event.preventDefault();
        turn(1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        turn(-1);
        return;
      case GAME_KEYS.console:
        // A focused button answers Enter itself.
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        if (last) close();
        else turn(1);
        return;
      default:
        return;
    }
  };

  return (
    <div className="gvt-scrim" data-owns-keys="true">
      <div
        aria-label={t('game.tutorial.aria')}
        aria-modal="true"
        className="gv-glass gvt-dialog"
        onKeyDown={onKeyDown}
        ref={home}
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-label={t('game.tutorial.close')}
          className="gv-icon-button gv-panel-close"
          onClick={close}
          type="button"
        >
          ×
        </button>
        <TutorialScenes key={page.scene} scene={page.scene} />
        <div className="gvt-words" key={`${page.scene}-words`}>
          <h3>{page.title}</h3>
          <p>{page.body}</p>
          {page.aside === undefined ? null : <p className="gv-quiet">{page.aside}</p>}
        </div>
        <div className="gvt-nav">
          <div
            aria-label={t('game.tutorial.page', { page: at + 1, count: PAGES.length })}
            className="gvt-steps"
            role="group"
          >
            {PAGES.map((one, index) => (
              <button
                aria-current={index === at ? 'step' : undefined}
                aria-label={t('game.tutorial.page', { page: index + 1, count: PAGES.length })}
                data-progress={progressAt(index, at)}
                key={one.scene}
                onClick={() => setAt(index)}
                type="button"
              />
            ))}
          </div>
          <span className="gv-grow" />
          <button className="gvt-button" disabled={at === 0} onClick={() => turn(-1)} type="button">
            {t('game.tutorial.back')}
          </button>
          <button
            className="gvt-button"
            data-primary="true"
            onClick={() => (last ? close() : turn(1))}
            type="button"
          >
            {last ? t('game.tutorial.done') : t('game.tutorial.next')}
          </button>
        </div>
        <footer className="gvt-foot">
          <label className="gvt-check">
            <input
              checked={tutorial.onStartup}
              onChange={(event) => tutorial.setOnStartup(event.currentTarget.checked)}
              type="checkbox"
            />
            {t('game.tutorial.onStartup')}
          </label>
          <span className="gv-quiet">
            <kbd>{GAME_KEYS.help}</kbd> {t('game.tutorial.reopen')} ·{' '}
            <kbd>{clientChord(CLIENT_KEYS.palette)}</kbd> {t('game.tutorial.palette')}
          </span>
        </footer>
      </div>
    </div>
  );
}

export default memo(GameTutorial);
