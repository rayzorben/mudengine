import { memo, useEffect, useState } from 'react';

import { t } from '../lib/i18n';
import { copperWords, sourceWords } from '../lib/gearPicks';
import type { BlessAdd, BlessItem } from '@shared/blessItems';
import type { IpcApi } from '@shared/ipc';
import { errorMessage } from '@shared/values';

/**
 * The Gear card's Bless Items face (todo 44): every item in the realm that
 * would bless this character and is not carried, what its spell adds at the
 * character's level, how its uses go, and where it comes from. Items whose
 * uses come back are listed first, then the nearest counter.
 */
export interface GearBlessFaceProps {
  load(): ReturnType<IpcApi['gearBlessItems']>;
  /** Changes when the level or the pack does, and with the card's refresh. */
  askKey: string;
}

function GearBlessFace({ load, askKey }: GearBlessFaceProps) {
  const [items, setItems] = useState<BlessItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    void load().then(
      (answer) => {
        if (stale) return;
        setItems(answer);
        setFailed(null);
        setLoading(false);
      },
      (error: unknown) => {
        if (stale) return;
        setFailed(errorMessage(error));
        setLoading(false);
      }
    );
    return () => {
      stale = true;
    };
  }, [load, askKey]);

  const said =
    failed !== null
      ? t('cards.gear.failed', { why: failed })
      : items === null
        ? loading
          ? t('cards.gear.blessLoading')
          : t('cards.gear.blessUnread')
        : items.length === 0
          ? t('cards.gear.blessNone')
          : null;
  return (
    <div className="scroller gear-scroller">
      {said !== null ? (
        <p className="gear-reach">{said}</p>
      ) : (
        <ul className="bless-items tile-grid" data-loading={loading ? 'true' : 'false'}>
          {(items ?? []).map((item) => (
            <li className="tile bless-item" data-renews={item.renews} key={item.item}>
              <span className="gear-slot-name">{item.name}</span>
              <span className="bless-item-casts">
                {item.party
                  ? t('cards.gear.blessCastsParty', { spell: item.spell })
                  : t('cards.gear.blessCasts', { spell: item.spell })}
                {' · '}
                {item.adds.map(addWords).join(', ')}
              </span>
              <span className="bless-item-uses">{usesWords(item)}</span>
              <span className="bless-item-source">{whereWords(item)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default memo(GearBlessFace);

/** How its uses go: for ever, back each new day, or gone. */
function usesWords(item: BlessItem): string {
  const { capacity } = item;
  if (capacity.kind === 'unlimited') return t('cards.gear.blessForEver');
  const { of, daily } = capacity;
  if (item.renews) return t('cards.gear.blessRenews', { of, daily });
  return of === 1 ? t('cards.gear.blessCharged.one') : t('cards.gear.blessCharged.many', { of });
}

/** The counter and its price, else who drops it, else who hands it over; and the level it needs. */
function whereWords(item: BlessItem): string {
  const parts: string[] = [];
  if (item.sold !== null || item.droppedBy.length > 0 || item.givenBy.length === 0) {
    const source = sourceWords(item);
    parts.push(item.sold?.copper == null ? source : `${source} · ${copperWords(item.sold.copper)}`);
  }
  if (item.givenBy.length > 0) {
    parts.push(t('cards.gear.blessGiven', { who: item.givenBy.slice(0, 3).join(', ') }));
  }
  if (item.minLevel !== null) parts.push(t('cards.gear.blessLevel', { level: item.minLevel }));
  return parts.join(' · ');
}

/** One figure, signed, as the sheet says it. */
function addWords({ figure, value }: BlessAdd): string {
  const shown = `${value > 0 ? '+' : ''}${Math.round(value * 10) / 10}`;
  switch (figure) {
    case 'armourClass':
      return t('cards.gear.blessFigure.armourClass', { value: shown });
    case 'damageResist':
      return t('cards.gear.blessFigure.damageResist', { value: shown });
    case 'magicRes':
      return t('cards.gear.blessFigure.magicRes', { value: shown });
    case 'dodge':
      return t('cards.gear.blessFigure.dodge', { value: shown });
    case 'accuracy':
      return t('cards.gear.blessFigure.accuracy', { value: shown });
    case 'maxDamage':
      return t('cards.gear.blessFigure.maxDamage', { value: shown });
    case 'martialAccuracy':
      return t('cards.gear.blessFigure.martialAccuracy', { value: shown });
    case 'martialDamage':
      return t('cards.gear.blessFigure.martialDamage', { value: shown });
    case 'crits':
      return t('cards.gear.blessFigure.crits', { value: shown });
    case 'maxHp':
      return t('cards.gear.blessFigure.maxHp', { value: shown });
    case 'hpRegen':
      return t('cards.gear.blessFigure.hpRegen', { value: shown });
    case 'speed':
      return t('cards.gear.blessFigure.speed', { value: shown });
    default: {
      const never: never = figure;
      return never;
    }
  }
}
