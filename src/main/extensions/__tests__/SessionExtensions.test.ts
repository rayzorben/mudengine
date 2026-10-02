import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../../shared/config';
import type { ExtensionSession, ExtensionSessionHost } from '../api';
import type { LoadedExtension } from '../ExtensionLoader';
import { SessionExtensions, type ExtensionHostKit } from '../SessionExtensions';

const loaded = (name: string, session: (kit: ExtensionHostKit) => ExtensionSession) => {
  let kit: ExtensionHostKit | null = null;
  const extension: LoadedExtension = {
    manifest: { name, title: name, main: 'main.mjs' },
    dir: `/x/${name}`,
    module: { session: () => session(kit!) }
  };
  return { extension, capture: (given: ExtensionHostKit) => (kit = given) };
};

function make(entries: ReturnType<typeof loaded>[]) {
  const notices: string[] = [];
  let relaid = 0;
  const extensions = new SessionExtensions(
    entries.map((entry) => entry.extension),
    (extension, kit) => {
      entries.find((entry) => entry.extension === extension)!.capture(kit);
      return {} as ExtensionSessionHost;
    },
    {
      relayer: () => (relaid += 1),
      notice: (message) => notices.push(message),
      changed: () => {}
    }
  );
  return { extensions, notices, relaid: () => relaid };
}

describe('one character’s extensions', () => {
  it('lays each one’s settings over the character’s own, and configures again when they move', () => {
    let layer: ExtensionHostKit['layer'] = () => {};
    const planner = loaded('planner', (kit) => {
      layer = kit.layer;
      return { view: () => 'plan' };
    });
    const { extensions, relaid } = make([planner]);
    layer([[['combat', 'attack'], 'kic']]);
    expect(relaid()).toBe(1);
    expect(extensions.over(DEFAULT_CONFIG.automation).combat.attack).toBe('kic');
    layer(null);
    expect(extensions.over(DEFAULT_CONFIG.automation)).toBe(DEFAULT_CONFIG.automation);
  });

  it('drives the character while any one extension says it is, and stops when it says so', () => {
    let first: ExtensionHostKit['drive'] = () => {};
    let second: ExtensionHostKit['drive'] = () => {};
    const a = loaded('a', (kit) => ((first = kit.drive), { view: () => null }));
    const b = loaded('b', (kit) => ((second = kit.drive), { view: () => null }));
    const { extensions } = make([a, b]);
    expect(extensions.driving).toBe(false);
    first(true);
    second(true);
    first(false);
    expect(extensions.driving).toBe(true);
    second(false);
    expect(extensions.driving).toBe(false);
  });

  it('sends what it hears, and gathers each view by name', () => {
    const heard: string[] = [];
    const planner = loaded('planner', () => ({
      onBlock: (block) => heard.push(block.type),
      view: () => ({ goal: 'hunt' })
    }));
    const { extensions } = make([planner]);
    extensions.onBlock({ type: 'user-dies' } as never);
    expect(heard).toEqual(['user-dies']);
    expect(extensions.views()).toEqual({ planner: { goal: 'hunt' } });
  });

  it('says a failing hook once, and the session carries on', () => {
    const planner = loaded('planner', () => ({
      onCharacter: () => {
        throw new Error('boom');
      },
      view: () => null
    }));
    const { extensions, notices } = make([planner]);
    extensions.onCharacter({} as never);
    extensions.onCharacter({} as never);
    expect(notices).toHaveLength(1);
  });

  it('answers a card’s button, or why it could not', async () => {
    const planner = loaded('planner', () => ({
      view: () => null,
      action: (name, args) => (name === 'echo' ? args[0] : Promise.reject(new Error('no')))
    }));
    const { extensions } = make([planner]);
    expect(await extensions.action('planner', 'echo', [7])).toEqual({ value: 7 });
    expect(await extensions.action('planner', 'fail', [])).toHaveProperty('refusal');
    expect(await extensions.action('other', 'echo', [])).toHaveProperty('refusal');
  });
});
