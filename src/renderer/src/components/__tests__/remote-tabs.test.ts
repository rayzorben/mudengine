import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import RemoteTabs, { type RemoteTabsApi, type RemoteTabsProps } from '../RemoteTabs';
import { mount } from '../../hooks/__tests__/mount';
import { t } from '../../lib/i18n';
import { remoteAside } from '../../lib/remoteAside';
import type { RemoteCharacter } from '../../lib/remoteCharacters';
import { DEFAULT_CONFIG } from '@shared/config';
import type { SessionId } from '@shared/ipc';
import { sharedSheet } from '@shared/__tests__/sharedSheets';

/*
 * Todo 20261031-1156-01: a character shared with this install is a tab on the
 * rail below this install's own, pressed like one to open its console.
 */
const probe = mount();
afterEach(() => {
  probe.unmount();
  remoteAside.set('r', false);
});

const remote = (name: string, over: Partial<RemoteCharacter> = {}): RemoteCharacter => ({
  id: `realm:${name}`,
  name,
  key: `key-${name}`,
  sheet: sharedSheet(name).sheet,
  control: false,
  via: 'r',
  viaName: 'Rayzor',
  controlled: false,
  ...over
});

function fakeApi(refusal: string | null = null) {
  const opened: [SessionId, string][] = [];
  const closed: SessionId[] = [];
  const api: RemoteTabsApi = {
    controlOpen: (session, name) => {
      opened.push([session, name]);
      return Promise.resolve(refusal);
    },
    controlClose: (session) => {
      closed.push(session);
      return Promise.resolve();
    }
  };
  return { api, opened, closed };
}

function draw(
  props: Partial<RemoteTabsProps> & Pick<RemoteTabsProps, 'api' | 'remotes'>
): string[] {
  const selected: string[] = [];
  probe.render(
    createElement(RemoteTabs, {
      active: 'r',
      aside: remoteAside.read(),
      stacked: false,
      hp: DEFAULT_CONFIG.ui.vitals.hp,
      onSelect: (session: SessionId) => selected.push(session),
      ...props
    })
  );
  return selected;
}

const tabOf = (name: string) => probe.root().find((node) => node.props['data-remote-tab'] === name);
const press = (name: string): void => (tabOf(name).props['onClick'] as () => void)();
const settle = (): Promise<void> => act(() => new Promise<void>((done) => setTimeout(done, 0)));

describe('characters shared with this install on the tab rail', () => {
  it('draws nothing while nobody shares, and a heading once somebody does', () => {
    const { api } = fakeApi();
    draw({ api, remotes: [] });
    expect(probe.root().findAll((node) => node.props['className'] === 'remote-tabs-head')).toEqual(
      []
    );
    // Positive control: one sharer, and the section is there.
    draw({ api, remotes: [remote('Brakkle')] });
    expect(
      probe.root().findAll((node) => node.props['className'] === 'remote-tabs-head')
    ).toHaveLength(1);
  });

  it('opens control through the character it is shared with, then shows that pane', async () => {
    remoteAside.set('r', true);
    const { api, opened } = fakeApi();
    const selected = draw({ api, remotes: [remote('Brakkle', { control: true })] });
    press('Brakkle');
    await settle();
    expect(opened).toEqual([['r', 'Brakkle']]);
    expect(selected).toEqual(['r']);
    expect(remoteAside.read().has('r')).toBe(false);
  });

  it('brings back a console set aside without opening control again', () => {
    remoteAside.set('r', true);
    const { api, opened } = fakeApi();
    const selected = draw({
      api,
      remotes: [remote('Brakkle', { control: true, controlled: true })]
    });
    // Set aside: the pane shows Rayzor, so this tab is not the active one.
    expect(tabOf('Brakkle').props['data-active']).toBe('false');
    press('Brakkle');
    expect(opened).toEqual([]);
    expect(selected).toEqual(['r']);
    expect(remoteAside.read().has('r')).toBe(false);
  });

  it('says why control was refused and shows no pane', async () => {
    const { api } = fakeApi('Brakkle does not give this character remote control.');
    const selected = draw({ api, remotes: [remote('Brakkle', { control: true })] });
    press('Brakkle');
    await settle();
    expect(selected).toEqual([]);
    const said = probe
      .root()
      .findAll((node) => node.props['className'] === 'remote-tabs-refused settings-warn');
    expect(said).toHaveLength(1);
  });

  it('lists a sharer that gives no control, which cannot be pressed', () => {
    const { api } = fakeApi();
    draw({ api, remotes: [remote('Mirage')] });
    const tab = tabOf('Mirage');
    expect(tab.props['onClick']).toBeUndefined();
    expect(tab.props['aria-disabled']).toBe(true);
    expect(tab.props['title']).toBe(t('tabs.shared.noControlTooltip', { name: 'Mirage' }));
  });

  it('is the active tab while its console shows, and its close ends control alone', () => {
    const { api, closed } = fakeApi();
    const selected = draw({
      api,
      remotes: [remote('Brakkle', { control: true, controlled: true })]
    });
    expect(tabOf('Brakkle').props['data-active']).toBe('true');
    const [close] = tabOf('Brakkle').findAll(
      (node) => node.type === 'button' && node.props['className'] === 'close'
    );
    (close!.props['onClick'] as (event: { stopPropagation(): void }) => void)({
      stopPropagation: () => undefined
    });
    expect(closed).toEqual(['r']);
    expect(selected).toEqual([]);
  });
});
