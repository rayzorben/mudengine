import { describe, expect, it } from 'vitest';

import { documentVisibility, missedWhileHidden, type PageVisibility } from '../hiddenPage';

/** A page that is hidden and shown on the test's word. */
function page(): PageVisibility & { hide(): void; show(): void } {
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    hidden: () => hidden,
    onShown: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      for (const listener of listeners) listener();
    }
  };
}

function counted(): { redraw(): void; count(): number } {
  let count = 0;
  return { redraw: () => (count += 1), count: () => count };
}

describe('a console while the page is hidden', () => {
  it('writes every chunk while the page is shown, and is never redrawn', () => {
    const shown = page();
    const redraws = counted();
    const hidden = missedWhileHidden(shown, redraws.redraw);
    expect(hidden.skip()).toBe(false);
    shown.show();
    expect(redraws.count()).toBe(0);
  });

  it('drops what arrives while hidden and is redrawn once when shown', () => {
    const shown = page();
    const redraws = counted();
    const hidden = missedWhileHidden(shown, redraws.redraw);
    shown.hide();
    expect(hidden.skip()).toBe(true);
    expect(hidden.skip()).toBe(true);
    expect(redraws.count()).toBe(0);
    shown.show();
    expect(redraws.count()).toBe(1);
    expect(hidden.skip()).toBe(false);
  });

  it('is not redrawn when nothing arrived while hidden', () => {
    const shown = page();
    const idle = counted();
    const busy = counted();
    missedWhileHidden(shown, idle.redraw);
    // The control: a console that was sent something is redrawn by the same show.
    const sentTo = missedWhileHidden(shown, busy.redraw);
    shown.hide();
    sentTo.skip();
    shown.show();
    expect(busy.count()).toBe(1);
    expect(idle.count()).toBe(0);
  });

  it('is redrawn once per hiding that missed something', () => {
    const shown = page();
    const redraws = counted();
    const hidden = missedWhileHidden(shown, redraws.redraw);
    shown.hide();
    hidden.skip();
    shown.show();
    shown.show();
    expect(redraws.count()).toBe(1);
    shown.hide();
    hidden.skip();
    shown.show();
    expect(redraws.count()).toBe(2);
  });

  it('hears nothing after it is disposed', () => {
    const shown = page();
    const kept = counted();
    const gone = counted();
    const control = missedWhileHidden(shown, kept.redraw);
    const disposed = missedWhileHidden(shown, gone.redraw);
    shown.hide();
    control.skip();
    disposed.skip();
    disposed.dispose();
    shown.show();
    expect(kept.count()).toBe(1);
    expect(gone.count()).toBe(0);
  });
});

describe("the document's visibility", () => {
  function fakeDocument(): Document & { set(state: DocumentVisibilityState): void } {
    const target = new EventTarget() as Document & { set(state: DocumentVisibilityState): void };
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(target, 'visibilityState', { get: () => state });
    target.set = (next) => {
      state = next;
      target.dispatchEvent(new Event('visibilitychange'));
    };
    return target;
  }

  it('reads hidden from the document and calls back only when it is shown', () => {
    const doc = fakeDocument();
    const visibility = documentVisibility(doc);
    let shown = 0;
    const stop = visibility.onShown(() => (shown += 1));
    doc.set('hidden');
    expect(visibility.hidden()).toBe(true);
    expect(shown).toBe(0);
    doc.set('visible');
    expect(visibility.hidden()).toBe(false);
    expect(shown).toBe(1);
    stop();
    doc.set('hidden');
    doc.set('visible');
    expect(shown).toBe(1);
  });
});
