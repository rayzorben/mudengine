import { describe, expect, it } from 'vitest';

import {
  ACTIONABLE_REMOTES,
  isActionable,
  isRemoteName,
  isRemoteStance,
  judgeRemote,
  reachableBy,
  REMOTE_NAMES,
  REMOTE_STANCES,
  stanceFor,
  type RemoteAccess,
  type RemoteName
} from '../remotes';
import { DEFAULT_CONFIG, normalizeConfig } from '../config';

const access = (over: Partial<RemoteAccess> = {}): RemoteAccess => ({
  gang: [],
  party: [],
  players: {},
  ...over
});

const stranger = { inGang: null, inParty: false };
const inGang = { inGang: true, inParty: false };
const notInGang = { inGang: false, inParty: false };
const inParty = { inGang: null, inParty: true };

describe('what one player may ask for', () => {
  it('grants nobody anything by default, which is what the shipped config states', () => {
    expect(DEFAULT_CONFIG.automation.remotes.gang).toEqual([]);
    expect(DEFAULT_CONFIG.automation.remotes.players).toEqual({});
    /*
     * The party list is the one exception, and it is only reached by somebody
     * on this character's own party listing — so "nobody" still holds for a
     * stranger, which is what this case is about.
     */
    expect(DEFAULT_CONFIG.automation.remotes.party).not.toEqual([]);
    expect(judgeRemote('Rend', 'health', access(), stranger)).toEqual({
      allowed: false,
      because: 'not-granted',
      gangUnresolved: false,
      notInParty: false
    });
  });

  it('allows a remote on that player’s own list', () => {
    const settings = access({ players: { soul: { allow: ['health'], deny: [] } } });
    expect(judgeRemote('Soul', 'health', settings, stranger)).toEqual({
      allowed: true,
      because: 'player'
    });
  });

  it('grants only the remote that was named, and nothing beside it', () => {
    /*
     * The whole reason the grounds went. Under the old model `named` allowed
     * `@do` along with `@health`, and there was no way to say otherwise.
     */
    const settings = access({ players: { soul: { allow: ['health'], deny: [] } } });
    expect(judgeRemote('Soul', 'do', settings, stranger).allowed).toBe(false);
  });

  it('files a name without regard to case, because the server does not keep it', () => {
    const settings = access({ players: { soul: { allow: ['health'], deny: [] } } });
    expect(judgeRemote('SOUL', 'health', settings, stranger).allowed).toBe(true);
    expect(judgeRemote('  Soul  ', 'health', settings, stranger).allowed).toBe(true);
  });
});

describe('the gang grants, and only to somebody the roster puts in it', () => {
  const settings = access({ gang: ['health', 'where'] });

  it('allows a member', () => {
    expect(judgeRemote('Spike', 'health', settings, inGang)).toEqual({
      allowed: true,
      because: 'gang'
    });
  });

  it('refuses somebody the roster puts in another gang, without calling it unresolved', () => {
    expect(judgeRemote('Spike', 'health', settings, notInGang)).toEqual({
      allowed: false,
      because: 'not-granted',
      gangUnresolved: false,
      notInParty: false
    });
  });

  it('never allows while nothing has said, and names the ground it could not stand on', () => {
    /*
     * Unknown is never the reassuring answer, and here the reassuring answer is
     * the one that lets a stranger through. The refusal has to say *why*, or
     * somebody who granted their gang `@health` watches it be refused with no
     * way to tell that a `who` would settle it.
     */
    expect(judgeRemote('Spike', 'health', settings, stranger)).toEqual({
      allowed: false,
      because: 'not-granted',
      gangUnresolved: true,
      notInParty: false
    });
  });

  it('does not call it unresolved for a remote the gang was never granted', () => {
    expect(judgeRemote('Spike', 'do', settings, stranger)).toEqual({
      allowed: false,
      because: 'not-granted',
      gangUnresolved: false,
      notInParty: false
    });
  });

  it('stops granting the moment the roster stops putting them in it', () => {
    // Nothing is copied onto a member, so "they left the gang" and "they lost
    // the gang's remotes" are one fact rather than two that can drift.
    expect(judgeRemote('Spike', 'where', settings, inGang).allowed).toBe(true);
    expect(judgeRemote('Spike', 'where', settings, notInGang).allowed).toBe(false);
  });
});

describe('the party grants, and only to somebody who has joined it', () => {
  const settings = access({ party: ['health', 'where'] });

  it('allows a member', () => {
    expect(judgeRemote('Soul', 'health', settings, inParty)).toEqual({
      allowed: true,
      because: 'party'
    });
  });

  it('refuses somebody who is not on the listing, and says that rather than "stranger"', () => {
    /*
     * The two reasons somebody sees nothing happen are opposite: nothing
     * grants this command to anybody, or the party grants it and they are not
     * in the party. One is settled by a `party`; the other is not.
     */
    expect(judgeRemote('Rend', 'health', settings, stranger)).toEqual({
      allowed: false,
      because: 'not-granted',
      gangUnresolved: false,
      notInParty: true
    });
  });

  it('does not say it for a remote the party was never granted', () => {
    expect(judgeRemote('Rend', 'do', settings, stranger)).toEqual({
      allowed: false,
      because: 'not-granted',
      gangUnresolved: false,
      notInParty: false
    });
  });

  it('stops granting the moment the listing stops naming them', () => {
    // Nothing is copied onto a member: leaving the party and losing the
    // party's remotes are one fact, the way they are for the gang.
    expect(judgeRemote('Soul', 'where', settings, inParty).allowed).toBe(true);
    expect(judgeRemote('Soul', 'where', settings, stranger).allowed).toBe(false);
  });

  it('is refused by a deny on that player, which is the whole of the todo', () => {
    /*
     * `@exp` allowed to the party and denied to one person by name is denied.
     * A permission somebody else can hand out — and anybody can join a party —
     * must not be able to lift one made by name.
     */
    const named = access({ party: ['exp'], players: { rend: { allow: [], deny: ['exp'] } } });
    expect(judgeRemote('Rend', 'exp', named, { inGang: null, inParty: true })).toEqual({
      allowed: false,
      because: 'denied'
    });
  });

  it('is not granted by an invitation, which is what `inParty` being false means here', () => {
    // `joinedTheParty` is where an `[Invited]` row is refused; this is the
    // half that says a false answer from it grants nothing.
    expect(judgeRemote('Soul', 'health', settings, { inGang: null, inParty: false }).allowed).toBe(
      false
    );
  });

  it('grants alongside the gang rather than instead of it', () => {
    const both = access({ gang: ['do'], party: ['health'] });
    expect(judgeRemote('Spike', 'do', both, { inGang: true, inParty: true }).because).toBe('gang');
    expect(judgeRemote('Spike', 'health', both, { inGang: true, inParty: true }).because).toBe(
      'party'
    );
  });
});

describe('a deny is about one person and outranks everything', () => {
  /*
   * The order is the whole safety property, and it is what makes "the gang,
   * except Rend" expressible at all — which the old block list could only say
   * about *every* command at once.
   */
  it('beats the gang', () => {
    const settings = access({
      gang: ['health'],
      players: { rend: { allow: [], deny: ['health'] } }
    });
    expect(judgeRemote('Rend', 'health', settings, inGang)).toEqual({
      allowed: false,
      because: 'denied'
    });
  });

  it('beats an allow on the same player, so a name in both lists is refused', () => {
    const settings = access({ players: { rend: { allow: ['do'], deny: ['do'] } } });
    expect(judgeRemote('Rend', 'do', settings, stranger).because).toBe('denied');
  });

  it('takes away only what it names', () => {
    const settings = access({
      gang: ['health', 'where'],
      players: { rend: { allow: [], deny: ['health'] } }
    });
    expect(judgeRemote('Rend', 'where', settings, inGang).allowed).toBe(true);
  });
});

describe('reachability is a different question from permission', () => {
  /*
   * Its one caller decides whether a command on a channel this client never
   * answers on is worth *reporting*. A stranger gossiping `@health` must not
   * produce a notice on every mudengine character in the realm, once per line.
   */
  it('is false for somebody with no relationship to this character', () => {
    expect(reachableBy('Rend', access({ gang: ['health'] }), stranger)).toBe(false);
    expect(reachableBy('Rend', access({ gang: ['health'] }), notInGang)).toBe(false);
  });

  it('is true for a gang member when the gang grants anything at all', () => {
    expect(reachableBy('Spike', access({ gang: ['health'] }), inGang)).toBe(true);
    expect(reachableBy('Spike', access(), inGang)).toBe(false);
  });

  it('is true for somebody who has joined the party when the party grants anything', () => {
    expect(reachableBy('Soul', access({ party: ['health'] }), inParty)).toBe(true);
    expect(reachableBy('Soul', access(), inParty)).toBe(false);
    expect(reachableBy('Soul', access({ party: ['health'] }), stranger)).toBe(false);
  });

  it('is true for somebody named, and a deny does not subtract from it', () => {
    // Somebody with one remote allowed and one denied is still somebody this
    // character has a relationship with, and their attempts are worth seeing.
    const settings = access({ players: { soul: { allow: ['health'], deny: ['do'] } } });
    expect(reachableBy('Soul', settings, stranger)).toBe(true);
  });

  it('is false for somebody who is only denied things', () => {
    const settings = access({ players: { rend: { allow: [], deny: ['do'] } } });
    expect(reachableBy('Rend', settings, stranger)).toBe(false);
  });
});

describe('the stance a form shows is the decision, not the verdict', () => {
  /*
   * Conflating them is how somebody clicks Allow on a person the gang already
   * covered and sees nothing change — the button would already have been lit.
   */
  it('reads unset for a remote only the gang grants', () => {
    const settings = access({ gang: ['health'] });
    expect(stanceFor(settings, 'Spike', 'health')).toBe('unset');
    expect(judgeRemote('Spike', 'health', settings, inGang).allowed).toBe(true);
  });

  it('reads what the player’s own entry says otherwise', () => {
    const settings = access({ players: { soul: { allow: ['health'], deny: ['do'] } } });
    expect(stanceFor(settings, 'Soul', 'health')).toBe('allow');
    expect(stanceFor(settings, 'Soul', 'do')).toBe('deny');
    expect(stanceFor(settings, 'Soul', 'where')).toBe('unset');
  });

  it('knows a stance and a remote off the wire, and refuses what it does not', () => {
    expect(REMOTE_STANCES).toEqual(['allow', 'deny', 'unset']);
    expect(isRemoteStance('deny')).toBe(true);
    expect(isRemoteStance('block')).toBe(false);
    expect(isRemoteStance(null)).toBe(false);
    expect(isRemoteName('health')).toBe(true);
    expect(isRemoteName('healthy')).toBe(false);
    expect(isRemoteName(7)).toBe(false);
  });
});

describe('only an actionable remote is worth granting', () => {
  /*
   * A grant for a command this client will never answer is a permission
   * somebody sets and waits to see work — the failure this codebase already
   * wrote down for the `realm` guard field and for `ui.showDiagnostics`.
   */
  it('is exactly the answered and acted ones, and every surface uses that list', () => {
    expect(ACTIONABLE_REMOTES).toEqual(REMOTE_NAMES.filter(isActionable));
    expect(ACTIONABLE_REMOTES).toContain('health');
    expect(ACTIONABLE_REMOTES).toContain('do');
    expect(ACTIONABLE_REMOTES).not.toContain('kill');
    expect(ACTIONABLE_REMOTES).not.toContain('goto');
  });

  it('grants one when it is granted, so the list is not merely decorative', () => {
    // The positive control: a name that survives `ACTIONABLE_REMOTES` must also
    // be one `judgeRemote` will allow, or "allow all" would grant nothing.
    const settings = access({ gang: [...ACTIONABLE_REMOTES] });
    for (const remote of ACTIONABLE_REMOTES) {
      expect(judgeRemote('Spike', remote, settings, inGang).allowed).toBe(true);
    }
  });
});

describe('the two halves of the remote union move together', () => {
  /*
   * The `guard-fields.test.ts` rule, applied to this union: the type and the
   * runtime list that validates against it are two halves of one closed set,
   * and a name in one and not the other type-checks, then fails to load, and
   * the only symptom is a permission that never grants.
   */
  it('normalizes every remote the type declares', () => {
    for (const remote of REMOTE_NAMES) {
      const config = normalizeConfig({ automation: { remotes: { gang: [remote] } } });
      expect(config.automation.remotes.gang).toEqual([remote]);
      const party = normalizeConfig({ automation: { remotes: { party: [remote] } } });
      expect(party.automation.remotes.party).toEqual([remote]);
    }
  });

  it('drops a remote the union does not have rather than falling back', () => {
    /*
     * Dropping narrows and defaulting widens. A typo must never be the thing
     * that lets somebody in, so an unreadable name yields fewer grants — not
     * the shipped default, and not the whole list.
     */
    const config = normalizeConfig({
      automation: { remotes: { gang: ['health', 'helth', 'where'] } }
    });
    expect(config.automation.remotes.gang).toEqual<RemoteName[]>(['health', 'where']);
  });

  it('reads a leading @ off, because that is how a person writes one', () => {
    const config = normalizeConfig({ automation: { remotes: { gang: ['@health'] } } });
    expect(config.automation.remotes.gang).toEqual(['health']);
  });

  it('accepts a single word where a list is allowed, like every other list', () => {
    const config = normalizeConfig({ automation: { remotes: { gang: 'health' } } });
    expect(config.automation.remotes.gang).toEqual(['health']);
  });

  it('states one remote once however many times the file says it', () => {
    const config = normalizeConfig({
      automation: { remotes: { gang: ['health', 'health', 'where'] } }
    });
    expect(config.automation.remotes.gang).toEqual(['health', 'where']);
  });

  it('keeps an explicitly empty list, because granting nobody is a choice', () => {
    const config = normalizeConfig({ automation: { remotes: { gang: [] } } });
    expect(config.automation.remotes.gang).toEqual([]);
  });

  it('lower-cases a player key, so one person is one grant', () => {
    /*
     * `Soul:` clicked off a `who` listing and `soul:` typed in by hand are one
     * person. Two keys would be one grant that works and one that silently does
     * not, which is the shape of every permission bug this file guards.
     */
    const config = normalizeConfig({
      automation: {
        remotes: {
          players: {
            Soul: { allow: ['health'], deny: [] },
            soul: { allow: ['where'], deny: ['do'] }
          }
        }
      }
    });
    expect(config.automation.remotes.players).toEqual({
      soul: { allow: ['health', 'where'], deny: ['do'] }
    });
  });

  it('reads a malformed grant as nothing rather than guessing at it', () => {
    const config = normalizeConfig({
      automation: { remotes: { players: { soul: 'everything', '': { allow: ['do'] } } } }
    });
    expect(config.automation.remotes.players).toEqual({});
  });

  it('has a switch for the gangpath, off, like everything automated', () => {
    expect(DEFAULT_CONFIG.automation.remotes.gangpath).toBe(false);
    expect(
      normalizeConfig({ automation: { remotes: { gangpath: true } } }).automation.remotes.gangpath
    ).toBe(true);
  });
});
