import { memo, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';

import Icon from './Icon';
import { keepFocus } from '../lib/focus';
import { helpSections } from '../lib/help';
import { t } from '../lib/i18n';

export interface HelpScreenProps {
  onClose(): void;
}

/**
 * The help page (todo 75), in the box every dialog over the console is drawn
 * in, under the home browser's head and with its rules: it holds the caret
 * while it is up, Escape or a click on the scrim puts it away, and the closer
 * hands the caret back to the console.
 */
function HelpScreen({ onClose }: HelpScreenProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  // Built once per opening: the words are fixed for the build.
  const sections = useMemo(helpSections, []);

  useEffect(() => {
    frame.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose} role="presentation">
      <div
        aria-label={t('help.ariaLabel')}
        aria-modal="true"
        className="surface palette help-screen"
        data-help
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={frame}
        role="dialog"
        tabIndex={-1}
      >
        <header className="home-browser-head">
          <span className="home-browser-title">{t('help.ariaLabel')}</span>
          <button
            className="quiet"
            onClick={onClose}
            onMouseDown={keepFocus}
            title={t('help.close')}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="help-body">
          {sections.map((section) => (
            <section data-help-section={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.paragraphs.map((text) => (
                <p key={text}>{text}</p>
              ))}
              {section.rows.length > 0 && (
                <dl>
                  {section.rows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.text}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(HelpScreen);
