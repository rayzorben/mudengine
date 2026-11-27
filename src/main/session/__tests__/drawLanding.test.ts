/**
 * A room command that draws, replayed from Soul's OCI log (2026-11-27,
 * `logs/2026-11-27_23-08-08_soul.log` at 23:25:06): `go portal` out of 9/1291
 * without PhoenixQuest 5 lands in one of the Caves of Chaos, 9/1292–1327, and
 * the one it chose was dark. The hint used to name 9/1292 alone, so the dark
 * room was placed there by "coordinates" and the lit look after it in 9/1328,
 * a room outside the draw.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Classifier } from '../../parse/Classifier';
import { actsOf, applyAct, readLine } from '../../parse/lineActs';
import { CharacterTracker } from '../../parse/CharacterTracker';
import { WorldGraph } from '../../world/WorldGraph';
import { hintStep } from '../stepHint';
import { landingRooms, type Landing } from '../../../shared/world';

const REALM = path.resolve('resources/world/majormud.jsonl.gz');
const world = fs.existsSync(REALM) ? WorldGraph.load(REALM) : null;
const PROMPT = '[HP=310/310,MA=64/64]:';
const DRAW: Landing = {
  spell: 621,
  name: 'lower portal (uninvited)',
  map: 9,
  low: 1292,
  high: 1327
};
const CAVES = [
  'Caves of Chaos',
  '    These maddeningly mazelike caverns twist and turn with weblike complexity.'
];

function feeder(realm: WorldGraph): {
  tracker: CharacterTracker;
  feed: (...lines: string[]) => void;
  say: (command: string) => void;
} {
  const classifier = new Classifier();
  const tracker = new CharacterTracker(realm);
  let seq = 0;
  const feed = (...lines: string[]): void => {
    for (const text of lines) {
      seq += 1;
      const line = { seq, at: Date.now(), text, plain: text, terminator: 'newline' as const };
      for (const act of actsOf(readLine(classifier, line))) applyAct(tracker, act);
    }
  };
  const say = (command: string): void => void tracker.observeCommand(command);
  feed(PROMPT, 'Ancient Darkwood Tree, Portal', 'Obvious exits: east', PROMPT);
  return { tracker, feed, say };
}

const placed = (tracker: CharacterTracker): string | null => {
  const { map, number } = tracker.current.room;
  return map === null || number === null ? null : `${map}/${number}`;
};
const candidates = (tracker: CharacterTracker): string[] =>
  tracker.current.room.candidates.map((room) => `${room.map}/${room.room}`).sort();

describe.skipIf(world === null)('a room command that draws', () => {
  it('keeps the draw through a dark landing and narrows it after the light', () => {
    const { tracker, feed, say } = feeder(world!);
    expect(placed(tracker)).toBe('9/1291');
    hintStep(tracker, 'go portal', 'portal', '9/1292', DRAW);
    say('go portal');
    feed('You step into the portal, and find yourself elsewhere!', PROMPT);
    feed("The room is very dark - you can't see anything", PROMPT);
    expect(placed(tracker)).toBeNull();
    expect(tracker.current.room.ambiguous).toBe(landingRooms(DRAW).length);

    say('light brass lamp');
    feed('You lit the brass lamp.', PROMPT);
    say('l');
    feed(...CAVES, 'Obvious exits: north, southeast, southwest', PROMPT);
    // 9/1328 has the same name and exits and is outside the draw.
    expect(placed(tracker)).toBeNull();
    expect(candidates(tracker)).toEqual(['9/1303', '9/1316']);

    // North of 9/1303 is 9/1302 (e, s, w); north of 9/1316 is 9/1315 (five exits).
    say('n');
    feed(...CAVES, 'Obvious exits: east, south, west', PROMPT);
    expect(placed(tracker)).toBe('9/1302');
  });

  it('looks for a lit landing among the draw alone', () => {
    const { tracker, feed, say } = feeder(world!);
    hintStep(tracker, 'go portal', 'portal', '9/1292', DRAW);
    say('go portal');
    feed('You step into the portal, and find yourself elsewhere!');
    feed(...CAVES, 'Obvious exits: north, southeast, southwest', PROMPT);
    expect(placed(tracker)).toBeNull();
    expect(candidates(tracker)).toEqual(['9/1303', '9/1316']);
  });

  it('reads a reprint of the portal room as the draw not landed yet', () => {
    const { tracker, feed, say } = feeder(world!);
    hintStep(tracker, 'go portal', 'portal', '9/1292', DRAW);
    say('go portal');
    feed('You step into the portal, and find yourself elsewhere!', PROMPT);
    // The walk's nudge, answered by the room being left before the landing.
    tracker.observeReread();
    feed('Ancient Darkwood Tree, Portal', 'Obvious exits: east', PROMPT);
    expect(placed(tracker)).toBe('9/1291');
    feed(...CAVES, 'Obvious exits: north, southeast, southwest', PROMPT);
    expect(candidates(tracker)).toEqual(['9/1303', '9/1316']);
  });

  it('places a lit landing the draw holds once', () => {
    const { tracker, feed, say } = feeder(world!);
    hintStep(tracker, 'go portal', 'portal', '9/1292', DRAW);
    say('go portal');
    feed('You step into the portal, and find yourself elsewhere!');
    // 9/1298 is the draw's only Caves of Chaos with ne, se, sw.
    feed(...CAVES, 'Obvious exits: northeast, southeast, southwest', PROMPT);
    expect(placed(tracker)).toBe('9/1298');
  });
});
