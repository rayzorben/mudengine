import { describe, expect, it } from 'vitest';

import { itemsInScripts, parseRoomScript } from '../roomScript';

/*
 * `Rooms.CMD` → `TBInfo.Action`, verbatim from `gmud20230902.mdb`. Every
 * fixture here is a real row rather than a shape invented to test against:
 * the script language is another program's, and a test written from an
 * imagined example would prove only that the parser reads its own imagination.
 */
const VORTEX =
  'go vortex:adddelay 5:minlevel 20 1220:message 1205:teleport 681 3:message 1221\n' +
  'enter vortex:adddelay 5:minlevel 20 1220:message 1205:teleport 681 3:message 1221\n' +
  'go swirling vortex:adddelay 5:minlevel 20 1220:message 1205:teleport 681 3:message 1221';

const PORTAL =
  'go portal:roomitem 3389 1373:minlevel 40 2594:message 1375:teleport 1041 8:message 837';

const ORFEO =
  'give minotaur horn to orfeo:check class:class 9 2682:takeitem 1359 2683:' +
  'giveitem 1422:message 2684:message 2685';

const CASINO = 'roll dice:price 10000 1560:random 998\nplay dice:price 10000 1560:random 998';

const named = (id: number): string | undefined =>
  ({ 3389: 'shimmering key', 1359: 'minotaur horn', 1422: 'orfeo token' })[id];

describe('what a room answers to', () => {
  /*
   * A script writes one line per spelling with byte-identical steps. Three
   * ways to enter one vortex is one command with three names — the same
   * collapse a `Text:` exit's `commands` array already makes.
   */
  it('collapses the spellings of one command', () => {
    const [answer, ...rest] = parseRoomScript(VORTEX, named);
    expect(rest).toEqual([]);
    expect(answer?.say).toEqual(['go vortex', 'enter vortex', 'go swirling vortex']);
  });

  /*
   * `teleport <room> <map>` — room first, which is the opposite of the
   * `map/room` every id in this client is written as. Reading it the way it is
   * written would send a character to 681/3 instead of 3/681.
   */
  it('reads a teleport destination the right way round', () => {
    expect(parseRoomScript(VORTEX, named)[0]?.to).toBe('3/681');
    expect(parseRoomScript(PORTAL, named)[0]?.to).toBe('8/1041');
  });

  /*
   * The guards, verbatim, minus the trailing message id every one of them
   * carries — `minlevel 20 1220` wants level 20 and prints message 1220 on
   * failing, and a card showing "minlevel 20 1220" would be reading the
   * refusal text as part of the requirement.
   */
  it('keeps the conditions and drops the message ids', () => {
    expect(parseRoomScript(PORTAL, named)[0]?.need).toEqual([
      'roomitem shimmering key',
      'minlevel 40'
    ]);
  });

  /*
   * An item id tells nobody anything; a name tells them where to start. An id
   * the index does not carry keeps its number rather than being dropped — the
   * room still wants it.
   */
  it('names an item it can and keeps the number it cannot', () => {
    const answer = parseRoomScript('go door:roomitem 9999 1:teleport 1 1', named)[0];
    expect(answer?.need).toEqual(['roomitem 9999']);
  });

  /*
   * Narration is not a condition. `message`, `random`, `cast` and the two
   * delays are the server talking to itself, and listing them under "what this
   * wants" would read as four more things to satisfy.
   */
  it('drops the steps that are only the server narrating', () => {
    const answer = parseRoomScript('dive pool:message 1943:teleport 121 12:cast 512', named)[0];
    expect(answer?.to).toBe('12/121');
    expect(answer?.need).toBeUndefined();
  });

  it('reads a command that costs money and moves nobody', () => {
    const [answer] = parseRoomScript(CASINO, named);
    expect(answer?.say).toEqual(['roll dice', 'play dice']);
    expect(answer?.to).toBeUndefined();
    expect(answer?.need).toEqual(['price 10000']);
  });

  it('reads a quest hand-in as the thing it wants and gives', () => {
    const [answer] = parseRoomScript(ORFEO, named);
    expect(answer?.say).toEqual(['give minotaur horn to orfeo']);
    expect(answer?.need).toEqual([
      'check class',
      'class 9',
      'takeitem minotaur horn',
      'giveitem orfeo token'
    ]);
  });

  /* A line with no steps is not a command; a blank one is not anything. */
  it('ignores a line that is not a command', () => {
    expect(parseRoomScript('', named)).toEqual([]);
    expect(parseRoomScript('go nowhere', named)).toEqual([]);
  });

  /*
   * The item ids a script names, so the item index can carry them. 192 across
   * the shipped realm, which is why they are collected before the index is
   * built rather than looked up after.
   */
  it('finds the item ids a script mentions', () => {
    expect([...itemsInScripts([PORTAL, ORFEO])].sort((a, b) => a - b)).toEqual([1359, 1422, 3389]);
  });
});
