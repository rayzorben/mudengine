/**
 * The rewrite editor's tag completion list, under the brace being typed. The
 * themed list every picker here draws (`NameCombo`'s `.spell-options`), so it
 * scrolls and highlights the same way; the behaviour is `useTagCompletion`.
 */
import { useLayoutEffect } from 'react';

import type { TagCompletion as Completion } from '../hooks/useTagCompletion';
import { t } from '../lib/i18n';

export default function TagCompletion({
  completion
}: {
  completion: Completion;
}): React.JSX.Element | null {
  const { items, navigation, at, choose } = completion;
  const list = navigation.listRef;

  /*
   * Kept inside the field: the caret's column can sit past the field's right
   * edge on a long line, and the list's width is only known once drawn.
   */
  useLayoutEffect(() => {
    const node = list.current;
    const box = node?.offsetParent;
    if (!node || !(box instanceof HTMLElement) || at === null) return;
    node.style.left = `${Math.max(0, Math.min(at.x, box.clientWidth - node.offsetWidth))}px`;
    node.style.top = `${at.y}px`;
  }, [at, items, list]);

  if (at === null || items.length === 0) return null;
  return (
    <ul
      aria-label={t('settings.rewrites.editor.completion')}
      className="spell-options tag-options"
      ref={list}
      role="listbox"
    >
      {items.map((tag, index) => (
        <li
          aria-selected={navigation.isActive(index)}
          data-active={navigation.isActive(index) ? 'true' : 'false'}
          key={tag}
          // Before the textarea's blur, or the click would close the list out
          // from under itself and choose nothing.
          onMouseDown={(event) => {
            event.preventDefault();
            choose(tag);
          }}
          {...navigation.hover(index)}
          role="option"
        >
          <code>{tag}</code>
        </li>
      ))}
    </ul>
  );
}
