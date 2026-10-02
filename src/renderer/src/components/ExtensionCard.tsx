import { memo, useCallback, useEffect, useRef, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { useExtensions } from '../hooks/useExtensions';
import { writeClipboard } from '../lib/clipboard';
import { t } from '../lib/i18n';
import {
  extensionMessage,
  ROOT_ATTRIBUTES,
  rootAttributes,
  themeTokens,
  type ExtensionToCard,
  type CardToExtension
} from '../lib/extensions';
import type { SessionId } from '@shared/ipc';

export interface ExtensionCardProps extends CardChrome {
  session: SessionId;
  /** Each extension's view, by name, as main last published it. */
  views: Readonly<Record<string, unknown>>;
}

/**
 * An extension's card (todo 84): its own page in a sandboxed frame, so none of
 * its interface ships with the client. The page is sent the view its
 * extension publishes and the theme's tokens whenever either moves, and answers with its buttons, which go to main and back. With
 * several extensions installed, a tab row picks whose page is shown.
 */
function ExtensionCard({ session, views, ...chrome }: ExtensionCardProps) {
  const extensions = useExtensions();
  const [shown, setShown] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const current = extensions.find((each) => each.name === shown) ?? extensions[0] ?? null;
  const view = current === null ? null : (views[current.name] ?? null);
  const { returnFocus } = chrome;

  /** The view and the theme, to the page now showing. */
  const send = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (target === null || target === undefined || current === null) return;
    const message: CardToExtension = {
      type: 'mudengine:view',
      session,
      view,
      theme: themeTokens(document.documentElement),
      attributes: rootAttributes(document.documentElement)
    };
    // The page is its own origin and sandboxed; it is addressed by its window.
    target.postMessage(message, '*');
  }, [current, session, view]);

  useEffect(send, [send]);

  // The theme moved: the page is sent its tokens again.
  useEffect(() => {
    const watch = new MutationObserver(send);
    watch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [...ROOT_ATTRIBUTES, 'style', 'class']
    });
    return () => watch.disconnect();
  }, [send]);

  /*
   * The page is pointed at, never typed into: whenever the frame takes the
   * keyboard, the console gets it back once the click is done. A click still
   * lands; only the focus is handed back (the focus policy).
   */
  useEffect(() => {
    const handBack = (): void => {
      if (document.activeElement === frame.current) setTimeout(() => returnFocus?.(), 0);
    };
    window.addEventListener('blur', handBack);
    return () => window.removeEventListener('blur', handBack);
  }, [returnFocus]);

  // The page's buttons: only from the frame this card drew.
  useEffect(() => {
    const listen = (event: MessageEvent): void => {
      const target = frame.current?.contentWindow;
      if (target === null || target === undefined || event.source !== target || current === null) {
        return;
      }
      const asked: ExtensionToCard | null = extensionMessage(event.data);
      if (asked === null) return;
      if (asked.type === 'mudengine:ready') {
        send();
        return;
      }
      if (asked.type === 'mudengine:copy') {
        void writeClipboard(asked.text);
        return;
      }
      void window.mudengine
        .extensionAction(session, current.name, asked.action, asked.args)
        .then((result) => {
          const answer: CardToExtension = { type: 'mudengine:result', id: asked.id, result };
          target.postMessage(answer, '*');
        });
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [current, send, session]);

  return (
    <BentoCard
      {...chrome}
      className="extension-card"
      title={current?.title ?? t('cards.extension.title')}
    >
      {extensions.length > 1 && (
        <div className="tab-row" role="tablist">
          {extensions.map((each) => (
            <button
              aria-selected={each.name === current?.name}
              className="quiet"
              key={each.name}
              onClick={() => setShown(each.name)}
              role="tab"
              type="button"
            >
              {each.title}
            </button>
          ))}
        </div>
      )}
      {current === null || current.page === null ? (
        <div className="empty">{t('cards.extension.none')}</div>
      ) : (
        <iframe
          className="extension-frame"
          key={current.name}
          onLoad={send}
          ref={frame}
          sandbox="allow-scripts"
          src={`${current.page}index.html`}
          title={current.title}
        />
      )}
    </BentoCard>
  );
}

export default memo(ExtensionCard);
