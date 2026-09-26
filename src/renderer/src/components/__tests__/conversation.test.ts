/**
 * The Talk card's channel words and the composer's picker agree, word for word.
 *
 * The card's filter chips and per-line channel words come from the dictionary
 * (`cards.talk.channels.*`, read in ConversationCard.tsx), while the picker's
 * rows read `TALK_CHANNELS[].label` from `src/shared/talk.ts`, which stays
 * dependency-free and cannot read the dictionary. Nothing ties the two tables
 * together at build time, so a renamed label would silently lose its word —
 * the closed-union drift `guard-fields.test.ts` exists for. Each dictionary
 * key is named by the label itself, so a renamed label misses its key. What
 * the dictionary says for it is the user's to reword, and is never asserted.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { asUiDict, flattenDict } from '@shared/i18n';
import { TALK_CHANNELS } from '@shared/talk';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

describe('the Talk card and the picker speak one vocabulary', () => {
  const dict = asUiDict(parse(readFileSync(join(ROOT, 'locales', 'ui.en.yaml'), 'utf8')));
  expect(dict, 'locales/ui.en.yaml must parse to a dictionary of strings').not.toBeNull();
  const words = flattenDict(dict ?? {});

  it('has a word for every picker channel, keyed by its own label', () => {
    for (const channel of TALK_CHANNELS) {
      expect(
        words.get(`cards.talk.channels.${channel.label}`),
        `picker channel '${channel.word}'`
      ).toMatch(/\S/);
    }
  });
});
