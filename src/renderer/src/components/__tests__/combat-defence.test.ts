import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import CombatCard from '../CombatCard';
import { mount } from '../../hooks/__tests__/mount';
import { t } from '../../lib/i18n';
import { EMPTY_CHARACTER, NO_COMBAT, type CharacterState } from '@shared/character';
import { NO_PLAYERS } from '@shared/players';
import { EMPTY_ROOM_VERDICT } from '@shared/verdict';

/*
 * The Combat card's Defence row for the monster being fought. A realm that
 * records a monster's AC and not its DR leaves the DR unknown, and the row
 * says so as `—`, the way the reference card does, never as 0 DR.
 */
const probe = mount();
afterEach(() => probe.unmount());

function fighting(armour: number | undefined, damageResist: number | undefined): CharacterState {
  return {
    ...EMPTY_CHARACTER,
    combat: {
      ...NO_COMBAT,
      engaged: true,
      target: 'orc',
      health: {
        name: 'orc',
        max: null,
        source: null,
        span: null,
        damage: { mine: 0, others: 0 },
        remaining: null,
        observed: null,
        sinceLook: null
      },
      targetEntity: {
        name: 'orc',
        rawName: 'orc',
        source: 'mdb',
        charmed: false,
        disposition: null,
        uncertain: false,
        costly: 'never',
        ...(armour === undefined ? {} : { armour }),
        ...(damageResist === undefined ? {} : { damageResist })
      }
    }
  };
}

function drawn(character: CharacterState): string {
  probe.render(
    createElement(CombatCard, {
      character,
      players: NO_PLAYERS,
      verdict: EMPTY_ROOM_VERDICT
    })
  );
  const label = t('cards.reference.mob.defenceLabel');
  const rows = probe.root().findAll((node) => node.type === 'dt' || node.type === 'dd');
  const at = rows.findIndex((node) => node.type === 'dt' && node.children.join('') === label);
  if (at < 0) throw new Error('no Defence row');
  const dd = rows[at + 1];
  return dd!.children.join('');
}

describe('the Combat card says a defence the realm leaves out as unknown', () => {
  it('shows the DR as unknown when only the AC is recorded', () => {
    expect(drawn(fighting(30, undefined))).toBe(
      t('cards.reference.mob.defenceFigure', { ac: 30, dr: '—' })
    );
  });

  it('shows the AC as unknown when only the DR is recorded', () => {
    expect(drawn(fighting(undefined, 4))).toBe(
      t('cards.reference.mob.defenceFigure', { ac: '—', dr: 4 })
    );
  });
});
