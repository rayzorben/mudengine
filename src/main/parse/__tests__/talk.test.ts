/**
 * A line in a channel's frame is talk, whatever it says (2026-10-30). Rayzor
 * gossiped `You pound obsidian demon for 18 damage!`; the line was read as his
 * own blow and the loop waited three minutes on a fight that was not there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { domainOf, type BlockType } from '../../../shared/blocks';
import type { StreamLine } from '../../../shared/types';
import { Classifier } from '../Classifier';
import { CharacterTracker } from '../CharacterTracker';
import { actsOf, applyAct, readLine } from '../lineActs';
import { WorldGraph } from '../../world/WorldGraph';

let seq = 0;
function line(plain: string): StreamLine {
  seq += 1;
  return { seq, at: 1_700_000_000_000 + seq, text: plain, plain, terminator: 'newline' };
}

/** Every channel's frame, wrapped round what a player said. */
const CHANNELS: ReadonlyArray<(said: string) => string> = [
  (said) => `Brakkle gossips: ${said}`,
  (said) => `Rayzor gossips: ${said}`,
  (said) => `Brakkle auctions: ${said}`,
  (said) => `Brakkle telepaths: ${said}`,
  (said) => `Brakkle gangpaths: ${said}`,
  (said) => `(ghosting - Extra Chromosome) Brakkle gangpaths: ${said}`,
  (said) => `soul4 is paging you from Paradigm: ${said}`,
  (said) => `Broadcast from Brakkle "${said}"`,
  (said) => `Brakkle says "${said}"`,
  (said) => `Brakkle says (to Rayzor) "${said}"`,
  (said) => `Brakkle yells "${said}"`,
  (said) => `Someone yells from the north "${said}"`
];

const NAMES = {
  present: () => ['obsidian demon', 'Brakkle'],
  mob: (name: string) =>
    name === 'obsidian demon'
      ? ({ disposition: 'hostile', uncertain: false, costly: 'never' } as const)
      : undefined,
  self: () => 'Rayzor'
};

describe('talk is talk', () => {
  it("reads the incident's gossip as gossip, and its prompt-glued form too", () => {
    const said = 'Rayzor gossips: You pound obsidian demon for 18 damage!';
    expect(new Classifier(NAMES).classify(line(said)).block.type).toBe('conversation-gossip');
    const glued = new Classifier(NAMES).classify(line(`[HP=117/135,MA=26/123]:${said}`));
    expect(glued.tails?.map((tail) => tail.type)).toEqual(['conversation-gossip']);
  });

  /*
   * Every sentence the captures read as something other than talk, said on
   * every channel. Before talk was tried first, 6,032 of 10,963 came back as a
   * blow or a monster's miss.
   */
  const dir = path.resolve('captures');
  const captured = fs.existsSync(dir);
  it.runIf(captured)('reads every captured game sentence as talk when it is said', () => {
    const reader = new Classifier(NAMES);
    const read = (text: string): BlockType => {
      reader.reset();
      return reader.classify(line(text)).block.type;
    };
    const sentences = new Set<string>();
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.txt'))) {
      for (const raw of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
        const said = raw
          .replace(/\r$/, '')
          .replace(/^\[HP=[^\]]*\]:/, '')
          .trim();
        if (said.length === 0 || said.length > 200 || sentences.has(said)) continue;
        const type = read(said);
        if (type !== 'unknown' && type !== 'status-line' && domainOf(type) !== 'conversation')
          sentences.add(said);
      }
    }
    expect(sentences.size).toBeGreaterThan(9_000);
    const misread: string[] = [];
    for (const said of sentences) {
      for (const frame of CHANNELS) {
        const type = read(frame(said));
        if (domainOf(type) !== 'conversation' && type !== 'command-not-understood')
          misread.push(`${frame(said)} -> ${type}`);
      }
    }
    expect(misread.slice(0, 5)).toEqual([]);
  });

  it('still reads a refused command as one, and a say of the same word as talk', () => {
    const reader = new Classifier();
    reader.observeCommand('exits');
    expect(reader.classify(line('You say "exits"')).block.type).toBe('command-not-understood');
    expect(reader.classify(line('You say "hello"')).block.type).toBe('conversation-local');
  });
});

describe('a page', () => {
  it('reads a page from Paradigm and from stock MajorMUD', () => {
    const reader = new Classifier();
    expect(
      reader.classify(line('soul4 is paging you from Paradigm: hi')).block.groups
    ).toMatchObject({ player: 'soul4', where: 'Paradigm', message: 'hi' });
    // captures/025: two spaces after the colon.
    expect(
      reader.classify(line("Zoe is paging you from MajorMUD:  can't get in")).block.groups
    ).toMatchObject({ player: 'Zoe', message: "can't get in" });
  });

  it('binds the receipt to the page that sent it', () => {
    const reader = new Classifier();
    reader.observeCommand('/p soul hi there');
    const receipt = reader.classify(line('---Page sent to soul---')).block;
    expect(receipt.type).toBe('conversation-page');
    expect(receipt.groups).toMatchObject({ player: 'soul', sent: 'hi there' });
  });
});

describe('a telepath receipt', () => {
  it('never takes the words of a page still owed its receipt', () => {
    const reader = new Classifier();
    reader.observeCommand('/p soul hi');
    reader.observeCommand('/pete yo');
    const receipt = reader.classify(line('--- Telepath Sent to Pete ---')).block;
    expect(receipt.type).toBe('conversation-telepath');
    expect(receipt.groups['sent']).toBe('yo');
  });
});

describe('talk inside a listing', () => {
  it('leaves the carried list as it was', () => {
    const reader = new Classifier();
    reader.observeCommand('i');
    reader.classify(line('You are carrying a dagger, a torch,'));
    expect(reader.classify(line('Rayzor gossips: anyone selling a sword')).block.type).toBe(
      'conversation-gossip'
    );
    reader.classify(line('a rope'));
    reader.classify(line('You have no keys.'));
    const closed = reader.classify(line('[HP=1/2]:')).batch;
    expect(closed?.groups['items']).toBe('a dagger, a torch, a rope');
  });

  it('leaves the room listing open across a gossip that ends in a full stop', () => {
    const reader = new Classifier();
    reader.classify(line('Also here: Soul, Rayzor,'));
    reader.classify(line('Brakkle gossips: who has keys.'));
    const record = reader.classify(line('Brackle.')).batch;
    expect(record?.groups['who']).toBe('Soul, Rayzor, Brackle');
  });
});

describe('the echo of a typed line', () => {
  it('is the echo with the trailing space the player typed', () => {
    const reader = new Classifier();
    reader.observeCommand('gos You pound obsidian demon for 18 damage! ');
    expect(reader.classify(line('gos You pound obsidian demon for 18 damage! ')).block.type).toBe(
      'command-echo'
    );
  });
});

describe('a target the room no longer lists', () => {
  const file = path.resolve('resources/world/paradigm.jsonl.gz');
  const world = fs.existsSync(file) ? WorldGraph.load(file) : undefined;

  function play(lines: readonly string[], gone: string[]): CharacterTracker {
    const tracker = new CharacterTracker(
      world,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      undefined,
      (target) => gone.push(target)
    );
    const reader = new Classifier({
      present: () => tracker.current.room.occupants.map((who) => who.name),
      mob: (name) => world?.mob(name),
      self: () => tracker.current.name
    });
    for (const text of lines)
      for (const act of actsOf(readLine(reader, line(text)))) applyAct(tracker, act);
    return tracker;
  }

  const ROOM = [
    'Cracked Plain',
    'Also here: obsidian demon.',
    'Obvious exits: southwest',
    '[HP=117/135]:'
  ];
  const LOOK = [
    'Cracked Plain',
    'Also here: Brakkle.',
    'Obvious exits: southwest',
    '[HP=117/135]:'
  ];

  it('lets go of it on a look, and says so', () => {
    const gone: string[] = [];
    // A blow that set a target with no engagement behind it, then the monster gone.
    const tracker = play(
      [...ROOM, 'You pound obsidian demon for 18 damage!', '[HP=117/135]:'],
      gone
    );
    expect(tracker.current.combat.target).toBe('obsidian demon');
    expect(gone).toEqual([]);
    for (const text of LOOK)
      for (const act of actsOf(readLine(new Classifier(), line(text)))) applyAct(tracker, act);
    expect(tracker.current.combat.target).toBeNull();
    expect(gone).toEqual(['obsidian demon']);
  });

  it('keeps it while the room still lists it, or while engaged', () => {
    const gone: string[] = [];
    const listed = play([...ROOM, 'You pound obsidian demon for 18 damage!', ...ROOM], gone);
    expect(listed.current.combat.target).toBe('obsidian demon');
    const engaged = play(
      [...ROOM, '*Combat Engaged*', 'You pound obsidian demon for 18 damage!', ...LOOK],
      gone
    );
    expect(engaged.current.combat.target).toBe('obsidian demon');
    // The looks were read: each room's listing is the one the test sent last.
    expect(listed.current.room.occupants.map((who) => who.name)).toEqual(['obsidian demon']);
    expect(engaged.current.room.occupants.map((who) => who.name)).toEqual(['Brakkle']);
    expect(gone).toEqual([]);
  });
});
