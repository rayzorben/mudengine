import { describe, expect, it } from 'vitest';

import { BUILD, buildId, versionWithCommit, type BuildStamp } from '../build';
import type { UiLookup } from '../i18n';

const lookup: UiLookup = (key, params) => `${key}${params ? JSON.stringify(params) : ''}`;
const stamp = (over: Partial<BuildStamp> = {}): BuildStamp => ({
  commit: '4c461dec',
  dirty: false,
  builtAt: '2026-10-10T18:00:00.000Z',
  ...over
});

describe('the version with its commit', () => {
  it('names the commit, marked -dirty when built with uncommitted changes', () => {
    expect(versionWithCommit('0.8.5', stamp(), lookup)).toBe(
      lookup('app.versionWithCommit', { version: '0.8.5', commit: '4c461dec' })
    );
    expect(versionWithCommit('0.8.5', stamp({ dirty: true }), lookup)).toBe(
      lookup('app.versionWithCommit', { version: '0.8.5', commit: '4c461dec-dirty' })
    );
  });

  it('says unknown where the build could not tell', () => {
    expect(versionWithCommit('0.8.5', stamp({ commit: null }), lookup)).toBe(
      lookup('app.versionWithCommit', { version: '0.8.5', commit: lookup('app.commitUnknown') })
    );
  });

  it('is unstamped when run from source', () => {
    expect(BUILD).toEqual({ commit: null, dirty: false, builtAt: null });
  });
});

describe('one build told from another', () => {
  it('is the commit and when it was made, or nothing where unstamped', () => {
    const at = '2026-10-11T22:00:00.000Z';
    expect(buildId({ commit: 'd22df5a6', dirty: false, builtAt: at })).toBe(`d22df5a6@${at}`);
    expect(
      buildId({ commit: 'd22df5a6', dirty: false, builtAt: '2026-10-12T01:00:00.000Z' })
    ).not.toBe(buildId({ commit: 'd22df5a6', dirty: false, builtAt: at }));
    expect(buildId({ commit: null, dirty: false, builtAt: null })).toBeNull();
  });
});
