import { describe, expect, it } from 'vitest';

import {
  addressedTo,
  compose,
  DEFAULT_TALK_LAYOUT,
  DEFAULT_TALK_STAMP,
  formatTalkStamp,
  isTalkLayout,
  isTalkStamp,
  prefixOf,
  talkChannel,
  TALK_CHANNELS,
  TALK_LAYOUTS,
  TALK_STAMPS
} from '../talk';

const gossip = TALK_CHANNELS[0]!;
const broadcast = talkChannel('br');

describe('what a typed line means on a channel', () => {
  it('prefixes the channel showing', () => {
    expect(compose('anyone selling a rope?', gossip)).toEqual({
      command: 'gos anyone selling a rope?',
      channel: gossip
    });
  });

  /*
   * The behaviour the whole thing is for: type a channel word and it switches,
   * and the line goes as typed — so the *next* line goes there too without
   * being told again.
   */
  it('switches when the line starts with a channel, and sends it unchanged', () => {
    expect(compose('br yo', gossip)).toEqual({ command: 'br yo', channel: broadcast });
    expect(compose('auc halberd', gossip)?.channel.word).toBe('auc');
    expect(compose('gb on my way', gossip)?.channel.word).toBe('gb');
  });

  /*
   * The spellings come from the server's own table rather than a list written
   * beside this, so every abbreviation it accepts is accepted here for the same
   * reason — including the ones no rule would produce: `Broadgang` answers to
   * both `bg` and `gb`, which share no prefix.
   */
  it('knows every spelling the realm knows', () => {
    for (const typed of ['gossip', 'goss', 'gossi']) {
      expect(compose(`${typed} hi`, broadcast)?.channel.word).toBe('gos');
    }
    for (const typed of ['bg', 'gb', 'broadgang']) {
      expect(compose(`${typed} hi`, gossip)?.channel.word).toBe('gb');
    }
  });

  /*
   * And a command that is *not* a channel is prefixed like anything else. This
   * box is the Talk card's, not a second command line — the terminal is the
   * command line, and a box that sometimes typed into the game and sometimes
   * into a channel would be one nobody could predict.
   */
  it('does not treat every command as a channel', () => {
    expect(compose('who is around', gossip)?.command).toBe('gos who is around');
    expect(compose('l', gossip)?.command).toBe('gos l');
  });

  it('sends nothing for an empty line', () => {
    expect(compose('   ', gossip)).toBeNull();
    expect(compose('', gossip)).toBeNull();
  });

  it('trims, so a stray space does not go out as part of the message', () => {
    expect(compose('  hi  ', gossip)?.command).toBe('gos hi');
  });
});

describe('the channel a stored preference names', () => {
  it('takes one it recognises', () => {
    expect(talkChannel('auc').label).toBe('auction');
  });

  /* A value from an older build must not leave the picker sending nothing. */
  it('falls back to gossip for anything else', () => {
    expect(talkChannel('telepath')).toBe(gossip);
    expect(talkChannel(null)).toBe(gossip);
    expect(talkChannel(undefined)).toBe(gossip);
  });

  /*
   * There is still **no `say` command and no `yell` command** in `Commands.cs`,
   * and `You say "..."` is also what the server does with a command it does not
   * recognise — so an entry spelled `say` would be a button for broadcasting
   * typos to the room. The realm names both channels with a sigil instead, and
   * the sigils are captured (2026-08-27), not inferred.
   */
  it('names the room channels by their sigils, never by a word', () => {
    expect(TALK_CHANNELS.some((channel) => ['say', 'yell'].includes(channel.word))).toBe(false);
    expect(talkChannel('.').label).toBe('say');
    expect(talkChannel('"').label).toBe('yell');
  });
});

describe('what goes in front of the message', () => {
  /*
   * A space in the wrong one of the two is silent: `. hi` says something with
   * a leading space, and `gosHi` is not a command at all.
   */
  it('spaces a word and does not space a sigil', () => {
    expect(prefixOf(talkChannel('gos'))).toBe('gos ');
    expect(prefixOf(talkChannel('.'))).toBe('.');
    expect(prefixOf(talkChannel('"'))).toBe('"');
    expect(prefixOf(addressedTo('/', 'Soul'))).toBe('/Soul ');
  });
});

/*
 * The four the realm gives punctuation rather than a word. None of them is in
 * `Commands.cs`, so every one used to fall through to the prefixing below and
 * go out as the literal text `gos .hi` — gossiping the sigil to the realm
 * instead of saying anything to the room. Captured 2026-08-27.
 */
describe('the channels the realm names with a sigil', () => {
  it('says to the room, and moves the picker there', () => {
    const said = compose('.hi', gossip);
    expect(said).toEqual({ command: '.hi', channel: talkChannel('.') });
  });

  it('yells to the rooms around it', () => {
    expect(compose('"hi', gossip)).toEqual({ command: '"hi', channel: talkChannel('"') });
  });

  /* The sigil takes the message immediately: a space would go out as part of it. */
  it('keeps no space between the sigil and what is said', () => {
    expect(compose('. hi there', gossip)?.command).toBe('.hi there');
    expect(compose('"  hi there', gossip)?.command).toBe('"hi there');
  });

  it('stays on the channel it was pointed at', () => {
    expect(compose('hi', talkChannel('.'))?.command).toBe('.hi');
    expect(compose('hi', talkChannel('"'))?.command).toBe('"hi');
  });

  it('sends nothing for a bare sigil', () => {
    expect(compose('.', gossip)).toBeNull();
    expect(compose('"   ', gossip)).toBeNull();
  });
});

describe('the channels that address one person', () => {
  it('telepaths, and holds the address so a reply needs no retyping', () => {
    const said = compose('/soul hi', gossip);
    expect(said?.command).toBe('/soul hi');
    expect(said?.channel).toEqual(addressedTo('/', 'soul'));
    expect(compose('are you there', said!.channel)?.command).toBe('/soul are you there');
  });

  it('directs a say at one person in the room', () => {
    const said = compose('>Soul hi', gossip);
    expect(said?.command).toBe('>Soul hi');
    expect(said?.channel.word).toBe('>Soul');
  });

  /*
   * The server resolves and capitalises the name in its own receipt. Guessing
   * the capitalisation here would be guessing at somebody's name.
   */
  it('keeps the name as it was typed', () => {
    expect(compose('/soul hi', gossip)?.channel.label).toBe('/soul');
  });

  /*
   * `/Soul` names somebody to talk to and says nothing to them. The picker
   * moves; nothing goes out, because the server's answer to that is a scolding
   * that costs a command.
   */
  it('points the picker at somebody without sending anything', () => {
    const said = compose('/Soul', gossip);
    expect(said?.command).toBeNull();
    expect(said?.channel.word).toBe('/Soul');
  });

  /* A sigil addressing nobody is not an address, and is prefixed like any text. */
  it('does not treat a bare sigil as an address', () => {
    expect(compose('/ 25', gossip)?.command).toBe('gos / 25');
    expect(compose('>', gossip)?.command).toBe('gos >');
  });

  /* Naming a channel still switches away, from an address like from anywhere. */
  it('leaves the address when a channel word is typed', () => {
    expect(compose('gos hello all', addressedTo('/', 'Soul'))).toEqual({
      command: 'gos hello all',
      channel: gossip
    });
  });
});

describe('actions and joining', () => {
  it('sends an action verbatim, on no channel, and only the realm’s own list', () => {
    expect(compose('dance', talkChannel('gos'))?.command).toBe('dance');
    expect(compose('spit Rend', talkChannel('gos'))?.command).toBe('spit Rend');
    expect(compose('dance', talkChannel('gos'))?.channel.word).toBe('gos');
    expect(compose('who is around', talkChannel('gos'))?.command).toBe('gos who is around');
  });

  it('follows a join onto the broadcast channel', () => {
    const said = compose('join 1234', talkChannel('gos'));
    expect(said?.command).toBe('join 1234');
    expect(said?.channel.word).toBe('br');
  });

  it('still prefixes ordinary words, which are not commands', () => {
    expect(compose('hello there', talkChannel('gos'))?.command).toBe('gos hello there');
  });
});

describe('the dash shortcut', () => {
  it('broadcasts a line beginning with a dash, with or without a space', () => {
    expect(compose('-hi', talkChannel('gos'))).toEqual({
      command: 'br hi',
      channel: talkChannel('br')
    });
    expect(compose('- hi there', talkChannel('gos'))?.command).toBe('br hi there');
    expect(compose('-', talkChannel('gos'))).toBeNull();
  });
});

/*
 * Local time and written out by hand rather than handed to `Intl`: the formats
 * are a closed union this client chose, and `Intl`'s output varies by ICU
 * build, which would make the card's appearance depend on which Electron was
 * packaged. The moments below are built with the local constructor for the
 * same reason the formatter reads local fields -- a conversation happened at
 * the time the person reading it was sitting there.
 */
describe('the time beside a line', () => {
  const evening = new Date(2026, 7, 20, 19, 35, 2).getTime();
  const morning = new Date(2026, 7, 20, 7, 5, 9).getTime();

  it('writes the shape the request asked for', () => {
    expect(formatTalkStamp(evening, 'date-time-12')).toBe('8/20/2026 7:35PM');
  });

  it('writes each of the other four', () => {
    expect(formatTalkStamp(evening, 'date-time-24')).toBe('2026-08-20 19:35');
    expect(formatTalkStamp(evening, 'time-12')).toBe('7:35PM');
    expect(formatTalkStamp(evening, 'time-24')).toBe('19:35');
    expect(formatTalkStamp(evening, 'time-24-seconds')).toBe('19:35:02');
  });

  it('pads the 24-hour clock and does not pad the 12-hour one', () => {
    expect(formatTalkStamp(morning, 'time-24')).toBe('07:05');
    expect(formatTalkStamp(morning, 'time-12')).toBe('7:05AM');
  });

  /* The one case a bare modulo gets wrong, in both directions. */
  it('calls midnight and noon twelve, never zero', () => {
    expect(formatTalkStamp(new Date(2026, 0, 1, 0, 4).getTime(), 'time-12')).toBe('12:04AM');
    expect(formatTalkStamp(new Date(2026, 0, 1, 12, 4).getTime(), 'time-12')).toBe('12:04PM');
  });

  /*
   * The two halves of a closed union move together: every format the type
   * declares is one the formatter answers, or a stored choice would render as
   * nothing at all.
   */
  it('answers for every format the union declares', () => {
    for (const format of TALK_STAMPS) {
      expect(formatTalkStamp(evening, format).length).toBeGreaterThan(0);
    }
    expect(TALK_STAMPS).toContain(DEFAULT_TALK_STAMP);
  });

  it('refuses a value that is not one of them, so a stale store falls back', () => {
    expect(isTalkStamp('date-time-12')).toBe(true);
    expect(isTalkStamp('rfc2822')).toBe(false);
    expect(isTalkStamp(null)).toBe(false);
  });
});

describe('how a line is arranged', () => {
  it("defaults to the realm's own sentence, which invents nothing", () => {
    expect(DEFAULT_TALK_LAYOUT).toBe('original');
    expect(TALK_LAYOUTS).toContain(DEFAULT_TALK_LAYOUT);
  });

  it('refuses a layout this build cannot draw', () => {
    expect(isTalkLayout('condensed-aligned')).toBe(true);
    expect(isTalkLayout('columns')).toBe(false);
    expect(isTalkLayout(7)).toBe(false);
  });
});
