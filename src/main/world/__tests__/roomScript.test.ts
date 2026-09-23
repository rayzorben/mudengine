import { describe, expect, it } from 'vitest';

import { itemsInScripts, leversAsked, leversInScript, parseRoomScript } from '../roomScript';

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
    // But the spell it puts on you is kept (format 43): *holding breath* is
    // the only statement anywhere that the passage below is a timed one.
    expect(answer?.casts).toBe(512);
    expect(
      parseRoomScript('go door:roomitem 9999 1:teleport 1 1', named)[0]?.casts
    ).toBeUndefined();
  });

  /*
   * `Rooms.CMD` 308 on both databases: the drop from Dragon's Teeth Hills
   * 2/487 into the Stone Tunnel, whose only movement is spell 336 (*fall*,
   * `TeleportRoom 1306`, `TeleportMap 2`). Read as narration it was a room
   * command with no landing, and the router had the climb back up and not the
   * way down — format 29.
   */
  it('lands a cast whose spell teleports, and lets a teleport step win', () => {
    const HOLE =
      'go hole:message 774:cast 336:message 766:text 306\n' +
      'enter hole:message 774:cast 336:message 766:text 306\n' +
      'crawl hole:message 774:cast 336:message 766:text 306';
    const landing = (id: number): string | undefined => (id === 336 ? '2/1306' : undefined);
    const [answer, ...rest] = parseRoomScript(HOLE, named, landing);
    expect(rest).toEqual([]);
    expect(answer?.say).toEqual(['go hole', 'enter hole', 'crawl hole']);
    expect(answer?.to).toBe('2/1306');
    expect(answer?.need).toBeUndefined();
    // Nothing to land: the same phrase stays a command that moves nobody.
    expect(parseRoomScript(HOLE, named)[0]?.to).toBeUndefined();
    // The realm's own `teleport` is the word, whichever side of the cast it sits.
    expect(parseRoomScript('dive pool:cast 336:teleport 121 12', named, landing)[0]?.to).toBe(
      '12/121'
    );
    expect(parseRoomScript('dive pool:teleport 121 12:cast 336', named, landing)[0]?.to).toBe(
      '12/121'
    );
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
    /*
     * Without `check class`, which the server matches and returns straight
     * away from — *filler per DC, "blocks" after this do the actual check so
     * no need to do anything* (`TextBlockPart.cs:98`). The `class 9` beside it
     * is the gate; the filler was on the card as a second thing the room
     * wanted, 62 times over in Paradigm.
     */
    expect(answer?.need).toEqual(['class 9', 'takeitem minotaur horn', 'giveitem orfeo token']);
  });

  /* A bare number is a text block to print, not a condition. */
  it('drops a step that is only a text block to display', () => {
    expect(parseRoomScript('woohoo:666', named)[0]?.need).toBeUndefined();
  });

  /*
   * Four verbs the server reads two arguments of with no message after them.
   * `givecoins 400 G` is four hundred **gold**; shown as `givecoins 400` it is
   * a number that could be copper, which is a ten-thousandfold difference in
   * the one figure a reader acts on. And `testskill` is the same shape, which
   * is what the first cut of the arity rule got wrong.
   */
  it('keeps the second argument of a step that has no message id', () => {
    expect(parseRoomScript('pay toll:givecoins 400 G', named)[0]?.need).toEqual([
      'givecoins 400 G'
    ]);
    expect(parseRoomScript('ask elder:giveability 126 7', named)[0]?.need).toEqual([
      'giveability 126 7'
    ]);
    expect(parseRoomScript('go door:testskill agility -10 601', named)[0]?.need).toEqual([
      'testskill agility -10'
    ]);
    // And one that takes none at all, whose only argument is the message.
    expect(parseRoomScript('go portal:nomonsters 503', named)[0]?.need).toEqual(['nomonsters']);
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

  /*
   * `checkability <id> <value>` — the second argument is the rank the player
   * is measured against and not the message id every other guard trails, so
   * the generic two-word rule turned *be at rank five* into *have it at all*.
   * That gate is the only way in to the Ancient Darkwood Tree.
   */
  it('keeps the rank an ability gate names', () => {
    const script = 'go portal:checkability 133 5:cast 620';
    expect(parseRoomScript(script, named)[0]?.need).toEqual(['checkability 133 5']);
    expect(parseRoomScript('go vortex:minlevel 20 1220:teleport 681 3', named)[0]?.need).toEqual([
      'minlevel 20'
    ]);
  });
});

/*
 * Verbatim from `pmud.zip`, like every fixture above: 8/909's portcullis,
 * 1/1104's chains, and the four pedestals that open one passage in the Great
 * Pyramid — each pedestal in a room of its own, which is what `index` is for.
 */
const PORTCULLIS =
  'lift portcullis:message 1359:testskill strength 20 708:remoteaction 909 1360 0 3\n' +
  'move portcullis:message 1359:testskill strength 20 708:remoteaction 909 1360 0 3\n' +
  'lift gate:message 1359:testskill strength 20 708:remoteaction 909 1360 0 3\n' +
  'move gate:message 1359:testskill strength 20 708:remoteaction 909 1360 0 3';

const CROWBAR =
  'use crowbar:checkitem 570 657:message 54:testskill strength -10:remoteaction 1104 55 0 0\n' +
  'snap chains:checkitem 570 657:message 54:testskill strength -10:remoteaction 1104 55 0 0';

const PEDESTAL =
  'put diamond in hole:roomitem 1917 1373:checkitem 1921 1094:takeitem 1921:message 3318:' +
  'message 3322:remoteaction 3042 0 1 0';

describe('the levers a script pulls', () => {
  it('reads a remoteaction as the exit it opens, collapsing the spellings', () => {
    const [lever, ...rest] = leversInScript(PORTCULLIS);
    expect(rest).toEqual([]);
    expect(lever?.room).toBe(909);
    // Exit 3 is west, by the server's own numbering (`Exits.GetExitNameID`).
    expect(lever?.direction).toBe('w');
    expect(lever?.say).toEqual(['lift portcullis', 'move portcullis', 'lift gate', 'move gate']);
    // Ordinal zero says nothing about the order, as a bare `Action` does.
    expect(lever?.index).toBeUndefined();
    expect(lever?.item).toBeUndefined();
  });

  /* `checkitem` is the pack, which is what `RequirementAction.item` means. */
  it('takes the item the pack must hold to say it', () => {
    expect(leversInScript(CROWBAR)[0]?.item).toBe(570);
    expect(leversInScript(CROWBAR)[0]?.direction).toBe('n');
  });

  /* One of four, and the realm numbers it — `Needs 4 Actions, any order`. */
  it('keeps the ordinal where the realm states one', () => {
    expect(leversInScript(PEDESTAL)[0]).toMatchObject({ room: 3042, direction: 'n', index: 1 });
  });

  it('reads no lever out of a script that pulls none', () => {
    expect(leversInScript(VORTEX)).toEqual([]);
    // An exit id outside the ten names no exit, and is refused rather than
    // folded onto north.
    expect(leversInScript('pull lever:remoteaction 909 0 0 42')).toEqual([]);
  });

  /*
   * And the same lever one chain further out: `Monsters.GreetTXT` is a keyword
   * table, the shadow guard's reaches 1435, which holds **nothing but a
   * `LinkTo`** to the block that opens the door to Morukai. A reader that
   * treats an empty block as absent stops one short of every lever there is.
   */
  it('follows a monster greeting through an empty block to the lever', () => {
    const blocks: Record<number, { action: string; linkTo: number }> = {
      1433: { action: 'morukai:1435\norfeo:1435', linkTo: 1434 },
      1434: { action: '', linkTo: 0 },
      1435: { action: '', linkTo: 1436 },
      1436: { action: 'checkability 133 4:remoteaction 1423 66 0 3:message 1841', linkTo: 0 }
    };
    const [lever, ...rest] = leversAsked(1433, 'shadow guard', (id) => blocks[id]);
    expect(rest).toEqual([]);
    expect(lever).toMatchObject({ room: 1423, direction: 'w' });
    // The whole typed line, because that is what a lever's `say` is.
    expect(lever?.say).toEqual(['ask shadow guard morukai', 'ask shadow guard orfeo']);
  });

  /*
   * **A reached block's lines are steps, not phrases.** Three of the four
   * stone sphinxes hold `remoteaction 2001 0 0 8` and nothing else, and
   * reading the first field as a phrase skipped every one of them; the fourth
   * passed only because `cast 687` stood where a phrase would be. Measured on
   * both archives after the fix: five monster levers, not two.
   */
  it('reads a reached block as steps, not as a phrase and steps', () => {
    const blocks: Record<number, { action: string; linkTo: number }> = {
      1: { action: 'sun:2', linkTo: 0 },
      2: { action: 'remoteaction 2001 0 0 8', linkTo: 0 }
    };
    const [lever] = leversAsked(1, 'stone sphinx', (id) => blocks[id]);
    expect(lever).toMatchObject({ room: 2001, direction: 'u' });
    expect(lever?.say).toEqual(['ask stone sphinx sun']);
  });

  /* A lever nothing said reaches is one nobody can pull on purpose. */
  it('refuses a lever in the greeting itself', () => {
    const blocks: Record<number, { action: string; linkTo: number }> = {
      1: { action: 'pull lever:remoteaction 909 0 0 3', linkTo: 0 }
    };
    expect(leversAsked(1, 'shadow guard', (id) => blocks[id])).toEqual([]);
  });
});
