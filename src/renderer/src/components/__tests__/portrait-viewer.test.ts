import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_CHARACTER } from '@shared/character';
import PortraitHead from '../game/PortraitHead';
import PortraitViewer from '../game/PortraitViewer';
import { mount } from '../../hooks/__tests__/mount';

const probe = mount();
afterEach(() => probe.unmount());

const DRAWN = 'data:image/webp;base64,UklGRg==';

/* Todo 20261019-0931-01: the drawn portrait opens whole; nothing else does. */
describe('the portrait in the character panel', () => {
  it('opens the drawn portrait from the small square', () => {
    const onOpen = vi.fn();
    probe.render(
      createElement(PortraitHead, {
        character: EMPTY_CHARACTER,
        art: null,
        portrait: { picture: DRAWN, status: { kind: 'drawn' } },
        onOpen
      })
    );
    const square = probe.root().find((node) => node.props['data-drawn'] === 'true');
    act(() => square.props.onClick());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('offers nothing to open before a portrait is drawn', () => {
    probe.render(
      createElement(PortraitHead, {
        character: EMPTY_CHARACTER,
        art: null,
        portrait: { picture: null, status: { kind: 'waiting' } },
        onOpen: vi.fn()
      })
    );
    expect(probe.root().findAll((node) => node.props['data-drawn'] === 'true')).toEqual([]);
  });

  it('saves through main, and keeps its Esc from the game view', async () => {
    const savePortrait = vi.fn(async () => ({ kind: 'dismissed' as const }));
    const onClose = vi.fn();
    probe.render(
      createElement(PortraitViewer, {
        src: DRAWN,
        name: 'Probe',
        api: { copyImage: vi.fn(async () => true), savePortrait },
        session: 'probe',
        onClose
      })
    );
    const buttons = probe.root().findAllByType('button');
    await act(async () => buttons[1]!.props.onClick());
    expect(savePortrait).toHaveBeenCalledWith('probe');
    const stopPropagation = vi.fn();
    const dialog = probe.root().find((node) => node.props.role === 'dialog');
    act(() => dialog.props.onKeyDown({ key: 'Escape', preventDefault: vi.fn(), stopPropagation }));
    expect(stopPropagation).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
