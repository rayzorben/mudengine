import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CommandPalette from '../CommandPalette';
import { mount } from '../../hooks/__tests__/mount';
import { t } from '../../lib/i18n';
import { tuning } from '../../lib/tuning';

/*
 * A palette query also searches the realm (rooms, monsters, items). When that
 * search failed, the palette said "nothing in the realm by that name", which
 * is a claim about the realm the client never checked. It says the search
 * failed, and why.
 */
const probe = mount();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined
  });
});
afterEach(() => {
  probe.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const noop = (): void => undefined;

function texts(): string[] {
  return probe
    .root()
    .findAll((node) => typeof node.type === 'string' && node.props.className === 'empty')
    .map((node) => node.children.join(''));
}

async function typed(query: string): Promise<void> {
  const input = probe.root().find((node) => node.type === 'input');
  act(() => input.props.onChange({ target: { value: query } }));
  await act(async () => {
    vi.advanceTimersByTime(tuning().roomSearchDebounceMs);
    await Promise.resolve();
  });
}

describe('the palette when the realm search fails', () => {
  it('says the search failed rather than that the realm has nothing', async () => {
    const find = vi.fn(() => Promise.reject(new Error('no realm loaded')));
    probe.render(
      createElement(CommandPalette, {
        open: true,
        commands: [],
        pinned: new Set<string>(),
        onTogglePin: noop,
        onClose: noop,
        find
      })
    );

    await typed('temple');

    expect(find).toHaveBeenCalledWith('temple');
    expect(texts()).toEqual([t('palette.findFailed', { reason: 'no realm loaded' })]);
  });

  it('still says nothing matched when the search answered with nothing', async () => {
    const find = vi.fn(() => Promise.resolve([]));
    probe.render(
      createElement(CommandPalette, {
        open: true,
        commands: [],
        pinned: new Set<string>(),
        onTogglePin: noop,
        onClose: noop,
        find
      })
    );

    await typed('temple');

    expect(find).toHaveBeenCalledWith('temple');
    expect(texts()).toEqual([t('palette.noMatches')]);
  });
});
