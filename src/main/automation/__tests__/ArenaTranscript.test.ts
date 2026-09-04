import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { AutoCombat } from '../AutoCombat';
import { CommandQueue } from '../CommandQueue';
import { CharacterTracker } from '../../parse/CharacterTracker';
import { Classifier } from '../../parse/Classifier';
import { WorldGraph } from '../../world/WorldGraph';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import type { StreamLine } from '../../../shared/types';

/**
 * The Newhaven Arena fight, replayed from the live capture of 2026-08-26
 * (`2026-08-26_12-49-48_main.mudcap.jsonl`) that showed auto-combat proposing
 * correctly and the *queue* failing the player three ways: the first attack
 * on the kobold thief landed inside a half-typed `l` and the server said
 * `lpu thin kobold thief` out loud; every proposal made while the player
 * watched the fight expired under the old typing grace, so the thief hit the
 * character for five seconds before anything swung back; and `*Combat
 * Engaged*` left `combat.target` null until the first damage line, so the
 * round following the engagement had nothing to name.
 *
 * The wiring mirrors `SessionManager.publishLine` — classifier → combat
 * blocks → tracker → prompt credit → state fan-out — because every one of
 * those failures lived in the seams between the units, where the unit tests
 * could not see it.
 */

function arenaWorld(): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-arena-'));
  const file = path.join(dir, 'rooms.jsonl.gz');
  const header = JSON.stringify({
    v: 5,
    source: 'test',
    rooms: 0,
    generatedAt: 'x',
    // As the Paradigm realm actually indexes them: the thief and the filthbug
    // are certainly hostile; `giant rat` covers rows that disagree.
    mobs: [
      { n: 'giant rat', hp: 10, hi: 12, d: 'h', x: 1 },
      { n: 'kobold thief', hp: 20, d: 'h' },
      { n: 'filthbug', hp: 15, d: 'h' },
      { n: 'lashworm', hp: 8, d: 'h' },
      { n: 'acid slime', hp: 30, d: 'h' }
    ]
  });
  fs.writeFileSync(file, zlib.gzipSync(header + '\n'));
  const graph = WorldGraph.load(file);
  fs.rmSync(dir, { recursive: true, force: true });
  return graph;
}

/** Vaelor's combat block, as the profile that hit this states it. */
function vaelorConfig(): AutomationConfig {
  const base = structuredClone(DEFAULT_CONFIG.automation);
  base.enabled = true;
  base.combat = {
    ...base.combat,
    enabled: true,
    attack: 'pu',
    opener: '',
    engage: 'likely',
    retaliate: true,
    maxMobs: 0,
    minHealth: 0,
    whileWalking: false,
    refreshRounds: 3,
    avoid: [],
    prefer: []
  };
  return base;
}

interface Harness {
  sent: string[];
  /** One line from the server, through the real classifier and tracker. */
  feed(text: string): void;
  /** The player pressing keys that do not yet commit a line. */
  keys(): void;
  /** The player committing a command with Enter. */
  commit(command: string): void;
  tracker: CharacterTracker;
}

function harness(engage: 'hostile' | 'likely' = 'likely'): Harness {
  const world = arenaWorld();
  const sent: string[] = [];
  const tracker = new CharacterTracker(world);
  const classifier = new Classifier({
    present: () => tracker.current.room.occupants.map((who) => who.name),
    mob: (name) => world.mob(name)
  });
  const config = vaelorConfig();
  config.combat.engage = engage;
  const queue = new CommandQueue(config, {
    /*
     * `SessionManager`'s own gate, verbatim: an empty line is not a command,
     * so the three observers are skipped and the re-read is filed through its
     * own door. Copied rather than approximated because a harness that files a
     * bare Enter the client would not is a harness testing something the
     * client does not do — which is how the walker's nudge went unattributed
     * for a whole release with a green suite.
     */
    send: (command) => {
      sent.push(command);
      if (command.length > 0) {
        tracker.observeCommand(command);
        classifier.observeCommand(command);
      } else {
        tracker.observeReread();
      }
    }
  });
  const combat = new AutoCombat(config.combat, true, queue);
  let seq = 0;

  const feed = (text: string): void => {
    seq += 1;
    const line: StreamLine = { seq, at: Date.now(), text, plain: text, terminator: 'newline' };
    const { block, batch } = classifier.classify(line);
    combat.onBlock(block);
    const lineChanged = tracker.apply(block);
    const batchChanged = batch ? tracker.apply(batch, batch.rows) : false;
    if (block.type === 'status-line' || block.domain === 'session') queue.notePrompt();
    if (lineChanged || batchChanged) {
      combat.noteRetreating(false);
      combat.noteMovePending(tracker.pendingMoves > 0);
      combat.onCharacter(tracker.current);
    }
  };

  return {
    sent,
    feed,
    keys: () => queue.noteTyping(true),
    commit: (command: string) => {
      if (command.length > 0) {
        tracker.observeCommand(command);
        classifier.observeCommand(command);
        combat.noteUserCommand(command);
      } else {
        tracker.observeReread();
      }
      queue.noteTyping(false);
    },
    tracker
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const ROOM = [
  'Newhaven, Arena',
  '    This huge room is has been carved into the earth with crude work- manship.',
  'The blood-soaked floor is covered in broken, rusted weaponry and some things',
  'better left unmentioned.'
];

describe('the Arena transcript', () => {
  it('engages the giant rat on walking in, without waiting on a grace', () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.keys();
    h.commit('d');
    for (const line of ROOM) h.feed(line);
    h.feed('Also here: big giant rat.');
    h.feed('Obvious exits: closed door north, up, down');
    // The room completed and nothing is on the input line: the attack goes
    // now, not a second and a half of stand-down later.
    expect(h.sent).toContain('pu big giant rat');
  });

  it('leaves the disagreeing giant rat alone at engage: hostile', () => {
    // Two of this name's rows attack on sight and one does not, so `hostile`
    // declines the coin toss — the setting the profile changed away from.
    const h = harness('hostile');
    h.feed('[HP=34]:');
    for (const line of ROOM) h.feed(line);
    h.feed('Also here: big giant rat.');
    h.feed('Obvious exits: closed door north, up, down');
    expect(h.sent).toEqual([]);
  });

  it('engages a hostile monster the moment it walks in', () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.feed('A thin kobold thief sneaks into the room from the above!');
    expect(h.sent).toContain('pu thin kobold thief');
  });

  it('retaliates against realm-worded attack text', () => {
    const h = harness('hostile');
    h.feed('[HP=34]:');
    for (const line of ROOM) h.feed(line);
    h.feed('Also here: thin kobold thief.');
    h.feed('Obvious exits: closed door north, up, down');
    // `hostile` engaged it already? No — certain-hostile, so it did. Use the
    // attacker path: something already fighting us is hit back regardless.
    h.feed('The thin kobold thief lunges at you with their shortsword!');
    expect(h.tracker.current.combat.attackers).toEqual(['thin kobold thief']);
    expect(h.sent).toContain('pu thin kobold thief');
  });

  it('holds the attack behind a half-typed line and sends it on Enter', () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.keys(); // the player starts typing `l` and thinks
    h.feed('A thin kobold thief sneaks into the room from the above!');
    h.feed('The thin kobold thief lunges at you with their shortsword!');
    vi.advanceTimersByTime(5_000);
    // Nothing goes out mid-line, however long the pause — this is the
    // `lpu thin kobold thief` corruption from the capture.
    expect(h.sent).toEqual([]);

    h.commit('l');
    // The command comes after, immediately.
    expect(h.sent).toContain('pu thin kobold thief');
  });

  it('sets the target the moment *Combat Engaged* answers the attack', () => {
    const h = harness();
    h.feed('[HP=34]:');
    for (const line of ROOM) h.feed(line);
    h.feed('Also here: nasty filthbug.');
    h.feed('Obvious exits: closed door north, up, down');
    expect(h.sent).toContain('pu nasty filthbug');

    h.feed('*Combat Engaged*');
    // Before the first damage line arrives, a rule or round verb reading
    // `{target}` already has the name the attack was aimed at.
    expect(h.tracker.current.combat.target).toBe('nasty filthbug');
    expect(h.tracker.current.inCombat).toBe(true);
  });

  /*
   * The server holds its output while the player has a half-typed line, so a
   * whole fight arrives as one burst after their Enter — replayed here from
   * the capture of 2026-08-26: the filthbug died inside the burst, and the
   * client attacked the corpse because the experience line cleared the target
   * and the room but left the dead monster in `attackers`.
   */
  it('does not attack a monster that died inside a held burst', async () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.feed('A fierce filthbug scuttles into the room from the above!');
    expect(h.sent).toEqual(['pu fierce filthbug']);
    h.feed('*Combat Engaged*');

    h.keys(); // the player starts typing `l` — the server buffers its output
    await vi.advanceTimersByTimeAsync(7_000);
    h.commit('l');
    // The buffered fight arrives as one burst.
    h.feed('The fierce filthbug swipes at you with its claws!');
    h.feed('You punch fierce filthbug for 6 damage!');
    h.feed('The fierce filthbug swipes at you with its claws!');
    h.feed('You punch fierce filthbug for 7 damage!');
    h.feed('The filthbug collapses, its legs curling tightly around it.');
    h.feed('You gain 12 experience.');
    h.feed('*Combat Off*');
    h.feed('A small lashworm crawls into the room from the above!');
    h.feed('[HP=34]:');
    await vi.advanceTimersByTimeAsync(1_000);

    // One attack per monster: the corpse is not attacked again, the arrival is.
    expect(h.sent).toEqual(['pu fierce filthbug', 'pu small lashworm']);
  });

  /*
   * Re-attacking makes the server print `*Combat Off*` and `*Combat Engaged*`
   * as one answer to one command. Each Off cleared the target and the engage
   * cooldown, so the client asked again on the next state change and the
   * server answered with another pair: a self-sustaining loop at round-trip
   * speed, captured live at ~10 attacks a second.
   */
  it('does not loop on the server’s disengage/engage pair', async () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.feed('A small giant rat creeps into the room from the above!');
    expect(h.sent).toEqual(['pu small giant rat']);

    // The server's answer to that attack, then five more prompt cycles of the
    // kind that used to each provoke another attack.
    h.feed('*Combat Off*');
    h.feed('*Combat Engaged*');
    for (let i = 0; i < 5; i += 1) {
      h.feed('[HP=34]:');
      h.feed('The small giant rat lunges at you!');
      await vi.advanceTimersByTimeAsync(100);
    }
    // Exactly one attack. (The room refresh `l` the round clock proposes is
    // the configured backstop, not the loop.)
    expect(h.sent.filter((c) => c.startsWith('pu'))).toEqual(['pu small giant rat']);
    // And the pair's Engaged half bound the target, which is what gates it.
    expect(h.tracker.current.combat.target).toBe('small giant rat');
  });

  it('stays broken off when the player types break', async () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.feed('A large acid slime oozes into the room from the above!');
    expect(h.sent).toEqual(['pu large acid slime']);
    h.feed('*Combat Engaged*');

    h.keys();
    h.commit('break');
    h.feed('*Combat Off*');
    // Still here, still swinging — and five seconds ago this re-opened the
    // fight the player had just ended.
    h.feed('The large acid slime lashes at you, but you dodge out of the way!');
    h.feed('[HP=34]:');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sent).toEqual(['pu large acid slime']);
  });

  const NARROW_ROAD = [
    'Newhaven, Narrow Road',
    '    This narrow road is quite plain save for the various lanterns hanging from',
    'the trees around, and a large stone stairwell leading downwards.',
    'Obvious exits: north, east, west, down'
  ];

  /*
   * The character typed `u`; a giant rat walked into the room being left. The
   * client engaged it on the way out, the attack crossed the step on the
   * wire, and the server answered `Your command had no effect.` from the new
   * room — captured live, 2026-08-26.
   */
  it('does not open a fight into a room it is leaving', async () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.keys();
    h.commit('u');
    h.feed('A giant rat creeps into the room from the above!');
    h.feed('The giant rat lunges at you!');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent).toEqual([]);

    for (const line of NARROW_ROAD) h.feed(line);
    h.feed('[HP=34]:');
    await vi.advanceTimersByTimeAsync(1_000);
    // The new room holds nothing; nothing is attacked, there or behind.
    expect(h.sent).toEqual([]);
  });

  /*
   * The sewer transcript of 2026-09-02, reported by the player and replayed
   * from `2026-09-02_18-07-07_festus.mudcap.jsonl` (t=4862445).
   *
   * The walk's step went unanswered for a second, so the walker nudged it with
   * a bare Enter, and the server answered the step and the nudge in one packet:
   * two identical room blocks. The client read the second as the arrival of the
   * step it had just sent on the strength of the first, so `e` went out twice
   * inside three milliseconds and the walk ran a room ahead of the character.
   * Two monsters then walked in, the room block that listed them was read as
   * where the character was standing, and the fight opened into a room the
   * still-unanswered step was about to leave — five `pu`s, five
   * `Your command had no effect.`
   *
   * The nudge is written down now, so the reprint answers it and the step is
   * still outstanding when the monsters arrive.
   */
  const SEWER = ['Sewer Tunnel', 'Obvious exits: east, west'];

  it('does not swing out of a room its own nudge made it think it had left', async () => {
    const h = harness();
    h.feed('[HP=80]:');
    h.commit('e');
    // A second with no answer: the walker nudges.
    h.commit('');
    for (const line of SEWER) h.feed(line);
    // The step confirmed, so the walk sends the next one.
    h.commit('e');
    // And the nudge's reprint lands, identical to the block before it. It
    // answers the nudge; the step is still out, which is the whole fix — the
    // walk does not confirm a second arrival and does not send a third `e`.
    for (const line of SEWER) h.feed(line);
    expect(h.tracker.pendingMoves).toBe(1);
    expect(h.sent).toEqual([]);

    /*
     * So when the monsters walk in and the room lists them, that block is the
     * step's own answer and the character really is standing in it. The fight
     * opens here, once, with nothing left on the wire to carry it out of the
     * room again — which is the difference between this and the capture, where
     * a third `e` was outstanding and every swing was answered
     * `Your command had no effect.` from somewhere else.
     */
    h.feed('A thin kobold thief sneaks into the room from the east!');
    h.feed('A angry giant rat creeps into the room from the east!');
    h.feed('Sewer Tunnel');
    h.feed('Also here: thin kobold thief, angry giant rat.');
    h.feed('Obvious exits: closed door north, east, west');
    h.feed('[HP=80]:');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.tracker.pendingMoves).toBe(0);
    expect(h.sent).toEqual(['pu thin kobold thief']);
  });

  it('leaves the old room’s attackers behind on a step', async () => {
    const h = harness();
    h.feed('[HP=34]:');
    h.keys();
    h.commit('u');
    // Lunges landing while the step is unanswered: the attacker is recorded,
    // and must go with the room.
    h.feed('The giant rat lunges at you!');
    h.feed('The giant rat lunges at you!');
    for (const line of NARROW_ROAD) h.feed(line);
    h.feed('[HP=34]:');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.tracker.current.combat.attackers).toEqual([]);
    // Retaliation from the new room at the old room's monster was the stale
    // attack that armed the cooldown and slowed the next real fight.
    expect(h.sent).toEqual([]);
  });

  it('re-engages immediately on walking back into the room', async () => {
    const h = harness();
    h.feed('[HP=34]:');
    for (const line of ROOM) h.feed(line);
    h.feed('Also here: giant rat.');
    h.feed('Obvious exits: closed door north, up, down');
    expect(h.sent).toEqual(['pu giant rat']);
    h.feed('*Combat Engaged*');

    // The player breaks off and leaves.
    h.keys();
    h.commit('break');
    h.feed('*Combat Off*');
    h.feed('The giant rat lunges at you!');
    h.keys();
    h.commit('u');
    for (const line of NARROW_ROAD) h.feed(line);
    h.feed('[HP=34]:');
    await vi.advanceTimersByTimeAsync(500);
    // Nothing chased them out.
    expect(h.sent).toEqual(['pu giant rat']);

    // And walks straight back in. Moving cleared the break's stand-down, and
    // the monster's own vanish released its cooldown — the promise the notice
    // makes is "resumes when you move", not "resumes a few seconds after".
    h.keys();
    h.commit('d');
    for (const line of ROOM) h.feed(line);
    h.feed('Also here: giant rat.');
    h.feed('Obvious exits: closed door north, up, down');
    expect(h.sent).toEqual(['pu giant rat', 'pu giant rat']);
  });

  it('does not spend a second attack on the fight it just opened', () => {
    const h = harness();
    h.feed('[HP=34]:');
    for (const line of ROOM) h.feed(line);
    h.feed('Also here: nasty filthbug.');
    h.feed('Obvious exits: closed door north, up, down');
    h.feed('*Combat Engaged*');
    h.feed('You punch nasty filthbug for 7 damage!');
    h.feed('[HP=34]:');
    vi.advanceTimersByTime(6_000);
    h.feed('[HP=34]:');
    expect(h.sent.filter((c) => c === 'pu nasty filthbug')).toHaveLength(1);
  });
});
