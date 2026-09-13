import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { ActionBook, parseActionsCsv } from '../actions';
import { ACTIONS } from '../talk';

const SHIPPED = path.resolve('resources/world/actions.csv');

/*
 * Three rows in the server's own shape: a bare action with a room form, one
 * with no bare form at all, and the one shipped row whose room forms carry the
 * actor's pronoun.
 */
const csv = [
  'action,single_to_user,single_to_room,user_to_user,user_to_other_user,user_to_room,monster_to_user,monster_to_room,inventory_to_user,inventory_to_room,floor_item_to_user,floor_item_to_room',
  'giggle,You giggle loudly!,%s giggles loudly!,You giggle at %s!,%s giggles loudly at you!,%s giggles loudly at %s!,You giggle at %s!,%s giggles loudly at %s!,You giggle at your %s!,%s giggles loudly at %s %s!,You giggle at the %s!,%s giggles loudly at the %s!',
  'bearhug,,,You give %s a bearhug!,%s gives you a bone-crushing bearhug!,%s gives %s a bone-crushing bearhug!,,,,,,',
  'shake,You shake your head.,%s shakes %p head.,You shake your head at %s.,%s shakes %p head at you.,%s shakes %p head at %s.,You shake your head at %s.,%s shakes %p head at %s.,You shake your head at your %s.,%s shakes %p head at %s.,You shake your head at the %s.,%s shakes at the %s.',
  ',You are nobody!,,,,,,,,,,'
].join('\n');

describe('reading the action table', () => {
  it('reads a template per audience, drops empty cells and a wordless row', () => {
    const rows = parseActionsCsv(csv);
    expect(rows.map((row) => row.action)).toEqual(['giggle', 'bearhug', 'shake']);
    expect(Object.keys(rows[1]!.templates)).toEqual([
      'user_to_user',
      'user_to_other_user',
      'user_to_room'
    ]);
    expect(rows[0]!.templates.single_to_room).toBe('%s giggles loudly!');
  });

  it('refuses a template it cannot anchor or cannot split', () => {
    const book = new ActionBook();
    expect(book.add('odd', 'single_to_room', '%s%s!')).toBe(false);
    expect(book.add('odd', 'single_to_room', '%p nods')).toBe(false);
    expect(book.add('nod', 'single_to_room', '%s nods.')).toBe(true);
    expect(book.actions()).toEqual(['nod']);
  });
});

describe('fitting a line to the templates', () => {
  const book = ActionBook.fromRows(parseActionsCsv(csv));

  it('reads this character’s own bare action, with nobody named', () => {
    expect(book.match('You giggle loudly!')).toEqual({
      action: 'giggle',
      actor: null,
      target: null,
      message: 'giggle loudly!'
    });
  });

  it('reads somebody else’s, naming them off the front', () => {
    expect(book.match('Soul giggles loudly!')).toEqual({
      action: 'giggle',
      actor: 'Soul',
      target: null,
      message: 'giggles loudly!'
    });
  });

  it('reads the three aimed forms: at a target, at this character, between two others', () => {
    expect(book.match('You give Soul a bearhug!')).toMatchObject({
      action: 'bearhug',
      actor: null,
      target: 'Soul'
    });
    expect(book.match('Soul gives you a bone-crushing bearhug!')).toMatchObject({
      action: 'bearhug',
      actor: 'Soul',
      target: null
    });
    expect(book.match('Soul gives Yang a bone-crushing bearhug!')).toMatchObject({
      action: 'bearhug',
      actor: 'Soul',
      target: 'Yang',
      message: 'gives Yang a bone-crushing bearhug!'
    });
  });

  it('takes a monster’s or an item’s several words as the target', () => {
    expect(book.match('You giggle at tall orc rogue!')?.target).toBe('tall orc rogue');
    expect(book.match('Yang giggles loudly at angry chimera!')).toMatchObject({
      actor: 'Yang',
      target: 'angry chimera'
    });
    // The first template in file order answers, so the item's form is read by
    // the player's and the target is the words as printed, `your` included.
    expect(book.match('You giggle at your rusty short sword!')?.target).toBe(
      'your rusty short sword'
    );
  });

  it('fills a pronoun gap with his or her and nothing else', () => {
    expect(book.match('Soul shakes her head.')).toMatchObject({ action: 'shake', actor: 'Soul' });
    expect(book.match('Soul shakes his head at Yang.')).toMatchObject({
      actor: 'Soul',
      target: 'Yang'
    });
    expect(book.match('Soul shakes their head.')).toBeNull();
  });

  it('refuses a near miss: the wrong ending, an empty gap, a name of two words', () => {
    expect(book.match('You giggle loudly')).toBeNull();
    expect(book.match('You giggle at !')).toBeNull();
    expect(book.match('Old Soul giggles loudly!')).toBeNull();
    expect(book.match('You feel safe from evil!')).toBeNull();
    expect(book.match('The orc rogue collapses with a grunt.')).toBeNull();
  });
});

/*
 * The shipped file, against the wire and the corpus: `You giggle loudly!`
 * (live, 2026-09-12) and the emotes the capture corpus holds. Held against
 * the file rather than a fixture because the file is the fact.
 */
describe('the shipped action table', () => {
  const book = ActionBook.fromRows(parseActionsCsv(fs.readFileSync(SHIPPED, 'utf8')));

  it('holds the sixty-four actions the realm lists, and the same ones the composer sends', () => {
    expect(book.size).toBe(64);
    expect(new Set(book.actions())).toEqual(ACTIONS);
  });

  it.each([
    ['You giggle loudly!', 'giggle', null, null],
    ['You sigh wistfully.', 'sigh', null, null],
    ['You shrug your shoulders.', 'shrug', null, null],
    ['Vincent cheers loudly!', 'cheer', 'Vincent', null],
    ['Tazahir nods affirmatively.', 'nod', 'Tazahir', null],
    ['You wave to angry chimera!', 'wave', null, 'angry chimera'],
    ['You bow to rogue spirit.', 'bow', null, 'rogue spirit'],
    ['Galen winks at angry chimera!', 'wink', 'Galen', 'angry chimera']
  ])('reads %s', (line, action, actor, target) => {
    expect(book.match(line)).toMatchObject({ action, actor, target });
  });

  it('reads none of the lines the sheet was once spent on', () => {
    expect(
      book.match('You may also type ACTION LIST in game to list the actions available.')
    ).toBeNull();
    expect(book.match('You have no keys.')).toBeNull();
    expect(book.match('The forest becomes strangely silent.')).toBeNull();
  });
});
