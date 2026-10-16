import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER } from '../../../shared/character';
import { EMPTY_AUTOMATION } from '../../../shared/automation';
import { NO_BACKSCROLL, type BackscrollText } from '../../../shared/ipc';
import { NO_LOOP } from '../../../shared/loops';
import { NO_PLAYERS } from '../../../shared/players';
import { IDLE_QUEST_RUN } from '../../../shared/quests';
import { EMPTY_ROOM_VERDICT } from '../../../shared/verdict';
import { IDLE_WALK } from '../../../shared/walk';
import { IDLE_CONNECTION, type ConnectionState, type TerminalMark } from '../../../shared/types';
import { lineIdOf } from '../../../shared/stamps';
import { attachSnapshot, type AttachSlot, type AttachSources } from '../attach';
import { MarkBook } from '../MarkBook';

const book = new MarkBook({ lines: 10 });
const BANK = book.issue({ icon: 'bank', label: 'Bank of Godfrey' });
book.painted([BANK]);
const PAGE: BackscrollText = {
  text: `${lineIdOf(BANK)}Bank of Godfrey\r\nObvious exits: north\r\n`,
  older: 0
};

/** A loaded character whose backscroll page resolves when the test says so. */
function loaded() {
  let resolvePage: (page: BackscrollText) => void = () => undefined;
  let pageAsked: ConnectionState | null = null;
  const manager = {
    lines: [],
    state: { ...IDLE_CONNECTION, phase: 'connecting' } as ConnectionState,
    character: EMPTY_CHARACTER,
    players: NO_PLAYERS,
    walker: { progress: IDLE_WALK },
    loops: { progress: NO_LOOP },
    automation: EMPTY_AUTOMATION,
    appraisal: { verdict: EMPTY_ROOM_VERDICT, asks: [] },
    statsBaseline: { base: null },
    log: [],
    learned: [],
    foundHere: [],
    questProgress: {},
    questDesk: { progress: IDLE_QUEST_RUN },
    gearDesk: { progress: null }
  };
  const slot: AttachSlot = {
    manager,
    backscroll: {
      page: () => {
        pageAsked = manager.state;
        return new Promise((resolve) => (resolvePage = resolve));
      }
    },
    marks: book
  };
  return {
    slot,
    manager,
    resolve: (page: BackscrollText) => resolvePage(page),
    phaseWhenAsked: () => pageAsked?.phase
  };
}

function sources(find: () => AttachSlot | undefined) {
  const made: string[] = [];
  const registered: string[] = [];
  const src: AttachSources = {
    find,
    register: (id) => registered.push(id),
    shops: (id) => {
      made.push(`shops:${id}`);
      return [];
    },
    talk: (id) => {
      made.push(`talk:${id}`);
      return [];
    }
  };
  return { src, made, registered };
}

describe('attachSnapshot', () => {
  it('reads the state after the backscroll page, so a dial that connected during the wait shows as connected', async () => {
    const char = loaded();
    const { src, made, registered } = sources(() => char.slot);

    const answer = attachSnapshot(src, 'rayzor', 40);
    expect(char.phaseWhenAsked()).toBe('connecting');
    expect(registered).toEqual(['rayzor']);

    char.manager.state = { ...char.manager.state, phase: 'connected' };
    // A mark changed during the wait is the one handed over, not the one at the ask.
    const now: TerminalMark = { icon: 'bank', label: 'The Bank of Godfrey' };
    book.change([{ id: BANK, mark: now }]);
    char.resolve(PAGE);

    const snapshot = await answer;
    expect(snapshot.state.phase).toBe('connected');
    expect(snapshot.backscroll).toEqual({ ...PAGE, marks: [{ id: BANK, mark: now }] });
    expect(made).toEqual(['shops:rayzor', 'talk:rayzor']);
  });

  it('answers the empty view without making a talk log or shop book when the session went during the wait', async () => {
    const char = loaded();
    let present = true;
    const { src, made } = sources(() => (present ? char.slot : undefined));

    const answer = attachSnapshot(src, 'rayzor', 40);
    expect(char.phaseWhenAsked()).toBe('connecting');
    present = false;
    char.resolve(PAGE);

    const snapshot = await answer;
    expect(snapshot.state).toBe(IDLE_CONNECTION);
    expect(snapshot.talk).toEqual([]);
    expect(made).toEqual([]);
  });

  it('registers nothing and answers the empty view for an id nobody defines', async () => {
    const { src, made, registered } = sources(() => undefined);

    const snapshot = await attachSnapshot(src, 'stale', 40);
    expect(registered).toEqual([]);
    expect(made).toEqual([]);
    expect(snapshot.backscroll).toBe(NO_BACKSCROLL);
    expect(snapshot.state).toBe(IDLE_CONNECTION);
  });
});
