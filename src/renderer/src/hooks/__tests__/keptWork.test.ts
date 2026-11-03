/**
 * Each character's half-typed Talk line and its Up/Down history are kept
 * while its tab is away, and never shown on another character's card (todo
 * 20261102-2220-02). Drawn the way the rail draws it: `cardElement` from the
 * context `useCardContext` builds, inside one host, so a tab switch is the
 * keyed remount it is in the window.
 */
import { createElement, type MutableRefObject } from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CardChrome } from '../../components/BentoCard';
import { cardElement } from '../../components/CardSwitch';
import { t } from '../../lib/i18n';
import { keptSlot } from '../../lib/sessionMemory';
import { useCardContext, type CardContextInputs } from '../useCardContext';
import { useKeptState } from '../useKeptState';
import { EMPTY_VIEW, type SessionView } from '../useSessionViews';
import { cardInputs, noop } from './cardInputs';
import { mount } from './mount';
import type { SessionId } from '@shared/ipc';

const RAYZOR = 'rayzor' as SessionId;
const SOUL = 'soul' as SessionId;

const inputs = (sessions: SessionId[]): CardContextInputs => ({
  ...cardInputs(RAYZOR, sessions),
  nameIndexes: {}
});

/** In the realm, so the card draws its box. */
const inGame: SessionView = {
  ...EMPTY_VIEW,
  character: { ...EMPTY_VIEW.character, phase: 'in-game' }
};
const chrome = { cardId: 'conversation' } as CardChrome;

type Contexts = ReturnType<typeof useCardContext>;

/** The window's half: the contexts, and one rail slot drawing the Talk card for `shown`. */
function Rail({
  given,
  shown,
  out
}: {
  given: CardContextInputs;
  shown: SessionId;
  out: MutableRefObject<Contexts | null>;
}) {
  const contexts = useCardContext(given);
  out.current = contexts;
  return createElement(
    'div',
    null,
    cardElement('conversation', contexts.contextFor(shown, inGame, chrome))
  );
}

const rail = mount();
const out: MutableRefObject<Contexts | null> = { current: null };

beforeEach(() => {
  const frames = { requestAnimationFrame: () => 0, cancelAnimationFrame: noop };
  vi.stubGlobal('window', {
    ...frames,
    setTimeout: () => 0,
    clearTimeout: noop,
    localStorage: { getItem: () => null, setItem: noop }
  });
  vi.stubGlobal('requestAnimationFrame', frames.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', noop);
});
afterEach(() => {
  rail.unmount();
  vi.unstubAllGlobals();
});

const draw = (shown: SessionId, sessions: SessionId[] = [RAYZOR, SOUL]): void =>
  rail.render(createElement(Rail, { given: inputs(sessions), shown, out }));

const box = (): ReactTestInstance =>
  rail
    .root()
    .find(
      (node) =>
        node.type === 'input' && node.props['aria-label'] === t('cards.talk.messageInputAria')
    );
const value = (): string => box().props.value as string;
const type = (text: string): void => {
  act(() => {
    box().props.onChange({ target: { value: text } });
  });
};
const press = (key: string): void => {
  act(() => {
    box().props.onKeyDown({ key, preventDefault: noop });
  });
};

describe("each character's Talk box", () => {
  it('keeps the line and its history while the tab is away, and shows neither elsewhere', () => {
    draw(RAYZOR);
    type('gos hi');
    press('Enter');
    type('recover corpse;equip all');
    // The positive control: the line is in Rayzor's box before the switch.
    expect(value()).toBe('recover corpse;equip all');

    draw(SOUL);
    expect(value()).toBe('');
    press('ArrowUp');
    expect(value()).toBe('');

    draw(RAYZOR);
    expect(value()).toBe('recover corpse;equip all');
    press('ArrowUp');
    expect(value()).toBe('gos hi');
  });

  it("drops a closed tab's line", () => {
    draw(RAYZOR);
    type('set suicide');
    expect(value()).toBe('set suicide');

    draw(SOUL, [SOUL]);
    draw(RAYZOR);
    expect(value()).toBe('');
  });
});

describe('useKeptState', () => {
  function Probe({
    slot,
    next,
    seen
  }: {
    slot: ReturnType<typeof keptSlot<string>>;
    next: string | null;
    seen: string[];
  }): null {
    const [value, setValue] = useKeptState(slot, 'fresh');
    seen.push(value);
    if (next !== null && value !== next) setValue(next);
    return null;
  }
  const probe = mount();
  afterEach(() => probe.unmount());

  it("reads a new slot afresh and never writes one character's value into another's", () => {
    const first = keptSlot<string>();
    const second = keptSlot<string>();
    const seen: string[] = [];
    probe.render(createElement(Probe, { slot: first, next: 'typed', seen }));
    expect(first.read()).toBe('typed');

    probe.render(createElement(Probe, { slot: second, next: null, seen }));
    expect(seen.at(-1)).toBe('fresh');
    expect(second.read()).toBe('fresh');
    expect(first.read()).toBe('typed');
  });
});
