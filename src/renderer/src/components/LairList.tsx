/**
 * What a lair spawns, drawn once and read in two places.
 *
 * The Room card's `LAIR` face says what the room the character is *standing
 * in* spawns; the room quick view says the same about a room on the map or on
 * a route list. It is one readout answering one question — *what is in there,
 * and will it come at me* — so it is one component: two copies of a hostility
 * rule are two chances for the map and the card to disagree about whether a
 * room is worth walking into.
 *
 * See `mudengine-world` › *The realm decides a monster's maximum*.
 */
import { Fragment } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { Alignment, CharacterState } from '@shared/character';
import { attacksOnSight, DISPOSITION_WORD } from '@shared/mobs';
import type { WorldLair, WorldMob } from '@shared/world';

export interface LairListProps {
  lair: WorldLair;
  /**
   * How the realm ranks the reader, which two of the seven monster alignments
   * decide hostility by. Null reads as *unknown*, never as harmless.
   */
  mine: Alignment | null;
  /**
   * Opens the realm's answer beside a clicked monster. Absent where there is
   * nowhere to open one — a pinned float, a panel already hanging off a name
   * — and the name is then text, per the rule that a control bound to nowhere
   * is worse than none.
   */
  inspect?(name: string, anchor: HTMLElement): void;
}

/**
 * How the realm ranks this character, from the one place it is printed.
 *
 * The stat sheet carries no standing, so the `who` roster's own row for the
 * character is it — which means null for the first seconds of every session,
 * and null must read as *unknown* rather than as *not hostile*.
 */
export function ownAlignment(character: CharacterState): Alignment | null {
  if (character.name === null) return null;
  const self = character.name.toLowerCase();
  return character.online.find((entry) => entry.name.toLowerCase() === self)?.alignment ?? null;
}

/** The realm's figure, or its range where rows sharing the name disagree. */
export function healthOf(mob: WorldMob): string {
  return mob.span === undefined
    ? t('cards.room.lair.health', { hp: mob.hp })
    : t('cards.room.lair.healthSpan', { low: mob.span[0], high: mob.span[1] });
}

/** One line per thing that can spawn, with its health, for pasting. */
export function lairCopyText(lair: WorldLair): string {
  const head =
    lair.max === null
      ? t('cards.room.tabs.lair')
      : `${t('cards.room.tabs.lair')} — ${
          lair.max === 1
            ? t('cards.room.lair.upTo.one')
            : t('cards.room.lair.upTo.many', { max: lair.max })
        }`;
  return [head, ...lair.mobs.map((mob) => `${mob.name} — ${healthOf(mob)}`)].join('\n');
}

export default function LairList({ lair, mine, inspect }: LairListProps) {
  if (lair.mobs.length === 0) {
    /*
     * The realm marks this a lair and this client's data names none of what
     * spawns here — a derivative that added monsters after the data was
     * built. Said, because the map has already drawn the glyph and a readout
     * that quietly did not appear would read as the readout being broken.
     */
    return <div className="empty">{t('cards.room.lair.unnamed')}</div>;
  }
  return (
    <>
      {lair.max !== null && (
        <div className="chip-row">
          <span className="chip quiet">
            {lair.max === 1
              ? t('cards.room.lair.upTo.one')
              : t('cards.room.lair.upTo.many', { max: lair.max })}
          </span>
        </div>
      )}
      <dl className="readout lair-list">
        {lair.mobs.map((mob) => {
          const sure = attacksOnSight(mob.disposition, mine);
          return (
            <Fragment key={mob.name}>
              <dt>
                {inspect ? (
                  <button
                    className="occupant mob lookup"
                    onClick={(event) => inspect(mob.name, event.currentTarget)}
                    onMouseDown={keepFocus}
                    title={t('cards.room.itemLookupTooltip')}
                    type="button"
                  >
                    {mob.name}
                  </button>
                ) : (
                  <span className="occupant mob">{mob.name}</span>
                )}
              </dt>
              <dd>
                {healthOf(mob)}
                {/* The same words the occupant line uses, so a lair reads as
                    the room it is: hostile in words, uncertain with a mark. */}
                {sure === true && (
                  <span className={`chip warn${mob.uncertain ? ' quiet' : ''}`}>
                    {mob.uncertain
                      ? t('cards.room.occupant.hostileUncertainChip')
                      : t('cards.realm.facet.hostile')}
                  </span>
                )}
                {mob.disposition !== null && sure !== true && (
                  <span className="chip quiet">{DISPOSITION_WORD[mob.disposition]}</span>
                )}
                {mob.costly !== 'never' && (
                  <span className="chip quiet">
                    {mob.costly === 'always'
                      ? t('cards.room.occupant.alignCostChip')
                      : t('cards.room.occupant.alignCostUncertainChip')}
                  </span>
                )}
              </dd>
            </Fragment>
          );
        })}
      </dl>
      {/* The sentence about what a lair is — *what the realm says can spawn,
          not what is up now*. It belonged to the Room card's face and moved
          here with the rows it qualifies, because a readout that lost its own
          caveat in an extraction is exactly how a card comes to overclaim. */}
      <div className="aside">{t('cards.room.lair.aside')}</div>
    </>
  );
}
