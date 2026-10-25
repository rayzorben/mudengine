import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { Remotes, SWITCH_REMOTES } from '../Remotes';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { NO_TALLY, type CombatTally } from '../../../shared/tally';
import { wireExit, wireItem } from '../../../shared/entities';
import type { AutomationConfig, AutomationSwitch } from '../../../shared/config';
import type { Block } from '../../../shared/blocks';
import { NO_LOOP, type LoopProgress } from '../../../shared/loops';
import { IDLE_WALK, type WalkProgress } from '../../../shared/walk';
import {
  ACTIONABLE_REMOTES,
  REMOTES,
  parseRemoteReply,
  type MoveAnswer,
  type RemoteName,
  type PathReport
} from '../../../shared/remotes';
import { NO_PLAYERS, recordOf, type PlayerRegistry } from '../../../shared/players';
import type { DecisionKind } from '../../../shared/decisionSettings';

/**
 * Every name these tests speak as.
 *
 * Listed once and shared by the fixture rather than repeated per case: a test
 * added with a new name and no entry here would fail at the *gate* while
 * appearing to fail at whatever it was actually testing, which is the most
 * expensive kind of red.
 */
const SPEAKERS = [
  'Buster',
  'Hugeguy',
  'Milaq',
  'Rand',
  'Rend',
  'Sackhunter',
  'Sesub',
  'Sirkilla',
  'Soul',
  'Swampfox',
  'Syntax',
  'Vaelor',
  'Vulcan',
  'x',
  'Yang'
] as const;

const config: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  /*
   * Everybody these tests speak as is granted every actionable remote by name,
   * so each case below is about the *answer* rather than about the gate. The
   * gate has its own describe block at the foot of this file, and
   * `judgeRemote`'s own rules are unit-tested in
   * `src/shared/__tests__/remotes-access.test.ts`.
   */
  remotes: {
    ...DEFAULT_CONFIG.automation.remotes,
    enabled: true,
    gangpath: true,
    autoJoin: false,
    gang: [],
    // Empty, so nothing here is granted by a party listing arriving: these
    // cases are about the answer, and the gate has its own block below.
    party: [],
    players: Object.fromEntries(
      SPEAKERS.map((name) => [
        name.toLowerCase(),
        { allow: [...ACTIONABLE_REMOTES], deny: [], autoInvite: false }
      ])
    )
  },
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

/** `<player> started to follow you.`, or `You are now following <leader>.` */
const joins = (group: 'player' | 'leader', name: string): Block =>
  ({ type: 'party-joined', domain: 'presence', groups: { [group]: name } }) as unknown as Block;

const said = (type: string, player: string, message: string): Block =>
  ({
    type,
    domain: 'conversation',
    raw: '',
    plain: '',
    text: '',
    groups: { player, message },
    confidence: 1,
    at: 0,
    seq: 1
  }) as unknown as Block;

function who(over: Partial<CharacterState> = {}): CharacterState {
  return { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game', name: 'Vaelor', ...over };
}

let sent: string[];
let notices: string[];
let commanded: string[];
let queue: CommandQueue;
let peers: Remotes;
let clients: string[];
let placed: string[];
let comebacks: string[];
/** The members' answers to a `@disarm`, `@pick` or `@bash` this character sent (`askHand`). */
let handed: string[];
/** What the registry holds, read through `peer` as the session's tracker is. */
let registry: PlayerRegistry;
/** Whether the fixture's `comeBack` says a walk started. See the block below. */
let walks = true;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  commanded = [];
  clients = [];
  placed = [];
  comebacks = [];
  handed = [];
  registry = NO_PLAYERS;
  walks = true;
  queue = new CommandQueue(config, { send: (command) => sent.push(command) });
  peers = new Remotes(config, queue, {
    notice: (m) => notices.push(m),
    peer: (who) => recordOf(registry, who),
    commanded: (from, raw) => commanded.push(`${from}:${raw}`),
    clientNamed: (from, client, extended) => clients.push(`${from}:${client ?? '-'}:${extended}`),
    placed: (from, map, room, name) => placed.push(`${from}:${map}/${room}:${name ?? '-'}`),
    handAnswered: (from, ok) => handed.push(`${from}:${ok}`),
    comeBack: (from, map, room) => {
      comebacks.push(`${from}:${map}/${room}`);
      return walks;
    }
  });
});

/** Lets the queue drain: it paces on the prompt, and nothing here is a prompt. */
function drain(): void {
  vi.advanceTimersByTime(5_000);
}

describe('answering @health', () => {
  /*
   * The exact exchange in captures/055: `Sackhunter telepaths: @health` ->
   * `/Sackhunter {HP=600/600}`.
   */
  it('answers with the pair, on a telepath back to the sender', () => {
    peers.onBlock(
      said('conversation-telepath', 'Sackhunter', '@health'),
      who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 600, hpMax: 600 } })
    );
    drain();
    expect(sent).toEqual(['/Sackhunter {HP=600/600}']);
  });

  it('carries the mana half when the character has one', () => {
    peers.onBlock(
      said('conversation-telepath', 'Syntax', '@health'),
      who({
        vitals: { ...EMPTY_CHARACTER.vitals, hp: 4434, hpMax: 4434, mana: 516, manaMax: 516 }
      })
    );
    drain();
    expect(sent).toEqual(['/Syntax {HP=4434/4434,MA=516/516}']);
  });

  /*
   * Null is not zero. With no stat sheet yet there is no maximum to state, and
   * `{HP=62/0}` reads as full health on somebody else's screen.
   */
  it('sends nothing, and says why, when no maximum has arrived', () => {
    peers.onBlock(
      said('conversation-telepath', 'Soul', '@health'),
      who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 62, hpMax: null } })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.healthUnknown', { from: 'Soul' }));
  });
});

describe('answering the questions MegaMUD 2.1 was seen to answer', () => {
  const asked = (query: string, state: CharacterState): void => {
    peers.onBlock(said('conversation-telepath', 'Rand', query), state);
    drain();
  };

  it('answers @lives off the stat sheet, and says so when none has arrived', () => {
    asked('@lives', who({ progress: { ...EMPTY_CHARACTER.progress, lives: 9 } }));
    expect(sent).toEqual(['/Rand {9 lives remaining}']);
    sent.length = 0;
    asked('@lives', who());
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.answerUnknown', { from: 'Rand', raw: 'lives' })
    );
  });

  it('answers @stats, its own extension, off the stat sheet and not before it', () => {
    const sheet = {
      ...EMPTY_CHARACTER.progress,
      strength: 60,
      intellect: 45,
      willpower: 50,
      agility: 55,
      health: 45,
      charm: 40
    };
    asked('@stats', who({ progress: sheet }));
    expect(sent).toEqual(['/Rand {STR=60,INT=45,WIL=50,AGI=55,HEA=45,CHA=40}']);
    sent.length = 0;
    asked('@stats', who());
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.answerUnknown', { from: 'Rand', raw: 'stats' })
    );
  });

  it('hands @pick to the door path, which picks and answers (todo 86)', () => {
    const lockedNe = who({
      progress: { ...EMPTY_CHARACTER.progress, picklocks: 90 },
      room: {
        ...EMPTY_CHARACTER.room,
        map: 1,
        number: 7,
        exits: [
          {
            direction: 'ne',
            note: null,
            targetMap: 1,
            targetRoom: 8,
            targetName: null,
            requirement: { kind: 'door', raw: '', pickDifficulty: 10 }
          }
        ]
      }
    });
    peers.onBlock(said('conversation-telepath', 'Rand', '@pick ne'), lockedNe);
    drain();
    expect(sent).toEqual(['pi ne']);
    // Its answer deadline would outlive the test and speak into the next one.
    peers.dispose();
  });

  it('answers @wealth and @enc from the listing', () => {
    asked('@wealth', who({ inventory: { ...EMPTY_CHARACTER.inventory, wealth: 2199807 } }));
    asked(
      '@enc',
      who({
        inventory: {
          ...EMPTY_CHARACTER.inventory,
          encumbrance: 500,
          encumbranceMax: 3360,
          encumbranceWord: 'None'
        }
      })
    );
    expect(sent).toEqual(['/Rand {2199807 copper}', '/Rand {500/3360 - None}']);
  });

  it('answers @where, @who and @what from the room', () => {
    const room = {
      ...EMPTY_CHARACTER.room,
      name: 'Newhaven, Village Entrance',
      exits: [wireExit('n'), wireExit('se')],
      items: [wireItem('newbie manual'), wireItem('large sign')]
    };
    asked('@exp', who());
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.answerUnknown', { from: 'Rand', raw: 'exp' }));
    asked('@where', who({ room }));
    asked('@who', who({ room }));
    asked('@what', who({ room }));
    expect(sent).toEqual([
      '/Rand {Newhaven, Village Entrance (Exits: N,SE)}',
      '/Rand {No one}',
      '/Rand {newbie manual,large sign}'
    ]);
    // A bare floor is a word, not a refusal (captures/218).
    sent.length = 0;
    asked('@what', who({ room: { ...room, items: [] } }));
    expect(sent).toEqual(['/Rand {Nothing}']);
  });

  /* Who is a person, and who might be: the monsters are @what's business. */
  it('names the people and the strangers in the room for @who, never the monsters', () => {
    const occupant = (name: string, kind: 'player' | 'mob' | 'unknown') =>
      ({
        name,
        kind,
        disposition: null,
        uncertain: false,
        costly: 'never',
        charmed: false,
        free: false
      }) as never;
    asked(
      '@who',
      who({
        room: {
          ...EMPTY_CHARACTER.room,
          occupants: [
            occupant('Soul', 'player'),
            occupant('giant rat', 'mob'),
            occupant('Nathaniel', 'unknown')
          ]
        }
      })
    );
    expect(sent).toEqual(['/Rand {Soul,Nathaniel}']);
  });

  /*
   * Matched from the start of the bare name, as the server resolves one; the
   * two asks on the wire agree (`copper ring` yes, `ring` no, captures/217).
   * One copy is `{yes: 1}`; a second has never been answered, so it is
   * declined out loud rather than counted.
   */
  it('answers @have by the bare name for none or one, and declines a plural', () => {
    const items = [
      wireItem('padded helm', { slot: 'Head', equipped: true }),
      wireItem('copper ring'),
      wireItem('copper ring')
    ];
    asked('@have torch', who({ inventory: { ...EMPTY_CHARACTER.inventory, items } }));
    expect(sent).toEqual(['/Rand {no}']);
    sent.length = 0;
    asked('@have padded', who({ inventory: { ...EMPTY_CHARACTER.inventory, items } }));
    expect(sent).toEqual(['/Rand {yes: 1}']);
    sent.length = 0;
    asked('@have copper ring', who({ inventory: { ...EMPTY_CHARACTER.inventory, items } }));
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.haveUncaptured', { from: 'Rand', item: 'copper ring', count: 2 })
    );
    sent.length = 0;
    asked('@have ring', who({ inventory: { ...EMPTY_CHARACTER.inventory, items } }));
    expect(sent).toEqual(['/Rand {no}']);
  });

  /* Todo 20261021-1200-01: which of the rows asked the listed pack holds, in the asker's order. */
  it('answers @stoppers with the first row carried, {no} for none, and says so for an unlisted pack', () => {
    const listed = { ...EMPTY_CHARACTER.inventory, listedAt: 1, rows: [5, 1181] };
    asked('@stoppers 690,691,1181', who({ inventory: listed }));
    expect(sent).toEqual(['/Rand {yes: 1181}']);
    sent.length = 0;
    asked('@stoppers 690,691', who({ inventory: listed }));
    expect(sent).toEqual(['/Rand {no}']);
    sent.length = 0;
    asked('@stoppers 690', who());
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.stoppersUnlisted', { from: 'Rand' }));
  });

  it("answers @settings with this client's switches, on then off", () => {
    asked('@settings', who());
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^\/Rand \{ON: /);
    expect(sent[1]).toMatch(/^\/Rand \{OFF: /);
    // The words are ours: the test config has combat off and remotes on.
    expect(sent[0]).toContain('Remotes');
    expect(sent[1]).toContain('Combat');
  });

  it('answers @status idle when nothing has told it what the character is doing', () => {
    asked('@status', who({ stealth: 'seen' }));
    expect(sent).toEqual(['/Rand {IDLE: waiting for instructions}']);
  });

  /* A loop's leg is a walk, so both run at once; the answer is the loop. */
  it('answers @status with the loop over the leg it is on, and the walk otherwise', () => {
    const progress: { walk: WalkProgress; loop: LoopProgress; stopped: null } = {
      walk: {
        status: 'walking',
        asked: true,
        done: 2,
        total: 5,
        destination: 'Newhaven, Bank',
        destinationRoom: { map: 1, room: 297 },
        step: null,
        path: [],
        ahead: [],
        reason: null,
        hold: null,
        pace: 'walking',
        stoppedShort: false,
        arrivalAt: null
      },
      loop: { ...NO_LOOP, status: 'running', name: 'Rats', stop: 2, stops: 4, laps: 1 },
      stopped: null
    };
    const told = new Remotes(config, queue, { progress: () => progress });
    told.onBlock(said('conversation-telepath', 'Rand', '@status'), who({ stealth: 'sneaking' }));
    drain();
    expect(sent).toEqual(['/Rand {LOOP: Rats stop 2/4 lap 1 -Sneaking}']);
    sent.length = 0;
    progress.loop = { ...progress.loop, status: 'idle' };
    told.onBlock(said('conversation-telepath', 'Rand', '@status'), who({ stealth: 'unknown' }));
    drain();
    expect(sent).toEqual(['/Rand {WALK: Newhaven, Bank (2/5) -Stealth?}']);
  });

  it('answers @version with its own name', () => {
    asked('@version', who());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\/Rand \{mudengine \d+\.\d+\.\d+\}$/);
  });
});

describe('answering the imperative ones', () => {
  it('runs an @do and acknowledges it', () => {
    peers.onBlock(said('conversation-telepath', 'Sesub', '@do a ooze'), who());
    drain();
    expect(sent).toEqual(['a ooze', '/Sesub {ok}']);
    expect(notices).toContain(t('automation.remotes.ranDo', { from: 'Sesub', command: 'a ooze' }));
  });

  /*
   * The Re-equip Gear button from another player (todo 18): the recorded
   * slots not on are worn, the light's is left to `AutoLight`, and the
   * request is answered `{ok}` as `@do` is.
   */
  describe('@equip-all', () => {
    const kit = (cross: boolean): CharacterState =>
      who({
        loadout: [
          { slot: 'Off-Hand', item: 'large silvery cross', at: 1, locked: null },
          { slot: 'Readied', item: 'torch', at: 1, locked: null }
        ],
        inventory: {
          ...EMPTY_CHARACTER.inventory,
          items: [
            {
              ...wireItem('large silvery cross'),
              equipped: cross,
              slot: cross ? 'Off-Hand' : null
            },
            { ...wireItem('golden chalice'), equipped: !cross, slot: cross ? null : 'Off-Hand' },
            wireItem('torch')
          ]
        }
      });

    it('wears the recorded gear, never the light, and answers {ok}', () => {
      peers.onBlock(said('conversation-telepath', 'Rand', '@equip-all'), kit(false));
      drain();
      expect([...sent].sort()).toEqual(['/Rand {ok}', 'wear large silvery cross']);
      expect(notices).toContain(t('automation.remotes.ranEquipAll', { from: 'Rand' }));
    });

    /* Nothing recorded is not everything on: the client knows of no slot. */
    it('says no slot is recorded rather than that everything is on', () => {
      peers.onBlock(said('conversation-telepath', 'Rand', '@equip-all'), who());
      drain();
      expect(sent).toEqual(['/Rand {ok}']);
      expect(notices).toContain(t('automation.gear.noneRecorded'));
      expect(notices).not.toContain(t('automation.gear.allOn'));
    });

    it('says so when everything recorded is already on', () => {
      peers.onBlock(said('conversation-telepath', 'Rand', '@equip-all'), kit(true));
      drain();
      expect(sent).toEqual(['/Rand {ok}']);
      expect(notices).toContain(t('automation.gear.allOn'));
    });
  });

  /*
   * Todo 02 and 85: a switch on another player's word, `{ok}` once the file
   * says so. Every row of `SWITCH_REMOTES` is held to the same cases.
   */
  describe.each([
    {
      remote: 'auto-combat',
      setting: t('toolbar.combat'),
      at: (on: boolean): AutomationConfig => ({
        ...config,
        combat: { ...config.combat, enabled: on }
      })
    },
    {
      remote: 'auto-sneak',
      setting: t('toolbar.sneak'),
      at: (on: boolean): AutomationConfig => ({
        ...config,
        movement: { ...config.movement, sneak: on }
      })
    }
  ] as const)('@$remote', ({ remote, setting, at }) => {
    let switched: Array<[AutomationSwitch, boolean]>;
    let writes: boolean;
    const name = SWITCH_REMOTES[remote];
    const remotes = (switchOn: boolean): Remotes =>
      new Remotes(at(switchOn), queue, {
        notice: (m) => notices.push(m),
        switchAutomation: (which, on) => {
          switched.push([which, on]);
          return writes;
        }
      });
    const words = (word: 'on' | 'off') => ({ from: 'Rand', remote, setting, word });
    beforeEach(() => {
      switched = [];
      writes = true;
    });

    it('is a remote a grant can carry', () => {
      expect(REMOTES[remote].support).toBe('acted');
    });

    it('turns the switch off and answers {ok}', () => {
      remotes(true).onBlock(said('conversation-telepath', 'Rand', `@${remote} off`), who());
      drain();
      expect(switched).toEqual([[name, false]]);
      expect(sent).toEqual(['/Rand {ok}']);
      expect(notices).toContain(t('automation.remotes.switchSet', words('off')));
    });

    it('turns it on, whatever case the word is in', () => {
      remotes(false).onBlock(said('conversation-telepath', 'Rand', `@${remote} ON`), who());
      drain();
      expect(switched).toEqual([[name, true]]);
      expect(sent).toEqual(['/Rand {ok}']);
      expect(notices).toContain(t('automation.remotes.switchSet', words('on')));
    });

    it('answers {ok} without writing when the switch already says so', () => {
      remotes(true).onBlock(said('conversation-telepath', 'Rand', `@${remote} on`), who());
      drain();
      expect(switched).toEqual([]);
      expect(sent).toEqual(['/Rand {ok}']);
    });

    it('answers nothing when the file could not be written, and says so', () => {
      writes = false;
      remotes(true).onBlock(said('conversation-telepath', 'Rand', `@${remote} off`), who());
      drain();
      expect(switched).toEqual([[name, false]]);
      expect(sent).toEqual([]);
      expect(notices).toContain(t('automation.remotes.switchNotWritten', words('off')));
    });

    it('changes nothing without on or off', () => {
      remotes(true).onBlock(said('conversation-telepath', 'Rand', `@${remote}`), who());
      remotes(true).onBlock(said('conversation-telepath', 'Rand', `@${remote} maybe`), who());
      drain();
      expect(switched).toEqual([]);
      expect(sent).toEqual([]);
      const unread = t('automation.remotes.switchUnread', { from: 'Rand', remote, setting });
      expect(notices.filter((n) => n === unread)).toHaveLength(2);
    });

    it('answers nobody it was not granted to', () => {
      const refusing = remotes(true);
      refusing.configure({
        ...at(true),
        remotes: { ...config.remotes, players: {} }
      });
      refusing.onBlock(said('conversation-telepath', 'Rand', `@${remote} off`), who());
      drain();
      expect(switched).toEqual([]);
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('automation.remotes.refusedNotGranted', {
          from: 'Rand',
          raw: remote,
          unresolvedClause: ''
        })
      );
    });
  });

  /* Each switch remote is one row, and each row is a remote `REMOTES` says is acted. */
  it('has a test row for every switch remote', () => {
    expect(Object.keys(SWITCH_REMOTES).sort()).toEqual(['auto-combat', 'auto-sneak']);
  });

  it('joins the sender’s party on @join', () => {
    peers.onBlock(said('conversation-telepath', 'Buster', '@join'), who());
    drain();
    expect(sent).toEqual(['join Buster']);
  });

  /* `uninvite`, not `disband`: disband ends the whole party. */
  it('drops the sender on @forget', () => {
    peers.onBlock(said('conversation-telepath', 'Hugeguy', '@forget'), who());
    drain();
    expect(sent).toEqual(['uninvite Hugeguy']);
  });

  /*
   * The room's own maintained listing is what says what is on the floor. No
   * `get all` is sent: no capture shows this server accepting one, and a
   * command it does not know is said out loud in the room.
   */
  it('takes what the room listing names on @get-all', () => {
    peers.onBlock(
      said('conversation-local', 'Rend', '@get-all'),
      who({
        room: { ...EMPTY_CHARACTER.room, items: [wireItem('torch'), wireItem('padded helm')] }
      })
    );
    drain();
    expect(sent).toEqual(['get torch', 'get padded helm']);
  });

  // The case above takes both at the shipped count: the positive control.
  it('takes no more than the remotes block allows on @get-all, and says so', () => {
    peers.configure({ ...config, remotes: { ...config.remotes, maxGets: 1 } });
    peers.onBlock(
      said('conversation-local', 'Rend', '@get-all'),
      who({
        room: { ...EMPTY_CHARACTER.room, items: [wireItem('torch'), wireItem('padded helm')] }
      })
    );
    drain();
    expect(sent).toEqual(['get torch']);
    expect(notices).toContain(
      t('automation.remotes.getAllCapped', { from: 'Rend', max: 1, total: 2 })
    );
  });

  it('says so rather than sending anything when the floor is empty', () => {
    peers.onBlock(said('conversation-local', 'Rend', '@get-all'), who());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.getAllEmpty', { from: 'Rend' }));
  });

  it('runs what the leader tells the party to run', () => {
    peers.onBlock(said('conversation-local', 'Swampfox', '@party go rift'), who());
    drain();
    expect(sent).toEqual(['go rift']);
  });

  /*
   * The one command not from MegaMUD's manual: mudengine's own peer
   * extension. The event is the whole of it — what to do about an expired
   * blessing is `Blessings`' decision — and nothing is answered, because the
   * recast the sender sees land on them is the acknowledgement.
   */
  it('reports @bless-expired to the blessing tracker and answers nothing', () => {
    const expired: string[] = [];
    const listening = new Remotes(config, queue, {
      blessExpired: (from, spell) => expired.push(`${from}:${spell}`)
    });
    listening.onBlock(said('conversation-telepath', 'Soul', '@bless-expired bless'), who());
    drain();
    expect(expired).toEqual(['Soul:bless']);
    expect(sent).toEqual([]);
  });

  it('ignores a bare @bless-expired with no spell named', () => {
    const expired: string[] = [];
    const listening = new Remotes(config, queue, {
      blessExpired: (from, spell) => expired.push(`${from}:${spell}`)
    });
    listening.onBlock(said('conversation-telepath', 'Soul', '@bless-expired'), who());
    drain();
    expect(expired).toEqual([]);
  });
});

/*
 * Todo 07: an invitation is the ask, so `join` goes out without the `@join`
 * the leader would telepath next (captures/112: `Swampfox has invited you to
 * follow him.`, `Swampfox telepaths: @join`, `join Swampfox`).
 */
describe('joining when invited', () => {
  const invited = (leader: string): Block =>
    ({
      type: 'party-invited',
      domain: 'party',
      raw: '',
      plain: '',
      text: '',
      groups: { leader },
      confidence: 1,
      at: 0,
      seq: 1
    }) as unknown as Block;

  const joining = (over: Partial<AutomationConfig['remotes']> = {}): Remotes =>
    new Remotes({ ...config, remotes: { ...config.remotes, autoJoin: true, ...over } }, queue, {
      notice: (m) => notices.push(m)
    });

  it('joins a leader allowed @join as soon as they invite', () => {
    joining().onBlock(invited('Swampfox'), who());
    drain();
    expect(sent).toEqual(['join Swampfox']);
  });

  it('sends one join for the invitation and the @join behind it', () => {
    const remotes = joining();
    remotes.onBlock(invited('Swampfox'), who());
    remotes.onBlock(said('conversation-telepath', 'Swampfox', '@join'), who());
    drain();
    expect(sent).toEqual(['join Swampfox']);
  });

  it('waits for @join while the switch is off', () => {
    peers.onBlock(invited('Swampfox'), who());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('does not join a leader without @join, and says so', () => {
    joining({ players: {} }).onBlock(invited('Swampfox'), who());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([
      t('automation.remotes.autoJoinNotGranted', { from: 'Swampfox', unresolvedClause: '' })
    ]);
  });

  it('says the gang is unresolved rather than that the leader is not granted', () => {
    joining({ players: {}, gang: ['join'] }).onBlock(invited('Swampfox'), who());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([
      t('automation.remotes.autoJoinNotGranted', {
        from: 'Swampfox',
        unresolvedClause: t('automation.remotes.unresolvedGang')
      })
    ]);
  });

  it('says a leader denied @join by name is denied', () => {
    const players = { swampfox: { allow: [], deny: ['join' as const], autoInvite: false } };
    joining({ players }).onBlock(invited('Swampfox'), who());
    drain();
    expect(notices).toEqual([t('automation.remotes.autoJoinDenied', { from: 'Swampfox' })]);
  });

  it('answers a later @join once the prompt after the join has come', () => {
    const remotes = joining();
    remotes.onBlock(invited('Swampfox'), who());
    drain();
    expect(sent).toEqual(['join Swampfox']);
    remotes.onBlock(
      { ...invited('x'), type: 'status-line', groups: {} } as unknown as Block,
      who()
    );
    remotes.onBlock(said('conversation-telepath', 'Swampfox', '@join'), who());
    drain();
    expect(sent).toEqual(['join Swampfox', 'join Swampfox']);
  });

  it('does not wait on a join the queue dropped', () => {
    // Held behind a half-typed line, so the join waits in the queue, then dropped with it.
    queue.noteTyping(true);
    const remotes = joining();
    remotes.onBlock(invited('Swampfox'), who());
    drain();
    expect(sent).toEqual([]);
    queue.clear();
    remotes.onBlock(said('conversation-telepath', 'Swampfox', '@join'), who());
    drain();
    expect(sent).toEqual(['join Swampfox']);
  });

  it('does not join while following somebody else, and says so', () => {
    const party = { ...EMPTY_CHARACTER.party, following: 'Buster' };
    joining().onBlock(invited('Swampfox'), who({ party }));
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([t('automation.remotes.autoJoinInParty', { from: 'Swampfox' })]);
  });

  it('reads nothing into this character inviting somebody', () => {
    const own = { ...invited('x'), groups: { player: 'Swampfox' } } as unknown as Block;
    joining().onBlock(own, who());
    drain();
    expect(sent).toEqual([]);
  });
});

describe('the two it refuses', () => {
  /*
   * Refused *to the sender*, not merely dropped: somebody who sent one and
   * heard nothing would reasonably conclude it had worked.
   */
  it('will not attack a player, and says so', () => {
    // captures/058 has this arriving as a local say, so the refusal goes back
    // as a directed one — the channel that reaches somebody in the room.
    peers.onBlock(said('conversation-local', 'Sirkilla', '@kill Gambit'), who());
    drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^>Sirkilla \{no: /);
    expect(sent.join(' ')).not.toContain('Gambit');
    expect(notices).toContain(
      t('automation.remotes.refusedUnsupported', {
        from: 'Sirkilla',
        raw: 'kill',
        reason: t('automation.remotes.refusal.kill')
      })
    );
  });

  it('will not hang up', () => {
    peers.onBlock(said('conversation-telepath', 'Rend', '@hangup'), who());
    drain();
    expect(sent[0]).toMatch(/^\/Rend \{no: /);
  });
});

/* Todo 118: Allow @kill and @hangup lets the four through to a grant, and only then. */
describe('letting @kill, @hangup, @relog and @panic! through', () => {
  let hangUps: string[];
  let relogs: string[];
  /** Sirkilla granted all four by name; Rend granted nothing past the answerable ones. */
  const standing = (allowKillAndHangup: boolean): Remotes => {
    hangUps = [];
    relogs = [];
    const standingFour: RemoteName[] = ['kill', 'hangup', 'relog', 'panic!'];
    const remotes: AutomationConfig['remotes'] = {
      ...config.remotes,
      allowKillAndHangup,
      players: {
        ...config.remotes.players,
        sirkilla: { allow: [...ACTIONABLE_REMOTES, ...standingFour], deny: [], autoInvite: false }
      }
    };
    return new Remotes({ ...config, remotes }, queue, {
      notice: (m) => notices.push(m),
      hangUp: (why) => {
        hangUps.push(why);
        return true;
      },
      relog: (why) => {
        relogs.push(why);
        return true;
      }
    });
  };

  const occupant = (name: string, kind: 'player' | 'mob'): RoomOccupant => ({
    name,
    kind,
    disposition: null,
    uncertain: false,
    costly: 'never',
    charmed: false,
    hidden: false,
    free: false
  });
  const room = (...occupants: RoomOccupant[]): CharacterState =>
    who({ room: { ...EMPTY_CHARACTER.room, occupants } });

  it('attacks the named player for a sender granted @kill, with the switch on', () => {
    const here = room(occupant('Gambit', 'player'), occupant('goblin', 'mob'));
    standing(true).onBlock(said('conversation-telepath', 'Sirkilla', '@kill gam'), here);
    drain();
    expect(sent).toEqual(['a Gambit']);
  });

  it('attacks nobody the room does not name as exactly one player, and says who matched', () => {
    const here = room(
      occupant('Gambit', 'player'),
      occupant('Gamble', 'player'),
      occupant('gambling orc', 'mob')
    );
    const peers = standing(true);
    peers.onBlock(said('conversation-telepath', 'Sirkilla', '@kill gam'), here);
    peers.onBlock(said('conversation-telepath', 'Sirkilla', '@kill Rend'), here);
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.killAmbiguous', {
        from: 'Sirkilla',
        player: 'gam',
        candidates: 'Gambit, Gamble'
      })
    );
    expect(notices).toContain(
      t('automation.remotes.killNotHere', { from: 'Sirkilla', player: 'Rend' })
    );
  });

  it('still refuses a sender granted @kill while the switch is off, and names the setting', () => {
    standing(false).onBlock(said('conversation-telepath', 'Sirkilla', '@kill Gambit'), who());
    drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\/Sirkilla \{no: /);
    expect(notices).toContain(
      t('automation.remotes.refusedUnsupported', {
        from: 'Sirkilla',
        raw: 'kill',
        reason: t('automation.remotes.refusal.kill')
      })
    );
  });

  it('refuses a sender not granted it, with the switch on', () => {
    standing(true).onBlock(said('conversation-telepath', 'Rend', '@hangup'), who());
    drain();
    expect(sent).toEqual([]);
    expect(hangUps).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Rend',
        raw: 'hangup',
        unresolvedClause: ''
      })
    );
  });

  it('hangs up for @hangup and @panic!, and relogs for @relog', () => {
    const peers = standing(true);
    for (const raw of ['@hangup', '@panic!', '@relog']) {
      peers.onBlock(said('conversation-telepath', 'Sirkilla', raw), who());
    }
    expect(hangUps).toEqual([
      t('automation.remotes.whyRemote', { from: 'Sirkilla', raw: 'hangup' }),
      t('automation.remotes.whyRemote', { from: 'Sirkilla', raw: 'panic!' })
    ]);
    expect(relogs).toEqual([t('automation.remotes.whyRemote', { from: 'Sirkilla', raw: 'relog' })]);
  });
});

/* Todo 118: a changed @stats sheet goes out under the gate its first answer did. */
describe('sending a changed @stats sheet on', () => {
  const member = {
    name: 'Rand',
    className: null,
    health: 1,
    mana: null,
    rank: null,
    activity: null,
    invited: false,
    vitals: null,
    pool: null,
    sheet: null
  };
  const atLevel = (level: number): CharacterState =>
    who({
      progress: {
        ...EMPTY_CHARACTER.progress,
        strength: 60,
        intellect: 45,
        willpower: 50,
        agility: 55,
        health: 45,
        charm: 40,
        level
      },
      party: { ...EMPTY_CHARACTER.party, following: null, members: [member] }
    });

  it('sends the new sheet with automation on, and nothing with it off', () => {
    peers.onBlock(said('conversation-telepath', 'Rand', '@stats'), atLevel(10));
    drain();
    sent.length = 0;
    peers.configure({ ...config, enabled: false });
    peers.onCharacter(atLevel(11));
    drain();
    expect(sent).toEqual([]);
    // The positive control: the same change, automation back on.
    peers.configure(config);
    peers.onCharacter(atLevel(11));
    drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\/Rand \{STR=60/);
  });
});

describe('the ones with no captured reply', () => {
  /*
   * Reported and not answered. Inventing a format would put this client's guess
   * on another player's screen in a shape their client cannot read.
   */
  it('says it cannot answer, and sends nothing', () => {
    peers.onBlock(said('conversation-telepath', 'Rend', '@seen'), who());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.unread', { from: 'Rend', raw: 'seen' }));
  });
});

describe('what it will not be driven by', () => {
  it('is off unless the options file turns it on', () => {
    peers.configure({ ...config, remotes: { ...config.remotes, enabled: false } });
    peers.onBlock(
      said('conversation-telepath', 'Rend', '@health'),
      who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 10, hpMax: 10 } })
    );
    drain();
    expect(sent).toEqual([]);
  });

  /* The master switch holds the answer; the remote is still read, recorded and refused out loud. */
  it('is off with automation off, whatever its own switch says, and says so', () => {
    peers.configure({ ...config, enabled: false });
    peers.onBlock(said('conversation-telepath', 'Rend', '@join'), who());
    drain();
    expect(sent).toEqual([]);
    expect(commanded).toEqual(['Rend:join']);
    expect(notices).toContain(
      t('automation.remotes.refusedSwitchedOff', { from: 'Rend', raw: 'join' })
    );
  });

  /* This character's own words come back on the local channel. */
  it('does not answer itself', () => {
    peers.onBlock(said('conversation-local', 'Vaelor', '@join'), who());
    drain();
    expect(sent).toEqual([]);
  });

  /* A yell names a direction and no player, so there is nobody to answer. */
  it('ignores a channel that names nobody', () => {
    peers.onBlock(
      { ...said('conversation-yell', 'x', '@health'), groups: { message: '@health' } } as Block,
      who()
    );
    drain();
    expect(sent).toEqual([]);
  });
});

describe('asking, which is the other half of the same vocabulary', () => {
  it('asks somebody joining the party for its numbers and which client it runs', () => {
    peers.onBlock(joins('player', 'Soul'), who());
    drain();
    // The second question decides the wording of every question after this one.
    expect(sent).toEqual(['/Soul @health', '/Soul @version']);
  });

  /*
   * The leader disbanding sent both to the member who had just left
   * (festus, 2026-09-25). A second join asks `@health` again, and `@version`
   * only while nothing has answered or lapsed.
   */
  it('asks which client somebody runs once, however often they join', () => {
    peers.onBlock(joins('player', 'Soul'), who());
    drain();
    peers.onBlock(joins('leader', 'Soul'), who());
    drain();
    expect(sent).toEqual(['/Soul @health', '/Soul @version', '/Soul @health']);
  });

  /*
   * `@wait` and `@ok` are the pacing pair, sent on the **crossing** rather than
   * on every status line — a character resting for a minute is one message.
   */
  it('tells the leader it is under its floor, once, and that it is up again', () => {
    const low = (hp: number): CharacterState =>
      who({
        party: { engaged: {}, threatened: {}, following: 'Soul', members: [] },
        vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 100 }
      });
    const floor = DEFAULT_CONFIG.automation.health.restBelow * 100;
    peers.onCharacter(low(floor - 1));
    peers.onCharacter(low(floor - 1));
    peers.onCharacter(low(100));
    drain();
    expect(sent).toEqual(["/Soul @wait (HP's too low)", '/Soul @ok']);
  });

  /* A leader telling itself to wait would be talking to nobody. */
  it('says nothing when this character is not following anybody', () => {
    peers.onCharacter(who({ vitals: { ...EMPTY_CHARACTER.vitals, resting: true } }));
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * The answer goes back the way the question came.
 *
 * Measured live 2026-08-28: every one of these was answered by telepath, which
 * is right for exactly one of them. `.@health` in the room produced `/You
 * {HP=101/101,MA=5/5}` and the server answered `Cannot find user!`.
 */
describe('the channel an answer goes back on', () => {
  const hurt = (): CharacterState =>
    who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 101, hpMax: 101, mana: 5, manaMax: 5 } });

  it('answers a telepath by telepath', () => {
    peers.onBlock(said('conversation-telepath', 'Soul', '@health'), hurt());
    drain();
    expect(sent).toEqual(['/Soul {HP=101/101,MA=5/5}']);
  });

  it('answers a say in the room with a directed say, not a telepath', () => {
    peers.onBlock(said('conversation-local', 'Soul', '@health'), hurt());
    drain();
    expect(sent).toEqual(['>Soul {HP=101/101,MA=5/5}']);
  });

  /* `target` is required on this channel — see the third-party suite below. */
  it('answers a directed say directed', () => {
    const block = said('conversation-directed', 'Soul', '@health');
    (block.groups as Record<string, string>)['target'] = 'you';
    peers.onBlock(block, hurt());
    drain();
    expect(sent).toEqual(['>Soul {HP=101/101,MA=5/5}']);
  });

  /* `bg` is the realm's own verb (`Broadgang`), not a guessed punctuation prefix. */
  it('answers a gangpath on the gangpath, where the gang can see it', () => {
    peers.onBlock(said('conversation-gangpath', 'Soul', '@health'), hurt());
    drain();
    expect(sent).toEqual(['bg {HP=101/101,MA=5/5}']);
  });

  /*
   * Realm-wide channels are read and never answered in kind: one answer there
   * is this character's health in front of everybody logged in, once per asker.
   */
  for (const channel of ['conversation-gossip', 'conversation-broadcast', 'conversation-auction']) {
    it(`reads ${channel} and withholds the answer, saying so`, () => {
      peers.onBlock(said(channel, 'Soul', '@health'), hurt());
      drain();
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('automation.remotes.refusedRealmWide', { from: 'Soul', raw: 'health' })
      );
    });

    /*
     * The side effect, not merely the acknowledgement. Withholding only the
     * `{ok}` would leave one `broadcast @do who` running on every listening
     * character in the realm, with nobody told it happened.
     */
    it(`does not run @do arriving on ${channel}`, () => {
      peers.onBlock(said(channel, 'Soul', '@do who'), hurt());
      drain();
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('automation.remotes.refusedRealmWide', { from: 'Soul', raw: 'do' })
      );
    });

    it(`does not join a party from ${channel}`, () => {
      peers.onBlock(said(channel, 'Soul', '@join'), hurt());
      drain();
      expect(sent).toEqual([]);
    });

    /* A refusal is owed to somebody who asked; the realm at large did not. */
    it(`does not broadcast a refusal back at ${channel}`, () => {
      peers.onBlock(said(channel, 'Soul', '@kill Gambit'), hurt());
      drain();
      expect(sent).toEqual([]);
      expect(notices).toContain(
        t('automation.remotes.refusedRealmWide', { from: 'Soul', raw: 'kill' })
      );
    });
  }

  it('is not driven by a yell, which names a direction rather than a player', () => {
    peers.onBlock(said('conversation-yell', 'Soul', '@health'), hurt());
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * `--- Telepath Sent to Soul ---` is this character's own outbound half,
   * classified on the same channel with a player and no message.
   */
  it('ignores a send receipt, which carries no message', () => {
    const receipt = {
      type: 'conversation-telepath',
      domain: 'conversation',
      raw: '',
      plain: '',
      text: '',
      groups: { player: 'Soul' },
      confidence: 1,
      at: 0,
      seq: 1
    } as unknown as Block;
    peers.onBlock(receipt, hurt());
    drain();
    expect(sent).toEqual([]);
  });

  /* `Why are you telepathing to yourself?` — measured live, same session. */
  it('does not answer its own name', () => {
    peers.onBlock(said('conversation-local', 'Vaelor', '@health'), hurt());
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * `Name says (to Target) "..."` is one block type covering two facts: somebody
 * addressing this character, and somebody addressing a third party in front of
 * it. The pattern captures `target` and nothing read it until now.
 */
describe('a directed say aimed at somebody else', () => {
  const directed = (player: string, target: string, message: string): Block =>
    ({
      type: 'conversation-directed',
      domain: 'conversation',
      raw: '',
      plain: '',
      text: '',
      groups: { player, target, message },
      confidence: 1,
      at: 0,
      seq: 1
    }) as unknown as Block;

  const hurt = (): CharacterState =>
    who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 101, hpMax: 101, mana: 5, manaMax: 5 } });

  it('answers one addressed to this character', () => {
    peers.onBlock(directed('Vulcan', 'you', '@health'), hurt());
    drain();
    expect(sent).toEqual(['>Vulcan {HP=101/101,MA=5/5}']);
  });

  it("answers one addressed by this character's own name", () => {
    peers.onBlock(directed('Vulcan', 'Vaelor', '@health'), hurt());
    drain();
    expect(sent).toEqual(['>Vulcan {HP=101/101,MA=5/5}']);
  });

  /*
   * captures/059: `Milaq says (to Halifax) "..."` — overheard, not asked.
   * Answering names Milaq, who was talking to somebody else entirely.
   */
  it('does not answer one aimed at a third party', () => {
    peers.onBlock(directed('Milaq', 'Halifax', '@health'), hurt());
    drain();
    expect(sent).toEqual([]);
  });

  /* The dangerous half: the side effect, not the reply. */
  it("does not run a third party's @do", () => {
    peers.onBlock(directed('Milaq', 'Halifax', '@do who'), hurt());
    drain();
    expect(sent).toEqual([]);
  });

  it("does not obey a third party's @party", () => {
    peers.onBlock(directed('Milaq', 'Halifax', '@party stat'), hurt());
    drain();
    expect(sent).toEqual([]);
  });
});

/*
 * Two identical answers to the same asker are one answer — the same intent,
 * unlike two `@do`s, which are two decisions however alike they look.
 */
describe('coalescing an answer', () => {
  const hurt = (): CharacterState =>
    who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 101, hpMax: 101, mana: 5, manaMax: 5 } });

  /*
   * The queue pumps on enqueue, so answers only pile up while it is *held* —
   * a half-typed player line is the ordinary way that happens. Held is
   * therefore where coalescing is observable, and where it matters: without
   * a key, a room asking three times while somebody types produces three
   * identical `>Soul {HP=…}` lines the moment they press Enter.
   */
  it('answers a repeated question once when the queue is held', () => {
    queue.noteTyping(true);
    peers.onBlock(said('conversation-local', 'Soul', '@health'), hurt());
    peers.onBlock(said('conversation-local', 'Soul', '@health'), hurt());
    peers.onBlock(said('conversation-local', 'Soul', '@health'), hurt());
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual(['>Soul {HP=101/101,MA=5/5}']);
  });

  it('still answers two different askers', () => {
    queue.noteTyping(true);
    peers.onBlock(said('conversation-telepath', 'Soul', '@health'), hurt());
    peers.onBlock(said('conversation-telepath', 'Yang', '@health'), hurt());
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual(['/Soul {HP=101/101,MA=5/5}', '/Yang {HP=101/101,MA=5/5}']);
  });
});

describe('the gate: who may ask, and for what', () => {
  const grant = (
    players: Record<string, { allow: readonly string[]; deny?: readonly string[] }>,
    gang: readonly string[] = []
  ): AutomationConfig => ({
    ...config,
    remotes: {
      ...DEFAULT_CONFIG.automation.remotes,
      enabled: true,
      gangpath: true,
      autoJoin: false,
      gang: gang as never,
      party: [],
      players: Object.fromEntries(
        Object.entries(players).map(([name, entry]) => [
          name,
          {
            allow: [...entry.allow] as never,
            deny: [...(entry.deny ?? [])] as never,
            autoInvite: false
          }
        ])
      )
    }
  });

  const live = (over: Partial<CharacterState> = {}): CharacterState =>
    who({
      vitals: { ...EMPTY_CHARACTER.vitals, hp: 101, hpMax: 101, mana: 5, manaMax: 5 },
      ...over
    });

  it('answers a remote that player was granted by name', () => {
    peers.configure(grant({ yang: { allow: ['health'] } }));
    peers.onBlock(said('conversation-telepath', 'Yang', '@health'), live());
    drain();
    expect(sent).toEqual(['/Yang {HP=101/101,MA=5/5}']);
  });

  /*
   * The whole reason the grounds went. Under the old model, allowing somebody
   * by name allowed them `@do` along with `@health` and there was no way to say
   * otherwise; this is that sentence as a test.
   */
  it('refuses a remote that player was not granted, on the same settings', () => {
    peers.configure(grant({ yang: { allow: ['health'] } }));
    peers.onBlock(said('conversation-telepath', 'Yang', '@do who'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', { from: 'Yang', raw: 'do', unresolvedClause: '' })
    );
  });

  /* The positive control is `hands @pick to the door path`: granted, the same line picks. */
  it('stays silent to @disarm from a member not granted it (todo 86)', () => {
    peers.configure(grant({ yang: { allow: ['health'] } }));
    peers.onBlock(
      said('conversation-telepath', 'Yang', '@disarm ne'),
      live({ progress: { ...EMPTY_CHARACTER.progress, traps: 90 } })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('ignores somebody granted nothing at all', () => {
    peers.configure(grant({ yang: { allow: ['health'] } }));
    peers.onBlock(said('conversation-telepath', 'Rend', '@health'), live());
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The refusal is said to the person running *this* client and to nobody else.
   * Replying would confirm to anybody who probes that a remotely-drivable
   * client is on this name, and would let a stranger spend the command queue.
   */
  it('says a refusal to its own player and sends nothing to the asker', () => {
    peers.configure(grant({}));
    peers.onBlock(said('conversation-telepath', 'Rend', '@health'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Rend',
        raw: 'health',
        unresolvedClause: ''
      })
    );
  });

  it('lets a deny beat what the gang grants, and says which', () => {
    peers.configure(grant({ spike: { allow: [], deny: ['health'] } }, ['health']));
    peers.onBlock(
      said('conversation-telepath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', 'Old Guard')] })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedDenied', { from: 'Spike', raw: 'health' })
    );
  });

  /*
   * The gate sits ahead of every acting command too, not only the answering
   * ones. `@do` never routes through `reply()`, so a gate that only withheld
   * answers would have left the side effect: a stranger's `@do` would run.
   */
  it('does not run @equip-all for somebody who was not granted it', () => {
    peers.configure(grant({}));
    const state = live({
      loadout: [{ slot: 'Head', item: 'padded helm', at: 1, locked: null }],
      inventory: { ...EMPTY_CHARACTER.inventory, items: [wireItem('padded helm')] }
    });
    peers.onBlock(said('conversation-telepath', 'Rend', '@equip-all'), state);
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Rend',
        raw: 'equip-all',
        unresolvedClause: ''
      })
    );
  });

  it('does not run @do for somebody who was not granted it', () => {
    peers.configure(grant({}));
    peers.onBlock(said('conversation-telepath', 'Rend', '@do who'), live());
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * The roster is what says who is in a gang: this character's own `who` row
   * and the asker's each name one behind the title, and a `look` at them
   * names it in parentheses. The gangpath itself proves nothing -- this
   * character's own `bg` comes back naming itself.
   */
  function listed(name: string, gang: string | null, provisional = false) {
    return { name, alignment: null, title: null, flags: null, gang, provisional };
  }
  const gangOnly = (): AutomationConfig => grant({}, ['health']);

  it('answers somebody whose who row names the same gang as this character', () => {
    peers.configure(gangOnly());
    peers.onBlock(
      said('conversation-gangpath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', 'old guard')] })
    );
    drain();
    expect(sent).toEqual(['bg {HP=101/101,MA=5/5}']);
  });

  it('refuses somebody a listing put in a different gang, and does not call it unresolved', () => {
    peers.configure(gangOnly());
    peers.onBlock(
      said('conversation-gangpath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', 'Rivals')] })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Spike',
        raw: 'health',
        unresolvedClause: ''
      })
    );
  });

  it('refuses somebody a listing wrote with no gang at all', () => {
    peers.configure(gangOnly());
    peers.onBlock(
      said('conversation-gangpath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', null)] })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Spike',
        raw: 'health',
        unresolvedClause: ''
      })
    );
  });

  it('cannot decide while the asker is only known from an arrival', () => {
    peers.configure(gangOnly());
    peers.onBlock(
      said('conversation-gangpath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', null, true)] })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Spike',
        raw: 'health',
        unresolvedClause: t('automation.remotes.unresolvedGang')
      })
    );
  });

  it('names an unresolved gang so a configured one is not silently refused', () => {
    peers.configure(gangOnly());
    peers.onBlock(said('conversation-gangpath', 'Spike', '@health'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Spike',
        raw: 'health',
        unresolvedClause: t('automation.remotes.unresolvedGang')
      })
    );
  });

  /*
   * The party list, whose whole safety property is that it is read from the
   * *roster* rather than from an invitation: the objection that retired the
   * old `party` ground was that anybody could grant themselves one by typing
   * `invite`, and this is that objection as three tests.
   */
  const partyOnly = (...names: string[]): AutomationConfig => ({
    ...grant({}),
    remotes: { ...grant({}).remotes, party: names as never }
  });

  const member = (name: string, invited = false) => ({
    name,
    className: null,
    health: 1,
    mana: null,
    rank: null,
    activity: null,
    invited,
    vitals: null,
    pool: null,
    sheet: null
  });

  const withParty = (...members: ReturnType<typeof member>[]): Partial<CharacterState> => ({
    party: { ...EMPTY_CHARACTER.party, members }
  });

  it('answers somebody the party listing names', () => {
    peers.configure(partyOnly('health'));
    peers.onBlock(
      said('conversation-telepath', 'Soul', '@health'),
      live(withParty(member('Vaelor'), member('Soul')))
    );
    drain();
    expect(sent).toEqual(['/Soul {HP=101/101,MA=5/5}']);
  });

  it('refuses somebody who was only invited, and says what would settle it', () => {
    // An offer nobody accepted is not membership. If it were, `invite` would
    // be the gesture by which anybody handed themselves this list.
    peers.configure(partyOnly('health'));
    peers.onBlock(
      said('conversation-telepath', 'Rend', '@health'),
      live(withParty(member('Vaelor'), member('Rend', true)))
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Rend',
        raw: 'health',
        unresolvedClause: t('automation.remotes.notInParty')
      })
    );
  });

  it('refuses somebody who is in no party with this character', () => {
    peers.configure(partyOnly('health'));
    peers.onBlock(said('conversation-telepath', 'Rend', '@health'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Rend',
        raw: 'health',
        unresolvedClause: t('automation.remotes.notInParty')
      })
    );
  });

  it('lets a deny by name beat what the party grants', () => {
    peers.configure({
      ...grant({ rend: { allow: [], deny: ['health'] } }),
      remotes: { ...grant({ rend: { allow: [], deny: ['health'] } }).remotes, party: ['health'] }
    });
    peers.onBlock(
      said('conversation-telepath', 'Rend', '@health'),
      live(withParty(member('Vaelor'), member('Rend')))
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedDenied', { from: 'Rend', raw: 'health' })
    );
  });

  it('grants only what the party list names, not the rest of the vocabulary', () => {
    peers.configure(partyOnly('health'));
    peers.onBlock(
      said('conversation-telepath', 'Soul', '@do who'),
      live(withParty(member('Vaelor'), member('Soul')))
    );
    drain();
    expect(sent).toEqual([]);
  });

  /*
   * Nothing is said about a message that was never a command. A stranger
   * chatting is not somebody being refused, and a notice per line of other
   * people's conversation is a log nobody can read.
   */
  it('says nothing at all about a stranger who was not sending a command', () => {
    peers.configure(grant({}));
    peers.onBlock(said('conversation-local', 'Rend', 'hello there'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('the gangpath is answered on only when it is switched on', () => {
  /*
   * A gangpath answer is spoken to the whole gang, where every other addressed
   * channel answers one person. That asymmetry is a switch rather than a
   * decision made on somebody's behalf.
   */
  const inGang = (gangpath: boolean): AutomationConfig => ({
    ...config,
    remotes: {
      ...DEFAULT_CONFIG.automation.remotes,
      ...{ enabled: true, gangpath, autoJoin: false, gang: ['health'], party: [], players: {} }
    }
  });

  const together = (): CharacterState =>
    who({
      vitals: { ...EMPTY_CHARACTER.vitals, hp: 101, hpMax: 101, mana: 5, manaMax: 5 },
      online: [
        {
          name: 'Vaelor',
          alignment: null,
          title: null,
          flags: null,
          gang: 'Valor',
          provisional: false
        },
        {
          name: 'Spike',
          alignment: null,
          title: null,
          flags: null,
          gang: 'Valor',
          provisional: false
        }
      ]
    });

  it('answers on the gang’s own channel with it on', () => {
    peers.configure(inGang(true));
    peers.onBlock(said('conversation-gangpath', 'Spike', '@health'), together());
    drain();
    expect(sent).toEqual(['bg {HP=101/101,MA=5/5}']);
  });

  it('reads and never answers with it off, and says which switch', () => {
    peers.configure(inGang(false));
    peers.onBlock(said('conversation-gangpath', 'Spike', '@health'), together());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedGangpathOff', { from: 'Spike', raw: 'health' })
    );
  });

  /*
   * And the side effect is withheld with the answer, not merely the reply: one
   * `bg @do who` with the switch off must not run on this character quietly.
   */
  it('does not act on one with it off either', () => {
    peers.configure({
      ...inGang(false),
      remotes: {
        ...DEFAULT_CONFIG.automation.remotes,
        enabled: true,
        gangpath: false,
        autoJoin: false,
        gang: ['do'],
        party: [],
        players: {}
      }
    });
    peers.onBlock(said('conversation-gangpath', 'Spike', '@do who'), together());
    drain();
    expect(sent).toEqual([]);
  });
});

describe('a channel this client never answers on, from somebody with no grant', () => {
  /*
   * Gossip, broadcast and auction reach everybody logged in. A refusal notice
   * for one is one Alerts entry per listening character, per gossiped line,
   * from somebody addressing none of them — a stream a stranger can generate at
   * will. The "not addressed to this character" reading sits above the gate.
   */
  const ungranted = (): AutomationConfig => ({
    ...config,
    remotes: {
      ...DEFAULT_CONFIG.automation.remotes,
      ...{ enabled: true, gangpath: true, autoJoin: false, gang: [], party: [], players: {} }
    }
  });

  const live = (): CharacterState =>
    who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 101, hpMax: 101, mana: 5, manaMax: 5 } });

  it('says nothing and does nothing', () => {
    peers.configure(ungranted());
    peers.onBlock(said('conversation-gossip', 'Rend', '@health'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('does not count it against them either', () => {
    // `commanded` drives a state republish; one per gossip line is the same
    // stream in a different place.
    peers.configure(ungranted());
    peers.onBlock(said('conversation-broadcast', 'Rend', '@do who'), live());
    drain();
    expect(commanded).toEqual([]);
  });

  /*
   * But a sender this character *does* have a relationship with is still
   * reported once: that is a message it would have acted on and deliberately
   * did not, which is worth saying.
   */
  it('still reports one from somebody reachable', () => {
    peers.onBlock(said('conversation-gossip', 'Soul', '@health'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(
      t('automation.remotes.refusedRealmWide', { from: 'Soul', raw: 'health' })
    );
  });

  it('still refuses an addressed channel out loud, so the refusal is visible', () => {
    peers.configure(ungranted());
    peers.onBlock(said('conversation-telepath', 'Rend', '@health'), live());
    drain();
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Rend',
        raw: 'health',
        unresolvedClause: ''
      })
    );
  });
});

/*
 * The extended vocabulary: two questions only another mudengine can answer,
 * and the handshake that decides whether to ask them.
 *
 * The whole of it turns on one fact — that a room *name* is ambiguous and a
 * room *address* is not — so the extended forms carry the address. Nothing is
 * ever sent in this wording to somebody who has not said they run this client,
 * and the moment one of them fails the plain wording goes instead.
 */
describe('talking to another one of these clients', () => {
  /** A registry entry saying what is known about somebody's client, held where `peer` reads. */
  const knowing = (name: string, extended: 'unknown' | 'yes' | 'no'): void => {
    registry = {
      [name.toLowerCase()]: {
        name,
        alignment: null,
        title: null,
        flags: null,
        gang: null,
        level: null,
        race: null,
        className: null,
        gangRank: null,
        client: extended === 'unknown' ? null : 'mudengine 0.6.5',
        extendedRemotes: extended,
        equipment: null,
        equipmentAt: null,
        lastRoom: null,
        lastRoomName: null,
        lastRoomAt: null,
        lastSeen: 0,
        online: true,
        vitals: null,
        vitalsAt: null,
        inParty: false,
        commandsSent: 0,
        lastCommand: null,
        lastCommandAt: null
      }
    };
  };

  const inRoom = (map: number, number: number, name: string): Partial<CharacterState> => ({
    room: { ...structuredClone(EMPTY_CHARACTER.room), map, number, name }
  });

  /* Todo 86: the leader's half. */
  it('sends @pick to a member on this client and @do pi to anyone else', () => {
    knowing('Soul', 'yes');
    peers.askHand('Soul', 'pick', 'ne');
    peers.askHand('Rand', 'pick', 'e');
    drain();
    expect(sent).toEqual(['/Soul @pick ne', '/Rand @do pi e']);
  });

  /* An `@do` is answered on taking it, before the roll: a disarm taken as held walks into the trap. */
  it('never sends a disarm or a bash through @do, and reads an @do {ok} as tried', () => {
    expect(peers.askHand('Rand', 'disarm', 'e')).toBe(false);
    expect(peers.askHand('Rand', 'bash', 'e')).toBe(false);
    peers.askHand('Rand', 'pick', 'e');
    drain();
    expect(sent).toEqual(['/Rand @do pi e']);
    peers.onBlock(said('conversation-telepath', 'Rand', '{ok}'), who());
    expect(handed).toEqual(['Rand:tried']);
  });

  it('hands a member’s {ok} or {failed} back to the walk, once', () => {
    knowing('Soul', 'yes');
    peers.askHand('Soul', 'bash', 'n');
    drain();
    peers.onBlock(said('conversation-telepath', 'Soul', '{failed}'), who());
    peers.onBlock(said('conversation-telepath', 'Soul', '{ok}'), who());
    expect(handed).toEqual(['Soul:failed']);
  });

  /* Todo 133: the positive control is the test above, where the same {ok} is handed back. */
  it('reads no {ok} as the job once the walk withdrew the ask', () => {
    knowing('Soul', 'yes');
    const ask = peers.askHand('Soul', 'bash', 'n');
    drain();
    expect(ask).not.toBe(false);
    if (ask !== false) ask.withdraw();
    peers.onBlock(said('conversation-telepath', 'Soul', '{ok}'), who());
    expect(handed).toEqual([]);
  });

  it('leaves a newer ask to the member when an older one is withdrawn', () => {
    knowing('Soul', 'yes');
    const first = peers.askHand('Soul', 'pick', 'n');
    peers.askHand('Soul', 'bash', 'n');
    drain();
    if (first !== false) first.withdraw();
    peers.onBlock(said('conversation-telepath', 'Soul', '{ok}'), who());
    expect(handed).toEqual(['Soul:held']);
  });

  it('asks the plain question of somebody nothing has said anything about', () => {
    peers.ask('Soul', 'where', who());
    drain();
    expect(sent).toEqual(['/Soul @where']);
  });

  it('asks the extended question only of somebody who said they run this client', () => {
    knowing('Soul', 'yes');
    peers.ask('Soul', 'where', who());
    drain();
    expect(sent).toEqual(['/Soul @where-room']);
  });

  it('records the client a @version answer named, and that it can be talked to', () => {
    peers.ask('Soul', 'version', who());
    drain();
    peers.onBlock(said('conversation-telepath', 'Soul', '{mudengine 0.6.5}'), who());
    expect(clients).toEqual(['Soul:mudengine 0.6.5:yes']);
  });

  it('records another client as one the extended wording does not reach', () => {
    peers.ask('Rand', 'version', who());
    drain();
    peers.onBlock(said('conversation-telepath', 'Rand', '{MegaMMUD 2.1}'), who());
    expect(clients).toEqual(['Rand:MegaMMUD 2.1:no']);
  });

  /*
   * A reply is read only against a question this client asked. Nobody can
   * volunteer one: every shape in this vocabulary is a brace-wrapped phrase,
   * and a room genuinely called `Level 3` is a `@version` answer to a reader
   * that goes by shape alone.
   */
  it('does not read a reply nobody asked for', () => {
    peers.onBlock(said('conversation-telepath', 'Soul', '{mudengine 0.6.5}'), who());
    expect(clients).toEqual([]);
  });

  // The positive control is `asks somebody joining the party for its numbers`.
  it('does not ask a joining member which client it runs once the registry has said', () => {
    knowing('Soul', 'yes');
    peers.onBlock(joins('player', 'Soul'), who());
    drain();
    // Their sheet is asked instead: only this client answers it (todo 86).
    expect(sent).toEqual(['/Soul @health', '/Soul @stats']);
  });

  it('does not ask again after a @version went unanswered', () => {
    knowing('Rand', 'no');
    registry = { rand: { ...registry['rand']!, client: null } };
    peers.onBlock(joins('player', 'Rand'), who());
    drain();
    expect(sent).toEqual(['/Rand @health']);
  });

  it('reads where a peer said it is standing, by address', () => {
    knowing('Soul', 'yes');
    peers.ask('Soul', 'where', who());
    drain();
    peers.onBlock(said('conversation-telepath', 'Soul', '{1/2150 Town Gates}'), who());
    expect(placed).toEqual(['Soul:1/2150:Town Gates']);
  });

  /*
   * The fallback, and the fact behind it: `{command invalid or not allowed}`
   * is what MegaMUD 2.1 answers a word it has no entry for (captured
   * 2026-08-29). Nothing else this client sends is outside MegaMUD's own
   * vocabulary, so it can only ever be about an extended question.
   */
  it('falls back to the plain wording when the extended one is refused', () => {
    knowing('Rand', 'yes');
    peers.ask('Rand', 'where', who());
    drain();
    expect(sent).toEqual(['/Rand @where-room']);

    peers.onBlock(said('conversation-telepath', 'Rand', '{command invalid or not allowed}'), who());
    drain();
    expect(sent).toEqual(['/Rand @where-room', '/Rand @where']);
    expect(clients).toEqual(['Rand:-:no']);
  });

  it('falls back when nothing comes back at all, and says so', () => {
    knowing('Rand', 'yes');
    peers.ask('Rand', 'where', who());
    drain();
    /*
     * The positive control: the sweep really runs on this side of the deadline
     * and writes nobody off. `drain` has already spent five of the thirty
     * seconds, so the clock is read from here rather than from the ask.
     */
    vi.advanceTimersByTime(20_000);
    peers.onCharacter(who());
    drain();
    expect(sent).toEqual(['/Rand @where-room']);

    vi.advanceTimersByTime(10_000);
    peers.onCharacter(who());
    drain();
    expect(sent).toEqual(['/Rand @where-room', '/Rand @where']);
    expect(clients).toEqual(['Rand:-:no']);
    expect(notices).toContain(
      t('automation.remotes.extendedLapsed', { who: 'Rand', name: 'where' })
    );
  });

  /*
   * Every telepath here goes at `user`, so the queue does not hold it: the
   * module's own guard does. The silence is still recorded; the plain wording
   * waits. The case above is the positive control with the switch on.
   */
  it('records the lapse with automation off, and sends the plain wording to nobody', () => {
    knowing('Rand', 'yes');
    peers.ask('Rand', 'where', who());
    drain();
    expect(sent).toEqual(['/Rand @where-room']);
    peers.configure({ ...config, enabled: false });
    vi.advanceTimersByTime(30_000);
    peers.onCharacter(who());
    drain();
    expect(sent).toEqual(['/Rand @where-room']);
    expect(clients).toEqual(['Rand:-:no']);
    expect(notices).toContain(t('automation.remotes.followUpHeld', { who: 'Rand', name: 'where' }));
  });

  it('reads MegaMUD’s refusal with automation off, and sends the plain wording to nobody', () => {
    knowing('Rand', 'yes');
    peers.ask('Rand', 'where', who());
    drain();
    expect(sent).toEqual(['/Rand @where-room']);
    peers.configure({ ...config, enabled: false });
    peers.onBlock(said('conversation-telepath', 'Rand', '{command invalid or not allowed}'), who());
    drain();
    expect(sent).toEqual(['/Rand @where-room']);
    expect(clients).toEqual(['Rand:-:no']);
    expect(notices).toContain(t('automation.remotes.followUpHeld', { who: 'Rand', name: 'where' }));
  });

  it('answers @where-room with the realm’s own address and the room’s name', () => {
    peers.onBlock(
      said('conversation-telepath', 'Soul', '@where-room'),
      who(inRoom(1, 2150, 'Town Gates'))
    );
    drain();
    expect(sent).toEqual(['/Soul {1/2150 Town Gates}']);
  });

  it('answers @where-room with nothing at all where the realm has not placed it', () => {
    peers.onBlock(
      said('conversation-telepath', 'Soul', '@where-room'),
      who({ room: { ...structuredClone(EMPTY_CHARACTER.room), name: 'Town Gates' } })
    );
    drain();
    expect(sent).toEqual([]);
  });

  it('carries this character’s own address out with @comeback-room', () => {
    knowing('Soul', 'yes');
    peers.ask('Soul', 'comeback', who(inRoom(1, 2150, 'Gates')));
    drain();
    expect(sent).toEqual(['/Soul @comeback-room 1/2150']);
  });

  it('sends no @comeback-room from a room the realm data has not placed', () => {
    knowing('Soul', 'yes');
    peers.ask('Soul', 'comeback', who());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.comebackUnplaced', { who: 'Soul' }));
  });

  it('walks to the address somebody sends, and acknowledges only a walk that started', () => {
    peers.onBlock(said('conversation-telepath', 'Soul', '@comeback-room 1/2150'), who());
    drain();
    expect(comebacks).toEqual(['Soul:1/2150']);
    expect(sent).toEqual(['/Soul {ok}']);
  });

  it('does not acknowledge a route that was refused', () => {
    walks = false;
    peers.onBlock(said('conversation-telepath', 'Soul', '@comeback-room 1/2150'), who());
    drain();
    expect(comebacks).toEqual(['Soul:1/2150']);
    expect(sent).toEqual([]);
  });

  it('walks nowhere on an argument that is not an address', () => {
    peers.onBlock(said('conversation-telepath', 'Soul', '@comeback-room the gates'), who());
    drain();
    expect(comebacks).toEqual([]);
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.comebackUnreadable', { from: 'Soul' }));
  });
});

/*
 * `@heal`, both halves. Received, it is the member's word handed to the
 * healer and nothing said back — captures/081 answers `Death telepaths: @heal`
 * with `mend death` and no reply. Sent, it is MegaMUD's *Ask For Healing*: the
 * room say most of the corpus shows (`Kindred says "@heal"`, captures/167).
 */
describe('@heal', () => {
  const partyMember = (name: string, invited = false) => ({
    name,
    className: null,
    health: 1,
    mana: null,
    rank: null,
    activity: null,
    invited,
    vitals: null,
    pool: null,
    sheet: null
  });
  // Known to be seen, so the ask is the room say; `hidden` below covers the rest.
  const inParty = (hp: number | null, ...others: string[]): CharacterState =>
    who({
      stealth: 'seen',
      vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 100 },
      party: {
        ...EMPTY_CHARACTER.party,
        members: [partyMember('Vaelor'), ...others.map((name) => partyMember(name))]
      }
    });
  const asking = (below: number, over: Partial<AutomationConfig> = {}): AutomationConfig => ({
    ...config,
    party: { ...config.party, askForHealBelow: below },
    ...over
  });

  it('hands a request to the healer, said in the room or telepathed, and answers nothing', () => {
    const wanted: string[] = [];
    const healer = new Remotes(config, queue, { healRequested: (from) => wanted.push(from) });
    healer.onBlock(said('conversation-local', 'Soul', '@heal'), inParty(100, 'Soul'));
    healer.onBlock(said('conversation-telepath', 'Yang', '@heal'), inParty(100, 'Yang'));
    drain();
    expect(wanted).toEqual(['Soul', 'Yang']);
    // No answer to either; the one `par` is for their unlisted bars (todo 142, `ParOnWord`).
    expect(sent).toEqual([config.onPartyChange || 'par']);
  });

  it('is granted to a party member by the shipped list', () => {
    const wanted: string[] = [];
    const shipped: AutomationConfig = {
      ...config,
      remotes: { ...DEFAULT_CONFIG.automation.remotes, enabled: true }
    };
    const healer = new Remotes(shipped, queue, {
      healRequested: (from) => wanted.push(from),
      notice: (m) => notices.push(m)
    });
    healer.onBlock(said('conversation-local', 'Soul', '@heal'), inParty(100, 'Soul'));
    // And not to somebody who is not in the party.
    healer.onBlock(said('conversation-local', 'Rend', '@heal'), inParty(100, 'Soul'));
    expect(wanted).toEqual(['Soul']);
    expect(notices).toContain(
      t('automation.remotes.refusedNotGranted', {
        from: 'Rend',
        raw: 'heal',
        unresolvedClause: t('automation.remotes.notInParty')
      })
    );
  });

  it('asks the room once on the crossing, not on every status line', () => {
    peers.configure(asking(0.5));
    peers.onCharacter(inParty(80, 'Soul'));
    peers.onCharacter(inParty(40, 'Soul'));
    peers.onCharacter(inParty(38, 'Soul'));
    drain();
    peers.onCharacter(inParty(35, 'Soul'));
    drain();
    expect(sent).toEqual(['.@heal']);
  });

  it('asks again after the interval while still under the line', () => {
    peers.configure(asking(0.5));
    peers.onCharacter(inParty(40, 'Soul'));
    drain();
    vi.advanceTimersByTime(15_000);
    peers.onCharacter(inParty(40, 'Soul'));
    drain();
    expect(sent).toEqual(['.@heal', '.@heal']);
  });

  it('asks no oftener than the interval, however the bar bobs round the line', () => {
    peers.configure(asking(0.5));
    peers.onCharacter(inParty(48, 'Soul'));
    drain();
    peers.onCharacter(inParty(52, 'Soul'));
    peers.onCharacter(inParty(48, 'Soul'));
    drain();
    expect(sent).toEqual(['.@heal']);
    vi.advanceTimersByTime(15_000);
    peers.onCharacter(inParty(48, 'Soul'));
    drain();
    expect(sent).toEqual(['.@heal', '.@heal']);
  });

  /*
   * A say is `CommType.Talk`, which calls `BreakStealth()` on GreaterMUD
   * (`CommManager.cs:243`, the server's source); a telepath does not. So only a
   * character known to be seen says it; one sneaking, or nobody has placed
   * either way, telepaths each member instead.
   */
  it('telepaths each member instead of saying it unless known to be seen', () => {
    peers.configure(asking(0.5));
    for (const stealth of ['sneaking', 'unknown'] as const) {
      sent.length = 0;
      peers.reset();
      peers.onCharacter({ ...inParty(40, 'Soul', 'Yang'), stealth });
      drain();
      expect(sent).toEqual(['/Soul @heal', '/Yang @heal']);
    }
  });

  it('drops a say queued while seen once the character is hiding', () => {
    peers.configure(asking(0.5));
    queue.noteTyping(true);
    peers.onCharacter(inParty(40, 'Soul'));
    peers.onCharacter({ ...inParty(40, 'Soul'), stealth: 'sneaking' });
    queue.noteTyping(false);
    drain();
    // The telepath went instead; the say never left.
    expect(sent).toEqual(['/Soul @heal']);
  });

  it('does not ask outside a party, at 0, on an unknown bar, or with automation off', () => {
    peers.configure(asking(0.5));
    peers.onCharacter(inParty(10));
    peers.onCharacter(who({ party: inParty(10, 'Soul').party }));
    peers.onCharacter(
      who({
        vitals: { ...EMPTY_CHARACTER.vitals, hp: 10, hpMax: 100 },
        party: { ...EMPTY_CHARACTER.party, members: [partyMember('Rend', true)] }
      })
    );
    peers.configure(asking(0));
    peers.onCharacter(inParty(10, 'Soul'));
    peers.configure(asking(0.5, { enabled: false }));
    peers.onCharacter(inParty(10, 'Soul'));
    drain();
    // Rend's invitation is followed up with `@join` (todo 01); no heal is asked.
    expect(sent).toEqual(['/Rend @join']);
    // The positive control: the same bar, in a party, with it on.
    peers.configure(asking(0.5));
    peers.onCharacter(inParty(10, 'Soul'));
    drain();
    expect(sent).toEqual(['/Rend @join', '.@heal']);
  });

  it('asks on its own setting, with answering other players switched off', () => {
    peers.configure(asking(0.5, { remotes: { ...config.remotes, enabled: false } }));
    peers.onCharacter(inParty(40, 'Soul'));
    drain();
    expect(sent).toEqual(['.@heal']);
  });

  it('drops an ask the bar recovered from before it could go out', () => {
    peers.configure(asking(0.5));
    queue.noteTyping(true);
    peers.onCharacter(inParty(40, 'Soul'));
    peers.onCharacter(inParty(70, 'Soul'));
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual([]);
    // Nothing went out, so nothing was counted: the next crossing asks at once.
    queue.noteTyping(true);
    peers.onCharacter(inParty(40, 'Soul'));
    queue.noteTyping(false);
    drain();
    expect(sent).toEqual(['.@heal']);
  });
});

describe('@reset', () => {
  const baseline = (base: CombatTally | null = null) => {
    const port = { base, resets: 0, rebase: () => void port.resets++ };
    return port;
  };

  it('starts the combat statistics again, says so, and answers nothing', () => {
    const stats = baseline();
    const remotes = new Remotes(config, queue, { stats, notice: (m) => notices.push(m) });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@reset'), who());
    drain();
    expect(stats.resets).toBe(1);
    expect(notices).toContain(t('automation.remotes.statsReset', { from: 'Soul' }));
    expect(sent).toEqual([]);
  });

  it('is not granted by the shipped lists', () => {
    const stats = baseline();
    const shipped: AutomationConfig = {
      ...config,
      remotes: { ...DEFAULT_CONFIG.automation.remotes, enabled: true }
    };
    new Remotes(shipped, queue, { stats }).onBlock(
      said('conversation-telepath', 'Soul', '@reset'),
      who()
    );
    expect(stats.resets).toBe(0);
  });

  /* Todo 03: @exp is the Combat Stats card's figures, so a reset starts it again. */
  it('answers @exp and @level from the card, since the last reset', () => {
    const HOUR = 3_600_000;
    const now = Date.now();
    const since = now - 2 * HOUR;
    const tally: CombatTally = {
      ...NO_TALLY,
      since,
      at: now,
      experience: 3_000,
      onlineMs: 2 * HOUR,
      onlineSince: null
    };
    const progress = { ...EMPTY_CHARACTER.progress, level: 1, expNeeded: 4_500 };
    const state = who({ tally, progress });
    // Drained each time: two replies to one asker in the queue are one reply.
    const ask = (stats: ReturnType<typeof baseline>, raw: string) => {
      new Remotes(config, queue, { stats }).onBlock(
        said('conversation-telepath', 'Rand', raw),
        state
      );
      drain();
    };

    ask(baseline(), '@exp');
    // Reset an hour in, at 1,000: 2,000 made in the hour since.
    const reset = { ...tally, at: now - HOUR, experience: 1_000, onlineMs: HOUR };
    ask(baseline(reset), '@exp');
    ask(baseline(reset), '@level');
    // A baseline from another series is not subtracted.
    ask(baseline({ ...reset, since: since - 1 }), '@exp');
    expect(sent).toEqual([
      '/Rand {Made: 3,000  Needed: 4,500  Rate: 1.5 k/hr  Will level in: 3h 0m}',
      '/Rand {Made: 2,000  Needed: 4,500  Rate: 2.0 k/hr  Will level in: 2h 15m}',
      '/Rand {Level: 1  Needed: 4,500  Will level in: 2h 15m}',
      '/Rand {Made: 3,000  Needed: 4,500  Rate: 1.5 k/hr  Will level in: 3h 0m}'
    ]);
  });
});

/* Todo 15: the player's own Stop and Play on the sender's word. */
describe('@stop and @rego', () => {
  const driven = (answers: boolean) => {
    const asked: string[] = [];
    const remotes = new Remotes(config, queue, {
      stopMoving: (from) => (asked.push(`stop:${from}`), answers),
      resumeMoving: (from) => (asked.push(`rego:${from}`), answers)
    });
    return { asked, remotes };
  };

  it('answers {ok} on the channel it came in on when something was stopped or resumed', () => {
    const { asked, remotes } = driven(true);
    remotes.onBlock(said('conversation-telepath', 'Soul', '@stop'), who());
    drain();
    remotes.onBlock(said('conversation-telepath', 'Soul', '@rego'), who());
    drain();
    expect(asked).toEqual(['stop:Soul', 'rego:Soul']);
    expect(sent).toEqual(['/Soul {ok}', '/Soul {ok}']);
  });

  it('sends nothing back when there was nothing to stop or resume', () => {
    const { asked, remotes } = driven(false);
    remotes.onBlock(said('conversation-telepath', 'Soul', '@stop'), who());
    remotes.onBlock(said('conversation-telepath', 'Soul', '@rego'), who());
    drain();
    expect(asked).toEqual(['stop:Soul', 'rego:Soul']);
    expect(sent).toEqual([]);
  });

  it('is not granted by the shipped lists', () => {
    const shipped: AutomationConfig = {
      ...config,
      remotes: { ...DEFAULT_CONFIG.automation.remotes, enabled: true }
    };
    const asked: string[] = [];
    const remotes = new Remotes(shipped, queue, {
      stopMoving: (from) => (asked.push(from), true),
      resumeMoving: (from) => (asked.push(from), true)
    });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@stop'), who());
    remotes.onBlock(said('conversation-telepath', 'Soul', '@rego'), who());
    drain();
    expect(asked).toEqual([]);
  });

  it('answers @status with what a @stop stopped and who sent it', () => {
    const remotes = new Remotes(config, queue, {
      progress: () => ({
        walk: IDLE_WALK,
        loop: { ...NO_LOOP, status: 'stopped', name: 'Overgrown Trail' },
        stopped: { by: 'Brackle', name: 'Overgrown Trail' }
      })
    });
    remotes.onBlock(said('conversation-telepath', 'Rand', '@status'), who({ stealth: 'seen' }));
    drain();
    expect(sent).toEqual(['/Rand {IDLE: Overgrown Trail stopped by Brackle}']);
  });
});

/* Todo 16: one of this character's loops, on the sender's word; todo 32: every answer goes back. */
describe('@loop', () => {
  const driven = (answers: MoveAnswer, on: AutomationConfig = config) => {
    const asked: string[] = [];
    const notices: string[] = [];
    const remotes = new Remotes(on, queue, {
      notice: (message) => notices.push(message),
      startLoop: (from, request) => (asked.push(`${from}:${request}`), answers)
    });
    return { asked, notices, remotes };
  };

  it('hands the name over whole, and answers {ok} when a loop started', () => {
    const { asked, remotes } = driven({ kind: 'ok' });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@loop Overgrown Trail'), who());
    drain();
    expect(asked).toEqual(['Soul:Overgrown Trail']);
    expect(sent).toEqual(['/Soul {ok}']);
  });

  it('answers {failed} when a loop matched and could not start', () => {
    const { remotes } = driven({ kind: 'failed' });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@loop 17/16'), who());
    drain();
    expect(sent).toEqual(['/Soul {failed}']);
  });

  it('answers {unknown - "<name>"} when nothing matched', () => {
    const { remotes } = driven({ kind: 'unknown', request: 'Rats', candidates: [] });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@loop Rats'), who());
    drain();
    expect(sent).toEqual(['/Soul {unknown - "Rats"}']);
  });

  it('answers a bare @loop {unknown - ""}, and says so', () => {
    const { asked, notices, remotes } = driven({ kind: 'ok' });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@loop'), who());
    drain();
    expect(asked).toEqual([]);
    expect(notices).toEqual([t('automation.remotes.loopUnnamed', { from: 'Soul' })]);
    expect(sent).toEqual(['/Soul {unknown - ""}']);
  });

  it('lists what fits in one telepath, the whole line counted', () => {
    const candidates = Array.from({ length: 40 }, (_, at) => `Black House: Caveworm Area ${at}`);
    const { remotes } = driven({ kind: 'unknown', request: 'cave', candidates });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@loop cave'), who());
    drain();
    const line = sent[0]!;
    expect(line.length).toBeLessThanOrEqual(255);
    expect(line).toMatch(
      /^\/Soul \{unknown - "cave": Black House: Caveworm Area 0; .* \+\d+ more\}$/
    );
    const reply = parseRemoteReply(line.slice('/Soul '.length));
    expect(reply).toMatchObject({ kind: 'unknown', request: 'cave' });
    if (reply?.kind !== 'unknown') return;
    expect(reply.candidates.length + reply.more).toBe(40);
  });

  it('is not granted by the shipped lists', () => {
    const shipped: AutomationConfig = {
      ...config,
      remotes: { ...DEFAULT_CONFIG.automation.remotes, enabled: true }
    };
    const { asked, remotes } = driven({ kind: 'ok' }, shipped);
    remotes.onBlock(said('conversation-telepath', 'Soul', '@loop Rats'), who());
    drain();
    expect(asked).toEqual([]);
  });
});

/* Todo 17: a room named as a loop stop names one, on the sender's word; todo 32: answered. */
describe('@goto', () => {
  const driven = (answers: MoveAnswer, on: AutomationConfig = config) => {
    const asked: string[] = [];
    const notices: string[] = [];
    const remotes = new Remotes(on, queue, {
      notice: (message) => notices.push(message),
      goTo: (from, request) => (asked.push(`${from}:${request}`), answers)
    });
    return { asked, notices, remotes };
  };

  it('hands the room over whole, and answers {ok} when the walk started', () => {
    const { asked, remotes } = driven({ kind: 'ok' });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@goto Town Gates 1/2150'), who());
    drain();
    expect(asked).toEqual(['Soul:Town Gates 1/2150']);
    expect(sent).toEqual(['/Soul {ok}']);
  });

  it('answers the rooms a shared name could be, by map/room', () => {
    const { remotes } = driven({
      kind: 'unknown',
      request: 'Sewer Tunnel',
      candidates: ['1/766', '1/1348']
    });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@goto Sewer Tunnel'), who());
    drain();
    expect(sent).toEqual(['/Soul {unknown - "Sewer Tunnel": 1/766; 1/1348}']);
  });

  it('walks nothing without a room, says so, and answers {unknown - ""}', () => {
    const { asked, notices, remotes } = driven({ kind: 'ok' });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@goto'), who());
    drain();
    expect(asked).toEqual([]);
    expect(notices).toEqual([t('automation.remotes.gotoUnnamed', { from: 'Soul' })]);
    expect(sent).toEqual(['/Soul {unknown - ""}']);
  });

  it('is not granted by the shipped lists', () => {
    const shipped: AutomationConfig = {
      ...config,
      remotes: { ...DEFAULT_CONFIG.automation.remotes, enabled: true }
    };
    const { asked, remotes } = driven({ kind: 'ok' }, shipped);
    remotes.onBlock(said('conversation-telepath', 'Soul', '@goto 17/16'), who());
    drain();
    expect(asked).toEqual([]);
  });
});

/* Todo 32: where the character is going, in MegaMUD's frame; and the answers this one hears. */
describe('@path', () => {
  it('answers what the session reports, and {none} for nothing', () => {
    const report: PathReport = {
      path: 'DCCWLOOP.mp',
      title: 'Sewers: CaveWorm',
      to: null,
      why: null,
      steps: 4,
      end: 'lap end'
    };
    let now: PathReport | null = report;
    const remotes = new Remotes(config, queue, { path: () => now });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@path'), who());
    drain();
    now = null;
    remotes.onBlock(said('conversation-telepath', 'Rand', '@path'), who());
    drain();
    expect(sent).toEqual([
      '/Soul {DCCWLOOP.mp (Sewers: CaveWorm) - 4 steps to lap end}',
      '/Rand {none}'
    ]);
  });

  it('reads the answer to a typed /<name> @path, and to nothing else', () => {
    const notices: string[] = [];
    const remotes = new Remotes(config, queue, { notice: (message) => notices.push(message) });
    const answer = '{DCCWLOOP.mp (Sewers: CaveWorm) - 4 steps to lap end}';
    remotes.onBlock(said('conversation-telepath', 'Soul', answer), who());
    expect(notices).toEqual([]);
    remotes.noteTyped('/soul @path');
    remotes.onBlock(said('conversation-telepath', 'Soul', answer), who());
    expect(notices).toEqual([t('automation.remotes.heardPath', { who: 'Soul', path: answer })]);
  });
});

/* Todo 831: MegaMUD's party settings, on both ends of the party. */
describe('party pacing', () => {
  let paced: string[];
  const make = (party: Partial<AutomationConfig['party']>, health = {}): Remotes => {
    paced = [];
    return new Remotes(
      {
        ...config,
        party: { ...config.party, ...party },
        health: { ...config.health, ...health }
      },
      queue,
      {
        notice: (m) => notices.push(m),
        pace: (who, ready) => paced.push(`${who}:${ready ? 'ok' : 'wait'}`),
        peer: (who) => recordOf(registry, who)
      }
    );
  };
  const member = (name: string, health: number | null) => ({
    name,
    className: null,
    health,
    mana: null,
    rank: null,
    activity: null,
    invited: false,
    vitals: null,
    pool: null,
    sheet: null
  });
  it('walks on through @wait under Ignore @wait If Leading, and says so', () => {
    make({ ignoreWait: true }).onBlock(said('conversation-telepath', 'Soul', '@wait'), who());
    expect(paced).toEqual([]);
    expect(notices).toContain(t('automation.remotes.ignoredWait', { from: 'Soul' }));
    make({}).onBlock(said('conversation-telepath', 'Soul', '@wait'), who());
    expect(paced).toEqual(['Soul:wait']);
  });

  /* The user, 2026-10-10: leading, health and mana are held to this character's own settings. */
  it('walks on through a health @wait under Manage Party Health, and stops for a condition', () => {
    const leading = (soul: ReturnType<typeof member>): CharacterState =>
      who({ party: { engaged: {}, threatened: {}, following: null, members: [soul] } });
    const wait = (argument: string, row = member('Soul', 0.6), party = {}): string[] => {
      const remotes = make(party);
      remotes.onBlock(said('conversation-telepath', 'Soul', `@wait${argument}`), leading(row));
      return paced;
    };
    expect(wait('')).toEqual([]);
    expect(notices).toContain(t('automation.remotes.managedWait', { from: 'Soul' }));
    expect(wait(" (HP's too low)")).toEqual([]);
    expect(wait(' (Mana/Kai too low)')).toEqual([]);
    expect(wait(" (can't move)")).toEqual(['Soul:wait']);
    expect(wait(' (blinded)')).toEqual(['Soul:wait']);
    expect(wait(' (poisoned)')).toEqual(['Soul:wait']);
    // No reading of the member, or a flag this client cannot read: the @wait stands.
    expect(wait('', member('Soul', null))).toEqual(['Soul:wait']);
    expect(
      wait('', { ...member('Soul', 0.6), activity: { state: 'unknown', flag: 'P' } as never })
    ).toEqual(['Soul:wait']);
    expect(wait('', member('Soul', 0.6), { manageParty: false })).toEqual(['Soul:wait']);
  });

  /* Todo 142: nine minutes down the Silver River on one listing, Brackle saying he was low. */
  it('asks for the party listing when it walks on through a @wait', () => {
    const leading = who({
      party: { engaged: {}, threatened: {}, following: null, members: [member('Soul', 1)] }
    });
    make({}).onBlock(said('conversation-telepath', 'Soul', "@wait (HP's too low)"), leading);
    drain();
    expect(sent).toEqual([config.onPartyChange || 'par']);
  });

  it('refuses @party under Ignore @party If Following, and says so', () => {
    const following = who({
      party: { engaged: {}, threatened: {}, following: 'Soul', members: [member('Soul', 1)] }
    });
    make({ ignoreParty: true }).onBlock(
      said('conversation-local', 'Soul', '@party stat'),
      following
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices).toContain(t('automation.remotes.ignoredParty', { from: 'Soul' }));
  });

  it('asks a joining member for @health only under Request Party Health', () => {
    const party = who({
      party: { engaged: {}, threatened: {}, following: null, members: [member('Soul', 1)] }
    });
    make({ askHealth: false }).onBlock(joins('player', 'Soul'), party);
    drain();
    expect(sent).not.toContain('/Soul @health');
    make({ askHealth: true }).onBlock(joins('player', 'Soul'), party);
    drain();
    expect(sent).toContain('/Soul @health');
  });

  it("asks the leader to wait when this character's own walk would stand still, not while the leader rests", () => {
    const follower = (hp: number, leaderResting = false): CharacterState =>
      who({
        vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 100 },
        party: {
          engaged: {},
          threatened: {},
          following: 'Soul',
          members: [
            {
              ...member('Soul', 1),
              activity: leaderResting ? ({ state: 'resting' } as never) : null
            }
          ]
        }
      });
    const remotes = make({}, { restBelow: 0.5, restTo: 0.8 });
    // The leader resting is its own rest; nothing asked.
    remotes.onCharacter(follower(30, true));
    drain();
    expect(sent).toEqual([]);
    // Up and walking, and this character under its floor: wait, then ok at the line.
    remotes.onCharacter(follower(30));
    remotes.onCharacter(follower(60));
    remotes.onCharacter(follower(85));
    drain();
    expect(sent).toEqual(["/Soul @wait (HP's too low)", '/Soul @ok']);
  });

  /*
   * The user, 2026-10-10: Brakkle sat at 134/134 with the rest flag up and his
   * @ok went 21s later. The rest-up line is the @ok, whether or not the server
   * still has the character sitting.
   */
  it('says @ok at the rest-up line while still sitting, and gives a condition its own reason', () => {
    const follower = (hp: number, held = false): CharacterState =>
      who({
        vitals: { ...EMPTY_CHARACTER.vitals, hp, hpMax: 100, resting: true },
        afflictions: { ...EMPTY_CHARACTER.afflictions, held: held ? 'yes' : 'no' },
        party: { engaged: {}, threatened: {}, following: 'Soul', members: [member('Soul', 1)] }
      });
    const remotes = make({}, { restBelow: 0.5, restTo: 0.8 });
    remotes.onCharacter(follower(30));
    remotes.onCharacter(follower(80));
    remotes.onCharacter(follower(100, true));
    remotes.onCharacter(follower(100));
    drain();
    expect(sent).toEqual([
      "/Soul @wait (HP's too low)",
      '/Soul @ok',
      "/Soul @wait (can't move)",
      '/Soul @held',
      '/Soul @ok'
    ]);
  });

  /*
   * Todo 20261024-1900-02: Killa (MegaMUD 2.1) sent `@wait (can't move)`,
   * `@held`, then `@comeback` after the realm dropped it as Festus stepped off.
   */
  describe('dropped from the party while held', () => {
    const held = (yes: boolean, following: string | null = 'Soul'): CharacterState =>
      who({
        room: { ...EMPTY_CHARACTER.room, map: 1, number: 30 },
        vitals: { ...EMPTY_CHARACTER.vitals, hp: 100, hpMax: 100 },
        afflictions: { ...EMPTY_CHARACTER.afflictions, held: yes ? 'yes' : 'no' },
        party: { engaged: {}, threatened: {}, following, members: [member('Soul', 1)] }
      });
    const dropped = (leader: string): Block =>
      ({ type: 'party-left', domain: 'presence', groups: { leader } }) as unknown as Block;

    it('asks the leader @comeback once, and not when it was not held', () => {
      const remotes = make({});
      remotes.onCharacter(held(true));
      remotes.onBlock(dropped('Soul'), held(true, null));
      remotes.onBlock(dropped('Soul'), held(true, null));
      drain();
      expect(sent).toEqual(["/Soul @wait (can't move)", '/Soul @held', '/Soul @comeback']);
      // And a fresh follower dropped while free asks nothing.
      sent.length = 0;
      const free = make({});
      free.onCharacter(held(false));
      free.onBlock(dropped('Soul'), held(false, null));
      drain();
      expect(sent).toEqual([]);
    });

    it('asks a leader running this client to come to its room', () => {
      registry = {
        soul: { ...(recordOf(NO_PLAYERS, 'Soul') ?? {}), name: 'Soul', extendedRemotes: 'yes' }
      } as never;
      const remotes = make({});
      remotes.onCharacter(held(true));
      remotes.onBlock(dropped('Soul'), held(true, null));
      drain();
      expect(sent.at(-1)).toBe('/Soul @comeback-room 1/30');
    });
  });
});

describe('the decision behind each line and command (todo 119)', () => {
  let lines: Array<[string, DecisionKind | undefined]>;
  let decided: Array<[string, DecisionKind | undefined]>;
  const remotesUnder = (settings: AutomationConfig): Remotes =>
    new Remotes(
      settings,
      new CommandQueue(settings, {
        send: (command, intent) => decided.push([command, intent.decision])
      }),
      { notice: (message, decision) => lines.push([message, decision]) }
    );

  beforeEach(() => {
    lines = [];
    decided = [];
  });

  it('names @do on the command, its {ok} and its line', () => {
    remotesUnder(config).onBlock(said('conversation-telepath', 'Sesub', '@do a ooze'), who());
    drain();
    expect(decided).toEqual([
      ['a ooze', 'remote-do'],
      ['/Sesub {ok}', 'remote-do']
    ]);
    expect(lines).toEqual([
      [t('automation.remotes.ranDo', { from: 'Sesub', command: 'a ooze' }), 'remote-do']
    ]);
  });

  it('names an answer, a @party command and a refusal by their settings', () => {
    const remotes = remotesUnder({
      ...config,
      remotes: {
        ...config.remotes,
        players: {
          ...config.remotes.players,
          yang: { allow: ['health'], deny: [], autoInvite: false }
        }
      }
    });
    const up = who({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 600, hpMax: 600 } });
    remotes.onBlock(said('conversation-telepath', 'Sackhunter', '@health'), up);
    remotes.onBlock(said('conversation-local', 'Swampfox', '@party go rift'), up);
    remotes.onBlock(said('conversation-telepath', 'Yang', '@do who'), up);
    drain();
    expect(decided).toEqual([
      ['/Sackhunter {HP=600/600}', 'remote-answer'],
      ['go rift', 'remote-party-cmd']
    ]);
    expect(lines).toContainEqual([
      t('automation.remotes.refusedNotGranted', { from: 'Yang', raw: 'do', unresolvedClause: '' }),
      'remote-grant'
    ]);
  });

  it("names a join's @health and a follower's @wait by the party settings", () => {
    const remotes = remotesUnder(config);
    remotes.onBlock(joins('player', 'Soul'), who());
    drain();
    expect(decided[0]).toEqual(['/Soul @health', 'party-ask-health']);
    decided.length = 0;
    const floor = DEFAULT_CONFIG.automation.health.restBelow * 100;
    remotes.onCharacter(
      who({
        party: { engaged: {}, threatened: {}, following: 'Soul', members: [] },
        vitals: { ...EMPTY_CHARACTER.vitals, hp: floor - 1, hpMax: 100 }
      })
    );
    drain();
    expect(decided).toEqual([["/Soul @wait (HP's too low)", 'follower-wait']]);
  });
});

/*
 * Todo 20261023-1950-01: Killa telepathed `@held`, was dropped from the party
 * as Festus stepped off, then telepathed `@comeback`.
 */
describe('a held member: @held and @comeback', () => {
  let paced: string[];
  let walkedBack: string[];
  let holds: string[];
  const make = (over: Partial<AutomationConfig> = {}): Remotes => {
    paced = [];
    walkedBack = [];
    holds = [];
    return new Remotes({ ...config, ...over }, queue, {
      notice: (m) => notices.push(m),
      pace: (who, ready) => paced.push(`${who}:${ready ? 'ok' : 'wait'}`),
      held: (who, held) => holds.push(`${who}:${held ? 'held' : 'free'}`),
      walkBackFor: (who) => walkedBack.push(who)
    });
  };

  it('is a wait by telepath or said in the room, released by @ok', () => {
    const remotes = make();
    remotes.onBlock(said('conversation-telepath', 'Soul', '@held'), who());
    remotes.onBlock(said('conversation-local', 'Soul', '@held'), who());
    remotes.onBlock(said('conversation-telepath', 'Soul', '@ok'), who());
    expect(paced).toEqual(['Soul:wait', 'Soul:wait', 'Soul:ok']);
    expect(notices).toContain(t('automation.remotes.followerHeld', { from: 'Soul' }));
  });

  // Todo 20261024-1900-01: whoever can free the member is told, a plain @wait is no hold.
  it('tells whoever can free a member of @held and @ok, even under Ignore @wait', () => {
    const remotes = make({ party: { ...config.party, ignoreWait: true } });
    remotes.onBlock(said('conversation-telepath', 'Soul', '@wait'), who());
    remotes.onBlock(said('conversation-telepath', 'Soul', '@held'), who());
    remotes.onBlock(said('conversation-telepath', 'Soul', '@ok'), who());
    expect(holds).toEqual(['Soul:held', 'Soul:free']);
  });

  it('is skipped under Ignore @wait If Leading, and never walked on under Manage Party', () => {
    const ignoring = make({ party: { ...config.party, ignoreWait: true } });
    ignoring.onBlock(said('conversation-telepath', 'Soul', '@held'), who());
    expect(paced).toEqual([]);
    const managing = make({ party: { ...config.party, manageParty: true } });
    const soul = {
      name: 'Soul',
      className: null,
      health: 0.9,
      mana: null,
      rank: null,
      activity: null,
      invited: false,
      vitals: null,
      pool: null,
      sheet: null
    };
    const leading = who({
      party: { engaged: {}, threatened: {}, following: null, members: [soul] }
    });
    managing.onBlock(said('conversation-telepath', 'Soul', '@held'), leading);
    expect(paced).toEqual(['Soul:wait']);
  });

  it('takes @comeback from a member who left a moment ago, on the party grant', () => {
    const partyOnly: Partial<AutomationConfig> = {
      remotes: { ...config.remotes, players: {}, party: ['comeback'] }
    };
    const remotes = make(partyOnly);
    // A stranger first: the positive control for the refusal below.
    remotes.onBlock(said('conversation-telepath', 'Killa', '@comeback'), who());
    expect(walkedBack).toEqual([]);
    const left = {
      type: 'party-left',
      domain: 'presence',
      groups: { player: 'Killa' }
    } as unknown as Block;
    remotes.onBlock(left, who());
    remotes.onBlock(said('conversation-telepath', 'Killa', '@comeback'), who());
    expect(walkedBack).toEqual(['Killa']);
    // Past `regroupMinutes`, the party grant no longer covers them.
    vi.advanceTimersByTime((config.party.regroupMinutes * 60 + 1) * 1000);
    remotes.onBlock(said('conversation-telepath', 'Killa', '@comeback'), who());
    expect(walkedBack).toEqual(['Killa']);
  });
});
