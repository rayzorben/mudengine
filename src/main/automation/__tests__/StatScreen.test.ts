import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatScreen, readAdvance, readRefusal, readScreen } from '../StatScreen';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig, type TrainConfig } from '../../../shared/config';
import { domainOf, type Block, type BlockType } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

const NOTHING = { strength: 0, intellect: 0, willpower: 0, agility: 0, health: 0, charm: 0 };
const train = (wanted: Partial<TrainConfig['wanted']> = {}, stats = true): TrainConfig => ({
  stats,
  wanted: { ...NOTHING, ...wanted },
  // The levelling errand's own two, which this driver does not read.
  levels: false,
  trainer: 0
});

/*
 * The screen as the live realm drew it for Vaelor, 2026-09-12
 * (`out/drive-statscreen2.jsonl`): one flush, the box art and cost chart,
 * then the six `(base to max)` limits, then the values in `ShowCurrentValues`
 * order — given name, the menu's eleven fields, race, class, CP left — and
 * the blank family name drawn once more as `Focus(0)` takes it.
 */
const ART =
  '.─────────────────────────────────────.──./ P A R A D I G M      Char. Creation /    \\  ┌─    Point Cost Chart    ─┐' +
  '│ » Given Name«│___\\_/  │ 1st 10 points: 1 CP each ││ » Strength«│        │ +10 to base stat:  10 CP │' +
  '│ »  Exit:«» CP Left:«│ ──────── SAVE your character or EXIT⌐┴───────.     │\\_____\\___/';
const LIMITS =
  '(  40 to  140)(  40 to  140)(  30 to  130)(  60 to  170)(  30 to  120)(  50 to  150)';
const VALUES =
  'Vaelor                90  80  30 110  70  70None           Black          Black          SAVENekojin           Ninja               10';
const DUMP = ART + LIMITS + VALUES;

/* Each keystroke's echo, verbatim from the same run. */
const ECHO = {
  pastName: '            10            90',
  pastStrength: '  90  10  90  80',
  pastIntellect: '  80  10  80  30',
  pastWillpower: '  30  10  30 110',
  pastAgility: ' 110  10 110  70',
  typed71: '    71',
  pastHealth: '  71   5  71  70',
  pastCharm: '  70   5  70None',
  pastHairLength: 'None              5None           Black',
  pastHairColour: 'Black             5Black          Black',
  pastEyeColour: 'Black             5Black          SAVE'
};

let seq = 0;
function block(type: BlockType, text = ''): Block {
  seq += 1;
  return {
    seq,
    at: 1_700_000_000_000 + seq,
    type,
    domain: domainOf(type),
    groups: {},
    text,
    terminator: 'newline',
    confidence: 0.8
  };
}

/** At the trainer, the sheet read, ten points unspent. */
function atTheTrainer(over: Partial<CharacterState['progress']> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 1, number: 250, name: 'Ninja Training Room' },
    progress: {
      ...base.progress,
      cp: 10,
      strength: 90,
      intellect: 80,
      willpower: 30,
      agility: 110,
      health: 70,
      charm: 70,
      ...over
    },
    attributeSpans: {
      strength: [40, 140],
      intellect: [40, 140],
      willpower: [30, 130],
      agility: [60, 170],
      health: [30, 120],
      charm: [50, 150]
    }
  };
}

let sent: string[];
let wrote: string[];
let notices: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let trainer: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  sent = [];
  wrote = [];
  notices = [];
  decisions = [];
  trainer = true;
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});

afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (config = train({ health: 71 }), enabled = true): StatScreen =>
  new StatScreen(
    config,
    enabled,
    queue,
    { atTrainer: () => trainer, write: (bytes) => wrote.push(bytes) },
    { notice: (m) => notices.push(m), decided: (d) => decisions.push(d) }
  );
const drain = (): void => void vi.advanceTimersByTime(50);

/** Opens the screen as the driver's own and hands it the dump. */
function opened(auto: StatScreen): void {
  auto.onCharacter(atTheTrainer());
  drain();
  expect(sent).toEqual(['train stats']);
  auto.noteSent('train stats', 'automation');
  auto.onBlock(block('user-stats-screen', DUMP));
}

describe('reading the screen', () => {
  /*
   * Todo 111: with a prompt's credit in hand the queue sends inside `enqueue`,
   * and the session's send hook runs `noteSent` there — before the driver had
   * recorded its own proposal. It filed its own `train stats` as the player's,
   * went idle, and the assignment then set `proposed` over an idle phase: the
   * screen stood open with the arbiter held and the driver dead for the
   * session (Vaelor at the Sysop Trainer, 2026-09-13).
   */
  it('owns a train stats the queue sent at once, and drives the screen that answers it', () => {
    let auto: StatScreen | null = null;
    queue.dispose();
    queue = new CommandQueue(automation, {
      send: (command) => {
        sent.push(command);
        auto?.noteSent(command, 'automation');
      }
    });
    queue.notePrompt();
    auto = make();
    auto.onCharacter(atTheTrainer());
    expect(sent).toEqual(['train stats']);
    auto.onBlock(block('user-stats-screen', DUMP));
    // Driving: the first Enter past the family name went out.
    expect(wrote.length).toBeGreaterThan(0);
    expect(notices.some((line) => /Spending/.test(line))).toBe(true);
  });

  it('reads the six limits, the figures, the CP left and which field took focus off the dump', () => {
    const reading = readScreen(DUMP);
    expect(reading).toMatchObject({
      firstName: 'Vaelor',
      lastName: '',
      focused: '',
      cp: 10,
      exit: 'SAVE',
      current: { strength: 90, intellect: 80, willpower: 30, agility: 110, health: 70, charm: 70 }
    });
    expect(reading?.limits.health).toEqual({ base: 30, max: 120 });
    expect(reading?.limits.agility).toEqual({ base: 60, max: 170 });
    // Half a dump is not a reading yet.
    expect(readScreen(ART + LIMITS + VALUES.slice(0, 40))).toBeNull();
  });

  it("reads each Enter's echo: the field redrawn, the CP left, and the next field's value", () => {
    expect(readAdvance(ECHO.pastName, 0)).toEqual({ previous: '', cp: 10, next: '90' });
    expect(readAdvance(ECHO.pastHealth, 5)).toEqual({ previous: '71', cp: 5, next: '70' });
    expect(readAdvance(ECHO.pastCharm, 6)).toEqual({ previous: '70', cp: 5, next: 'None' });
    expect(readAdvance(ECHO.pastEyeColour, 9)).toEqual({ previous: 'Black', cp: 5, next: 'SAVE' });
    // The exit toggle is one of its two words or not there yet.
    expect(readAdvance('Black             5Black          SA', 9)).toBeNull();
    // A stat closes on its last digit; three characters of four is not it.
    expect(readAdvance('  90  10  90  8', 1)).toBeNull();
  });

  it("reads the server's three refusals", () => {
    expect(readRefusal('You may not assign that much to Strength  90')).toBe(
      'You may not assign that much to Strength'
    );
    expect(readRefusal('Health may not be higher than 120.  70')).toBe(
      'Health may not be higher than 120.'
    );
    expect(readRefusal('Invalid number.  70')).toBe('Invalid number.');
    expect(readRefusal(ECHO.pastHealth)).toBeNull();
  });
});

describe('deciding to open the screen', () => {
  /* Todo 113: a refused enqueue is *not now*; the same points in the same room are asked about again. */
  it('asks again after the queue refused the ask', () => {
    queue.hold('the stat screen has the keyboard');
    const auto = make();
    auto.onCharacter(atTheTrainer());
    drain();
    expect(sent).toEqual([]);
    queue.release();
    auto.onCharacter(atTheTrainer());
    drain();
    expect(sent).toEqual(['train stats']);
  });

  /*
   * Todo 116: the ask goes out behind whatever is in flight, and the prompt
   * that answers the command before it (a `sys go`, a step) arrived in the
   * `asked` phase and was read as the realm refusing the word. The form that
   * followed was then nobody's and stood open for three minutes.
   */
  it('does not take a prompt for an earlier command as the refusal of its ask', () => {
    const auto = make();
    auto.onCharacter(atTheTrainer());
    drain();
    auto.noteSent('train stats', 'automation');
    auto.onBlock(block('status-line', '[HP=452/MA=504]:'));
    auto.onBlock(block('command-echo', 'train stats'));
    auto.onBlock(block('user-stats-screen', DUMP));
    expect(wrote.length).toBeGreaterThan(0);
    expect(notices.some((line) => /Spending/.test(line))).toBe(true);
  });

  it('takes a prompt after the echo as the refusal, and asks again from the next state', () => {
    const auto = make();
    auto.onCharacter(atTheTrainer());
    drain();
    auto.noteSent('train stats', 'automation');
    auto.onBlock(block('command-echo', 'train stats'));
    auto.onBlock(block('status-line', '[HP=452/MA=504]:'));
    auto.onBlock(block('user-stats-screen', DUMP));
    expect(wrote).toEqual([]);
  });

  it('lets an unanswered ask go quietly and asks again', () => {
    const auto = make();
    auto.onCharacter(atTheTrainer());
    drain();
    auto.noteSent('train stats', 'automation');
    vi.advanceTimersByTime(5_000);
    expect(notices.some((line) => /nothing answered/.test(line))).toBe(true);
    auto.onCharacter(atTheTrainer());
    drain();
    expect(sent).toEqual(['train stats', 'train stats']);
  });

  it('proposes train stats at a trainer with points unspent and a figure wanted above the sheet', () => {
    make().onCharacter(atTheTrainer());
    drain();
    expect(sent).toEqual(['train stats']);
  });

  it("does nothing, and says so once, while every wanted figure is at or under the sheet's", () => {
    const auto = make(train({ health: 70, strength: 90 }));
    auto.onCharacter(atTheTrainer());
    auto.onCharacter(atTheTrainer());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/every wanted figure is at or under/);
    expect(decisions[0]).toMatchObject({ action: 'train stats', acted: false });
  });

  it('does not open a screen it would only have to leave: the cheapest wanted point priced off the sheet', () => {
    const auto = make(train({ strength: 95 }));
    auto.onCharacter(atTheTrainer({ cp: 5 }));
    drain();
    expect(sent).toEqual([]);
    expect(notices[0]).toMatch(/Strength, 6 CP/);
  });

  it('is not its business away from a trainer, with no points, or with the switch off', () => {
    trainer = false;
    make().onCharacter(atTheTrainer());
    trainer = true;
    make().onCharacter(atTheTrainer({ cp: 0 }));
    make().onCharacter(atTheTrainer({ cp: null }));
    make(train({ health: 71 }, false)).onCharacter(atTheTrainer());
    make(train({ health: 71 }), false).onCharacter(atTheTrainer());
    drain();
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe('driving the screen it opened', () => {
  it('Enters past the name, buys Health 71 for 5 CP where it is focused, Enters to SAVE, and reports', () => {
    const auto = make();
    opened(auto);
    expect(notices.at(-1)).toMatch(/Spending 5 of 10 CP: Health 70→71 \(5 CP\)/);
    expect(wrote).toEqual(['\r\n']);

    auto.onBlock(block('unknown', ECHO.pastName));
    auto.onBlock(block('unknown', ECHO.pastStrength));
    auto.onBlock(block('unknown', ECHO.pastIntellect));
    auto.onBlock(block('unknown', ECHO.pastWillpower));
    expect(wrote).toEqual(['\r\n', '\r\n', '\r\n', '\r\n', '\r\n']);
    // Health took focus: the figure goes in, then the Enter, only once echoed.
    auto.onBlock(block('unknown', ECHO.pastAgility));
    expect(wrote.at(-1)).toBe('71');
    auto.onBlock(block('unknown', ECHO.typed71));
    expect(wrote.at(-1)).toBe('\r\n');
    auto.onBlock(block('unknown', ECHO.pastHealth));
    auto.onBlock(block('unknown', ECHO.pastCharm));
    auto.onBlock(block('unknown', ECHO.pastHairLength));
    auto.onBlock(block('unknown', ECHO.pastHairColour));
    auto.onBlock(block('unknown', ECHO.pastEyeColour));
    // Eleven Enters and one figure: nothing typed into a name, nothing but SAVE at the end.
    expect(wrote.filter((w) => w === '\r\n')).toHaveLength(11);
    expect(wrote.filter((w) => w !== '\r\n')).toEqual(['71']);
    expect(auto.driving).toBe(true);

    auto.onBlock(
      block('user-stats-assigned', 'To prevent accidental suicide or reroll, these commands')
    );
    expect(auto.driving).toBe(false);
    expect(notices.at(-1)).toBe('Trained: Health 70→71 (5 CP). 5 CP left.');
    expect(decisions.at(-1)).toMatchObject({ action: 'train stats', acted: true });
  });

  it('waits for an echo that arrives in two pieces rather than counting Enters', () => {
    const auto = make();
    opened(auto);
    auto.onBlock(block('unknown', ECHO.pastName.slice(0, 20)));
    expect(wrote).toEqual(['\r\n']);
    auto.onBlock(block('unknown', ECHO.pastName.slice(20)));
    expect(wrote).toEqual(['\r\n', '\r\n']);
  });

  it("stops buying on the server's refusal, out loud, and saves what was accepted", () => {
    const auto = make();
    opened(auto);
    for (const echo of [
      ECHO.pastName,
      ECHO.pastStrength,
      ECHO.pastIntellect,
      ECHO.pastWillpower,
      ECHO.pastAgility
    ]) {
      auto.onBlock(block('unknown', echo));
    }
    expect(wrote.at(-1)).toBe('71');
    auto.onBlock(block('unknown', ECHO.typed71));
    // The server disagrees with the reading: the field snaps back to 70.
    auto.onBlock(block('unknown', 'You may not assign that much to Health  70'));
    expect(notices.at(-1)).toMatch(/refused it — “You may not assign that much to Health”/);
    expect(wrote.at(-1)).toBe('\r\n');
    auto.onBlock(block('unknown', '  70  10  70  70'));
    auto.onBlock(block('unknown', ECHO.pastCharm.replace('   5', '  10')));
    auto.onBlock(block('unknown', ECHO.pastHairLength.replace('  5None', ' 10None')));
    auto.onBlock(block('unknown', ECHO.pastHairColour.replace('  5Black', ' 10Black')));
    auto.onBlock(block('unknown', ECHO.pastEyeColour.replace('  5Black', ' 10Black')));
    auto.onBlock(block('user-stats-assigned'));
    expect(notices.at(-1)).toBe('The stat screen was saved unchanged. 10 CP left.');
    expect(decisions.at(-1)).toMatchObject({ acted: false });
  });

  it('lets go of a screen that stops answering, and says how to finish it', () => {
    const auto = make();
    opened(auto);
    vi.advanceTimersByTime(4000);
    expect(auto.driving).toBe(false);
    expect(notices.at(-1)).toMatch(
      /did not answer the last keystroke in 4s.*Enter through to SAVE/
    );
    // Whatever arrives now is the player's screen.
    auto.onBlock(block('unknown', ECHO.pastName));
    expect(wrote).toEqual(['\r\n']);
  });

  it('never drives a screen the player opened, and withdraws its own ask', () => {
    const auto = make();
    // The player is mid-line, so the ask waits in the queue — and then they type the same thing.
    queue.noteTyping(true);
    auto.onCharacter(atTheTrainer());
    expect(queue.snapshot.depth).toBe(1);
    auto.noteSent('train stats', 'user');
    queue.noteTyping(false);
    drain();
    auto.onBlock(block('user-stats-screen', DUMP));
    auto.onBlock(block('unknown', ECHO.pastName));
    expect(sent).toEqual([]);
    expect(wrote).toEqual([]);
  });

  it('never drives the form that has the given name up for editing', () => {
    const auto = make();
    auto.onCharacter(atTheTrainer());
    drain();
    auto.noteSent('train stats', 'automation');
    // `Focus(0)` drew the given name: the first field is the one it must never Enter past.
    auto.onBlock(block('user-stats-screen', DUMP + 'Vaelor'));
    expect(wrote).toEqual([]);
    expect(notices.at(-1)).toMatch(/has the name up for editing/);
    expect(auto.driving).toBe(false);
  });

  it('leaves a screen unchanged when the screen prices the wanted point beyond what is left', () => {
    // The sheet said 10 CP; the screen says 4, and Health costs 5.
    const auto = make();
    auto.onCharacter(atTheTrainer());
    drain();
    auto.noteSent('train stats', 'automation');
    auto.onBlock(
      block('user-stats-screen', DUMP.replace('Ninja               10', 'Ninja                4'))
    );
    expect(notices.at(-1)).toMatch(
      /Nothing to buy on the stat screen \(the cheapest wanted point costs 5 CP and 4 are left\)/
    );
    expect(wrote).toEqual(['\r\n']);
  });
});
