import { describe, expect, it } from 'vitest';

import { Classifier, foregroundCodes, looksLikeRoomName, tailAfterPrompt } from '../Classifier';
import type { BlockType } from '../../../shared/blocks';
import type { StreamLine } from '../../../shared/types';

let seq = 0;
/** A framed line as the tokenizer would produce it. */
function line(plain: string, raw = plain): StreamLine {
  seq += 1;
  return { seq, at: 1_700_000_000_000 + seq, text: raw, plain, terminator: 'newline' };
}

/**
 * A realm that names the monsters these tests use.
 *
 * A combat line's verb is realm data, so nothing in the grammar says where the
 * monster's name stops — see the note beside `mob-hits` in `patterns.ts`. The
 * classifier is handed a lookup for exactly that, and one without it classifies
 * the line and names nobody, which is the honest degradation rather than the
 * behaviour under test.
 */
const KNOWN = new Set(['orc rogue', 'giant rat', 'cave rat']);
const NAMES = {
  present: () => [],
  mob: (name: string) =>
    KNOWN.has(name.toLowerCase())
      ? ({ disposition: 'hostile', uncertain: false, costly: 'never' } as const)
      : undefined
};

function classify(plain: string, raw?: string) {
  return new Classifier(NAMES).classify(line(plain, raw)).block;
}

/** Asserts the type and returns the groups, so tests read as one statement. */
function expectType(plain: string, type: BlockType, raw?: string): Record<string, string> {
  const block = classify(plain, raw);
  expect(block.type, `${JSON.stringify(plain)} -> ${block.type}`).toBe(type);
  return block.groups;
}

describe('status line', () => {
  it('reads a status line with mana', () => {
    const g = expectType('[HP=100/MA=50]: ', 'status-line');
    expect(g).toMatchObject({ hp: '100', manaType: 'MA', mana: '50' });
  });

  it('reads a status line with no mana at all', () => {
    // A warrior has none. This is the shape the local server actually sends,
    // and treating a missing mana as zero is how a HUD invents a stat.
    const g = expectType('[HP=31]: ', 'status-line');
    expect(g['hp']).toBe('31');
    expect(g['mana']).toBeUndefined();
  });

  it('reads the monk KAI variant', () => {
    expect(expectType('[HP=80/KAI=12]: ', 'status-line')['manaType']).toBe('KAI');
  });

  it('reads resting on either side of the colon', () => {
    expect(expectType('[HP=50 (Resting) ]: ', 'status-line')['stateA']).toBe('Resting');
    expect(expectType('[HP=50]: (Meditating)', 'status-line')['stateB']).toBe('Meditating');
  });
});

describe('room', () => {
  it('reads exits', () => {
    const g = expectType('Obvious exits: north, south, west, southeast', 'room-exits');
    expect(g['exits']).toBe('north, south, west, southeast');
  });

  it('reads occupants', () => {
    expect(expectType('Also here: Nathaniel.', 'room-also-here')['who']).toBe('Nathaniel');
  });

  it('reads noticed items', () => {
    expect(expectType('You notice newbie manual here.', 'room-items')['items']).toBe(
      'newbie manual'
    );
  });

  it('reads a room name', () => {
    expect(expectType('Newhaven, Village Entrance', 'room-name')['name']).toBe(
      'Newhaven, Village Entrance'
    );
  });

  it('does not mistake prose for a room name', () => {
    // The room-name rule is the loosest in the table; without the plausibility
    // guard it swallows any short capitalised line.
    for (const prose of [
      'You are now wearing a cap.',
      'The orc swings at you.',
      'Welcome to Newhaven!',
      'A stocky man stands here'
    ]) {
      expect(classify(prose).type, prose).not.toBe('room-name');
    }
  });
});

describe('combat', () => {
  it('distinguishes a mob hitting the player from the player hitting a mob', () => {
    // Ordering in the table is what makes this work: `The orc hits you for 3`
    // matches the generic attacker pattern too, with source="The".
    const mob = expectType('The orc rogue hits you for 7 damage!', 'mob-hits');
    expect(mob).toMatchObject({ attacker: 'orc rogue', damage: '7' });

    const user = expectType('Rayzor slashes the orc rogue for 12 damage!', 'user-hits');
    expect(user).toMatchObject({ attacker: 'Rayzor', target: 'orc rogue', damage: '12' });
  });

  it('reads a miss', () => {
    expect(expectType('The giant rat swings at you.', 'mob-misses')['attacker']).toBe('giant rat');
  });

  /*
   * The two lines that were in front of somebody when the old pair of patterns
   * was found to be wrong. Neither is `<one word> you` and neither ends in a
   * full stop, so the client did not know it was being attacked at all — it
   * went on trying to open a fight with a monster it had already killed while
   * a second one hit it eleven times.
   */
  it('reads an attack however many words the realm spent on it', () => {
    const teeth = expectType('The thin carrion beast snaps at you with its teeth!', 'mob-misses');
    expect(teeth['line']).toBe('thin carrion beast snaps at you with its teeth');

    const lunge = expectType('The large lashworm lunges at you!', 'mob-misses');
    expect(lunge['line']).toBe('large lashworm lunges at you');

    const tail = expectType('The cave rat lashes you with its tail for 4 damage!', 'mob-hits');
    expect(tail).toMatchObject({ attacker: 'cave rat', damage: '4' });
  });

  /*
   * The name is a *modifier plus* a name the realm knows, and the modifier is
   * kept: `MobNameModifierType.Before` is what the server prints and what an
   * `attack` has to be given back.
   */
  it('keeps the modifier the realm hung on the front of a name', () => {
    const g = expectType('The huge cave rat bites you for 3 damage!', 'mob-hits');
    expect(g['attacker']).toBe('huge cave rat');
  });

  /* Speech is not a swing, and a name that merely starts with "you" is not you. */
  it('does not read an ordinary sentence as a blow', () => {
    expect(classify('The shopkeeper says "I have nothing for you!"').type).not.toBe('mob-misses');
    expect(classify('The orc rogue slashes Youssef for 5 damage!').type).not.toBe('mob-hits');
  });

  it('names nothing when neither the room nor the realm can say', () => {
    const g = expectType('The gelatinous horror engulfs you!', 'mob-misses');
    expect(g['attacker']).toBeUndefined();
    expect(g['line']).toBe('gelatinous horror engulfs you');
  });

  it('reads this character’s own miss, and what it swung at', () => {
    expect(expectType('You swing at thin carrion beast!', 'user-misses')['target']).toBe(
      'thin carrion beast'
    );
    // The armour-turned-it frame, which names the target the same way.
    expect(expectType('Your punch glances off big filthbug!', 'user-misses')['target']).toBe(
      'big filthbug'
    );
  });

  /*
   * A monster walking in. The arrival verb is per-monster realm data exactly
   * like the attack message, so again only the frame is matched.
   */
  it('reads a monster walking into the room', () => {
    const g = expectType(
      'A large lashworm crawls into the room from the above!',
      'mob-arrives-room'
    );
    expect(g['line']).toBe('large lashworm crawls');
    expect(g['direction']).toBe('above');

    const slither = expectType('A giant rat slithers in from the north.', 'mob-arrives-room');
    expect(slither).toMatchObject({ attacker: 'giant rat', direction: 'north' });

    /*
     * `in the room`, not `into the room`. Both came out of the same room in the
     * same two minutes, for two different monsters — the preposition is part of
     * the per-monster string, so it is data like everything else in there.
     */
    const creep = expectType('A giant rat creeps in the room from the above!', 'mob-arrives-room');
    expect(creep).toMatchObject({ attacker: 'giant rat', direction: 'above' });
  });

  it('reads combat state and experience', () => {
    expect(expectType('*Combat Engaged*', 'combat-status')['status']).toBe('Engaged');
    expect(expectType('You gain 42 experience.', 'user-gain-experience')['exp']).toBe('42');
  });

  /*
   * The answer to `look <mob>` — the only statement of a monster's health this
   * server ever makes. Every pronoun the three server builds can produce, and
   * the plural verb the newest of them added for non-binary mobs.
   */
  it('reads a wound level, whatever pronoun the mob has', () => {
    expect(expectType('He appears to be severely wounded.', 'mob-wounded')['band']).toBe(
      'severely wounded'
    );
    expect(expectType('She appears to be unwounded.', 'mob-wounded')['band']).toBe('unwounded');
    expect(expectType('It appears to be mortally wounded.', 'mob-wounded')['band']).toBe(
      'mortally wounded'
    );
    expect(expectType('They appear to be slightly wounded.', 'mob-wounded')['band']).toBe(
      'slightly wounded'
    );
  });

  /*
   * `very critically wounded` has to beat `critically wounded` in the
   * alternation, or the band arrives one step less urgent than the server said.
   */
  it('does not read the worst band as the one above it', () => {
    expect(expectType('He appears to be very critically wounded.', 'mob-wounded')['band']).toBe(
      'very critically wounded'
    );
  });

  /* A ninth word is a line somebody can go and look at, not a wound level. */
  it('refuses a band the server cannot produce', () => {
    expect(classify('He appears to be a bit poorly.').type).not.toBe('mob-wounded');
  });

  /*
   * The refusals, read out of `AttackCommand.Execute` rather than captured —
   * producing one means being a class that lacks the skill and typing it
   * anyway, which is a thing to recognise rather than a thing to go and do on a
   * live realm.
   *
   * They matter because the refusal is printed *in the room*: a client that
   * kept sending a verb its character cannot use would announce that once a
   * round for as long as the fight lasted.
   */
  it('reads an attack the character cannot make, and which one', () => {
    expect(
      expectType("You don't know the first thing about bashing!", 'attack-refused')['skill']
    ).toBe('bashing');
    expect(
      expectType("You don't know the first thing about jumpkicking!", 'attack-refused')['skill']
    ).toBe('jumpkicking');
  });

  /* Backstab refuses on the *weapon*, so the sentence has a different shape. */
  it('reads the backstab refusal, which is worded differently', () => {
    expect(expectType('You may not backstab with this weapon!', 'attack-refused')['skill']).toBe(
      'backstab'
    );
  });

  /*
   * The one refusal that matters most to automation: the attack is landing and
   * achieving nothing, and the damage lines that would say so never arrive.
   */
  it('reads a weapon that is achieving nothing', () => {
    const groups = expectType(
      'Your weapon has no effect against this creature!',
      'attack-ineffective'
    );
    expect(groups['weapon']).toBe('weapon');
    expect(groups['target']).toBe('creature');
    expect(
      expectType('Your fists have no effect against this golem!', 'attack-ineffective')['weapon']
    ).toBe('fists');
  });
});

/*
 * A batch ends on a status line or not at all — `maxLines` is a backstop, not a
 * terminator. That is easy to forget when writing a *fixture*, and forgetting
 * it is silent: the second listing is not mis-parsed, it simply never exists,
 * and whatever reads it shows an empty card.
 *
 * It cost a smoke run: a wrapped inventory was added in front of the `who`
 * listing with nothing between them, the inventory batch swallowed
 * `Current Adventurers` and the four rows under it, and five assertions about
 * the Realm card failed in a place that had nothing to do with the change.
 */
describe('two listings in a row', () => {
  const feed = (lines: string[]) => {
    const classifier = new Classifier();
    const batches: string[] = [];
    let seq = 0;
    for (const text of lines) {
      seq += 1;
      const { batch } = classifier.classify({
        seq,
        at: seq,
        text,
        plain: text,
        terminator: 'newline'
      });
      if (batch) batches.push(batch.type);
    }
    return batches;
  };

  const INVENTORY = [
    'You are carrying padded helm (Head), padded vest (Torso), padded gloves',
    '(Hands), padded pants (Legs), quarterstaff (Weapon Hand)',
    'You have no keys.',
    'Wealth: 0 copper farthings',
    'Encumbrance: 500/3360 - None [14%]'
  ];
  const WHO = [
    '         Current Adventurers',
    '         ===================',
    '         Rayzor                -  Apprentice S',
    '         Outlaw   Grimjaw     -  Cutpurse',
    '[HP=98/MA=50]:'
  ];

  it('frames both when a status line closes the first', () => {
    expect(feed([...INVENTORY, '[HP=98/MA=50]:', ...WHO])).toEqual(['user-inventory', 'who-list']);
  });

  /*
   * Recorded rather than fixed. It is not the classifier being wrong — the
   * server does not send two listings back to back, and inventing a second
   * terminator would mean guessing which lines belong to which. What is worth
   * pinning is the *shape of the failure*: the first block wins and the second
   * is not merely wrong but absent.
   */
  it('loses the second when nothing closes the first', () => {
    expect(feed([...INVENTORY, ...WHO])).toEqual(['user-inventory']);
  });

  /*
   * A `who` is the one listing whose length is the realm's population rather
   * than the pattern's, and it shipped capped at sixty lines beside the rule.
   * A realm with more adventurers than that truncated its own roster: the rows
   * past the cut were dropped, the roster was replaced by the short version —
   * a listing is authoritative — and the rows after it were fed back through
   * the classifier one at a time. The reported symptom was a `who` on screen
   * with the client calling somebody on it offline.
   */
  it('reads a listing longer than the cap it used to carry', () => {
    const crowd = Array.from(
      { length: 120 },
      (_, at) => `         Player${at.toString().padStart(3, '0')}          -  Apprentice`
    );
    const classifier = new Classifier();
    let batch;
    let seq = 0;
    for (const text of ['         Current Adventurers', ...crowd, '[HP=98/MA=50]:']) {
      seq += 1;
      const out = classifier.classify({ seq, at: seq, text, plain: text, terminator: 'newline' });
      if (out.batch) batch = out.batch;
    }
    expect(batch?.type).toBe('who-list');
    expect(batch?.rows).toHaveLength(120);
  });

  /*
   * And what makes that cap safe to raise: the status line is the terminator,
   * and two MajorMUD realms in the corpus print it lower-cased (`[hp=`,
   * captures/076, 43 times). Matched case-insensitively *only here* — what a
   * status line means is still `STATUS_LINE`'s to say.
   */
  it('closes a listing on a lower-cased prompt', () => {
    expect(feed([...WHO.slice(0, 4), '[hp=98/MA=50]:', ...INVENTORY, '[HP=98/MA=50]:'])).toEqual([
      'who-list',
      'user-inventory'
    ]);
  });
});

describe('session prompts', () => {
  const cases: Array<[string, BlockType]> = [
    ['Please enter your username or "new": ', 'prompt-username'],
    ['Please enter your password: ', 'prompt-password'],
    // The account-creation pair, captured live 2026-08-26; both echo `*`.
    ['Please enter the password you would like to use: ', 'prompt-new-password'],
    ['Please confirm your new password: ', 'prompt-new-password'],
    ['Please enter your selection: ', 'prompt-selection'],
    ['Please select a realm: ', 'prompt-realm'],
    ['Please select a character: ', 'prompt-character'],
    ['[PARADIGM]: ', 'prompt-menu'],
    ['Invalid username/password!', 'login-failed'],
    ['Welcome to the official Paradigm server!', 'login-welcome'],
    ['Welcome back, soul!', 'login-welcome']
  ];

  for (const [text, type] of cases) {
    it(`reads ${type}`, () => {
      expectType(text, type);
    });
  }
});

describe('conversation, movement, items', () => {
  it('reads the conversation channels', () => {
    expect(expectType('Rayzor gossips: hello', 'conversation-gossip')).toMatchObject({
      player: 'Rayzor',
      message: 'hello'
    });
    expect(expectType('Rayzor telepaths: hi', 'conversation-telepath')['player']).toBe('Rayzor');
    expect(expectType('Broadcast from Admin "reboot"', 'conversation-broadcast')['player']).toBe(
      'Admin'
    );
    expect(expectType('Rayzor says "hi there"', 'conversation-local')['message']).toBe('hi there');
  });

  it('reads movement failures', () => {
    expectType('There is no exit in that direction!', 'direction-failed');
    expectType('The door is closed in that direction!', 'direction-failed');
    expect(expectType('You hear movement to the north.', 'heard-movement')['direction']).toBe(
      'north'
    );
  });

  it('reads the rate-limit complaints', () => {
    // These are the messages the pacing question in legacy-assessment 6.2 turns
    // on; recognising them is how that experiment gets its answer.
    expectType('You are typing too quickly - command ignored', 'command-ignored');
    expectType("Why don't you slow down for a few seconds?", 'slow-down');
  });

  it('reads item actions', () => {
    expect(expectType('You took a rusty dagger.', 'player-gets')['item']).toBe('a rusty dagger');
    expect(expectType('Rayzor picks up a torch.', 'player-gets')['player']).toBe('Rayzor');
    expect(
      expectType('You just bought 2 healing potion for 40 copper farthings.', 'user-buys')
    ).toMatchObject({ quantity: '2', item: 'healing potion', price: '40' });
  });

  it('reads presence announcements', () => {
    expect(expectType('Masta just entered the Realm.', 'player-enters')['player']).toBe('Masta');
    expect(expectType('Masta just left the Realm.', 'player-exits')['player']).toBe('Masta');
  });
});

describe('unknown lines', () => {
  it('returns an unknown block with zero confidence rather than guessing', () => {
    const block = classify('    Welcome to Newhaven! You are standing at the gates.');
    expect(block.type).toBe('unknown');
    expect(block.confidence).toBe(0);
  });

  it('leaves an empty line unknown', () => {
    expect(classify('').type).toBe('unknown');
  });
});

describe('colour as a confidence signal, never a test', () => {
  it('classifies exits with no colour at all', () => {
    // The whole point: a server with a different scheme, or none, still parses.
    expect(classify('Obvious exits: north').type).toBe('room-exits');
  });

  it('raises confidence when the colour agrees', () => {
    const plain = classify('Obvious exits: north');
    const green = classify('Obvious exits: north', '\x1b[0;32mObvious exits: north\x1b[0m');
    expect(green.confidence).toBeGreaterThan(plain.confidence);
  });

  it('lowers but does not veto when the colour disagrees', () => {
    const red = classify('Obvious exits: north', '\x1b[0;31mObvious exits: north\x1b[0m');
    expect(red.type).toBe('room-exits');
    expect(red.confidence).toBeLessThan(0.8);
  });

  it('extracts foreground codes, including the bright range', () => {
    expect(foregroundCodes('\x1b[0;32mA\x1b[1;36mB\x1b[0m')).toEqual([32, 36]);
    expect(foregroundCodes('\x1b[92mA')).toEqual([32]);
    expect(foregroundCodes('no colour here')).toEqual([]);
  });
});

describe('looksLikeRoomName', () => {
  it('accepts titles and rejects sentences', () => {
    expect(looksLikeRoomName('Newhaven, Village Entrance')).toBe(true);
    expect(looksLikeRoomName('Mossy Tunnel')).toBe(true);
    expect(looksLikeRoomName('You are here.')).toBe(false);
    expect(looksLikeRoomName('a')).toBe(false);
    expect(looksLikeRoomName('X'.repeat(80))).toBe(false);
  });
});

describe('batch blocks', () => {
  it('assembles the stat sheet spread over many lines', () => {
    const classifier = new Classifier();
    const sheet = [
      'Name:   Rayzor              Lives/CP: 3/12',
      'Race:   Human      Exp:      1500   Perception:  20',
      'Class:  Warrior    Level:    4      Stealth:     10',
      'Hits:   58/72      Armour Class: 12/3   Thievery:    5',
      '        Spellcasting: 0   Traps:   4',
      '        Picklocks:  6',
      'Strength:  18   Agility:  14   Tracking:   9',
      'Willpower: 11   Charm:    10   MagicRes:   3',
      '[HP=58]: '
    ];

    let batch;
    for (const text of sheet) {
      const result = classifier.classify(line(text));
      if (result.batch) batch = result.batch;
    }

    expect(batch?.type).toBe('player-status');
    expect(batch?.groups).toMatchObject({
      first: 'Rayzor',
      race: 'Human',
      class: 'Warrior',
      level: '4',
      hp: '58',
      hpMax: '72'
    });
  });

  it('reads a two-word race, and the two fields that used to go with it', () => {
    /*
     * `Gaunt One` is one of the thirteen races the shipped realm data names,
     * and a single-token race did not merely lose the word — the whole
     * qualifier failed, so this character's *experience* and *perception* were
     * on screen and reached nothing. Verbatim off the wire (2026-09-01,
     * Paradigm, a Gaunt One Mystic).
     */
    const classifier = new Classifier();
    const sheet = [
      'Name: Festus Marcus                    Lives/CP:      9/0',
      'Race: Gaunt One   Exp: 53477           Perception:     88',
      'Class: Mystic     Level: 4             Stealth:        57',
      'Hits:    57/57    Armour Class:  11/0  Thievery:        0',
      '[HP=57/KAI=9]: '
    ];

    let batch;
    for (const text of sheet) {
      const result = classifier.classify(line(text));
      if (result.batch) batch = result.batch;
    }

    expect(batch?.groups).toMatchObject({
      race: 'Gaunt One',
      exp: '53477',
      perception: '88',
      class: 'Mystic',
      level: '4'
    });
  });

  /*
   * Captured from the live realm. The server wraps at its own width with a real
   * CRLF at the fold, so an inventory long enough to wrap arrives as two lines
   * and only the first says `You are carrying`. The tail used to be dropped in
   * silence: the Carrying card listed three of six items and looked like a
   * character wearing half its kit.
   */
  it('rejoins an inventory the server wrapped mid-list', () => {
    const classifier = new Classifier();
    const listing = [
      'You are carrying padded helm (Head), padded vest (Torso), padded gloves',
      '(Hands), padded pants (Legs), padded boots (Feet), quarterstaff (Weapon Hand)',
      'You have no keys.',
      'Wealth: 0 copper farthings',
      'Encumbrance: 500/3360 - None [14%]',
      '[HP=34]: '
    ];

    let batch;
    for (const text of listing) {
      const result = classifier.classify(line(text));
      if (result.batch) batch = result.batch;
    }

    expect(batch?.type).toBe('user-inventory');
    // The fold ate a space, so it is put back: `gloves` and `(Hands)` are one
    // item and gluing them without it produces something nobody carries.
    expect(batch?.groups['items']).toBe(
      'padded helm (Head), padded vest (Torso), padded gloves (Hands), ' +
        'padded pants (Legs), padded boots (Feet), quarterstaff (Weapon Hand)'
    );
    expect(batch?.groups).toMatchObject({ encumbrance: '500', encumbranceMax: '3360' });
  });

  it('keeps the terminator out of the last field it followed', () => {
    const classifier = new Classifier();
    let batch;
    // The status line matches no qualifier either, and folding it in would have
    // written `[HP=34]:` onto the end of whichever field came last.
    for (const text of [
      'You are carrying a rusty dagger',
      'Encumbrance: 12/2400 - None [0%]',
      '[HP=34]: '
    ]) {
      const result = classifier.classify(line(text));
      if (result.batch) batch = result.batch;
    }
    expect(batch?.groups['encumbranceMax']).toBe('2400');
    expect(batch?.groups['items']).toBe('a rusty dagger');
  });

  it('does not start a batch on an unrelated line', () => {
    const classifier = new Classifier();
    for (const text of ['Obvious exits: north', '[HP=31]: ']) {
      expect(classifier.classify(line(text)).batch).toBeUndefined();
    }
  });

  it('forgets a partial batch on reset', () => {
    const classifier = new Classifier();
    classifier.classify(line('Name:   Rayzor              Lives/CP: 3/12'));
    classifier.reset();
    // Without the reset the next status line would close the stale batch.
    expect(classifier.classify(line('[HP=31]: ')).batch).toBeUndefined();
  });
});

describe('lines that only make sense next to the command that caused them', () => {
  /*
   * Both of these were found by capturing a real session against the local
   * server — `npm run capture:analyse`. Neither is recognisable from its shape
   * alone, which is exactly why they were unclassified until a capture showed
   * them next to the command that produced them.
   */
  function afterCommand(command: string, ...lines: string[]) {
    const classifier = new Classifier();
    classifier.observeCommand(command);
    return lines.map((text) => classifier.classify(line(text)).block);
  }

  it('recognises the server echoing back what was sent', () => {
    expect(afterCommand('exp', 'exp')[0]?.type).toBe('command-echo');
  });

  it('does not mistake an echoed command for a room name', () => {
    // `Rest` matches the room-name pattern and passes `looksLikeRoomName`, so
    // without the echo check the client believes it walked into a room by that
    // name — and then resolves a location from it.
    expect(classify('Rest').type).toBe('room-name');
    expect(afterCommand('Rest', 'Rest')[0]?.type).toBe('command-echo');
  });

  it('reports a command the realm said out loud instead of running', () => {
    // Captured live: this server does not refuse an unknown command, it speaks
    // it. `exits`, `time`, `stats` and `gold` all came back this way, which
    // means a typo in a rule file broadcasts to everyone in the room.
    const [block] = afterCommand('exits', 'You say "exits"');
    expect(block?.type).toBe('command-not-understood');
    expect(block?.groups['message']).toBe('exits');
  });

  it('leaves a real conversation alone', () => {
    // `say hello` is someone talking. Only a `You say` of exactly the command
    // just sent is a refusal.
    const [block] = afterCommand('say hello', 'You say "hello"');
    expect(block?.type).toBe('conversation-local');
  });

  it('treats another player speaking as conversation whatever was typed', () => {
    const [block] = afterCommand('exits', 'Corwyn says "exits"');
    expect(block?.type).toBe('conversation-local');
  });

  it('claims nothing before anything has been sent', () => {
    expect(classify('You say "exits"').type).toBe('conversation-local');
  });

  /*
   * And that `conversation-local` names **nobody**: `You` is a pronoun the
   * server writes where a name would go, and the generic say rule captured it
   * as a player. Everything downstream believed it — the registry filed a
   * player called `You`, the Talk card drew it as a control because the
   * registry knew it, and clicking it opened a flyout headed `You  OFFLINE`.
   * Reported 2026-09-02, with the screenshot.
   *
   * Absence is how this client already says *this character said it*, which is
   * what `You yell` had been doing correctly all along.
   */
  it('names nobody when this character is the one speaking', () => {
    const block = classify('You say "hello"');
    expect(block.type).toBe('conversation-local');
    expect(block.groups['player']).toBeUndefined();
    expect(block.groups['message']).toBe('hello');
  });

  it('still names the speaker when it is somebody else', () => {
    expect(classify('Youngblood says "hello"').groups['player']).toBe('Youngblood');
    expect(classify('Rayth says "hello"').groups['player']).toBe('Rayth');
  });

  it('does the same for a yell, which is where the shape came from', () => {
    expect(classify('You yell "hello"').groups['player']).toBeUndefined();
    expect(classify('Rayth yells "hello"').groups['player']).toBe('Rayth');
  });
});

describe('the receipt for an addressed message carries what was said', () => {
  /*
   * `--- Telepath Sent to Soul ---` confirms the send and names the resolved
   * recipient, and nothing else — the body is never echoed (captured
   * 2026-08-27, the same session that fixed the receipt's capitalisation). The
   * command that provoked it is the only record of the words, so the
   * classifier binds it into `sent` — a group of its own, because `message` on
   * this channel means *incoming*, and three consumers recognise the receipt
   * as our own outbound half by its absence.
   */
  function sends(...commands: string[]) {
    const classifier = new Classifier();
    for (const command of commands) classifier.observeCommand(command);
    return (text: string) => classifier.classify(line(text)).block;
  }

  it('binds the telepath body to its receipt', () => {
    const block = sends('/Soul hi there')('--- Telepath Sent to Soul ---');
    expect(block.type).toBe('conversation-telepath');
    expect(block.groups).toMatchObject({ player: 'Soul', sent: 'hi there' });
    expect(block.groups['message']).toBeUndefined();
  });

  it('matches the name as typed against the recipient the server resolved', () => {
    // The server resolves a target by prefix: `/brack` answers `to Brackle`.
    const block = sends('/brack bitch')('--- Telepath Sent to Brackle ---');
    expect(block.groups['sent']).toBe('bitch');
  });

  it('binds a directed say to its own receipt', () => {
    const block = sends('>soul look behind you')('--- Message Directed to Soul ---');
    expect(block.type).toBe('conversation-directed');
    expect(block.groups['sent']).toBe('look behind you');
  });

  it('does not let one sigil answer the other receipt', () => {
    // `/soul hi` is a telepath; a directed receipt cannot be its confirmation.
    const block = sends('/soul hi')('--- Message Directed to Soul ---');
    expect(block.groups['sent']).toBeUndefined();
  });

  it('refuses a recipient the typed name does not extend', () => {
    // A wrong body on a receipt is the client misquoting its own player.
    const block = sends('/soul hi')('--- Telepath Sent to Brackle ---');
    expect(block.groups['sent']).toBeUndefined();
  });

  it('survives an unrelated command sent behind it', () => {
    // The server answers in order: the receipt for `/soul hi` still means
    // `/soul hi` after an `n` has gone out behind it.
    const block = sends('/soul hi', 'n')('--- Telepath Sent to Soul ---');
    expect(block.groups['sent']).toBe('hi');
  });

  it('binds each body once', () => {
    const next = sends('/soul hi');
    expect(next('--- Telepath Sent to Soul ---').groups['sent']).toBe('hi');
    expect(next('--- Telepath Sent to Soul ---').groups['sent']).toBeUndefined();
  });

  it('leaves the earlier of two in flight unbound rather than misquoted', () => {
    // One slot, the attack-command binding's shape: the second send overwrote
    // the first, so the first receipt states the send with no body invented.
    const next = sends('/soul hi', '/brack yo');
    expect(next('--- Telepath Sent to Soul ---').groups['sent']).toBeUndefined();
    expect(next('--- Telepath Sent to Brackle ---').groups['sent']).toBe('yo');
  });

  it('never decorates an incoming telepath', () => {
    // A refused send leaves the slot armed; somebody else's message on the
    // same channel is incoming, and its `message` is theirs.
    const block = sends('/soul hi')('Soul telepaths: ok');
    expect(block.groups).toMatchObject({ player: 'Soul', message: 'ok' });
    expect(block.groups['sent']).toBeUndefined();
  });

  it('does not read an address into an ordinary command', () => {
    const block = sends('gos hi soul')('--- Telepath Sent to Soul ---');
    expect(block.groups['sent']).toBeUndefined();
  });

  it('forgets the slot on reset', () => {
    const classifier = new Classifier();
    classifier.observeCommand('/soul hi');
    classifier.reset();
    const block = classifier.classify(line('--- Telepath Sent to Soul ---')).block;
    expect(block.groups['sent']).toBeUndefined();
  });
});

describe('health', () => {
  it('reads current and maximum from the one command that reports both', () => {
    const g = expectType('Health:   33/33   [100%]', 'user-health');
    expect(g).toMatchObject({ hp: '33', hpMax: '33', percent: '100' });
  });

  it('is not confused by the statistic of the same name on the stat sheet', () => {
    // `Intellect: 45  Health:  45  Martial Arts: 14` carries the *statistic*
    // called Health, which is a different number entirely.
    expect(classify('Intellect: 45     Health:  45          Martial Arts:   14').type).not.toBe(
      'user-health'
    );
  });
});

describe('room names the realm actually has', () => {
  /*
   * Measured against the 3,789 distinct names in the shipped realm data. The
   * previous rule turned away 6.5% of every room in the game, concentrated in
   * the starting city — and losing a name is not cosmetic, because the room
   * block then completes with nothing to look up and the client stops knowing
   * where it is.
   */
  const names = [
    'Intersection of Guild St. & River St.',
    'Corner of Sovereign St. & Noble St.',
    'Intersection of Stone St. and Crown St.',
    'The Silver River, Silvermere Docks',
    'The Homely Hearth, Common Room',
    'Newhaven, Village Entrance',
    'Guild Street, Northern End'
  ];

  for (const name of names) {
    it(`recognises ${name}`, () => {
      expect(looksLikeRoomName(name)).toBe(true);
    });
  }

  const prose = [
    'This is a cobblestoned street.',
    'It continues to the east and west.',
    'You stand at the southernmost edge of Newhaven.',
    'The city wall is to the north, towering over twenty feet.',
    'A dusty path leads away from the gates.',
    'You do not have a suicide password set.'
  ];

  for (const line of prose) {
    it(`does not mistake prose for a room: ${line.slice(0, 32)}`, () => {
      expect(looksLikeRoomName(line)).toBe(false);
    });
  }

  it('separates a title from a sentence by its capitals alone', () => {
    // The only difference between these two is title case, which is why it
    // carries the discrimination rather than a word list.
    expect(looksLikeRoomName('The Silver River')).toBe(true);
    expect(looksLikeRoomName('The city wall is to the north')).toBe(false);
  });

  it('allows an abbreviating stop but not a sentence stop', () => {
    expect(looksLikeRoomName('Oak St. & Brass St.')).toBe(true);
    expect(looksLikeRoomName('Newhaven Docks are quiet.')).toBe(false);
  });
});

describe('shapes read out of the server source', () => {
  /*
   * The first three were not seen on the wire. They came from
   * `GreaterMUD.Module/Comms/CommManager.cs`, which is the server's own account
   * of what it sends — and every one of them was invisible to this client until
   * the source said it existed. See docs/greatermud/communication.md.
   *
   * The two receipts below have since been seen, which is how the spelling of
   * one of them turned out to be wrong: a shape read from a source still has
   * to meet the wire before it can be trusted.
   */
  const cases: Array<[string, string, Record<string, string>]> = [
    [
      'a say directed at you',
      'Rayth says (to Vaelor) "meet me at the docks"',
      { player: 'Rayth', target: 'Vaelor', message: 'meet me at the docks' }
    ],
    [
      'a yell carrying from the next room',
      'Someone yells from the north "help!"',
      { direction: 'north', message: 'help!' }
    ],
    [
      'a gangpath an admin is ghosting',
      '(ghosting - Wolves) Soul gangpaths: on my way',
      { player: 'Soul', message: 'on my way' }
    ],
    /*
     * The receipts for a message addressed to one person, and the only thing
     * on the wire that says either went out: neither `/Soul hi` nor `>Soul hi`
     * is echoed back as a sentence the way a yell is.
     *
     * `Sent` is capitalised, and this pattern was written from the shape
     * rather than from the bytes and spelled `sent` — so it matched nothing
     * for as long as it existed, and every telepath sent from this client was
     * invisible to it. Four captures in `captures/` say `Sent`, the wire said
     * `Sent` on 2026-08-27, and `CommManager.cs` agrees.
     */
    [
      'the receipt for a telepath sent from here',
      '--- Telepath Sent to Soul ---',
      {
        player: 'Soul'
      }
    ],
    [
      'the receipt for a say directed from here',
      '--- Message Directed to Soul ---',
      {
        player: 'Soul'
      }
    ]
  ];

  for (const [what, line, groups] of cases) {
    it(`reads ${what}`, () => {
      const block = classify(line);
      expect(block.domain).toBe('conversation');
      for (const [key, value] of Object.entries(groups)) {
        expect(block.groups[key]).toBe(value);
      }
    });
  }

  it('files each receipt on the channel it is a receipt for', () => {
    expect(classify('--- Telepath Sent to Soul ---').type).toBe('conversation-telepath');
    expect(classify('--- Message Directed to Soul ---').type).toBe('conversation-directed');
  });

  it('does not let the general say swallow a directed one', () => {
    // Order is load-bearing: the general pattern matches this line too, and
    // would report the message as `(to Vaelor) "..."`.
    expect(classify('Rayth says (to Vaelor) "hello"').type).toBe('conversation-directed');
    expect(classify('Rayth says "hello"').type).toBe('conversation-local');
  });

  it('recognises being told it has stopped listening', () => {
    /*
     * The one place the server admits it is ignoring you. The command window
     * discards in silence; this does not, which makes it the only throttle
     * automation can actually observe.
     */
    const block = classify(
      'Too many messages sent - please wait for a few moments before trying again'
    );
    expect(block.type).toBe('comms-throttled');
  });
});

/*
 * `list`, in a shop. Captured verbatim from the live realm:
 *
 *     [HP=34]:list
 *     The following items are for sale here:
 *
 *     Item                          Quantity    Price
 *     ------------------------------------------------------
 *     quarterstaff                  31           Free
 *     club                          26           Free (You can't use)
 */
describe('a shop listing', () => {
  const listing = [
    'The following items are for sale here:',
    '',
    'Item                          Quantity    Price',
    '------------------------------------------------------',
    'quarterstaff                  31           Free',
    'club                          26           Free (You can’t use)',
    'iron ration                   12           25',
    '[HP=34]: '
  ];

  const read = () => {
    const classifier = new Classifier();
    let batch;
    for (const text of listing) {
      const result = classifier.classify(line(text));
      if (result.batch) batch = result.batch;
    }
    return batch;
  };

  it('reads a row per item on sale', () => {
    const batch = read();
    expect(batch?.type).toBe('shop-list');
    expect(batch?.rows.map((row) => row['item'])).toEqual(['quarterstaff', 'club', 'iron ration']);
  });

  /*
   * The heading and the rule of dashes are excluded by the qualifier itself
   * rather than by hand: "Quantity" is not a number, and a row of dashes has no
   * columns at all.
   */
  it('does not read its own heading as an item', () => {
    expect(read()?.rows.some((row) => row['item'] === 'Item')).toBe(false);
    expect(read()?.rows.some((row) => String(row['item']).startsWith('---'))).toBe(false);
  });

  /* `Free` is what this realm prints, and reading it as zero invents a figure. */
  it('keeps a price the realm states in words', () => {
    const rows = read()?.rows ?? [];
    expect(rows[0]).toMatchObject({ item: 'quarterstaff', quantity: '31', price: 'Free' });
    expect(rows[2]).toMatchObject({ item: 'iron ration', quantity: '12', price: '25' });
  });

  /* A class restriction is an annotation on the row, not part of the name. */
  it('keeps the restriction apart from the item it applies to', () => {
    const club = read()?.rows.find((row) => row['item'] === 'club');
    expect(club?.['note']).toMatch(/can.t use/);
  });
});

describe('buying and selling', () => {
  it('reads what was bought and what it cost', () => {
    const g = expectType('You just bought quarterstaff for 0 copper farthings.', 'user-buys');
    expect(g).toMatchObject({ item: 'quarterstaff', price: '0' });
  });

  it('reads what was sold, which mirrors it', () => {
    const g = expectType('You sold quarterstaff for 0 copper farthings.', 'user-sells');
    expect(g).toMatchObject({ item: 'quarterstaff', price: '0' });
  });
});

/*
 * Shapes from the capture corpus — 214 captures across MajorMUD, GreaterMUD
 * and Paradigm (docs/capture-analysis.md). Every line below is verbatim from
 * `captures/`; none was written from memory of another client.
 */
describe('the status line as a field grammar', () => {
  it('reads current of maximum for both resources', () => {
    const g = expectType('[HP=498/498,MA=391/442]:', 'status-line');
    expect(g).toMatchObject({
      hp: '498',
      hpMax: '498',
      manaType: 'MA',
      mana: '391',
      manaMax: '442'
    });
  });

  it('keeps the optional fields for the tracker to read', () => {
    const g = expectType('[HP=580/754,Need=16848293]:', 'status-line');
    expect(g).toMatchObject({ hp: '580', hpMax: '754' });
    expect(g['fields']).toContain('Need=16848293');
  });

  it('accepts every separator the corpus uses', () => {
    expect(expectType('[HP=120/120|MA=40/40]:', 'status-line')['manaMax']).toBe('40');
    expect(expectType('[H=100|M=50|E=200]:', 'status-line')).toMatchObject({
      hp: '100',
      manaType: 'M',
      mana: '50'
    });
    expect(expectType('[HP=100 MA=50 XP=200]', 'status-line')['mana']).toBe('50');
    expect(expectType('[HP=120/120 : Need 500 XP]:', 'status-line')['hpMax']).toBe('120');
  });

  it('still reads the resting flag on either side', () => {
    expect(expectType('[HP=34 (Resting) ]:', 'status-line')['stateA']).toBe('Resting');
  });
});

describe('combat, anchored on the frame', () => {
  const present = (...who: string[]) => new Classifier({ present: () => who, mob: NAMES.mob });
  const withRoom = (who: string[], plain: string) => present(...who).classify(line(plain)).block;

  it('reads this character’s target off the end of the line', () => {
    const g = expectType('You slash the orc rogue for 12 damage!', 'user-hits');
    expect(g).toMatchObject({ attacker: 'You', target: 'orc rogue', damage: '12' });
  });

  it('does not turn a spell into a target', () => {
    // 424 lines in 41 captures set `combat.target` to this fragment.
    const g = expectType('You fire an acid jet at Thrag for 34 damage!', 'user-hits');
    expect(g['attacker']).toBe('You');
    expect(g['target']).toBeUndefined();
  });

  it('names a player target the room has listed', () => {
    const b = withRoom(['Thrag'], 'You fire an acid jet at Thrag for 34 damage!');
    expect(b.type).toBe('user-hits');
    expect(b.groups['target']).toBe('Thrag');
  });

  it('reads a surprise attack as a blow on this character', () => {
    // The two-word verb used to make this "You attacking `chops you`".
    const g = expectType('Lynx surprise chops you for 59 damage!', 'user-hits');
    expect(g).toMatchObject({ attacker: 'Lynx', target: 'you', damage: '59' });
  });

  it('prefers the room’s spelling of the attacker', () => {
    const b = withRoom(['Champion Gudruk'], 'Champion Gudruk smashes you for 20 damage!');
    expect(b.groups['attacker']).toBe('Champion Gudruk');
  });

  it('counts a spell’s blow on this character without inventing a caster', () => {
    const g = expectType('A withering blast of dragonfire sears you for 152 damage!', 'mob-hits');
    expect(g['damage']).toBe('152');
    expect(g['attacker']).toBeUndefined();
  });

  it('records a blow between two other parties against the target', () => {
    const b = withRoom(['Cercio', 'orc rogue'], 'Cercio chops orc rogue for 11 damage!');
    expect(b.type).toBe('user-hits');
    expect(b.groups).toMatchObject({ attacker: 'Cercio', target: 'orc rogue', damage: '11' });
  });

  it('refuses an article as an attacker', () => {
    const b = withRoom(
      ['orc rogue'],
      'A withering blast of dragonfire sears orc rogue for 205 damage!'
    );
    expect(b.groups['attacker']).toBeUndefined();
    expect(b.groups['target']).toBe('orc rogue');
  });

  it('reads the opening of a PvP fight', () => {
    expect(expectType('Rend moves to attack you!', 'player-attacks')).toMatchObject({
      attacker: 'Rend',
      target: 'you'
    });
    expect(
      expectType('Cercio moves to attack massive ice dragon.', 'player-attacks')['target']
    ).toBe('massive ice dragon');
    expect(
      expectType('Raptor moves to attack everyone in the room.', 'player-attacks')['target']
    ).toBe('everyone in the room');
  });

  it('reads a miss between two other parties, with or without a weapon', () => {
    expect(expectType('Cercio swings at massive ice dragon!', 'player-misses')).toMatchObject({
      attacker: 'Cercio',
      target: 'massive ice dragon'
    });
    expect(
      expectType('LaW swings at adult she-dragon with his starsteel greatsword!', 'player-misses')
    ).toMatchObject({ target: 'adult she-dragon', weapon: 'starsteel greatsword' });
    expect(
      expectType('The massive ice dragon snaps at Cercio with its fangs!', 'player-misses')
    ).toMatchObject({ attacker: 'The massive ice dragon', target: 'Cercio' });
    expect(
      expectType(
        " Shooting's swing at ancient sand dragon hits, but glances off its armour.",
        'player-misses'
      )['target']
    ).toBe('ancient sand dragon');
  });

  it('keeps a monster’s swing at this character as mob-misses', () => {
    expect(expectType('The silver cobra lunges at you!', 'mob-misses')).toBeTruthy();
  });

  it('reads a swing at this character from something with no article', () => {
    expect(expectType('Rend swings at you!', 'mob-misses')['attacker']).toBe('Rend');
    const b = withRoom(['Champion Gudruk'], 'Champion Gudruk swings at you with a dwarven axe!');
    expect(b.type).toBe('mob-misses');
    expect(b.groups['attacker']).toBe('Champion Gudruk');
    expect(expectType('You miss giant crab!', 'user-misses')['target']).toBe('giant crab');
  });

  it('reads this character’s own miss with a weapon or a thrown item', () => {
    expect(
      expectType('You swing at adult she-dragon with your starsteel greatsword!', 'user-misses')[
        'target'
      ]
    ).toBe('adult she-dragon');
    expect(
      expectType('You hurl your chakram at large black dragon!', 'user-misses')['target']
    ).toBe('large black dragon');
  });

  it('reads a player’s death and a rest', () => {
    expect(expectType('Trickster drops to the ground!', 'player-dies')['player']).toBe('Trickster');
    expect(expectType('Rend is dead.', 'player-dies')['player']).toBe('Rend');
    expect(expectType('Kaylon kneels to meditate.', 'player-rests')['player']).toBe('Kaylon');
  });

  it('reads damage with no attacker', () => {
    expect(
      expectType('You take 1 damage for bashing the door!', 'user-takes-damage')
    ).toMatchObject({ damage: '1', kind: 'bashing the door' });
    expect(expectType('You take 8 fire damage!', 'user-takes-damage')).toMatchObject({
      damage: '8',
      kind: 'fire'
    });
  });
});

describe('spells', () => {
  it('reads the refusal the mid-round tick needs', () => {
    expectType('You have already cast a spell this round!', 'spell-refused');
  });

  it('reads who cast what on whom, in all three spellings of the amount', () => {
    expect(expectType('You cast major healing on Sir for 20 healing!', 'spell-cast')).toMatchObject(
      { caster: 'You', spell: 'major healing', target: 'Sir', amount: '20' }
    );
    expect(
      expectType('You cast mend on Techno, regenerating 10 damage!', 'spell-cast')['amount']
    ).toBe('10');
    expect(
      expectType('You cast minor healing on Sylvio, healing 16 damage!', 'spell-cast')['amount']
    ).toBe('16');
    expect(expectType('Naji casts mend on Naji!', 'spell-cast')).toMatchObject({
      caster: 'Naji',
      target: 'Naji'
    });
    expect(expectType('You cast barkskin on yourself!', 'spell-cast')['target']).toBe('yourself');
    expect(
      expectType('Cass moves to cast forked lightning upon whipvine.', 'spell-cast')
    ).toMatchObject({ caster: 'Cass', spell: 'forked lightning', target: 'whipvine' });
  });

  /* The receiving half of the frame — a party member blessing this character. */
  it('reads a cast landing on this character', () => {
    expect(expectType('Buster casts chant on you!', 'spell-cast')).toMatchObject({
      caster: 'Buster',
      spell: 'chant',
      target: 'you'
    });
    expect(expectType('Celyn casts speed on you.', 'spell-cast')['target']).toBe('you');
    expect(expectType('Eagle casts greater healing on you!', 'spell-cast')).toMatchObject({
      spell: 'greater healing',
      target: 'you'
    });
  });
});

describe('a duration spell ending', () => {
  it('reads the generic frame in every captured spelling', () => {
    expect(expectType('The effects of bless wear off!', 'user-buff-expired')['spell']).toBe(
      'bless'
    );
    expect(
      expectType('The effects of song of traveling wear off.', 'user-buff-expired')['spell']
    ).toBe('song of traveling');
    expect(
      expectType("The effects of the mummy's curse wears off!", 'user-buff-expired')['spell']
    ).toBe("mummy's curse");
  });

  it('reads the per-spell endings that keep the frame', () => {
    expect(expectType('Your shield of deflection wears off.', 'user-buff-expired')['spell']).toBe(
      'shield of deflection'
    );
    expect(expectType('The song of soothing wears off.', 'user-buff-expired')['spell']).toBe(
      'song of soothing'
    );
    expect(expectType('Your heroism wears off.', 'user-buff-expired')['spell']).toBe('heroism');
  });

  /*
   * The endings that abandon the frame are realm message data none of the
   * realm databases on hand export — they cannot be enumerated, so they are
   * deliberately not matched and the fallback clock expires those buffs.
   */
  it('does not guess at a custom ending', () => {
    expect(classify('Your skin returns to normal.').type).not.toBe('user-buff-expired');
    expect(classify('The silvery aura fades.').type).not.toBe('user-buff-expired');
  });
});

describe('a table heading is not a room', () => {
  it('refuses the heading over a shop’s stock, captured live', () => {
    expect(looksLikeRoomName('Item                          Quantity    Price')).toBe(false);
    expect(classify('Item                          Quantity    Price').type).not.toBe('room-name');
    expect(looksLikeRoomName('Newhaven, Spell Shop')).toBe(true);
    // Four real rooms carry one doubled space; a heading carries two.
    expect(looksLikeRoomName('Crumbling  Catacombs, West Stairwell')).toBe(true);
  });
});

describe('the cheap eight', () => {
  it('has the hide vocabulary, split exactly like sneaking', () => {
    expectType('Attempting to hide...', 'user-hide-initiate');
    expectType("Attempting to hide... You don't think you are hidden.", 'user-hide-failed');
    expectType('You may not hide while attacking or being attacked!', 'user-cant-hide');
  });

  it('reads coins picked up, which go to wealth and not the pack', () => {
    expect(expectType('You picked up 17 copper farthings', 'user-gets-coins')).toMatchObject({
      count: '17',
      coin: 'copper farthings'
    });
    expect(expectType('You picked up 1 silver noble', 'user-gets-coins')['coin']).toBe(
      'silver noble'
    );
  });

  it('reads the guild training a level, captured live', () => {
    expect(expectType('Welcome to level 2!', 'user-levels')['level']).toBe('2');
    expect(
      expectType('You hand over 0 copper farthings to train to the next level!', 'user-trains')[
        'price'
      ]
    ).toBe('0');
    expect(
      expectType('You have learned a new power way of the swan!', 'user-learns')
    ).toMatchObject({ kind: 'power', name: 'way of the swan' });
    expect(expectType('You gain 10 CPs', 'user-gains')).toMatchObject({ count: '10', what: 'CPs' });
    expect(expectType('You gain 0 additional lives.', 'user-gains')['what']).toBe(
      'additional lives'
    );
  });

  it('reads coins landing on the floor', () => {
    expect(expectType('18 gold drop to the ground.', 'room-coins')).toMatchObject({
      count: '18',
      coin: 'gold'
    });
    expect(expectType('1 platinum drop to the ground.', 'room-coins')['coin']).toBe('platinum');
  });

  it('reads the room’s light, the search failure and the exit refusal', () => {
    expect(expectType('The room is barely visible', 'room-light')['light']).toBe('barely visible');
    expect(
      expectType("The room is very dark - you can't see anything", 'room-light')['light']
    ).toBe('very dark');
    expectType('Your search revealed nothing.', 'user-search-failed');
    expectType('You may not go through this exit!', 'direction-failed');
  });

  /*
   * Measured live 2026-08-27 by teleporting to rooms of known light value:
   * −100 and −150 print `dimly lit`, −175 `barely visible`, −999 this. It
   * matched nothing for four phases, so the darkest ninety-five rooms in the
   * realm classified as `unknown` and the tracker went on reporting the room
   * the character had been in before.
   */
  it('reads the darkest phrase of the four', () => {
    expect(
      expectType("The room is pitch black - you can't see anything", 'room-light')['light']
    ).toBe('pitch black');
    expect(expectType('The room is dimly lit', 'room-light')['light']).toBe('dimly lit');
  });

  /*
   * The level gate seen from inside it. Its sibling `You may not go through
   * this exit!` has been read since phase 3; this one classified as `unknown`,
   * which leaves the pending move in the queue and mis-resolves the next room
   * the character genuinely does reach.
   */
  it('reads the gate a character has outgrown as a refusal', () => {
    expectType('You have progressed too far to go through this exit!', 'direction-failed');
  });

  it('reads the refusal that names what is not here', () => {
    expect(expectType("You don't see soul here.", 'target-missing')['target']).toBe('soul');
  });

  it('reads the server walking a follower after its leader, captured live', () => {
    expect(
      expectType(' -- Following your Party leader north --', 'party-follows')['direction']
    ).toBe('north');
  });

  /*
   * The two invitations are opposite facts under one block type, and the name
   * of the capture is the only thing that separates them: `player` is somebody
   * this character invited, `leader` is somebody who invited this character.
   */
  it('reads an invitation from either side, captured live', () => {
    expect(expectType('You have invited Soul to follow you.', 'party-invited')['player']).toBe(
      'Soul'
    );
    const incoming = expectType('Soul has invited you to follow him.', 'party-invited');
    expect(incoming['leader']).toBe('Soul');
    expect(incoming['player']).toBeUndefined();
  });

  // `uninvite soul`, captured live: the offer withdrawn before it was accepted.
  it('reads an invitation withdrawn, captured live', () => {
    expect(expectType('Soul has been removed from your followers.', 'party-left')['player']).toBe(
      'Soul'
    );
  });

  it('reads this character’s own rank change, captured live', () => {
    expect(
      expectType('You have moved to the back ranks of your group.', 'party-rank-changed')['rank']
    ).toBe('back');
  });

  it('reads the realm’s conscience, and somebody looking, both captured live', () => {
    expectType(
      'You are overcome with a feeling of guilt and break off your attack.',
      'attack-warned'
    );
    expectType('To do this action, you must turn off your evil warnings.', 'attack-warned');
    expect(expectType('Yang is looking around the room.', 'player-looks')).toMatchObject({
      player: 'Yang',
      at: 'around the room'
    });
    expect(expectType('RedruM is looking at you.', 'player-looks')['at']).toBe('at you');
  });

  it('reads the evil-warnings toggle both ways, captured live', () => {
    expect(
      expectType('You will no longer be stopped from performing evil actions.', 'user-warnings')[
        'state'
      ]
    ).toContain('no longer');
    expect(
      expectType(
        'You will now be warned and stopped from doing most evil actions.',
        'user-warnings'
      )['state']
    ).toContain('now be warned');
  });

  it('reads the refusal to ready what is already in hand, captured live', () => {
    expect(
      expectType('You do not have quarterstaff left unequipped.', 'user-equipped-failed')['item']
    ).toBe('quarterstaff');
    expect(expectType('You are already wearing padded helm!', 'user-equipped-failed')['item']).toBe(
      'padded helm'
    );
  });

  it('reads the two refusals the stealth probe captured live', () => {
    expectType('That is not a door or a gate!', 'open-failed');
    expect(expectType('The door is locked.', 'open-failed')).toMatchObject({
      barrier: 'door',
      reason: 'locked'
    });
    expectType('You cannot LIST if you are not in a shop!', 'user-list-failed');
  });

  it('reads doors and tracks', () => {
    expect(expectType('The door is now open.', 'door-changed')['state']).toBe('open');
    // Past tense, captured live: the same fact said after somebody else opened it.
    expect(expectType('The door was already open.', 'door-changed')['state']).toBe('open');
    expect(expectType('You successfully unlocked the door.', 'door-changed')['state2']).toBe(
      'unlocked'
    );
    expect(expectType('Rend went west from here.', 'user-tracks')).toMatchObject({
      player: 'Rend',
      direction: 'west'
    });
    expectType('Your tracking skills fail you this time.', 'user-tracks-failed');
    expectType('You are now resting.', 'user-rests');
  });
});

describe('the gang listing', () => {
  const feed = (lines: string[]) => {
    const c = new Classifier(NAMES);
    let batch;
    for (const text of lines) {
      const out = c.classify(line(text));
      if (out.batch) batch = out.batch;
    }
    return batch;
  };

  /*
   * Captured from the live realm, `bg` with no argument. The trailing space on
   * the second row is the server's — the rank field is padded and empty — and
   * it is kept here deliberately: it is the shape an unranked member arrives
   * in, and stripping it in the fixture would test a line the server does not
   * send.
   */
  const CAPTURED = [
    'Valor members (2)',
    'Vaelor                        28 Half-Ogre Mystic       - Online [Leader]',
    'Soul Guardian                 1 Human Warrior           - Online ',
    '[HP=334/KAI=27]:'
  ];

  it('reads the header the gang and its whole membership count', () => {
    const batch = feed(CAPTURED);
    expect(batch?.type).toBe('gang-roster');
    expect(batch?.groups).toMatchObject({ gang: 'Valor', count: '2' });
  });

  it('reads a level, a hyphenated race, a class and the leader mark', () => {
    const batch = feed(CAPTURED);
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[0]).toMatchObject({
      name: 'Vaelor',
      level: '28',
      who: 'Half-Ogre Mystic',
      online: 'Online',
      rank: 'Leader'
    });
  });

  // `Soul Guardian` is a first name and a surname in one 29-column field, the
  // same shape the party listing prints. Read as one word it would file two
  // people under one name.
  it('keeps a surname with its name, and leaves an unranked member unranked', () => {
    const batch = feed(CAPTURED);
    expect(batch?.rows[1]).toMatchObject({
      name: 'Soul',
      last: 'Guardian',
      level: '1',
      who: 'Human Warrior',
      online: 'Online'
    });
    expect(batch?.rows[1]?.['rank']).toBeUndefined();
  });

  /*
   * The offline half of the roster, which is the reason to read this listing
   * rather than `who`: the field keeps its column and is simply empty, so the
   * absence of `- Online` is the statement. Synthesised rather than captured —
   * no gang member has been offline during a capture — and marked as such.
   */
  it('reads an absent Online field as offline rather than as a broken row', () => {
    const batch = feed([
      'Valor members (2)',
      'Vaelor                        28 Half-Ogre Mystic       - Online [Leader]',
      'Offliner                      7 Human Warrior           ',
      '[HP=334/KAI=27]:'
    ]);
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[1]).toMatchObject({ name: 'Offliner', level: '7', who: 'Human Warrior' });
    expect(batch?.rows[1]?.['online']).toBeUndefined();
  });

  // `Gaunt One` is the one two-word race the realm ships, so the race/class
  // boundary cannot be found by counting words from either end.
  it('carries a two-word race through as part of the pair', () => {
    const batch = feed([
      'Valor members (1)',
      'Someone Else                  12 Gaunt One Druid                [Captain]',
      '[HP=334/KAI=27]:'
    ]);
    expect(batch?.rows[0]).toMatchObject({ who: 'Gaunt One Druid', rank: 'Captain' });
  });
});

describe('the MajorMUD party listing', () => {
  const feed = (lines: string[]) => {
    const c = new Classifier(NAMES);
    let batch;
    for (const text of lines) {
      const out = c.classify(line(text));
      if (out.batch) batch = out.batch;
    }
    return batch;
  };

  it('reads surnames, spaced percentages, kai and the middle rank', () => {
    const batch = feed([
      'The following people are in your travel party:',
      '  Slayer OfSouls                 (Gypsy)      [M: 81%] [H: 76%]   - Midrank',
      '  Daytona KingOfThePrudes        (Mystic)     [K:100%] [H:100%]   - Frontrank',
      '[HP=100]:'
    ]);
    expect(batch?.type).toBe('party-roster');
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[0]).toMatchObject({
      name: 'Slayer',
      last: 'OfSouls',
      class: 'Gypsy',
      mana: '81',
      health: '76',
      rank: 'Midrank'
    });
    expect(batch?.rows[1]).toMatchObject({ manaType: 'K', mana: '100' });
  });

  /*
   * The row that reads as having no rank is a folded one, every time.
   *
   * Nine rows across five captures end at the dash and all nine have their rank
   * on the next line; the shape was read as MajorMUD printing an empty rank,
   * which made the rank optional — and an optional rank closes the row at the
   * fold, losing the rank and leaving `Backrank` to swallow the member below.
   */
  it('rejoins a rank the server folded onto the next line', () => {
    const batch = feed([
      'The following people are in your travel party:',
      '  Azazyl Raines                  (Bard)       [M: 91%] [H: 43%] R -',
      'Backrank',
      '  Legolas GreanLeaf              (Mystic)     [K:100%] [H:100%] R -',
      'Frontrank',
      '[HP=267/KAI=30]:'
    ]);
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[0]).toMatchObject({ name: 'Azazyl', flag: 'R', rank: 'Backrank' });
    expect(batch?.rows[1]).toMatchObject({ name: 'Legolas', flag: 'R', rank: 'Frontrank' });
  });

  /*
   * The flag a resting member carries, glued to the bracket on GreaterMUD and
   * spaced off it elsewhere. Unmatched, the row qualified as nothing and a
   * party of two fell to one — which the tracker reads as no party at all.
   */
  it('reads the status flag between the health and the rank', () => {
    const batch = feed([
      'The following people are in your travel party:',
      '  Vaelor                        (Mystic)     [M:100%] [H:100%]  - Frontrank',
      '  Soul Guardian                 (Warrior)             [H:100%]R - Frontrank',
      '[HP=101/KAI=5]:'
    ]);
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[0]?.['flag']).toBeUndefined();
    expect(batch?.rows[1]).toMatchObject({ name: 'Soul', flag: 'R', rank: 'Frontrank' });
  });

  // `P` on every member of a party mid-fight, twice in captures/039, with
  // nothing on the wire saying what it means. The letter is kept; the meaning
  // is not invented.
  it('keeps a flag it cannot name', () => {
    const batch = feed([
      'The following people are in your travel party:',
      '  Alucard Vampire                (Gypsy)      [M: 81%] [H:100%]P  - Frontrank',
      '  Ultralisk SevenHundred         (Witchunter)          [H: 78%]P  - Frontrank',
      '[HP=590/754,Need=16848293]:'
    ]);
    expect(batch?.rows.map((r) => r['flag'])).toEqual(['P', 'P']);
  });

  it('assembles a row a poster’s client folded into four lines', () => {
    const batch = feed([
      'The following people are in your travel party:',
      '        Brutus Nobleblood',
      '        (Warrior)',
      '        [H:100%]',
      '        - Frontrank',
      '        Daytona KingOfThePrudes',
      '        (Mystic)',
      '        [K:100%] [H:100%]',
      '        - Frontrank',
      '[HP=100]:'
    ]);
    expect(batch?.rows.map((r) => r['name'])).toEqual(['Brutus', 'Daytona']);
    expect(batch?.rows[1]).toMatchObject({ health: '100', mana: '100', rank: 'Frontrank' });
  });

  /*
   * `invite soul`, then `par` before the answer — captured live, 2026-08-28.
   * `[Invited]` stands where the health, the flag and the rank would be, and
   * the row matched nothing: the listing fell to one row, which the tracker
   * reads as no party, so the card vanished at the moment the player was
   * watching it for an answer.
   */
  it('reads the row of somebody invited who has not accepted', () => {
    const batch = feed([
      'The following people are in your travel party:',
      '  Vaelor                        (Mystic)     [M:100%] [H:100%]  - Frontrank',
      '  Soul Guardian                 (Warrior)    [Invited]',
      '[HP=101/KAI=5]:'
    ]);
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[1]).toMatchObject({
      name: 'Soul',
      last: 'Guardian',
      class: 'Warrior',
      invited: 'Invited'
    });
    expect(batch?.rows[1]?.['health']).toBeUndefined();
    expect(batch?.rows[1]?.['rank']).toBeUndefined();
  });

  it('still reads the GreaterMUD listing it was built from', () => {
    const batch = feed([
      'The following people are in your travel party:',
      '  Vaelor                        (Warrior)             [H:100%]  - Frontrank',
      '  Soul                          (Paladin)    [M:100%] [H:100%]  - Backrank',
      '[HP=100]:'
    ]);
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[1]).toMatchObject({ name: 'Soul', mana: '100', rank: 'Backrank' });
  });
});

/*
 * Blindness is two sentences and the punctuation is the whole difference: the
 * bang is the onset, beside the attack that caused it (10 in the corpus, every
 * one of them behind a `casts blind`, a `flash` or a smoke bomb), and the full
 * stop is the server declining to draw a room (31, every one of them directly
 * after a status line).
 *
 * They were one pattern, keyed on the full stop, which had it exactly
 * backwards: the alert fired once per *look* and never once when the condition
 * began, and the room block that answers a move was read as a status line
 * nothing consumes. See `room-unseen` in patterns.ts.
 */
describe('blindness', () => {
  function typeOf(text: string): string | undefined {
    const classifier = new Classifier();
    return classifier.classify({ seq: 1, at: 1, text, plain: text, terminator: 'newline' }).block
      ?.type;
  }

  it('reads the onset off the bang', () => {
    expect(typeOf('You are blind!')).toBe('user-blinded');
  });

  it('reads the undrawn room off the full stop', () => {
    expect(typeOf('You are blind.')).toBe('room-unseen');
  });
});

/*
 * The conditions the corpus states both ends of. Counts are across the 218
 * posted captures; a single sample is still the wire, and the wire wins.
 */
describe('afflictions, on and off', () => {
  const cases: Array<[string, BlockType]> = [
    ['You can see again!', 'user-blind-ends'],
    ['You are dizzy and disoriented from poison!', 'user-poisoned'],
    ['Poison burns through your veins!', 'user-poisoned'],
    ['The dizzying poison runs its course.', 'user-poison-ends'],
    ['You are inflicted with a hideous rotting disease!', 'user-diseased'],
    ['The disease dies down.', 'user-disease-ends'],
    ['Your legs are paralyzed!', 'user-held'],
    ["You are held by the queen's spit!", 'user-held'],
    ['You can move again!', 'user-held-ends']
  ];
  for (const [text, type] of cases) {
    it(`reads ${type} from "${text}"`, () => {
      expectType(text, type);
    });
  }

  /* Somebody else's disease is a fact about them, not about this character. */
  it('does not read another player’s affliction as its own', () => {
    const classifier = new Classifier();
    const { block } = classifier.classify({
      seq: 1,
      at: 1,
      text: 'SandTiger is inflicted with a hideous rotting disease!',
      plain: 'SandTiger is inflicted with a hideous rotting disease!',
      terminator: 'newline'
    });
    expect(block?.type).not.toBe('user-diseased');
  });
});

describe('a player looked at', () => {
  /* captures/076: the same player the who listing puts in `Old Guard`. */
  it('reads the name and the gang off the first line of look', () => {
    const g = expectType('[ Nester TheDupe ] (Old Guard)', 'player-look');
    expect(g).toMatchObject({ name: 'Nester', last: 'TheDupe', gang: 'Old Guard' });
  });

  /* captures/058: two files print the line with no parentheses at all. */
  it('reads a player with no gang as having none', () => {
    const g = expectType('[ Sirkilla Dathrilla ]', 'player-look');
    expect(g['name']).toBe('Sirkilla');
    expect(g['gang']).toBeUndefined();
  });

  it('keeps the odd gang names the corpus has', () => {
    expect(expectType('[ Buttah Bang ] (--=ICP FOREVER=--)', 'player-look')['gang']).toBe(
      '--=ICP FOREVER=--'
    );
    expect(expectType('[ Ultralisk SevenHundred ] (................)', 'player-look')['gang']).toBe(
      '................'
    );
  });
});

/*
 * One framed line, two facts.
 *
 * `LineTokenizer` frames on the status line's `ESC[79D ESC[K` repaint, and the
 * server does not always emit one between the prompt it painted and the
 * sentence it then says. `You withdrew 20000 copper farthings.` arrives glued
 * to the prompt; `You deposit 20000 copper farthings.` gets a repaint and a
 * line of its own. Measured over the 218 posted captures and every recorded
 * session: 8,608 of 125,306 status lines carry a tail.
 */
describe('a prompt may carry a tail', () => {
  const classify = (text: string) =>
    new Classifier().classify({
      seq: 1,
      at: 1_700_000_000_000,
      text,
      plain: text,
      terminator: 'newline'
    });

  it('leaves a bare prompt alone', () => {
    const { block, tails } = classify('[HP=334/KAI=27]:');
    expect(block.type).toBe('status-line');
    expect(tails).toBeUndefined();
  });

  it('reads the prompt and the sentence after it', () => {
    const { block, tails } = classify('[HP=334/KAI=27]:You withdrew 20000 copper farthings.');
    expect(block.type).toBe('status-line');
    expect(block.groups['hp']).toBe('334');
    expect(tails?.map((t) => t.type)).toEqual(['user-withdraws']);
    expect(tails?.[0]?.groups['amount']).toBe('20000');
  });

  /*
   * The commonest tail by far is this client's own command coming back — 3,064
   * of the 3,159 tails on its own wire. It was invisible before, because
   * `status-line` claimed the whole line.
   */
  it('recognises an echo that arrived after the prompt', () => {
    const classifier = new Classifier();
    classifier.observeCommand('deposit 30000');
    const { tails } = classifier.classify({
      seq: 1,
      at: 1_700_000_000_000,
      text: '[HP=334/KAI=27]:deposit 30000',
      plain: '[HP=334/KAI=27]:deposit 30000',
      terminator: 'newline'
    });
    expect(tails?.map((t) => t.type)).toEqual(['command-echo']);
  });

  /*
   * Health goes below zero on the way down, and the pattern refused it for
   * three phases: 126 such prompts across the corpus and every recorded
   * session, every one unread, freezing the health readout at the last
   * positive figure for exactly the run of lines somebody is watching it
   * hardest. It cost the corpus's one death its sentence too — a prompt that
   * does not match has no tail to peel.
   */
  it('reads a prompt whose health has gone below zero, and its tail', () => {
    const { block, tails } = classify('[HP=-25/MA=26]:You have been killed!');
    expect(block.type).toBe('status-line');
    expect(block.groups['hp']).toBe('-25');
    expect(block.groups['mana']).toBe('26');
    expect(tails?.map((t) => t.type)).toEqual(['user-dies']);
  });

  /*
   * A prompt's tail can be another prompt, and the two carry different health.
   * `[HP=191]:[HP=188]:You surprise smash Rend for 86 damage!` is in the
   * corpus; peeling once would keep the stale bar and lose the blow.
   */
  it('peels a prompt whose tail is another prompt', () => {
    const { block, tails } = classify('[HP=191]:[HP=188]:Rend just left to the south.');
    expect(block.groups['hp']).toBe('191');
    expect(tails?.map((t) => t.type)).toEqual(['status-line', 'player-leaves-room']);
    expect(tails?.[0]?.groups['hp']).toBe('188');
  });

  /*
   * Verbatim, leading whitespace and all: a rule that tolerates indentation
   * says `^\\s*` already, and trimming here would let an anchored rule match
   * text that was not at the start of anything.
   */
  it('keeps the tail exactly as the server sent it', () => {
    expect(tailAfterPrompt('[HP=334/KAI=27]:   Current Adventurers')).toBe(
      '   Current Adventurers'
    );
    expect(tailAfterPrompt('[HP=334/KAI=27]:   ')).toBeNull();
    expect(tailAfterPrompt('You withdrew 20000 copper farthings.')).toBeNull();
  });
});

/*
 * The table `exp` prints, taken verbatim out of this client's own recorded
 * sessions (2026-09-03, Paradigm, a Kang Paladin at level 3). The blank line
 * and the rule of dashes are real; the status line terminates it.
 */
describe('the experience table', () => {
  const feed = (lines: string[]) => {
    const c = new Classifier(NAMES);
    let batch;
    for (const text of lines) {
      const out = c.classify(line(text));
      if (out.batch) batch = out.batch;
    }
    return batch;
  };

  const WIRE = [
    'The following is a table of experience for your character:',
    '',
    'Level   Experience',
    '-----   ----------',
    '   2     7400',
    '   3     14800',
    '   4     27133',
    '   5     49743',
    '   6     85273',
    '   7     146182',
    '   8     237545',
    '   9     386010',
    '  10     600460',
    '  11     934048'
  ];

  it('reads every row, and neither the rule nor the blank line as one', () => {
    const batch = feed([...WIRE, '[HP=56/MA=12]:']);
    expect(batch?.type).toBe('user-experience-table');
    expect(batch?.rows).toHaveLength(10);
    expect(batch?.rows[0]).toEqual({ level: '2', experience: '7400' });
    expect(batch?.rows[9]).toEqual({ level: '11', experience: '934048' });
  });

  it('emits no room block anywhere in the listing', () => {
    /*
     * `Level   Experience` is title case and multi-word — exactly what the
     * loosest rule in the table accepts — so without `tailsLookLikeRooms` the
     * column header begins a phantom room draft in the middle of the table.
     * The spellbook's own listing had this bug and this is the same guard.
     */
    const c = new Classifier(NAMES);
    const seen: string[] = [];
    for (const text of [...WIRE, '[HP=56/MA=12]:']) seen.push(c.classify(line(text)).block.type);
    expect(seen).not.toContain('room-name');
  });
});

/*
 * The `sp` / `pow` listings, captured live from both sides (`npm run
 * probe:spellbook`, 2026-09-01, orohost) — one grammar under two headers,
 * with the column header consumed and the status line terminating. Before
 * this batch existed, the title-cased column header read as a *room name*
 * and every row after it was swallowed as room description, live and in
 * captures/056.
 */
describe('the spellbook listing', () => {
  const feed = (lines: string[]) => {
    const c = new Classifier(NAMES);
    let batch;
    for (const text of lines) {
      const out = c.classify(line(text));
      if (out.batch) batch = out.batch;
    }
    return batch;
  };

  it('reads the powers listing, wire-verbatim, rows keyed off the columns', () => {
    const batch = feed([
      'You have the following powers:',
      'Level Kai  Short Spell Name',
      '  2   1    swan  way of the swan',
      ' 10   6    mant  way of the mantis',
      ' 24   5    fist  way of the exploding fist',
      '[HP=334/KAI=27]:'
    ]);
    expect(batch?.type).toBe('spellbook');
    expect(batch?.groups['book']).toBe('powers');
    expect(batch?.rows).toEqual([
      { level: '2', cost: '1', short: 'swan', name: 'way of the swan' },
      { level: '10', cost: '6', short: 'mant', name: 'way of the mantis' },
      { level: '24', cost: '5', short: 'fist', name: 'way of the exploding fist' }
    ]);
  });

  it('reads the spells listing under its own header', () => {
    const batch = feed([
      'You have the following spells:',
      'Level Mana Short Spell Name',
      '  1   1    harm  harm',
      '  1   2    mihe  minor healing',
      '[HP=33/MA=22]:'
    ]);
    expect(batch?.type).toBe('spellbook');
    expect(batch?.groups['book']).toBe('spells');
    expect(batch?.rows).toHaveLength(2);
    expect(batch?.rows[1]).toMatchObject({ name: 'minor healing', short: 'mihe' });
  });

  it('emits no room block anywhere in the listing', () => {
    // The mis-read this batch ends: the title-cased column header used to
    // start a phantom room draft and the rows filled it as description. On
    // the wire the header sentence always precedes it, so the batch claims
    // the whole run.
    const c = new Classifier(NAMES);
    const seen: string[] = [];
    for (const text of [
      'You have the following powers:',
      'Level Kai  Short Spell Name',
      '  2   1    swan  way of the swan',
      '[HP=334/KAI=27]:'
    ]) {
      seen.push(c.classify(line(text)).block.type);
    }
    expect(seen).not.toContain('room-name');
    expect(seen).not.toContain('room-description');
  });

  it('reads the wrong-book refusals and the book each names', () => {
    expect(
      expectType(
        'You may not list your spells. You are KAI! You must list your powers.',
        'spellbook-refused'
      )['book']
    ).toBe('powers');
    expect(
      expectType(
        'You may not list your powers. You are not KAI! You must list your spells.',
        'spellbook-refused'
      )['book']
    ).toBe('spells');
  });
});

/*
 * A search's answer wears a look's sentence.
 *
 * `You notice … here.` is printed for both and nothing in the line separates
 * them, so the classifier tells them apart from the command each answers —
 * which matters because what a search turns up stays concealed and its coins
 * refuse a bare `get`. Measured on the live realm 2026-09-02.
 */
describe('a floor listing that answers a search', () => {
  const feed = (classifier: Classifier, plain: string) => classifier.classify(line(plain)).block;

  it('retypes the listing a bare search provoked', () => {
    const classifier = new Classifier(NAMES);
    classifier.observeCommand('search');
    const block = feed(classifier, 'You notice 4 copper farthings, scroll of minor healing here.');
    expect(block.type).toBe('room-hidden-items');
    expect(block.groups['items']).toBe('4 copper farthings, scroll of minor healing');
  });

  it('accepts every spelling the realm accepts, and only a bare one', () => {
    for (const word of ['sea', 'sear', 'searc', 'search']) {
      const classifier = new Classifier(NAMES);
      classifier.observeCommand(word);
      expect(feed(classifier, 'You notice a rusty key here.').type).toBe('room-hidden-items');
    }
    /*
     * `search north` is a different question with its own answers, and the
     * walker sends one at every `Hidden/Searchable` edge it is refused by — so
     * arming on those would read the next room's floor as a discovery.
     */
    const directed = new Classifier(NAMES);
    directed.observeCommand('search north');
    expect(feed(directed, 'You notice a rusty key here.').type).toBe('room-items');
  });

  it('leaves an ordinary look alone', () => {
    const classifier = new Classifier(NAMES);
    classifier.observeCommand('l');
    expect(feed(classifier, 'You notice a rusty key here.').type).toBe('room-items');
  });

  /*
   * The slot must not outlive its own question: a fruitless search consumes it
   * too, or the *next* room's floor would come back as a discovery.
   */
  /*
   * The leak this was found by. `You may not search while attacking!` is a
   * third refusal (`Player.TrySearch`) with no pattern, so it classifies as
   * `unknown` — and it is in the corpus twice, both times straight after a
   * bare `sea` (`captures/006:265`, `captures/008:413`). With the slot still
   * armed, the **next room's open floor** was retyped as a discovery, which
   * loses it: the `room-items` case is what writes the draft.
   */
  it('does not carry into the next room when the refusal is one it cannot read', () => {
    const classifier = new Classifier(NAMES);
    classifier.observeCommand('sea');
    expect(feed(classifier, 'You may not search while attacking!').type).toBe('unknown');
    // A room's name arrives before its `You notice`, which is what makes the
    // room the exact backstop.
    expect(feed(classifier, 'Town Square').type).toBe('room-name');
    expect(feed(classifier, 'You notice padded boots, large sign here.').type).toBe('room-items');
  });

  /* And the two other refusals the server's own source names end it outright. */
  it('is consumed by a room too dark to search, and by being blind', () => {
    for (const refusal of ['The room is pitch black', 'You are blind.']) {
      const classifier = new Classifier(NAMES);
      classifier.observeCommand('search');
      feed(classifier, refusal);
      expect(feed(classifier, 'You notice a rusty key here.').type, refusal).toBe('room-items');
    }
  });

  it('is consumed by a search that found nothing', () => {
    const classifier = new Classifier(NAMES);
    classifier.observeCommand('search');
    expect(feed(classifier, 'Your search revealed nothing.').type).toBe('user-search-failed');
    expect(feed(classifier, 'You notice a rusty key here.').type).toBe('room-items');
  });

  it('is consumed by the listing it answered, so the next look is a look', () => {
    const classifier = new Classifier(NAMES);
    classifier.observeCommand('search');
    expect(feed(classifier, 'You notice a rusty key here.').type).toBe('room-hidden-items');
    expect(feed(classifier, 'You notice a rusty key here.').type).toBe('room-items');
  });

  /*
   * The server answers in order, so a command sent behind the search does not
   * invalidate what its answer will mean — the `addressed` slot's own rule.
   */
  it('survives a command sent behind it', () => {
    const classifier = new Classifier(NAMES);
    classifier.observeCommand('search');
    classifier.observeCommand('n');
    expect(feed(classifier, 'You notice a rusty key here.').type).toBe('room-hidden-items');
  });
});
