import { describe, expect, it } from 'vitest';

import { hazardAtLevel, hazardWords, roomSpellCopyLines, stoppersShown } from '../RoomSpellRows';
import { healthShareWords } from '../../lib/healthShare';
import type { WorldSpell } from '@shared/world';
import { t } from '../../lib/i18n';

/**
 * What a room's own spell does, as the Room card says it (todo 72). The
 * hazard is narrowed to the character's level at the card, so a level-up in
 * the room shows without a move. The fixture is shaped like the desert spell
 * (#683), whose teleport is `maxlevel 19` on Paradigm.
 */
const desert: WorldSpell = {
  id: 683,
  name: 'desert spell',
  hazard: {
    damage: 13,
    relocates: true,
    unread: true,
    reach: { relocates: [{ band: { max: 19 } }] }
  }
};

describe('the Room card says what the room casts', () => {
  it('says every effect, so a room that hurts and moves says both', () => {
    const words = hazardWords(hazardAtLevel(desert, 10)!).map((word) => word.text);
    expect(words).toEqual([
      t('cards.roomSpell.damage', { damage: 13 }),
      t('cards.roomSpell.moves'),
      t('cards.route.hazardUnread')
    ]);
  });

  it('drops an effect the realm gates away from this level, and keeps it when the level is unknown', () => {
    expect(hazardWords(hazardAtLevel(desert, 21)!).map((word) => word.text)).not.toContain(
      t('cards.roomSpell.moves')
    );
    expect(hazardWords(hazardAtLevel(desert, null)!).map((word) => word.text)).toContain(
      t('cards.roomSpell.moves')
    );
  });

  it('says so when nothing is left at this level, rather than nothing', () => {
    const gated: WorldSpell = {
      id: 713,
      name: 'sandstorm',
      hazard: { relocates: true, reach: { relocates: [{ band: { max: 19 } }] } }
    };
    expect(hazardWords(hazardAtLevel(gated, 21)!).map((word) => word.text)).toEqual([
      t('cards.roomSpell.notAtYourLevel')
    ]);
  });

  it('has no hazard for a spell the realm states none for', () => {
    expect(hazardAtLevel({ id: 484, name: 'inn rest' }, 10)).toBeUndefined();
    const copied = roomSpellCopyLines({
      spell: { id: 484, name: 'inn rest' },
      hazard: undefined,
      stoppedBy: undefined
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('inn rest');
  });

  it('says the damage as a share of the maximum health, and only where the maximum is known', () => {
    const hazard = hazardAtLevel(desert, 10)!;
    expect(hazardWords(hazard, 130)[0]?.title).toBe(healthShareWords(0.1));
    expect(hazardWords(hazard, 2000)[0]?.title).toBe(healthShareWords(13 / 2000));
    expect(hazardWords(hazard, null)[0]?.title).toBeUndefined();
  });

  it('copies every row drawn: what stops it, and the passage where the room casts nothing', () => {
    const copied = roomSpellCopyLines({
      spell: null,
      hazard: { damage: 13, reach: { damage: [{ fails: [1180], wards: [711] }] } },
      stoppedBy: {
        items: [{ id: 1180, name: 'waterskin' }],
        spells: [{ id: 711, name: 'quench' }]
      },
      passage: { spell: 711, name: 'quench', rooms: 4, ends: true }
    });
    expect(copied).toHaveLength(3);
    expect(copied[0]).toContain('waterskin');
    expect(copied[1]).toContain('quench');
    expect(copied[2]).toContain(
      t('cards.roomSpell.passageValue', { spellName: 'quench', roomCount: 4 })
    );
  });

  /*
   * Desert spell 2 above level 19: the sunstone wristband takes its teleports off and
   * leaves the summons, so it is said as stopping part of it, with what.
   */
  it('says what an item that stops part of it takes off', () => {
    const shown = stoppersShown(
      {
        relocates: true,
        summons: true,
        reach: { relocates: [{ fails: [1180] }], summons: [{}] }
      },
      {
        items: [
          { id: 1180, name: 'sunstone wristband' },
          { id: 690, name: 'log raft' }
        ],
        spells: []
      }
    );
    expect(shown.items).toEqual([]);
    expect(shown.part).toEqual([
      t('cards.roomSpell.stopsPartValue', {
        stopperName: 'sunstone wristband',
        effectList: t('cards.roomSpell.moves')
      })
    ]);
  });
});
