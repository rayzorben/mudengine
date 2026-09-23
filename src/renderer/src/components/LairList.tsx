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

import EntityNumber, { entityNumberText } from './EntityNumber';
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

/**
 * A clock, in the shortest reading that rounds no real difference away.
 *
 * The realm states `Rooms.Delay` in whole minutes (1–120 across both shipped
 * worlds) and `Monsters.RegenTime` in whole hours, so minutes and hours are
 * what a reader recognises — but GreaterMUD's thirty-second offset lands a
 * two-minute lair on 90 seconds, and `2m` there would be the client rounding
 * away the half of the clock the player is standing about waiting for.
 *
 * Bare unit letters rather than dictionary keys, as the Hunting card's own
 * figures are: a suffix on a numeral is not a word the chrome is saying.
 */
export function clockText(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const rest = Math.round((seconds % 3600) / 60);
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The realm's figure, or its range where rows sharing the name disagree. */
export function healthOf(mob: WorldMob): string {
  return mob.span === undefined
    ? t('cards.room.lair.health', { hp: mob.hp })
    : t('cards.room.lair.healthSpan', { low: mob.span[0], high: mob.span[1] });
}

/** One line per thing that can spawn, with its health, for pasting. */
export function lairCopyText(lair: WorldLair): string {
  /*
   * The same two facts the chip row draws, in the order it draws them: the
   * clock is half of what a lair is worth knowing, and a paste that carried
   * only the slots would be the card copying something other than its face.
   */
  const qualifiers = [
    ...(lair.max === null
      ? []
      : [
          lair.max === 1
            ? t('cards.room.lair.upTo.one')
            : t('cards.room.lair.upTo.many', { max: lair.max })
        ]),
    ...(lair.respawnSeconds === null
      ? []
      : [t('cards.room.lair.respawn', { clock: clockText(lair.respawnSeconds) })])
  ];
  const head =
    qualifiers.length === 0
      ? t('cards.room.tabs.lair')
      : `${t('cards.room.tabs.lair')} — ${qualifiers.join(', ')}`;
  /*
   * The number goes into the paste because it is drawn on the rows: a copy
   * that dropped it would be the card copying something other than the face
   * on screen, and the number is the half of a pasted lair that is worth
   * anything outside this client.
   */
  return [
    head,
    ...lair.mobs.map((mob) => {
      const number = entityNumberText(mob);
      return `${mob.name}${number === null ? '' : ` ${number}`} — ${healthOf(mob)}`;
    })
  ].join('\n');
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
      {(lair.max !== null || lair.respawnSeconds !== null) && (
        <div className="chip-row">
          {lair.max !== null && (
            <span className="chip quiet">
              {lair.max === 1
                ? t('cards.room.lair.upTo.one')
                : t('cards.room.lair.upTo.many', { max: lair.max })}
            </span>
          )}
          {/* How long the room takes to fill again — `Rooms.Delay`, resolved in
              main against the family the wire stated (`WorldGraph.lair`). It
              is the other half of what a lair is worth: the slots say how much
              is up, this says how often. Absent, never guessed at, for a realm
              converted before the column was read. */}
          {lair.respawnSeconds !== null && (
            <span className="chip quiet" title={t('cards.room.lair.respawnHint')}>
              {t('cards.room.lair.respawn', { clock: clockText(lair.respawnSeconds) })}
            </span>
          )}
        </div>
      )}
      <dl className="readout lair-list">
        {lair.mobs.map((mob) => {
          const sure = attacksOnSight(mob.disposition, mine);
          return (
            /*
             * Keyed by the row, not the name: a descriptor naming two rows of
             * one name — row 224's 100-HP gnoll scout and row 2204's 830-HP
             * one — is two monsters and two lines, and two lines under one key
             * is React drawing the first one twice.
             */
            <Fragment key={mob.row?.id ?? mob.name}>
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
                {/* The realm's own row, beside the name rather than in the
                    value column: a lair descriptor *names rows*, so this is
                    the one place a monster's number is certain, and it says
                    which of two `gnoll scout` lines is which. */}
                <EntityNumber of={mob} />
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
                {/* This row's *own* clock — `Monsters.RegenTime` (format 36),
                    which is a boss's and not the room's: about 300 rows in
                    each shipped world hold one, up to a day, and a monster
                    that comes back tomorrow inside a lair that fills every two
                    minutes is the one thing about the room worth knowing. */}
                {mob.regenHours !== undefined && mob.regenHours > 0 && (
                  <span className="chip quiet" title={t('cards.room.lair.mobRespawnHint')}>
                    {t('cards.room.lair.respawn', { clock: clockText(mob.regenHours * 3600) })}
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
