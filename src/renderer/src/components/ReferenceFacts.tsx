import { memo } from 'react';

import Kpi from './viz/Kpi';
import { useItemArt } from '../hooks/useItemArt';
import { t } from '../lib/i18n';
import { pictureOf } from '../lib/itemArt';
import { entryFigure, mobDefence, mobHealth, type ReferenceEntry } from '../lib/reference';
import type { RealmFamily } from '@shared/character';

/**
 * The few figures a monster, an item or a spell is looked up for, set large
 * as tiles over the readout that states them in full: what a small card
 * shows of the thing, and the head of a larger one. An item's picture is
 * beside them where the art run drew one (from the large size; always in the
 * slide-out, which draws everything). A figure the realm does not state is a
 * quiet dash. Races and classes have no figures to set large.
 */
function figures(
  entry: ReferenceEntry
): Array<{ key: string; label: string; value: string | null }> {
  if (entry.kind === 'mob') {
    const { mob } = entry;
    return [
      {
        key: 'hp',
        label: t('cards.player.detail.health'),
        value: mobHealth(mob)
      },
      {
        key: 'exp',
        label: t('cards.reference.race.expLabel'),
        value: mob.experience === undefined ? null : mob.experience.toLocaleString()
      },
      {
        key: 'ac',
        label: t('cards.reference.mob.defenceLabel'),
        value: mobDefence(mob)
      },
      {
        key: 'mr',
        label: t('cards.reference.mob.magicResistLabel'),
        value: mob.magicResist === undefined ? null : String(mob.magicResist)
      }
    ];
  }
  if (entry.kind === 'item') {
    const { item } = entry;
    const weight = {
      key: 'weight',
      label: t('cards.inventory.columns.weight'),
      value: item.encumbrance === undefined ? null : String(item.encumbrance)
    };
    if (item.weapon) {
      return [
        {
          key: 'damage',
          label: t('cards.reference.item.weapon.damageLabel'),
          value: entryFigure(entry)
        },
        {
          key: 'speed',
          label: t('cards.reference.item.weapon.speedLabel'),
          value: item.weapon.speed === undefined ? null : String(item.weapon.speed)
        },
        {
          key: 'strength',
          label: t('cards.reference.item.weapon.needsLabel'),
          value:
            item.weapon.strength === undefined
              ? null
              : t('cards.reference.item.weapon.needsStrength', { strength: item.weapon.strength })
        },
        weight
      ];
    }
    if (item.armour) {
      const { ac, dr } = item.armour;
      const stops = [
        ac === undefined ? null : t('cards.reference.item.armour.acFigure', { ac }),
        dr === undefined ? null : t('cards.reference.item.armour.drFigure', { dr })
      ].filter((part): part is string => part !== null);
      return [
        {
          key: 'stops',
          label: t('cards.reference.mob.defenceLabel'),
          value: stops.length === 0 ? null : stops.join(' · ')
        },
        weight
      ];
    }
    return [
      {
        key: 'price',
        label: t('cards.room.shop.columnPrice'),
        value: item.price === undefined ? null : item.price.toLocaleString()
      },
      weight
    ];
  }
  if (entry.kind === 'spell') {
    const { spell } = entry;
    return [
      {
        key: 'level',
        label: t('cards.vitals.labels.level'),
        value: spell.level === undefined ? null : String(spell.level)
      },
      {
        key: 'mana',
        label: t('cards.alerts.vitals.manaLabel'),
        value: spell.mana === undefined ? null : String(spell.mana)
      }
    ];
  }
  return [];
}

function ReferenceFacts({ entry, realm }: { entry: ReferenceEntry; realm: RealmFamily | null }) {
  const art = useItemArt();
  const shown = figures(entry);
  const picture =
    entry.kind === 'item' && art !== null
      ? pictureOf(art, realm, { name: entry.item.name, id: entry.item.id })
      : null;
  if (shown.length === 0 && picture === null) return null;
  return (
    <div className="reference-facts">
      {picture === null ? null : (
        <img alt="" className="reference-art from-large" draggable={false} src={picture} />
      )}
      <div className="kpis">
        {shown.map((each) => (
          <Kpi key={each.key} label={each.label} value={each.value} />
        ))}
      </div>
    </div>
  );
}

export default memo(ReferenceFacts);
