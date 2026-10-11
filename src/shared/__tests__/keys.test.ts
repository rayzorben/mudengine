import { describe, expect, it } from 'vitest';

import {
  CLIENT_KEYS,
  MEGAMUD_KEYS,
  chordName,
  chordOfEvent,
  keyRowRefusals,
  normalizeKeys,
  parseChord,
  readKeys,
  statedKeys
} from '../keys';
import { normalizeConfig } from '../config';

// Keys bound to a line, MegaMUD's macros (todo 74).
describe('a chord in the file', () => {
  it('reads modifiers in any case and order, and writes them one way', () => {
    expect(chordName(parseChord('shift+ctrl+KeyK')!)).toBe('Ctrl+Shift+KeyK');
    expect(chordName(parseChord('Cmd+F5')!)).toBe('Ctrl+F5');
    expect(chordName(parseChord('numpad8')!)).toBe('Numpad8');
  });

  it('names no key when a part is not one', () => {
    expect(parseChord('')).toBeNull();
    expect(parseChord('Ctrl+')).toBeNull();
    expect(parseChord('Hyper+KeyK')).toBeNull();
    expect(parseChord('Ctrl+Ctrl+KeyK')).toBeNull();
    expect(parseChord('Numpad 8')).toBeNull();
  });

  it('is the chord a press makes, Cmd counted as Ctrl', () => {
    const press = {
      code: 'Numpad8',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false
    };
    expect(chordName(chordOfEvent(press))).toBe('Ctrl+Numpad8');
  });
});

describe('what a keys: block loads', () => {
  it("is MegaMUD's keypad when the file has no block, and nothing it refuses", () => {
    expect(normalizeKeys(undefined)).toEqual(MEGAMUD_KEYS);
    expect(readKeys(MEGAMUD_KEYS).refused).toEqual([]);
    expect(normalizeConfig({}).keys).toEqual(MEGAMUD_KEYS);
    expect(statedKeys(undefined)).toHaveLength(Object.keys(MEGAMUD_KEYS).length);
    // A stated empty block means none.
    expect(normalizeKeys({})).toEqual({});
  });

  it('keeps a binding under the chord as written one way, the line trimmed', () => {
    expect(readKeys({ 'shift+f2': ' 2d,6s;rest ' })).toEqual({
      bindings: { 'Shift+F2': '2d,6s;rest' },
      refused: []
    });
  });

  it('refuses each entry it cannot load, and says why', () => {
    const { bindings, refused } = readKeys({
      'Ctrl+KeyK': 'look',
      KeyK: 'look',
      Enter: 'look',
      'Shift+Digit8': 'n',
      'Bad Key': 'n',
      F3: '  ',
      Numpad8: 'n',
      numpad8: 'north',
      F4: 'rest'
    });
    // Positive control: the one clean entry loads.
    expect(bindings).toEqual({ F4: 'rest' });
    expect(refused).toEqual([
      { name: 'Ctrl+KeyK', refusal: 'client' },
      { name: 'KeyK', refusal: 'typing' },
      { name: 'Enter', refusal: 'typing' },
      { name: 'Shift+Digit8', refusal: 'typing' },
      { name: 'Bad Key', refusal: 'chord' },
      { name: 'F3', refusal: 'empty' },
      { name: 'Numpad8', refusal: 'twice' },
      { name: 'numpad8', refusal: 'twice' }
    ]);
  });

  it("refuses every one of the client's own chords and the editing keys", () => {
    for (const chord of Object.values(CLIENT_KEYS)) {
      const name = [
        chord.mod && 'Ctrl',
        chord.alt && 'Alt',
        chord.shift && 'Shift',
        /^[a-z]$/.test(chord.key)
          ? `Key${chord.key.toUpperCase()}`
          : chord.key === '\\'
            ? 'Backslash'
            : ',<'.includes(chord.key)
              ? 'Comma'
              : chord.key
      ]
        .filter(Boolean)
        .join('+');
      expect(keyRowRefusals([{ name, text: 'look' }]), name).toEqual(['client']);
    }
    expect(keyRowRefusals([{ name: 'Ctrl+KeyC', text: 'look' }])).toEqual(['client']);
    expect(keyRowRefusals([{ name: 'Ctrl+Shift+KeyV', text: 'look' }])).toEqual(['client']);
    expect(keyRowRefusals([{ name: 'Ctrl+KeyB', text: 'look' }])).toEqual([null]);
  });
});
