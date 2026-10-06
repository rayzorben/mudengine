import type { ItemRarity, RarityFrom, RarityGate, RaritySource } from '@shared/rarity';
import { t } from '../lib/i18n';
import { tuning } from '../lib/tuning';
import { clockText } from './LairList';

/** Hours to one copy: the lair clock's letters, and days past two of them. */
function rarityClock(hours: number): string {
  return hours < 48 ? clockText(hours * 3600) : `${Number((hours / 24).toFixed(1))}d`;
}

/** A percent to three figures: `10`, `0.15`, `33.3`. */
const figure = (percent: number): number => Number(percent.toPrecision(3));

function sentence(from: RarityFrom): string {
  switch (from.kind) {
    case 'shop':
      return from.percent >= 100
        ? t('cards.reference.item.rarity.shop', from)
        : t('cards.reference.item.rarity.shopChance', from);
    case 'placed':
      return t('cards.reference.item.rarity.placed', { room: from.room });
    case 'drop':
      return t('cards.reference.item.rarity.drop', {
        monster: from.monster,
        percent: figure(from.percent)
      });
    case 'spell':
      switch (from.when) {
        case 'arrive':
          return t('cards.reference.item.rarity.arrive', { monster: from.monster });
        case 'death':
          return t('cards.reference.item.rarity.death', { monster: from.monster });
        case 'fight':
          return t('cards.reference.item.rarity.fight', { monster: from.monster });
        case 'attack':
          return t('cards.reference.item.rarity.attack', { monster: from.monster });
        default: {
          const never: never = from.when;
          return never;
        }
      }
    case 'use':
      return t('cards.reference.item.rarity.use', { item: from.item });
    case 'ask':
      return t('cards.reference.item.rarity.ask', { who: from.who, say: from.say });
    case 'say': {
      const others = from.rooms.length - 1;
      const words = { say: from.say, room: from.rooms[0], count: others };
      if (others === 0) return t('cards.reference.item.rarity.say', words);
      return others === 1
        ? t('cards.reference.item.rarity.sayRooms.one', words)
        : t('cards.reference.item.rarity.sayRooms.many', words);
    }
    default: {
      const never: never = from;
      return never;
    }
  }
}

/** What a phrase asks first; nothing for one said on demand. */
function gateNote(gate: RarityGate): string | null {
  switch (gate.kind) {
    case 'onDemand':
      return null;
    case 'uses':
      return t('cards.reference.item.rarity.uses', { items: gate.items.join(', ') });
    case 'quest':
      return t('cards.reference.item.rarity.questReward');
    default: {
      const never: never = gate;
      return never;
    }
  }
}

/** How many one run makes, where it is not a sure single copy. */
function copiesNote(from: RarityFrom): string | null {
  if (from.kind === 'shop' || from.kind === 'placed' || from.kind === 'drop') return null;
  return from.copies === 1
    ? null
    : t('cards.reference.item.rarity.perRun', { percent: figure(from.copies * 100) });
}

function SourceLine({ source }: { source: RaritySource }) {
  const notes = [
    copiesNote(source.from),
    source.from.kind === 'ask' || source.from.kind === 'say' ? gateNote(source.from.gate) : null
  ].filter((note): note is string => note !== null);
  return (
    <span className="rarity-source">
      <span className="rarity-clock">
        {source.hours === null
          ? t('cards.reference.item.rarity.noFigure')
          : rarityClock(source.hours)}
      </span>
      {sentence(source.from)}
      {notes.length > 0 && <span className="quiet">{` (${notes.join(', ')})`}</span>}
    </span>
  );
}

/**
 * How rare the item is and where the realm makes it, quickest first (todo 13):
 * the band, the time to one copy at the quickest source, and each source with
 * its own figure, so the reader can check the band against what it rests on.
 */
export default function RarityRows({ rarity }: { rarity: ItemRarity }) {
  const shown = rarity.sources.slice(0, tuning().raritySourcesShown);
  const more = rarity.sources.length - shown.length;
  return (
    <>
      <dt title={t('cards.reference.item.rarity.hint')}>
        {t('cards.reference.item.rarity.label')}
      </dt>
      <dd>
        <span>{bandWord(rarity)}</span>
        {rarity.hours !== null && (
          <span className="quiet">
            {t('cards.reference.item.rarity.every', { clock: rarityClock(rarity.hours) })}
          </span>
        )}
        {rarity.limited && (
          <span className="quiet">{t('cards.reference.item.rarity.limited')}</span>
        )}
      </dd>
      {shown.length > 0 && (
        <>
          <dt>{t('cards.reference.item.rarity.sourcesLabel')}</dt>
          <dd className="item-rarity">
            {shown.map((source, index) => (
              <SourceLine key={index} source={source} />
            ))}
            {more > 0 && (
              <span className="quiet">
                {t('cards.reference.item.rarity.more', { count: more })}
              </span>
            )}
          </dd>
        </>
      )}
    </>
  );
}

function bandWord({ rarity }: ItemRarity): string {
  switch (rarity) {
    case 'common':
      return t('cards.reference.item.rarity.band.common');
    case 'uncommon':
      return t('cards.reference.item.rarity.band.uncommon');
    case 'rare':
      return t('cards.reference.item.rarity.band.rare');
    case 'veryRare':
      return t('cards.reference.item.rarity.band.veryRare');
    case 'extremelyRare':
      return t('cards.reference.item.rarity.band.extremelyRare');
    case 'unknown':
      return t('cards.reference.item.rarity.band.unknown');
    default: {
      const never: never = rarity;
      return never;
    }
  }
}
