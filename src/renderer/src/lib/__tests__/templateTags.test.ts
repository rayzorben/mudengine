import { describe, expect, it } from 'vitest';

import { rankNames } from '../rankNames';
import { tagAt, templateTags } from '../templateTags';

describe('the tags a template may name', () => {
  const pack = templateTags('inventory');

  it("offers a record's own fields, addressed through the row, and never the bare record", () => {
    expect(pack).toContain('{item.action.autoDrop}');
    expect(pack).toContain('{item.action.toggleEquip}');
    expect(pack).not.toContain('{item.action}');
    expect(pack).toContain('{for item in items}');
    expect(pack).toContain('{brightGreen}');
    expect(pack).toContain('{if ');
    expect(new Set(pack).size).toBe(pack.length);
  });

  it('offers the row fields only to an entity that has a list', () => {
    expect(templateTags('statline')).not.toContain('{for item in items}');
    expect(templateTags('statline')).toContain('{hp}');
  });
});

describe('the tag at the caret', () => {
  it('is the open brace before it on the same line', () => {
    expect(tagAt('{bold}x {item.ac', 16)).toEqual({ from: 8, typed: '{item.ac' });
  });

  it('is nothing after a closed tag, or past a line break', () => {
    expect(tagAt('{bold} x', 8)).toBeNull();
    expect(tagAt('{item\nab', 8)).toBeNull();
    expect(tagAt('plain', 5)).toBeNull();
  });
});

describe('ranking what was typed', () => {
  it('puts a prefix ahead of a match anywhere', () => {
    expect(
      rankNames(['{item.action.drop}', '{item.drop}', '{item.dropper}'], '{item.drop', 10)
    ).toEqual(['{item.drop}', '{item.dropper}']);
    expect(rankNames(['b', 'ab'], 'b', 10)).toEqual(['b', 'ab']);
  });
});
