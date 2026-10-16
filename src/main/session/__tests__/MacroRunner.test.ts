import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../../automation/CommandQueue';
import { MacroRunner, type MacroRunnerParts } from '../MacroRunner';
import type { AliasFile } from '../aliasAnswers';
import { aliasRefusalText } from '../../../shared/aliases';
import { t } from '../../app/i18n';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';
import type { KeyBindings } from '../../../shared/keys';
import type { RoomMatch } from '../../../shared/loops';
import type { RoomReference } from '../../../shared/world';

let seq = 0;
function block(type: BlockType, groups: Record<string, string> = {}): Block {
  seq += 1;
  return {
    seq,
    at: 0,
    type,
    domain: domainOf(type),
    groups,
    text: '',
    terminator: 'newline',
    confidence: 0.8
  };
}

describe('a macro', () => {
  let sent: string[];
  let typed: string[];
  let notices: string[];
  let queue: CommandQueue;
  let state: CharacterState;
  let mob: string | null;
  let maxGets = DEFAULT_CONFIG.automation.remotes.maxGets;
  let keys: KeyBindings;
  let aliases: Record<string, string>;
  let pending: boolean;
  let blocked: boolean;
  let match: RoomMatch;
  let walks: RoomReference[];
  let walkAnswer: { stepCount: number; room: string } | string;
  let owed: boolean;
  let onWalk: () => void;
  let file: AliasFile | null;
  let writes: Array<[string, string | null]>;
  let runner: MacroRunner;

  const parts = (): MacroRunnerParts => ({
    send: (data) => typed.push(data.trim()),
    queue,
    connected: () => true,
    notice: (message) => notices.push(message),
    published: () => undefined,
    state: () => state,
    mob: () => mob,
    automation: () => ({ aliases, remotes: { maxGets } }),
    keys: () => keys,
    aliasFile: () => file,
    movesPending: () => pending,
    sneakBlocked: () => blocked,
    roomNamed: () => match,
    walkTo: (at) => {
      walks.push(at);
      onWalk();
      return walkAnswer;
    },
    routeOwed: () => owed
  });

  /** Each prompt credits one command and lets the next go. */
  const prompts = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      vi.advanceTimersByTime(50);
      queue.notePrompt();
    }
    vi.advanceTimersByTime(50);
  };

  const at = (map: number, room: number): CharacterState => ({
    ...state,
    room: { ...state.room, map, number: room }
  });

  beforeEach(() => {
    maxGets = DEFAULT_CONFIG.automation.remotes.maxGets;
    vi.useFakeTimers();
    sent = [];
    typed = [];
    notices = [];
    mob = null;
    keys = {};
    aliases = {};
    pending = false;
    blocked = false;
    match = { kind: 'one', at: { map: 1, room: 297 } };
    walks = [];
    walkAnswer = { stepCount: 4, room: 'Town Square' };
    owed = false;
    onWalk = () => undefined;
    writes = [];
    file = {
      own: () => [{ name: 'dg', text: 'dig grave' }],
      write: (word, line) => {
        writes.push([word, line]);
        return null;
      }
    };
    state = { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game' };
    queue = new CommandQueue(
      { ...DEFAULT_CONFIG.automation, pacing: { window: 1, minGapMs: 10, ackTimeoutMs: 30_000 } },
      { send: (command) => sent.push(command), connected: () => true }
    );
    runner = new MacroRunner(parts());
  });

  afterEach(() => {
    queue.dispose();
    vi.useRealTimers();
  });

  // Steps worked out at their turn (todo 83): a client command and `{mob}`.
  describe('step worked out at its turn', () => {
    it('gets what is on the floor of the room the step before walked into', () => {
      runner.run('sw;get all');
      expect(sent).toEqual(['sw']);
      state = { ...state, room: { ...state.room, items: [wireItem('torch'), wireItem('rope')] } };
      prompts(2);
      expect(sent).toEqual(['sw', 'get torch', 'get rope']);
    });

    it('gets no more than the remotes block allows, read at the step’s turn', () => {
      runner.run('sw;get all');
      maxGets = 1;
      state = { ...state, room: { ...state.room, items: [wireItem('torch'), wireItem('rope')] } };
      prompts(2);
      expect(sent).toEqual(['sw', 'get torch']);
      expect(notices).toContain(t('session.clientCommand.getAllCapped', { max: 1, total: 2 }));
    });

    it('names the monster auto-combat would open on, at its turn', () => {
      runner.run('sw;a {mob};grin');
      mob = 'giant rat';
      prompts(2);
      expect(sent).toEqual(['sw', 'a giant rat', 'grin']);
    });

    it('stops the line at a {mob} with nothing to attack, and says so', () => {
      runner.run('sw;a {mob};grin');
      prompts(3);
      // Positive control: the step before it went.
      expect(sent).toEqual(['sw']);
      expect(notices).toContain(t('session.macro.noMob', { command: 'a {mob}' }));
      expect(queue.snapshot.depth).toBe(0);
    });

    it('refuses a name it cannot fill inside a line, before anything goes', () => {
      runner.run('sw;a {who}');
      expect(sent).toEqual([]);
      expect(notices).toContain(t('session.macro.inside', { name: '{who}' }));
    });

    it('fills a guard field at its turn, and stops at one not read yet', () => {
      runner.run('get {hp} gold;grin');
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('session.macro.noValue', { command: 'get {hp} gold', name: '{hp}' })
      );
      state = { ...state, vitals: { ...state.vitals, hp: 42 } };
      runner.run('get {hp} gold');
      prompts(1);
      expect(sent).toEqual(['get 42 gold']);
    });

    it('fills the leader, the first thing on the floor and the last telepath (todo 134)', () => {
      state = {
        ...state,
        party: { ...state.party, following: 'Soul' },
        room: { ...state.room, items: [wireItem('torch')] }
      };
      runner.onBlock(block('conversation-telepath', { player: 'Festus', message: 'hi' }));
      // The receipt of one sent names the other end, and is not who telepathed.
      runner.onBlock(block('conversation-telepath', { player: 'Rayzor' }));
      runner.run('fol {leader};get {item};/{telepath} ok');
      prompts(3);
      expect(sent).toEqual(['fol Soul', 'get torch', '/Festus ok']);
    });

    it('stops at a value nobody has said, and says which', () => {
      runner.run('fol {leader};grin');
      prompts(2);
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('session.macro.noValue', { command: 'fol {leader}', name: '{leader}' })
      );
    });

    it('sends a marked line as typed, mark off and braces kept', () => {
      runner.run('\\a {mob}');
      expect(typed).toEqual(['a {mob}']);
    });
  });

  describe('written one command a line', () => {
    it('keeps a line with a ; whole', () => {
      runner.run('gos gg ;)\nn');
      prompts(1);
      expect(sent).toEqual(['gos gg ;)', 'n']);
    });
  });

  it('runs a counted client command that many times', () => {
    state = { ...state, room: { ...state.room, items: [wireItem('torch')] } };
    runner.run('2get all');
    prompts(2);
    expect(sent).toEqual(['get torch', 'get torch']);
  });

  describe('calling another macro', () => {
    it('runs a key’s lines in place', () => {
      keys = { F2: 'n\ns' };
      runner.run('{f2}\nl');
      prompts(2);
      expect(sent).toEqual(['n', 's', 'l']);
    });

    it('runs an alias’s lines in place', () => {
      aliases = { doit: 'ne;recover corpse;sw' };
      runner.run('{doit}');
      prompts(2);
      expect(sent).toEqual(['ne', 'recover corpse', 'sw']);
    });

    it('refuses a macro that runs itself, before anything goes', () => {
      keys = { F1: '{f2}', F2: 'n\n{f1}' };
      runner.run('{f1}');
      expect(sent).toEqual([]);
      expect(notices).toContain(t('session.macro.loops', { chain: 'F1 → F2 → F1' }));
    });

    it('refuses a call to a macro the character does not have', () => {
      runner.run('n;{f9}');
      expect(sent).toEqual([]);
      expect(notices).toContain(t('session.macro.missing', { name: '{f9}' }));
    });
  });

  describe('{goto}', () => {
    it('queues the lines after it only once the walk arrives', () => {
      runner.run('{goto 1/297};l');
      // The trigger: the walk was asked for.
      expect(walks).toEqual([{ map: 1, room: 297 }]);
      prompts(2);
      expect(sent).toEqual([]);
      runner.onWalkEnded(true, null, at(1, 297));
      // Positive control: arrival lets the rest go.
      expect(sent).toEqual(['l']);
    });

    it('waits for a move still on its way before walking', () => {
      runner.run('n;{goto 1/297};l');
      expect(sent).toEqual(['n']);
      pending = true;
      prompts(1);
      expect(walks).toEqual([]);
      pending = false;
      runner.onBlock(block('room-name', { name: 'Town' }));
      expect(walks).toEqual([{ map: 1, room: 297 }]);
    });

    it('keeps waiting through a leg that ends short of the room', () => {
      runner.run('{goto 1/297};l');
      owed = true;
      runner.onWalkEnded(true, null, at(1, 5));
      prompts(1);
      expect(sent).toEqual([]);
      runner.onWalkEnded(true, null, at(1, 297));
      expect(sent).toEqual(['l']);
    });

    it('drops the rest when the walk ends anywhere else with nothing owed', () => {
      runner.run('{goto 1/297};l');
      expect(walks).toHaveLength(1);
      runner.onWalkEnded(true, null, at(1, 5));
      prompts(1);
      expect(sent).toEqual([]);
      expect(notices).toContain(t('session.macro.walkElsewhere', { room: 'Town Square' }));
    });

    it('starts a walk whose first step the queue takes from inside the turn', () => {
      // The walk's step is offered while the queue is resolving the marker.
      onWalk = () => {
        queue.enqueue({ command: 'e', priority: 'movement', coalesceKey: 'walk' });
      };
      runner.run('{goto 1/297};l');
      prompts(1);
      expect(sent).toEqual(['e']);
      runner.onWalkEnded(true, null, at(1, 297));
      prompts(1);
      expect(sent).toEqual(['e', 'l']);
    });

    it('drops the rest when the walk stops, and says why', () => {
      runner.run('{goto 1/297};l');
      expect(walks).toHaveLength(1);
      runner.onWalkEnded(false, 'the door is locked', at(1, 5));
      runner.onWalkEnded(true, null, at(1, 297));
      prompts(1);
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('session.macro.walkStopped', { room: 'Town Square', reason: 'the door is locked' })
      );
    });

    it('names every room a request matches rather than picking one', () => {
      match = {
        kind: 'several',
        rooms: [
          { map: 1, room: 2 },
          { map: 3, room: 4 }
        ]
      };
      runner.run('{goto Temple};l');
      prompts(1);
      expect(walks).toEqual([]);
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('session.macro.gotoSeveral', { request: 'Temple', addresses: '1/2, 3/4' })
      );
    });

    it('is refused written inside a line', () => {
      runner.run('say {goto 1/297}');
      expect(walks).toEqual([]);
      expect(notices).toContain(t('session.macro.inside', { name: '{goto 1/297}' }));
    });
  });

  describe('{sneak}', () => {
    it('sends nothing when already sneaking, and goes on', () => {
      state = { ...state, stealth: 'sneaking' };
      runner.run('{sneak};bs barry');
      prompts(1);
      expect(sent).toEqual(['bs barry']);
    });

    it('sends sn when seen, and goes on at the attempt', () => {
      state = { ...state, stealth: 'seen' };
      runner.run('{sneak};bs barry');
      expect(sent).toEqual(['sn']);
      prompts(1);
      expect(sent).toEqual(['sn']);
      runner.onBlock(block('user-sneak-initiate'));
      prompts(1);
      expect(sent).toEqual(['sn', 'bs barry']);
    });

    it('stops the macro when the sneak fails', () => {
      state = { ...state, stealth: 'seen' };
      runner.run('{sneak};bs barry');
      expect(sent).toEqual(['sn']);
      runner.onBlock(block('user-sneak-failed'));
      prompts(2);
      expect(sent).toEqual(['sn']);
      expect(notices).toContain(t('session.macro.notSneaking'));
    });

    it('stops the macro when nothing answers sn', () => {
      state = { ...state, stealth: 'unknown' };
      runner.run('{sneak};bs barry');
      expect(sent).toEqual(['sn']);
      vi.advanceTimersByTime(60_000);
      prompts(1);
      expect(sent).toEqual(['sn']);
      expect(notices).toContain(t('session.macro.sneakUnanswered'));
    });

    it('stops in a room the server refuses sn in', () => {
      blocked = true;
      runner.run('{sneak};bs barry');
      prompts(1);
      expect(sent).toEqual([]);
      expect(notices).toContain(t('session.macro.cannotSneak'));
    });
  });

  it('drops a waiting macro when another starts, and says so', () => {
    runner.run('{goto 1/297};l');
    expect(walks).toHaveLength(1);
    // A plain line typed on the way is no macro, and leaves it waiting.
    runner.run('grin');
    expect(notices).toEqual([]);
    runner.run('grin;smile');
    expect(notices).toContain(t('session.macro.replaced', { line: '{goto 1/297};l' }));
    runner.onWalkEnded(true, null, at(1, 297));
    prompts(2);
    expect(typed).toEqual(['grin']);
    expect(sent).toEqual(['grin', 'smile']);
  });

  it('drops a waiting macro on the Talk box’s Drop', () => {
    runner.run('{goto 1/297};l');
    runner.drop();
    runner.onWalkEnded(true, null, at(1, 297));
    expect(sent).toEqual([]);
    expect(notices).toContain(t('session.macro.droppedRest', { line: '{goto 1/297};l' }));
  });

  describe('the alias command', () => {
    it('sets an alias with its ; kept, queuing nothing', () => {
      runner.run('alias doit ne;recover corpse;sw');
      expect(writes).toEqual([['doit', 'ne;recover corpse;sw']]);
      expect(sent).toEqual([]);
      expect(typed).toEqual([]);
    });

    it('refuses an alias it would not load, writing nothing', () => {
      runner.run('alias alias x');
      // Positive control: a word that loads is written.
      runner.run('alias dg dig grave');
      expect(writes).toEqual([['dg', 'dig grave']]);
      expect(notices).toContain(
        t('session.alias.refused', { word: 'alias', reason: aliasRefusalText('client', t) })
      );
    });

    it('refuses an alias that would run itself, through a key or another alias', () => {
      keys = { F2: '{doit}' };
      runner.run('alias doit l;{f2}');
      runner.run('alias self {self}');
      expect(writes).toEqual([]);
      const reason = aliasRefusalText('loops', t);
      expect(notices).toEqual([
        t('session.alias.refused', { word: 'doit', reason }),
        t('session.alias.refused', { word: 'self', reason })
      ]);
    });

    it('lists the character’s and Global’s, Global’s marked', () => {
      aliases = { dg: 'dig grave', kk: 'pu kobold' };
      runner.run('alias');
      expect(notices).toEqual([
        t('session.alias.listed', { count: 2 }),
        t('session.alias.own', { word: 'dg', line: 'dig grave' }),
        t('session.alias.global', { word: 'kk', line: 'pu kobold' })
      ]);
    });

    it('removes one', () => {
      aliases = { dg: 'dig grave' };
      runner.run('unalias dg');
      expect(writes).toEqual([['dg', null]]);
      expect(notices).toContain(t('session.alias.removed', { word: 'dg' }));
    });

    it('sends \\alias to the server', () => {
      runner.run('\\alias');
      expect(typed).toEqual(['alias']);
      expect(writes).toEqual([]);
    });
  });
});
