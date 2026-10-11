import { describe, expect, it } from 'vitest';

import { realmName, realmNamedAt, realmOf } from '../types';

/* Todo 34: Paradigm's PvE and PvP behind one address are two realms. */
describe('which realm a connection plays', () => {
  const paramud = { host: 'Paramud.mudinfo.net ', port: 2323 };

  it('names the address alone without a menu, and the choice after it', () => {
    expect(realmName(realmOf({ host: 'orohost', port: 2427 }))).toBe('orohost:2427');
    expect(realmName(realmOf(paramud, 'Paradigm PVP'))).toBe(
      'paramud.mudinfo.net:2323/Paradigm PVP'
    );
    expect(realmName(realmOf(paramud, 'Paradigm PVE'))).not.toBe(
      realmName(realmOf(paramud, 'Paradigm PVP'))
    );
  });

  it('reads a written name back at its own address only', () => {
    const name = realmName(realmOf(paramud, 'Paradigm PVP'));
    expect(realmNamedAt(name, paramud)).toEqual(realmOf(paramud, 'Paradigm PVP'));
    expect(realmNamedAt('paramud.mudinfo.net:2323', paramud)).toEqual(realmOf(paramud));
    expect(realmNamedAt(name, { host: 'orohost', port: 2427 })).toBeNull();
    expect(realmNamedAt('paramud.mudinfo.net:2323/', paramud)).toBeNull();
  });
});
