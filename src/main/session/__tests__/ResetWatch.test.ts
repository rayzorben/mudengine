import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { CharacterIdentity, ResetSignal } from '../../../shared/reset';
import { ResetWatch } from '../ResetWatch';
import { StatlineReport } from '../StatlineReport';

/** Soul as the record held it, off `exp`: 2,463,069 with the quest reward in. */
const KEPT: CharacterIdentity = {
  race: 'Half-Ogre',
  className: 'Paladin',
  level: 15,
  exp: 2_463_069,
  at: 1
};

function soul(over: {
  className?: string | null;
  exp: number;
  promptExp: number | null;
  expBehind: number | null;
}): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    race: 'Half-Ogre',
    className: over.className === undefined ? 'Paladin' : over.className,
    progress: { ...EMPTY_CHARACTER.progress, level: 15, exp: over.exp },
    statline: { ...EMPTY_CHARACTER.statline, exp: over.promptExp, expBehind: over.expBehind }
  };
}

function watching(first: CharacterState) {
  const tracker = { current: first };
  let kept: CharacterIdentity | null = KEPT;
  const asked: ResetSignal[][] = [];
  const watch = new ResetWatch({
    tracker,
    record: () => ({
      recallIdentity: () => kept,
      rememberIdentity: (identity) => {
        kept = identity;
      }
    }),
    sink: { notice: () => undefined, reset: (prompt) => asked.push([...prompt.signals]) }
  });
  return {
    asked,
    kept: () => kept,
    see(state: CharacterState): void {
      tracker.current = state;
      watch.watch();
    }
  };
}

describe('a prompt whose Exp= is a quest reward behind', () => {
  it('does not ask at login, and keeps the experience the record held', () => {
    // The first prompt of a login: 750,000 under what `exp` stated last night.
    const login = soul({ exp: 1_713_069, promptExp: 1_713_069, expBehind: null });
    const session = watching(login);
    session.see(login);
    expect(session.kept()?.exp).toBe(2_463_069);
    // `exp` answers, and the prompt after it is corrected.
    session.see(soul({ exp: 2_463_069, promptExp: 1_713_069, expBehind: 750_000 }));
    // Positive control: the watch is asking, and asks about a class that changed.
    expect(session.asked).toEqual([]);
    session.see(
      soul({ className: 'Thief', exp: 2_463_069, promptExp: 1_713_069, expBehind: 750_000 })
    );
    expect(session.asked).toEqual([['class']]);
  });

  it('still asks when the checked figure is far under what was kept', () => {
    const session = watching(soul({ exp: 1_000, promptExp: 1_000, expBehind: null }));
    session.see(soul({ exp: 1_000, promptExp: 1_000, expBehind: null }));
    expect(session.asked).toEqual([]);
    session.see(soul({ exp: 1_000, promptExp: 1_000, expBehind: 0 }));
    expect(session.asked).toEqual([['experience']]);
  });
});

describe('what is said about the prompt against exp', () => {
  const noticesOf = (states: CharacterState[]): string[] => {
    const notices: string[] = [];
    const report = new StatlineReport({ notice: (message) => notices.push(message) });
    for (const state of states) report.noteStatline(state);
    return notices;
  };

  it('says the difference once, and once more when it is gone', () => {
    const behind = soul({ exp: 2_463_069, promptExp: 1_713_069, expBehind: 750_000 });
    const notices = noticesOf([
      soul({ exp: 1_713_069, promptExp: 1_713_069, expBehind: null }),
      behind,
      behind,
      soul({ exp: 1_713_069, promptExp: 1_713_069, expBehind: 0 })
    ]);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('750,000');
  });

  it('says nothing when the prompt goes unchecked again at the character menu', () => {
    const behind = soul({ exp: 2_463_069, promptExp: 1_713_069, expBehind: 750_000 });
    const unchecked = soul({ exp: 1_713_069, promptExp: 1_713_069, expBehind: null });
    const notices = noticesOf([behind, unchecked]);
    // Positive control: the difference was said, and nothing after it.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('750,000');
    // Measured the same again, it is said again for the new stay.
    expect(noticesOf([behind, unchecked, behind])).toHaveLength(2);
  });

  it('says nothing where the two agree', () => {
    expect(noticesOf([soul({ exp: 5, promptExp: 5, expBehind: 0 })])).toEqual([]);
  });
});
