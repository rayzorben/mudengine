import { describe, expect, it } from 'vitest';

import type { KeyStore } from '../storage';
import { dropTalkAll, settleTalkAll, takeTalkAllNotice } from '../talkFilters';

/** A store over a plain map, holding what `localStorage` would. */
function store(entries: Record<string, string>): KeyStore & { held: Map<string, string> } {
  const held = new Map(Object.entries(entries));
  return {
    held,
    read: (key) => held.get(key) ?? null,
    forget: (key) => void held.delete(key)
  };
}

const ALL = 'mudengine.talk-all.rayzor';
const MUTED = 'mudengine.talk-muted.rayzor';

/* The Talk card lost its All toggle (user, 2026-11-03); `talk-muted` alone decides now. */
describe('the stored All toggle', () => {
  it('clears the muted set where All was on, and says so', () => {
    const kept = store({ [ALL]: 'on', [MUTED]: '["gossip"]' });
    expect(dropTalkAll(kept, 'rayzor')).toBe(true);
    expect([...kept.held.keys()]).toEqual([]);
  });

  it('keeps the muted set where All was off, since that is what was drawn', () => {
    const kept = store({ [ALL]: 'off', [MUTED]: '["gossip"]' });
    expect(dropTalkAll(kept, 'rayzor')).toBe(false);
    expect([...kept.held]).toEqual([[MUTED, '["gossip"]']]);
  });

  it('says nothing where All was on with nothing muted', () => {
    const kept = store({ [ALL]: 'on', [MUTED]: '[]' });
    expect(dropTalkAll(kept, 'rayzor')).toBe(false);
    expect(kept.held.size).toBe(0);
  });

  it('does nothing where neither key is stored', () => {
    const kept = store({ 'mudengine.talk-mentions.rayzor': 'on' });
    expect(dropTalkAll(kept, 'rayzor')).toBe(false);
    expect(kept.held.size).toBe(1);
  });

  it('touches only its own character', () => {
    const kept = store({ [ALL]: 'on', 'mudengine.talk-muted.festus': '["page"]' });
    dropTalkAll(kept, 'rayzor');
    expect([...kept.held.keys()]).toEqual(['mudengine.talk-muted.festus']);
  });

  it('run twice is the same as once', () => {
    const kept = store({ [ALL]: 'on', [MUTED]: '["gossip"]' });
    dropTalkAll(kept, 'rayzor');
    expect(dropTalkAll(kept, 'rayzor')).toBe(false);
    expect(kept.held.size).toBe(0);
  });

  it('hands the notice out once per character, however often the card draws', () => {
    const kept = store({
      'mudengine.talk-all.vaelor': 'on',
      'mudengine.talk-muted.vaelor': '["auction"]'
    });
    settleTalkAll(kept, 'vaelor');
    settleTalkAll(kept, 'vaelor');
    expect(takeTalkAllNotice('vaelor')).toBe(true);
    expect(takeTalkAllNotice('vaelor')).toBe(false);
  });
});
