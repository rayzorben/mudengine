import { describe, expect, it } from 'vitest';

import { openedAs, remoteCharacters } from '../remoteCharacters';
import type { SessionSummary } from '@shared/ipc';
import { NO_SHARES, type SharedSheet, type ShareView } from '@shared/peers';
import { IDLE_CONNECTION } from '@shared/types';
import { sharedSheet } from '@shared/__tests__/sharedSheets';

/*
 * Todo 20261031-1156-01: the tab rail lists each character shared with this
 * install once, opened through a character it gives control.
 */
const view = (sheets: SharedSheet[]): ShareView => ({ ...NO_SHARES, enabled: true, sheets });
const RAYZOR = { id: 'r', name: 'Rayzor' };
const SOUL = { id: 's', name: 'Soul' };

describe('the characters shared with this install', () => {
  it('lists a sharer once, through the first character it gives control', () => {
    const views = new Map([
      ['r', view([sharedSheet('Brakkle')])],
      ['s', view([sharedSheet('Brakkle', { control: true })])]
    ]);
    const remotes = remoteCharacters([RAYZOR, SOUL], views);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({ name: 'Brakkle', via: 's', viaName: 'Soul', control: true });
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

  it('finds the session a sharer is opened as, by name in any case', () => {
    const opened: SessionSummary[] = [
      {
        id: '@remote:s:brakkle',
        name: 'Brakkle',
        server: 'orohost:2427/GreaterMUD',
        accent: 'violet',
        state: IDLE_CONNECTION,
        retrying: false,
        remote: { via: 's', viaName: 'Soul' }
      }
    ];
    expect(openedAs(opened, 'brakkle')?.id).toBe('@remote:s:brakkle');
    expect(openedAs(opened, 'Mirage')).toBeUndefined();
  });
});
