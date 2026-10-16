import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '@shared/character';
import { UNKNOWN_WEARER, type Wearer } from '@shared/gear';
import { useWearer } from '../useWearer';
import { mount } from './mount';

/*
 * The pack and the Room card's floor marks read one wearer (todo 146), asked
 * again when the class, race, level or strength move and not on every push.
 */

let seen: Wearer | null = null;

function Probe({
  character,
  load
}: {
  character: CharacterState;
  load: (() => Promise<Wearer>) | undefined;
}): null {
  seen = useWearer(character, load);
  return null;
}

const probe = mount();

afterEach(() => {
  probe.unmount();
  seen = null;
});

const warrior: Wearer = { ...UNKNOWN_WEARER, classId: 1, antiMagic: false };

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useWearer', () => {
  it('answers what main said, and asks again only when the stats move', async () => {
    const load = vi.fn(() => Promise.resolve(warrior));
    probe.render(createElement(Probe, { character: EMPTY_CHARACTER, load }));
    expect(seen).toBe(UNKNOWN_WEARER);
    await settle();
    expect(seen).toEqual(warrior);
    expect(load).toHaveBeenCalledTimes(1);

    // A status line: a new object, the same stats.
    probe.render(createElement(Probe, { character: { ...EMPTY_CHARACTER }, load }));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    const levelled = {
      ...EMPTY_CHARACTER,
      progress: { ...EMPTY_CHARACTER.progress, level: 5 }
    };
    probe.render(createElement(Probe, { character: levelled, load }));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stays unknown when the lookup fails or there is nothing to ask', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi.fn(() => Promise.reject(new Error('no realm')));
    probe.render(createElement(Probe, { character: EMPTY_CHARACTER, load }));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(seen).toBe(UNKNOWN_WEARER);
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    probe.render(createElement(Probe, { character: EMPTY_CHARACTER, load: undefined }));
    await settle();
    expect(seen).toBe(UNKNOWN_WEARER);
  });
});
