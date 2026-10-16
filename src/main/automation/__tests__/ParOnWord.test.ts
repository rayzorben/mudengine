import { beforeEach, describe, expect, it } from 'vitest';

import { t } from '../../app/i18n';
import type { Intent, Offered } from '../CommandQueue';
import { ParOnWord } from '../ParOnWord';
import { CONFIG } from '../walk/__tests__/walking';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { member } from '../../parse/presence';

const PAR = DEFAULT_CONFIG.automation.onPartyChange;
const AGAIN = DEFAULT_INTERNAL.tuning.remotes.parOnWordMs;

/* Todo 142: Brackle at `[H:100%]` by the last party list, saying he is low. */
const leading = (health: number | null): CharacterState => {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    name: 'Festus',
    party: {
      ...base.party,
      members: [member('Festus', { health: 1 }), member('Brackle', { health })]
    }
  };
};

describe("sending par on a member's word", () => {
  let offered: string[];
  let answer: Offered;
  let notices: string[];
  let clock: number;
  let par: ParOnWord;

  beforeEach(() => {
    offered = [];
    answer = 'queued';
    notices = [];
    clock = 0;
    const queue = {
      offer: (intent: Intent): Offered => {
        offered.push(intent.command);
        return answer;
      }
    };
    par = new ParOnWord(
      CONFIG,
      queue,
      (message) => notices.push(message),
      () => clock
    );
  });

  it('sends par on a walked-on @wait, once a window, and says so', () => {
    par.said('Brackle', 'wait', leading(1));
    expect(offered).toEqual([PAR]);
    expect(notices).toEqual([
      t('automation.remotes.parOnWord', { from: 'Brackle', word: '@wait' })
    ]);
    clock = AGAIN - 1;
    par.said('Brackle', 'wait', leading(1));
    expect(offered).toEqual([PAR]);
    clock = AGAIN;
    par.said('Brackle', 'wait', leading(1));
    expect(offered).toEqual([PAR, PAR]);
  });

  it('sends par on a @heal only while the bar shows nothing missing', () => {
    par.said('Brackle', 'heal', leading(1));
    expect(offered).toEqual([PAR]);
    clock = AGAIN;
    par.said('Brackle', 'heal', leading(0.6));
    expect(offered).toEqual([PAR]);
    // An unlisted bar is as good as full: the party list is what says otherwise.
    par.said('Brackle', 'heal', leading(null));
    expect(offered).toEqual([PAR, PAR]);
  });

  it('says a refusal once a window', () => {
    answer = 'offline';
    par.said('Brackle', 'wait', leading(1));
    par.said('Brackle', 'wait', leading(1));
    const refused = t('automation.remotes.parOnWordNotSent', { from: 'Brackle', word: '@wait' });
    expect(notices).toEqual([refused]);
  });
});
