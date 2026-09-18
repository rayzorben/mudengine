import { describe, expect, it } from 'vitest';

import { credentialsNamed, fillLogin } from '../login';

const account = { username: 'vaelor', password: 'secret' };

describe('filling a login step', () => {
  it('leaves an answer with no placeholder exactly as written', () => {
    // Which is every menu row, and is why this runs over the whole script
    // rather than over rows somebody has had to mark.
    expect(fillLogin('P', account)).toEqual({ kind: 'filled', command: 'P', credentials: [] });
    expect(fillLogin('', account)).toEqual({ kind: 'filled', command: '', credentials: [] });
  });

  it('sends the account where a placeholder names it', () => {
    expect(fillLogin('{user}', account)).toEqual({
      kind: 'filled',
      command: 'vaelor',
      credentials: ['username']
    });
    expect(fillLogin('{password}', account)).toEqual({
      kind: 'filled',
      command: 'secret',
      credentials: ['password']
    });
  });

  /*
   * Both spellings of each, because both are the obvious one to somebody who
   * has not read the module — and a client that sent `{username}` verbatim at
   * a password prompt would be teaching that lesson at the worst moment.
   */
  it('takes either spelling, however it is capitalised', () => {
    for (const send of ['{username}', '{USER}', '{User}']) {
      expect(fillLogin(send, account)).toMatchObject({ command: 'vaelor' });
    }
    for (const send of ['{pass}', '{PASSWORD}']) {
      expect(fillLogin(send, account)).toMatchObject({ command: 'secret' });
    }
  });

  /* A BBS that asks for both on one line, which is why this is a template. */
  it('fills a placeholder that is only part of the answer', () => {
    expect(fillLogin('login {user} {password}', account)).toEqual({
      kind: 'filled',
      command: 'login vaelor secret',
      credentials: ['username', 'password']
    });
  });

  it('refuses rather than sending a blank where a credential is missing', () => {
    // The old shape's rule, kept: a missing password leaves the prompt for the
    // player rather than sending an empty line at a live service.
    expect(fillLogin('{password}', { username: 'vaelor', password: '' })).toEqual({
      kind: 'missing',
      credential: 'password'
    });
  });

  it('refuses a placeholder it does not know, naming it', () => {
    expect(fillLogin('{slot}', account)).toEqual({ kind: 'unknown', placeholder: '{slot}' });
  });

  /*
   * A typo outranks a missing value: the placeholder nobody can fill in is the
   * one the player has to fix, and naming the other first would send them to a
   * field that is already correct.
   */
  it('reports the typo first when a row has both faults', () => {
    expect(fillLogin('{slot} {password}', { username: '', password: '' })).toEqual({
      kind: 'unknown',
      placeholder: '{slot}'
    });
  });
});

describe('which credentials a row would send', () => {
  /*
   * Asked before filling, because the automator decides whether to send a row
   * by what it *would* send — and the migration asks the weaker question of
   * whether a script already names the account at all.
   */
  it('names them, filled in or not', () => {
    expect(credentialsNamed('{user}')).toEqual(['username']);
    expect(credentialsNamed('login {PASSWORD} now')).toEqual(['password']);
    expect(credentialsNamed('{user} {password}')).toEqual(['username', 'password']);
  });

  /* Twice in one answer is one credential: it goes out once either way. */
  it('names each one once', () => {
    expect(credentialsNamed('{user} {username}')).toEqual(['username']);
  });

  it('names none for a menu row or a placeholder that means nothing', () => {
    expect(credentialsNamed('P')).toEqual([]);
    expect(credentialsNamed('')).toEqual([]);
    expect(credentialsNamed('{slot}')).toEqual([]);
  });

  /* Called once per row per line and per file; no shared regex state. */
  it('gives the same answer every time it is asked', () => {
    for (let i = 0; i < 3; i += 1) expect(credentialsNamed('{user}')).toEqual(['username']);
  });
});
