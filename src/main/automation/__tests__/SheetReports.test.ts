import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { formatStats } from '../../../shared/remotes';
import { SheetReports } from '../SheetReports';

/** Leading Rand, at `level` with a full sheet. */
const leading = (level: number, inParty = true): CharacterState => {
  const state = structuredClone(EMPTY_CHARACTER);
  state.name = 'Vaelor';
  state.progress = {
    ...state.progress,
    strength: 50,
    intellect: 40,
    willpower: 40,
    agility: 60,
    health: 50,
    charm: 30,
    level,
    traps: 40,
    picklocks: 35
  };
  state.party = {
    ...state.party,
    following: null,
    members: inParty
      ? [
          {
            name: 'Rand',
            className: null,
            health: 1,
            mana: null,
            rank: null,
            activity: null,
            invited: false,
            vitals: null,
            sheet: null
          }
        ]
      : []
  };
  return state;
};

/* Todo 86: `@stats` sent on when the sheet changes, to a member who asked. */
describe('sending a changed sheet on', () => {
  const unit = (): { sheets: SheetReports; sent: string[] } => {
    const sent: string[] = [];
    const sheets = new SheetReports({
      enqueue: (intent) => {
        sent.push(intent.command);
        return true;
      }
    });
    return { sheets, sent };
  };

  it('sends the new sheet once after a level, and nothing while it holds', () => {
    const { sheets, sent } = unit();
    sheets.answered('Rand', formatStats(leading(10).progress)!);
    sheets.onCharacter(leading(10));
    expect(sent).toEqual([]);
    sheets.onCharacter(leading(11));
    sheets.onCharacter(leading(11));
    expect(sent).toEqual([`/Rand ${formatStats(leading(11).progress)}`]);
  });

  /* The positive control is the test above: in the party, the same change is sent. */
  it('sends nothing to a member who left the party, and forgets them', () => {
    const { sheets, sent } = unit();
    sheets.answered('Rand', formatStats(leading(10).progress)!);
    sheets.onCharacter(leading(11, false));
    sheets.onCharacter(leading(12));
    expect(sent).toEqual([]);
  });
});
