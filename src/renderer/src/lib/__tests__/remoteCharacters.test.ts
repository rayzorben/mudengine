import { describe, expect, it } from 'vitest';

import { createRemoteAside } from '../remoteAside';
import { controllers, remoteCharacters, showsRemote } from '../remoteCharacters';
import { NO_SHARES, UNKNOWN_PEER_SHEET, type SharedSheet, type ShareView } from '@shared/peers';
import { sharedSheet } from '@shared/__tests__/sharedSheets';

/*
 * Todo 20261031-1156-01: the tab rail lists each character shared with this
 * install once, reached through the character best placed to control it.
 */
const view = (sheets: SharedSheet[], controlling: ShareView['controlling'] = null): ShareView => ({
  ...NO_SHARES,
  enabled: true,
  sheets,
  controlling
});
const RAYZOR = { id: 'r', name: 'Rayzor' };
const SOUL = { id: 's', name: 'Soul' };

describe('the characters shared with this install', () => {
  it('lists a sharer once, through the character that controls it', () => {
    const brakkle = sharedSheet('Brakkle', { control: true, heardAt: 5 });
    const views = new Map([
      ['r', view([brakkle])],
      ['s', view([brakkle], { name: 'brakkle', key: brakkle.key })]
    ]);
    const remotes = remoteCharacters([RAYZOR, SOUL], views);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({ via: 's', viaName: 'Soul', controlled: true });
  });

  it('prefers a character given control over one shown the sheet alone', () => {
    const views = new Map([
      ['r', view([sharedSheet('Brakkle')])],
      ['s', view([sharedSheet('Brakkle', { control: true })])]
    ]);
    expect(remoteCharacters([RAYZOR, SOUL], views)[0]).toMatchObject({
      via: 's',
      controlled: false
    });
  });

  it('keeps the rail order and lists nothing for characters shown no sheets', () => {
    const views = new Map([
      ['r', view([sharedSheet('Mirage')])],
      ['s', view([sharedSheet('Brakkle'), sharedSheet('Mirage', { control: true })])]
    ]);
    expect(remoteCharacters([RAYZOR, SOUL], views).map((each) => each.name)).toEqual([
      'Mirage',
      'Brakkle'
    ]);
    expect(remoteCharacters([RAYZOR], new Map([['r', view([])]]))).toEqual([]);
  });

  it('keeps a controlled character listed when its sheet is no longer fresh', () => {
    const views = new Map([['r', view([], { name: 'Brakkle', key: 'key-Brakkle' })]]);
    const [only, ...rest] = remoteCharacters([RAYZOR], views);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ name: 'Brakkle', via: 'r', controlled: true, control: true });
    expect(only!.sheet).toBe(UNKNOWN_PEER_SHEET);
  });

  it('moves a stale control onto the row another character still has a sheet for', () => {
    const views = new Map([
      ['r', view([sharedSheet('Brakkle', { control: true })])],
      ['s', view([], { name: 'Brakkle', key: 'key-Brakkle' })]
    ]);
    const remotes = remoteCharacters([RAYZOR, SOUL], views);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({ via: 's', viaName: 'Soul', controlled: true });
    expect(remotes[0]!.sheet).not.toBe(UNKNOWN_PEER_SHEET);
  });

  it('shows a remote console only where control is open and not set aside', () => {
    const views = new Map([
      ['r', view([], { name: 'Brakkle', key: 'key-Brakkle' })],
      ['s', view([sharedSheet('Brakkle', { control: true })])]
    ]);
    const controlling = controllers(views);
    const aside = createRemoteAside();
    expect(showsRemote(controlling, 'r', aside.read())).toBe(true);
    expect(showsRemote(controlling, 's', aside.read())).toBe(false);
    aside.set('r', true);
    expect(showsRemote(controlling, 'r', aside.read())).toBe(false);
  });
});

describe('the consoles set aside', () => {
  it('tells its listeners of a change, and only of a change', () => {
    const aside = createRemoteAside();
    let heard = 0;
    const off = aside.subscribe(() => (heard += 1));
    const before = aside.read();
    aside.set('r', true);
    aside.set('r', true);
    expect(heard).toBe(1);
    expect(aside.read()).not.toBe(before);
    aside.set('r', false);
    expect(heard).toBe(2);
    expect(aside.read().has('r')).toBe(false);
    off();
    aside.set('r', true);
    expect(heard).toBe(2);
  });
});
