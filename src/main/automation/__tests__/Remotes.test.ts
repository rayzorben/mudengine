import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { Remotes } from '../Remotes';
import { DEFAULT_CONFIG } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { wireExit, wireItem } from '../../../shared/entities';
import type { AutomationConfig } from '../../../shared/config';
import type { Block } from '../../../shared/blocks';
import { NO_LOOP, type LoopProgress } from '../../../shared/loops';
import type { WalkProgress } from '../../../shared/walk';
import { ACTIONABLE_REMOTES } from '../../../shared/remotes';

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
    enabled: true,
    gangpath: true,
    gang: [],
    // Empty, so nothing here is granted by a party listing arriving: these
    // cases are about the answer, and the gate has its own block below.
    party: [],
    players: Object.fromEntries(
      SPEAKERS.map((name) => [name.toLowerCase(), { allow: [...ACTIONABLE_REMOTES], deny: [] }])
    )
  },
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

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

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  notices = [];
  commanded = [];
  queue = new CommandQueue(config, { send: (command) => sent.push(command) });
  peers = new Remotes(config, queue, {
    notice: (m) => notices.push(m),
    commanded: (from, raw) => commanded.push(`${from}:${raw}`)
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
    expect(notices.join(' ')).toContain('no stat sheet');
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
    expect(notices.join(' ')).toContain('does not have that number yet');
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
    expect(notices.join(' ')).toContain('does not have that number yet');
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
    expect(notices.join(' ')).toContain('only ever been seen answering for one');
    sent.length = 0;
    asked('@have ring', who({ inventory: { ...EMPTY_CHARACTER.inventory, items } }));
    expect(sent).toEqual(['/Rand {no}']);
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
    const progress: { walk: WalkProgress; loop: LoopProgress } = {
      walk: {
        status: 'walking',
        done: 2,
        total: 5,
        destination: 'Newhaven, Bank',
        destinationRoom: { map: 1, room: 297 },
        step: null,
        path: [],
        reason: null,
        hold: null
      },
      loop: { ...NO_LOOP, status: 'running', name: 'Rats', stop: 2, stops: 4, laps: 1 }
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
    expect(notices.join(' ')).toContain('Remote execution (@do) by Sesub: "a ooze"');
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

  it('says so rather than sending anything when the floor is empty', () => {
    peers.onBlock(said('conversation-local', 'Rend', '@get-all'), who());
    drain();
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toContain('nothing is listed');
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
    expect(notices.join(' ')).toContain('refused');
  });

  it('will not hang up', () => {
    peers.onBlock(said('conversation-telepath', 'Rend', '@hangup'), who());
    drain();
    expect(sent[0]).toMatch(/^\/Rend \{no: /);
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
    expect(notices.join(' ')).toContain('Unsupported remote command @seen');
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

  it('is off with automation off, whatever its own switch says', () => {
    peers.configure({ ...config, enabled: false });
    peers.onBlock(said('conversation-telepath', 'Rend', '@join'), who());
    drain();
    expect(sent).toEqual([]);
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
  it('asks every member of the party for its numbers when one is formed', () => {
    peers.askParty(
      who({
        party: {
          engaged: {},
          threatened: {},
          following: null,
          members: [
            {
              name: 'Vaelor',
              className: null,
              health: null,
              mana: null,
              rank: null,
              activity: null,
              invited: false,
              vitals: null
            },
            {
              name: 'Soul',
              className: null,
              health: null,
              mana: null,
              rank: null,
              activity: null,
              invited: false,
              vitals: null
            },
            {
              name: 'Yang',
              className: null,
              health: null,
              mana: null,
              rank: null,
              activity: null,
              invited: true,
              vitals: null
            }
          ]
        }
      })
    );
    drain();
    // Not itself, and not somebody who has not accepted the invitation.
    expect(sent).toEqual(['/Soul @health']);
  });

  /*
   * `@wait` and `@ok` are the pacing pair, sent on the **crossing** rather than
   * on every status line — a character resting for a minute is one message.
   */
  it('tells the leader it has sat down, once, and that it is up again', () => {
    const resting = who({
      party: { engaged: {}, threatened: {}, following: 'Soul', members: [] },
      vitals: { ...EMPTY_CHARACTER.vitals, resting: true }
    });
    peers.onCharacter(resting);
    peers.onCharacter(resting);
    peers.onCharacter(
      who({ party: { engaged: {}, threatened: {}, following: 'Soul', members: [] } })
    );
    drain();
    expect(sent).toEqual(['/Soul @wait', '/Soul @ok']);
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
      expect(notices.join(' ')).toContain('realm-wide');
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
      expect(notices.join(' ')).toContain('realm-wide');
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
      expect(notices.join(' ')).toContain('realm-wide');
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
      enabled: true,
      gangpath: true,
      gang: gang as never,
      party: [],
      players: Object.fromEntries(
        Object.entries(players).map(([name, entry]) => [
          name,
          { allow: [...entry.allow] as never, deny: [...(entry.deny ?? [])] as never }
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
    expect(notices.join(' ')).toContain('has not been granted');
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
    expect(notices.join(' ')).toContain('Rend has not been granted');
  });

  it('lets a deny beat what the gang grants, and says which', () => {
    peers.configure(grant({ spike: { allow: [], deny: ['health'] } }, ['health']));
    peers.onBlock(
      said('conversation-telepath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', 'Old Guard')] })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toContain('denied to Spike');
  });

  /*
   * The gate sits ahead of every acting command too, not only the answering
   * ones. `@do` never routes through `reply()`, so a gate that only withheld
   * answers would have left the side effect: a stranger's `@do` would run.
   */
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
    expect(notices.join(' ')).not.toContain('nothing has said yet');
  });

  it('refuses somebody a listing wrote with no gang at all', () => {
    peers.configure(gangOnly());
    peers.onBlock(
      said('conversation-gangpath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', null)] })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices.join(' ')).not.toContain('nothing has said yet');
  });

  it('cannot decide while the asker is only known from an arrival', () => {
    peers.configure(gangOnly());
    peers.onBlock(
      said('conversation-gangpath', 'Spike', '@health'),
      live({ online: [listed('Vaelor', 'Old Guard'), listed('Spike', null, true)] })
    );
    drain();
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toContain('nothing has said yet');
  });

  it('names an unresolved gang so a configured one is not silently refused', () => {
    peers.configure(gangOnly());
    peers.onBlock(said('conversation-gangpath', 'Spike', '@health'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toContain('nothing has said yet');
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
    vitals: null
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
    expect(notices.join(' ')).toContain('not on the party listing');
  });

  it('refuses somebody who is in no party with this character', () => {
    peers.configure(partyOnly('health'));
    peers.onBlock(said('conversation-telepath', 'Rend', '@health'), live());
    drain();
    expect(sent).toEqual([]);
    expect(notices.join(' ')).toContain('not on the party listing');
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
    expect(notices.join(' ')).toContain('denied to Rend');
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
    remotes: { enabled: true, gangpath, gang: ['health'], party: [], players: {} }
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
    expect(notices.join(' ')).toContain('does not answer on the gangpath');
  });

  /*
   * And the side effect is withheld with the answer, not merely the reply: one
   * `bg @do who` with the switch off must not run on this character quietly.
   */
  it('does not act on one with it off either', () => {
    peers.configure({
      ...inGang(false),
      remotes: { enabled: true, gangpath: false, gang: ['do'], party: [], players: {} }
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
    remotes: { enabled: true, gangpath: true, gang: [], party: [], players: {} }
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
    expect(notices.join(' ')).toContain('realm-wide');
  });

  it('still refuses an addressed channel out loud, so the refusal is visible', () => {
    peers.configure(ungranted());
    peers.onBlock(said('conversation-telepath', 'Rend', '@health'), live());
    drain();
    expect(notices.join(' ')).toContain('has not been granted');
  });
});
