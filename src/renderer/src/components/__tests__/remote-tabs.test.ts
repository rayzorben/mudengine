import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import RemoteTabs, { type RemoteTabsApi, type RemoteTabsProps } from '../RemoteTabs';
import { mount } from '../../hooks/__tests__/mount';
import { t } from '../../lib/i18n';
import type { RemoteCharacter } from '../../lib/remoteCharacters';
import { EMPTY_CHARACTER } from '@shared/character';
import { DEFAULT_CONFIG } from '@shared/config';
import type { SessionId, SessionSummary } from '@shared/ipc';
import { remoteSessionId } from '@shared/peerRelay';
import { IDLE_CONNECTION } from '@shared/types';
import { sharedSheet } from '@shared/__tests__/sharedSheets';

/*
 * Todo 20261031-1156-01: a character shared with this install is a tab on the
 * rail below this install's own; opened, it is a session pressed like any.
 */
const probe = mount();
afterEach(() => probe.unmount());

const sharer = (name: string, control = false): RemoteCharacter => ({
  id: `realm:${name}`,
  name,
  sheet: sharedSheet(name).sheet,
  control,
  via: 'r',
  viaName: 'Rayzor'
});

const summary = (name: string): SessionSummary => ({
  id: remoteSessionId('r', name),
  name,
  server: 'paramud',
  accent: 'violet',
  state: IDLE_CONNECTION,
  retrying: false,
  remote: { via: 'r', viaName: 'Rayzor' }
});

function fakeApi(refusal: string | null = null) {
  const opened: [SessionId, string][] = [];
  const api: RemoteTabsApi = {
    controlOpen: (session, name) => {
      opened.push([session, name]);
      return Promise.resolve(refusal);
    }
  };
  return { api, opened };
}

function draw(
  props: Partial<RemoteTabsProps> & Pick<RemoteTabsProps, 'api'>,
  selected: string[] = [],
  closed: string[] = []
): { selected: string[]; closed: string[] } {
  probe.render(
    createElement(RemoteTabs, {
      sharers: [],
      opened: [],
      views: {},
      active: 'r',
      stacked: false,
      hp: DEFAULT_CONFIG.ui.vitals.hp,
      onSelect: (session: SessionId) => selected.push(session),
      onClose: (session: SessionId) => closed.push(session),
      ...props
    })
  );
  return { selected, closed };
}

const tabOf = (name: string) => probe.root().find((node) => node.props['data-remote-tab'] === name);
const press = (name: string): void => (tabOf(name).props['onClick'] as () => void)();
const settle = (): Promise<void> => act(() => new Promise<void>((done) => setTimeout(done, 0)));

describe('characters shared with this install on the tab rail', () => {
  it('draws nothing while nobody shares, and a heading once somebody does', () => {
    const { api } = fakeApi();
    draw({ api });
    expect(probe.root().findAll((node) => node.props['className'] === 'remote-tabs-head')).toEqual(
      []
    );
    // Positive control: one sharer, and the section is there.
    draw({ api, sharers: [sharer('Brakkle')] });
    expect(
      probe.root().findAll((node) => node.props['className'] === 'remote-tabs-head')
    ).toHaveLength(1);
  });

  it('opens a sharer through the character it is shared with, and shows it once the roster has it', async () => {
    const { api, opened } = fakeApi();
    const selected: string[] = [];
    draw({ api, sharers: [sharer('Brakkle', true)] }, selected);
    press('Brakkle');
    await settle();
    expect(opened).toEqual([['r', 'Brakkle']]);
    // Not yet on the roster: nothing to show.
    expect(selected).toEqual([]);
    draw({ api, sharers: [sharer('Brakkle', true)], opened: [summary('Brakkle')] }, selected);
    expect(selected).toEqual([remoteSessionId('r', 'Brakkle')]);
  });

  it("draws an opened character from its own session's state, and its close closes that session", () => {
    const { api, opened } = fakeApi();
    const id = remoteSessionId('r', 'Brakkle');
    const character = { ...EMPTY_CHARACTER, inCombat: true };
    const { selected, closed } = draw({
      api,
      active: id,
      sharers: [sharer('Brakkle', true)],
      opened: [summary('Brakkle')],
      views: { [id]: { character } }
    });
    // One row, the session's, and it is the active tab.
    expect(
      probe.root().findAll((node) => node.props['data-remote-tab'] === 'Brakkle')
    ).toHaveLength(1);
    expect(tabOf('Brakkle').props['data-active']).toBe('true');
    expect(tabOf('Brakkle').props['data-opened']).toBe('true');
    press('Brakkle');
    expect(opened).toEqual([]);
    expect(selected).toEqual([id]);
    const [close] = tabOf('Brakkle').findAll(
      (node) => node.type === 'button' && node.props['className'] === 'close'
    );
    (close!.props['onClick'] as (event: { stopPropagation(): void }) => void)({
      stopPropagation: () => undefined
    });
    expect(closed).toEqual([id]);
  });

  it('says why opening was refused and shows nothing', async () => {
    const { api } = fakeApi('Brakkle does not give this character remote control.');
    const { selected } = draw({ api, sharers: [sharer('Brakkle', true)] });
    press('Brakkle');
    await settle();
    expect(selected).toEqual([]);
    expect(
      probe
        .root()
        .findAll((node) => node.props['className'] === 'remote-tabs-refused settings-warn')
    ).toHaveLength(1);
  });

  it('lists a sharer that gives no control, which cannot be pressed', () => {
    const { api } = fakeApi();
    draw({ api, sharers: [sharer('Mirage')] });
    const tab = tabOf('Mirage');
    expect(tab.props['onClick']).toBeUndefined();
    expect(tab.props['aria-disabled']).toBe(true);
    expect(tab.props['title']).toBe(t('tabs.shared.noControlTooltip', { name: 'Mirage' }));
  });
});
