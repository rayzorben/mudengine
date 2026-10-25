import { createElement, type MutableRefObject } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import type { CardChrome } from '../../components/BentoCard';
import type { NameIndex } from '../../lib/names';
import { useCardContext, type CardContext, type CardContextInputs } from '../useCardContext';
import { useCardRenderers, type CardRendererInputs } from '../useCardRenderers';
import { EMPTY_VIEW, type SessionView } from '../useSessionViews';
import { ZERO_METER } from '../useStreamPressure';
import { useToolbarPins } from '../useToolbarPins';
import { mount } from './mount';
import { t } from '../../lib/i18n';
import { type SupplyItem } from '@shared/packConfig';
import type { SessionId } from '@shared/ipc';

/*
 * What todo 761 feared: once the card context stopped being rebuilt on every
 * commit, a value `contextFor` read but did not list became a stale closure.
 * Each input here is held the same object across renders but the one a case
 * moves, which is exactly the render where a missing dependency shows.
 */

const SHOWN = 'shown' as SessionId;
const PINNED = 'pinned' as SessionId;

const probe = mount();

afterEach(() => probe.unmount());

describe('useToolbarPins', () => {
  const patterns = ['*'];
  const ids = ['heal', 'rest'];

  function Probe({ out }: { out: MutableRefObject<unknown[]> }): null {
    out.current.push(useToolbarPins(patterns, ids));
    return null;
  }

  it('hands back the same object until the row changes', () => {
    const out: MutableRefObject<unknown[]> = { current: [] };
    probe.render(createElement(Probe, { out }));
    probe.render(createElement(Probe, { out }));
    const [first, second] = out.current as ReturnType<typeof useToolbarPins>[];
    expect(second).toBe(first);

    act(() => first?.toggle('heal'));
    const moved = out.current.at(-1) as ReturnType<typeof useToolbarPins>;
    expect(moved).not.toBe(first);
    expect(moved.pinned.has('heal')).toBe(false);
  });
});

const noop = (): void => undefined;
/** A bridge call that never settles: none of these cases makes or waits on one. */
const pending = (): Promise<never> => new Promise<never>(noop);

/** Every input `App` hands the context, each one object for the whole test. */
const stable: Omit<CardContextInputs, 'nameIndexes'> = {
  api: new Proxy({}, { get: () => pending }) as CardContextInputs['api'],
  session: SHOWN,
  sessions: [{ id: SHOWN }, { id: PINNED }],
  thresholds: {} as CardContextInputs['thresholds'],
  navigationVisible: false,
  size: { cols: 80, rows: 24 },
  meter: ZERO_METER,
  pressure: 'calm',
  realmAt: 1,
  flyout: null,
  loops: [],
  toolbarPins: { pinned: new Set(), toggle: noop },
  remotesFor: () => ({}) as ReturnType<CardContextInputs['remotesFor']>,
  switchesFor: () => ({}) as ReturnType<CardContextInputs['switchesFor']>,
  suppliesFor: () => [],
  profileNameFor: () => '',
  ask: noop,
  forget: noop,
  inspect: noop,
  loadWearer: pending,
  loadMap: pending,
  lookupName: pending,
  chooseOnMap: noop,
  peekRoom: noop,
  endPeek: noop,
  goToRoom: noop,
  runHunt: noop,
  createHunt: noop,
  builder: {} as CardContextInputs['builder'],
  openBuilder: noop,
  startMoving: noop,
  stopMoving: noop,
  startLoop: noop,
  reverseLoop: noop,
  send: noop,
  openLoops: noop,
  openAreaSearch: noop,
  dial: noop,
  hangUp: noop,
  sayRefusal: () => noop,
  startMovingIn: noop,
  stepBackIn: noop,
  selectPlayer: noop,
  resetStats: noop
};

const chrome = {} as CardChrome;

describe('useCardContext', () => {
  type Contexts = ReturnType<typeof useCardContext>;

  function Probe({
    inputs,
    out
  }: {
    inputs: CardContextInputs;
    out: MutableRefObject<Contexts | null>;
  }): null {
    out.current = useCardContext(inputs);
    return null;
  }

  it("gives a pinned float's Talk card its name index once the realm's names arrive", () => {
    const out: MutableRefObject<Contexts | null> = { current: null };
    probe.render(createElement(Probe, { inputs: { ...stable, nameIndexes: {} }, out }));
    expect(out.current?.contextFor(PINNED, EMPTY_VIEW, chrome).nameIndex).toBeNull();

    const index = {} as NameIndex;
    probe.render(
      createElement(Probe, { inputs: { ...stable, nameIndexes: { [PINNED]: index } }, out })
    );
    expect(out.current?.contextFor(PINNED, EMPTY_VIEW, chrome).nameIndex).toBe(index);
  });

  it('closes the Loops modal it opened, and asks the quest book again after a realm edit', () => {
    const out: MutableRefObject<Contexts | null> = { current: null };
    probe.render(createElement(Probe, { inputs: { ...stable, nameIndexes: {} }, out }));
    const toggleClosed = (): void => undefined;
    probe.render(
      createElement(Probe, {
        inputs: { ...stable, nameIndexes: {}, openLoops: toggleClosed, realmAt: 2 },
        out
      })
    );
    const shown = out.current?.contextFor(SHOWN, EMPTY_VIEW, chrome);
    expect(shown?.toolbar.openLoops).toBe(toggleClosed);
    expect(shown?.realmAt).toBe(2);
  });

  it('is not rebuilt when nothing it reads moved', () => {
    const out: MutableRefObject<Contexts | null> = { current: null };
    const inputs = { ...stable, nameIndexes: {} };
    probe.render(createElement(Probe, { inputs, out }));
    const first = out.current?.contextFor;
    probe.render(createElement(Probe, { inputs: { ...inputs }, out }));
    expect(out.current?.contextFor).toBe(first);
  });

  it('edits the newest supplies list, not the one a field was drawn from', () => {
    const out: MutableRefObject<Contexts | null> = { current: null };
    const writes: SupplyItem[][] = [];
    const api = new Proxy(
      {},
      {
        get: (_, key) =>
          key === 'setSupplies'
            ? (_sid: SessionId, items: SupplyItem[]) => {
                writes.push(items);
                return pending();
              }
            : pending
      }
    ) as CardContextInputs['api'];
    const torch: SupplyItem = {
      name: 'torch',
      min: 1,
      max: 2,
      shop: '',
      at: null,
      buy: true,
      doneOnFound: false
    };
    const rope: SupplyItem = {
      name: 'rope',
      min: 1,
      max: 1,
      shop: '',
      at: null,
      buy: true,
      doneOnFound: false
    };
    const drawn = [torch, rope];
    probe.render(
      createElement(Probe, {
        inputs: { ...stable, api, nameIndexes: {}, suppliesFor: () => drawn },
        out
      })
    );
    const list = out.current?.suppliesBundle(SHOWN);

    // Min left, then Max closed before Min's write has come back.
    list?.edit('torch', (row) => row && { ...row, min: 3 });
    list?.edit('torch', (row) => row && { ...row, max: 5 });
    expect(writes.at(-1)?.find((row) => row.name === 'torch')).toMatchObject({ min: 3, max: 5 });

    // The torch row removed, then a field drawn before the removal closed.
    const removed = [rope];
    probe.render(
      createElement(Probe, {
        inputs: { ...stable, api, nameIndexes: {}, suppliesFor: () => removed },
        out
      })
    );
    out.current?.suppliesBundle(SHOWN);
    const before = writes.length;
    list?.edit('torch', (row) => row && { ...row, max: 9 });
    expect(writes).toHaveLength(before);
  });
});

/*
 * Todo 149: the Self card's bin and count fields. A row removed stays removed
 * across the push that answers the write, and a Max typed under Min is kept at
 * Min and said.
 */
describe('the supplies bundle', () => {
  type Contexts = ReturnType<typeof useCardContext>;

  function Probe({
    inputs,
    out
  }: {
    inputs: CardContextInputs;
    out: MutableRefObject<Contexts | null>;
  }): null {
    out.current = useCardContext(inputs);
    return null;
  }

  const torch: SupplyItem = {
    name: 'torch',
    min: 3,
    max: 6,
    shop: 'General Store',
    at: null,
    buy: true,
    doneOnFound: false
  };
  const rope: SupplyItem = {
    name: 'rope',
    min: 1,
    max: 2,
    shop: '',
    at: null,
    buy: true,
    doneOnFound: false
  };
  const flask: SupplyItem = {
    name: 'flask',
    min: 1,
    max: 1,
    shop: '',
    at: null,
    buy: true,
    doneOnFound: false
  };

  function draw(drawn: () => SupplyItem[]): {
    out: MutableRefObject<Contexts | null>;
    writes: SupplyItem[][];
    to: SessionId[];
    said: string[];
    push(list: SupplyItem[]): void;
  } {
    const out: MutableRefObject<Contexts | null> = { current: null };
    const writes: SupplyItem[][] = [];
    const to: SessionId[] = [];
    const said: string[] = [];
    const api = new Proxy(
      {},
      {
        get: (_, key) =>
          key === 'setSupplies'
            ? (sid: SessionId, items: SupplyItem[]) => {
                to.push(sid);
                writes.push(items);
                return pending();
              }
            : pending
      }
    ) as CardContextInputs['api'];
    const sayRefusal = () => (refused: string | null) => {
      if (refused !== null) said.push(refused);
    };
    const inputs = (list: () => SupplyItem[]): CardContextInputs => ({
      ...stable,
      api,
      sayRefusal,
      nameIndexes: {},
      suppliesFor: list
    });
    probe.render(createElement(Probe, { inputs: inputs(drawn), out }));
    return {
      out,
      writes,
      to,
      said,
      push: (list) => probe.render(createElement(Probe, { inputs: inputs(() => list), out }))
    };
  }

  it('keeps a removed row removed after the push that answers it', () => {
    const { out, writes, push } = draw(() => [torch, rope, flask]);
    out.current?.suppliesBundle(SHOWN).edit('torch', () => null);
    expect(writes.at(-1)).toEqual([rope, flask]);

    push([rope, flask]);
    out.current?.suppliesBundle(SHOWN).edit('rope', () => null);
    expect(writes.at(-1)).toEqual([flask]);
  });

  it("writes a pinned float's list to its own character, not the shown one", () => {
    const { out, to } = draw(() => [torch]);
    const float = out.current?.contextFor(PINNED, EMPTY_VIEW, chrome);
    float?.supplies.edit('torch', () => null);
    out.current?.contextFor(SHOWN, EMPTY_VIEW, chrome).supplies.edit('torch', () => null);
    expect(to).toEqual([PINNED, SHOWN]);
  });

  it('keeps a Max typed under Min at Min, and says so', () => {
    const { out, writes, said } = draw(() => [torch]);
    out.current?.suppliesBundle(SHOWN).edit('torch', (row) => row && { ...row, max: 2 });
    expect(writes.at(-1)).toEqual([{ ...torch, max: 3 }]);
    expect(said).toEqual([t('cards.self.supplies.maxRaised', { item: 'torch', min: 3 })]);
  });

  it('says nothing when the Max typed is at or over Min', () => {
    const { out, writes, said } = draw(() => [torch]);
    out.current?.suppliesBundle(SHOWN).edit('torch', (row) => row && { ...row, max: 3 });
    // The positive control: the write went out.
    expect(writes.at(-1)).toEqual([{ ...torch, max: 3 }]);
    expect(said).toEqual([]);
  });
});

describe('useCardRenderers.pinnedFor', () => {
  type Renderers = ReturnType<typeof useCardRenderers>;

  const base: Omit<CardRendererInputs, 'views' | 'view'> = {
    cards: { floatOf: () => undefined },
    drag: { state: null, begin: noop },
    railOpen: false,
    hudOpen: true,
    session: SHOWN,
    contextFor: () => ({}) as CardContext,
    chromeFor: () => chrome,
    pinnedChrome: () => chrome
  };

  function Probe({
    views,
    out
  }: {
    views: Record<SessionId, SessionView>;
    out: MutableRefObject<Renderers | null>;
  }): null {
    out.current = useCardRenderers({ ...base, view: views[SHOWN] ?? EMPTY_VIEW, views });
    return null;
  }

  it("holds a pinned float's renderer while only another character's view moves", () => {
    const out: MutableRefObject<Renderers | null> = { current: null };
    const pinned = { ...EMPTY_VIEW };
    probe.render(
      createElement(Probe, { views: { [SHOWN]: { ...EMPTY_VIEW }, [PINNED]: pinned }, out })
    );
    const first = out.current?.pinnedFor(PINNED);
    // A status line for the character on screen: a new view for it alone.
    probe.render(
      createElement(Probe, { views: { [SHOWN]: { ...EMPTY_VIEW }, [PINNED]: pinned }, out })
    );
    expect(out.current?.pinnedFor(PINNED)).toBe(first);
    // And one for the pinned character itself.
    probe.render(
      createElement(Probe, { views: { [SHOWN]: { ...EMPTY_VIEW }, [PINNED]: { ...pinned } }, out })
    );
    expect(out.current?.pinnedFor(PINNED)).not.toBe(first);
  });

  it('binds each character not yet heard from to its own id', () => {
    const out: MutableRefObject<Renderers | null> = { current: null };
    probe.render(createElement(Probe, { views: {}, out }));
    expect(out.current?.pinnedFor(PINNED)).not.toBe(out.current?.pinnedFor(SHOWN));
  });
});
