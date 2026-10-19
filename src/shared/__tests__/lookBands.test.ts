import { describe, expect, it } from 'vitest';

import { appearanceOf } from '../appearance';
import { asArtServer } from '../artConfig';
import { bandOf } from '../lookBands';

/* GreaterMUD `Player.cs` GetHealthDesc .. GetWillpowerDesc (todo 20261019-0931-01). */
describe('the look phrase for a stat', () => {
  it('turns at each band’s floor', () => {
    expect(bandOf('health', 80)).toBe('massive');
    expect(bandOf('health', 79)).toBe('solid');
    expect(bandOf('strength', 110)).toBe('physically Godlike');
    expect(bandOf('strength', 109)).toBe('Herculean');
    expect(bandOf('agility', 29)).toBe('slowly');
    expect(bandOf('charm', 50)).toBe('likable in an unassuming sort of way');
    expect(bandOf('intellect', 40)).toBe('slightly dull');
    expect(bandOf('willpower', 70)).toBe('has a worldly air');
  });

  it('knows nothing of an unknown stat', () => {
    expect(bandOf('charm', null)).toBeNull();
  });

  /* captures/036: Bhaal's phrases from the figures that give them. */
  it('gives Bhaal’s phrases', () => {
    expect([bandOf('health', 85), bandOf('strength', 84), bandOf('agility', 100)]).toEqual([
      'massive',
      'powerfully built',
      'blindingly fast'
    ]);
    expect(bandOf('intellect', 80)).toBe('brilliant');
    expect(bandOf('willpower', 55)).toBe('looks fairly knowledgeable');
  });
});

describe('the appearance a look states', () => {
  it('reads hair, eyes and the pronoun, and nothing outside creation’s lists', () => {
    expect(appearanceOf('Shoulder-Length brown', 'slate-grey', 'He')).toEqual({
      gender: 'male',
      hair: { none: false, length: 'shoulder-length', colour: 'brown' },
      eyes: 'slate-grey'
    });
    expect(appearanceOf('no', 'black', 'They')).toEqual({
      gender: 'androgynous',
      hair: { none: true },
      eyes: 'black'
    });
    expect(appearanceOf('wild purple', 'mauve', 'It')).toEqual({
      gender: null,
      hair: null,
      eyes: null
    });
    expect(appearanceOf(undefined, 'black', 'He')).toBeNull();
  });
});

describe('the art server’s address', () => {
  it('takes https, and http only on this machine', () => {
    expect(asArtServer('https://art.example/')).toBe('https://art.example');
    expect(asArtServer('http://127.0.0.1:8190')).toBe('http://127.0.0.1:8190');
    expect(asArtServer('http://art.example')).toBeNull();
    expect(asArtServer('https://art.example/?key=1')).toBeNull();
    expect(asArtServer('art.example')).toBeNull();
  });
});
