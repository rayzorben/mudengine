import { describe, expect, it } from 'vitest';

import { MessageBook, parseMessagesCsv } from '../messages';

/*
 * The server's own message table read as templates (todo 109, 2026-09-13).
 * Rows are the official realm's `Messages` table as `build:messages` ships
 * them; the shapes here are the ones `Message.cs` documents.
 */
const CSV = [
  'number,kind,line1,line2,line3',
  '2,cast,"You cast %s!","%s casts %s!","%s casts %s!"',
  '7,cast,"You cast %s on %s!","%s casts %s upon you!","%s casts %s on %s!"',
  '127,other,"%s is healed of %d damage!","You are healed of %d damage!","%s is healed of %s damage!"',
  '11,verbs,"pound|smash|crush","pounds|smashes|crushes","pounds|smashes|crushes"',
  '12,commands,"go manhole","go man","enter manhole"',
  '39,other,"You slash %s for %d damage!","The %s slashes %s for %s damage!","The %s slashes %s for %s damage!"',
  '900,other,"%s %s %s","",""'
].join('\n');

describe('the message table', () => {
  const book = MessageBook.fromRows(parseMessagesCsv(CSV));

  it("reads the rows and skips a verb table and a text exit's words", () => {
    const rows = parseMessagesCsv(CSV);
    expect(rows.map((row) => row.number)).toEqual([2, 7, 127, 11, 12, 39, 900]);
    // 2: the caster's line only (`%s casts %s!` has six literal characters);
    // 7, 127, 39: three each; 900: none. Too little literal text is not fitted.
    expect(book.size).toBe(10);
  });

  it('fits the caster line and fills the placeholders in order', () => {
    const hit = book.match('You cast blind on kobold thief!');
    expect(hit).toMatchObject({ number: 7, role: 1, fills: ['blind', 'kobold thief'] });
  });

  it('fits the target line and the room line of the same row', () => {
    expect(book.match('kobold thief casts curse upon you!')).toMatchObject({ number: 7, role: 2 });
    expect(book.match('Soul casts bless on Yang!')).toMatchObject({
      number: 7,
      role: 3,
      fills: ['Soul', 'bless', 'Yang']
    });
  });

  it('reads a figure as one, whichever placeholder printed it', () => {
    expect(book.match('You are healed of 12 damage!')).toMatchObject({
      number: 127,
      role: 2,
      fills: ['12'],
      numeric: [true]
    });
    // The caster's line and the room's line of this row are the same words;
    // either role is the truth, and the figure is read as one in both.
    expect(book.match('Soul is healed of 7 damage!')).toMatchObject({
      number: 127,
      numeric: [false, true]
    });
  });

  it('prefers the template that says more', () => {
    // `You cast %s!` fits `You cast blind on kobold thief!` too, with the
    // whole tail as the spell; the row with more literal text wins.
    expect(book.match('You cast blind on kobold thief!')?.number).toBe(7);
    expect(book.match('You cast blur!')).toMatchObject({ number: 2, role: 1, fills: ['blur'] });
  });

  it('answers nothing for a line no template fits, and never on a template of placeholders', () => {
    expect(book.match('The room is dimly lit')).toBeNull();
    expect(book.match('a b c')).toBeNull();
    expect(book.match('')).toBeNull();
  });
});
