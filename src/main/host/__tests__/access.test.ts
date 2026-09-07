import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AccessTokens,
  basicPassword,
  COOKIE,
  cookieToken,
  generatePassword,
  passwordMatches,
  PASSWORD_FILE,
  resolveAccessPassword
} from '../web/access';

let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-access-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveAccessPassword', () => {
  it('takes MUDENGINE_PASSWORD over everything, and writes nothing', () => {
    fs.writeFileSync(path.join(home, PASSWORD_FILE), 'saved-one');
    const access = resolveAccessPassword({ MUDENGINE_PASSWORD: 'chosen' }, home);
    expect(access).toMatchObject({ password: 'chosen', source: 'env' });
    expect(fs.readFileSync(path.join(home, PASSWORD_FILE), 'utf8')).toBe('saved-one');
  });

  it('reads what a previous start saved, trailing newline or not', () => {
    fs.writeFileSync(path.join(home, PASSWORD_FILE), 'saved-one\n');
    expect(resolveAccessPassword({}, home)).toMatchObject({
      password: 'saved-one',
      source: 'saved'
    });
  });

  it('generates one on the first start, saves it 0600, and finds it on the second', () => {
    const first = resolveAccessPassword({}, home, () => 'generated-one');
    expect(first).toMatchObject({ password: 'generated-one', source: 'generated' });
    const file = path.join(home, PASSWORD_FILE);
    expect(fs.readFileSync(file, 'utf8')).toBe('generated-one');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const second = resolveAccessPassword({}, home, () => 'would-be-a-new-one');
    expect(second).toMatchObject({ password: 'generated-one', source: 'saved' });
  });

  it('creates the home if it does not exist yet', () => {
    const fresh = path.join(home, 'nested', 'home');
    const access = resolveAccessPassword({}, fresh, () => 'p');
    expect(access.source).toBe('generated');
    expect(fs.existsSync(path.join(fresh, PASSWORD_FILE))).toBe(true);
  });

  it('refuses to replace a saved password it cannot read', () => {
    // A directory where the file should be: exists, and is not a password.
    fs.mkdirSync(path.join(home, PASSWORD_FILE));
    expect(() => resolveAccessPassword({}, home, () => 'p')).toThrow();
  });
});

describe('generatePassword', () => {
  it('is the length asked for, from letters and digits only', () => {
    for (let i = 0; i < 20; i += 1) {
      const password = generatePassword(24);
      expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
    }
  });

  it('does not repeat itself', () => {
    expect(generatePassword(24)).not.toBe(generatePassword(24));
  });
});

describe('passwordMatches', () => {
  it('matches the same string and nothing else, whatever the length', () => {
    expect(passwordMatches('abc', 'abc')).toBe(true);
    expect(passwordMatches('abc', 'abd')).toBe(false);
    expect(passwordMatches('ab', 'abc')).toBe(false);
    expect(passwordMatches('', 'abc')).toBe(false);
  });
});

describe('AccessTokens', () => {
  it('knows the tokens it issued and no others', () => {
    const tokens = new AccessTokens();
    const token = tokens.issue();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.has(token)).toBe(true);
    expect(tokens.has(token.replace(/./, 'z'))).toBe(false);
    expect(tokens.has(null)).toBe(false);
    tokens.revoke(token);
    expect(tokens.has(token)).toBe(false);
  });
});

describe('cookieToken', () => {
  it('finds the session cookie among others', () => {
    const token = 'a'.repeat(64);
    expect(cookieToken(`theme=dark; ${COOKIE}=${token}; other=1`)).toBe(token);
    expect(cookieToken(`${COOKIE}=${token}`)).toBe(token);
  });

  it('refuses a value that is not a token', () => {
    expect(cookieToken(`${COOKIE}=short`)).toBeNull();
    expect(cookieToken(`${COOKIE}x=${'a'.repeat(64)}`)).toBeNull();
    expect(cookieToken(undefined)).toBeNull();
  });
});

describe('basicPassword', () => {
  it('takes the password after the first colon, whoever the user is', () => {
    const header = `Basic ${Buffer.from('anyone:pass:with:colons').toString('base64')}`;
    expect(basicPassword(header)).toBe('pass:with:colons');
  });

  it('refuses anything that is not Basic', () => {
    expect(basicPassword('Bearer abc')).toBeNull();
    expect(basicPassword(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeNull();
    expect(basicPassword(undefined)).toBeNull();
  });
});
