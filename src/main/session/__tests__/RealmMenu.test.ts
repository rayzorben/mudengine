import { describe, expect, it } from 'vitest';

import { RealmMenu } from '../RealmMenu';
import { Classifier } from '../../parse/Classifier';
import type { Block } from '../../../shared/blocks';

/* Paradigm's menu, as the wire has it in 226 sessions (`logs/…_festus.log`). */
const PARADIGM = [
  '{ Realm Selection }',
  '',
  '[1] . Paradigm PVE (v1.9.1) [ PvE ]',
  '    . . Realm Launch: 07/17/2026 @ 04:00 PM (68 days ago)',
  '    . . Character Limit 2',
  '    . . Dupe XP Requirement 6,050,000,000',
  '[2] . Paradigm PVP (v1.9.1) [ PvP Enabled ]',
  '    . . Realm Launch: 07/10/2026 @ 04:00 PM (75 days ago)',
  '    . . Character Limit 1',
  '    . . PvP Level Range 12',
  '    . . Hang Penalties 25%',
  '',
  'Please select a realm: '
];

/** The lines through the real classifier, so the patterns are under test too. */
function blocks(lines: string[]): Block[] {
  const classifier = new Classifier();
  return lines.flatMap((text, seq) => {
    const out = classifier.classify({ seq, at: seq, text, plain: text, terminator: 'newline' });
    return out.block === null ? [] : [out.block];
  });
}

function menu(lines: string[] = PARADIGM): RealmMenu {
  const read = new RealmMenu();
  for (const block of blocks(lines)) read.onBlock(block);
  return read;
}

describe('what a realm menu says about hanging up', () => {
  it('reads a PvE realm that states no penalty as charging nothing', () => {
    const read = menu();
    expect(read.noteCommand('1')).toEqual({ realm: 'Paradigm PVE', percent: 0 });
    expect(read.penalty).toEqual({ realm: 'Paradigm PVE', percent: 0 });
  });

  it('reads the penalty stated under the realm chosen', () => {
    expect(menu().noteCommand(' 2 ')).toEqual({ realm: 'Paradigm PVP', percent: 25 });
  });

  it('reads nothing for a PvP realm that states no figure, or a choice it did not list', () => {
    const silent = menu(PARADIGM.filter((line) => !line.includes('Hang Penalties')));
    expect(silent.noteCommand('2')).toBeNull();
    expect(silent.penalty).toBeNull();
    expect(menu().noteCommand('9')).toBeNull();
  });

  /* Back at the menu on one connection, a choice it cannot read replaces the last one. */
  it('forgets the last realm when the next answer is one it cannot read', () => {
    const read = menu();
    expect(read.noteCommand('1')?.percent).toBe(0);
    for (const block of blocks(PARADIGM)) read.onBlock(block);
    expect(read.noteCommand('9')).toBeNull();
    expect(read.penalty).toBeNull();
  });

  /* Stock GreaterMUD's menu states no mode, so it leaves the setting to decide. */
  it('reads nothing from a menu that states no mode', () => {
    const stock = menu(['Realms:', '', ' 1) GreaterMUD - Docker', '', 'Please select a realm: ']);
    expect(stock.noteCommand('1')).toBeNull();
  });

  it('takes only the answer to the realm prompt, and forgets the menu after it', () => {
    const read = new RealmMenu();
    const lines = blocks(PARADIGM);
    for (const block of lines.slice(0, -1)) read.onBlock(block);
    // Listed, not yet asked: a command now is not the choice.
    expect(read.noteCommand('1')).toBeNull();
    read.onBlock(lines.at(-1)!);
    expect(read.noteCommand('2')?.percent).toBe(25);
    // Answered: a later command is not a second choice.
    expect(read.noteCommand('1')).toBeNull();
    expect(read.penalty?.percent).toBe(25);
    read.reset();
    expect(read.penalty).toBeNull();
  });
});
