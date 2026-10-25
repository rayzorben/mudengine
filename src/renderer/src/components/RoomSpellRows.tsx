/**
 * The spell a room casts on whoever stands in it, what it does and what stops
 * it: rows for a `.readout`, drawn on the Room card and on the room peek, so
 * the room the character is in and a room on the map are described alike
 * (todo 72). The hazard is narrowed to the reader's level by the caller, at
 * the one join (`hazardFor`). See `LairList` for the same two-surface rule.
 */
import EntityNumber from './EntityNumber';
import { corridorTitle } from '../lib/corridor';
import { healthShareWords } from '../lib/healthShare';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  hazardEffects,
  hazardFor,
  stopperEffects,
  type Corridor,
  type HazardEffect,
  type HazardStopper,
  type SpellHazard,
  type SpellStoppers,
  type WorldSpell
} from '@shared/world';

export interface RoomSpellRowsProps {
  /** Null in a passage whose own rooms cast nothing. */
  spell: WorldSpell | null;
  /** What it does to this reader, or undefined where it does nothing the realm states. */
  hazard: SpellHazard | undefined;
  stoppedBy: SpellStoppers | undefined;
  /** The timed passage the room is inside, where it is one. */
  passage?: Corridor | null;
  /** The reader's maximum health, for the damage's share; null or absent is unknown. */
  hpMax?: number | null;
  /** Opens the spell's Reference entry; absent where nothing can open one. */
  inspect?(name: string, anchor: HTMLElement): void;
}

/**
 * A room spell's hazard narrowed to a level, for the room the character is in;
 * the peek's arrives narrowed from `WorldGraph.hazardOf`. Null level keeps it whole.
 */
export function hazardAtLevel(
  spell: WorldSpell | null | undefined,
  level: number | null
): SpellHazard | undefined {
  return spell?.hazard === undefined ? undefined : hazardFor(spell.hazard, level);
}

/**
 * The damage as a share of the reader's maximum health, worded as the route
 * panel words it. Null while the maximum is unknown, so the bare figure stands.
 */
export function damageShare(damage: number, hpMax: number | null): string | null {
  return hpMax === null || hpMax <= 0 ? null : healthShareWords(damage / hpMax);
}

export interface HazardWord {
  text: string;
  loud: boolean;
  title?: string;
}

/** The chip for one effect the hazard has. */
function effectWord(hazard: SpellHazard, effect: HazardEffect, hpMax: number | null): HazardWord {
  switch (effect) {
    case 'damage': {
      const share = damageShare(hazard.damage ?? 0, hpMax);
      return {
        text: t('cards.roomSpell.damage', { damage: hazard.damage ?? 0 }),
        loud: true,
        ...(share === null ? {} : { title: share })
      };
    }
    case 'relocates':
      return { text: t('cards.roomSpell.moves'), loud: true };
    case 'summons':
      return { text: t('cards.roomSpell.summons'), loud: false };
    // Unknown is said as itself, never as harmless.
    case 'unread':
      return { text: t('cards.route.hazardUnread'), loud: false };
    default: {
      const never: never = effect;
      return never;
    }
  }
}

/** One chip per effect, so a room that both hurts and moves says both. */
export function hazardWords(hazard: SpellHazard, hpMax: number | null = null): HazardWord[] {
  const words = hazardEffects(hazard).map((effect) => effectWord(hazard, effect, hpMax));
  // Everything the realm states was gated away from this level.
  if (words.length === 0) words.push({ text: t('cards.roomSpell.notAtYourLevel'), loud: false });
  return words;
}

/** The named stoppers as they stand for this hazard: those that stop it whole, and the rest each with what it takes off. */
export interface StoppersShown {
  items: string[];
  spells: string[];
  part: string[];
}

/**
 * Sorts what the realm names against the hazard as the reader meets it:
 * desert spell 2's sunstone wristband takes its teleports off above level 19 and
 * leaves the summons, so it is said as stopping part of it.
 */
export function stoppersShown(
  hazard: SpellHazard | undefined,
  stoppedBy: SpellStoppers | undefined
): StoppersShown {
  const shown: StoppersShown = { items: [], spells: [], part: [] };
  if (hazard === undefined || stoppedBy === undefined) return shown;
  const has = hazardEffects(hazard).length;
  const sort = (side: HazardStopper, named: SpellStoppers['items'], whole: string[]): void => {
    for (const { id, name } of named) {
      const effects = stopperEffects(hazard, side, id);
      if (effects.length === 0) continue;
      if (effects.length === has) whole.push(name);
      else {
        const effectList = effects
          .map((effect) => effectWord(hazard, effect, null).text)
          .join(', ');
        shown.part.push(t('cards.roomSpell.stopsPartValue', { stopperName: name, effectList }));
      }
    }
  };
  sort('fails', stoppedBy.items, shown.items);
  sort('wards', stoppedBy.spells, shown.spells);
  return shown;
}

/** The same rows as text, one line per row drawn, for a card's copy. */
export function roomSpellCopyLines({
  spell,
  hazard,
  stoppedBy,
  passage
}: Pick<RoomSpellRowsProps, 'spell' | 'hazard' | 'stoppedBy' | 'passage'>): string[] {
  const lines: string[] = [];
  if (spell !== null) {
    const effects = hazard === undefined ? [] : hazardWords(hazard).map((word) => word.text);
    lines.push(`${t('cards.roomSpell.label')}: ${[spell.name, ...effects].join(', ')}`);
  }
  const shown = stoppersShown(hazard, stoppedBy);
  if (shown.items.length > 0) {
    lines.push(`${t('cards.roomSpell.stoppedBy')}: ${shown.items.join(', ')}`);
  }
  if (shown.spells.length > 0) {
    lines.push(`${t('cards.roomSpell.stoppedBySpell')}: ${shown.spells.join(', ')}`);
  }
  if (shown.part.length > 0) {
    lines.push(`${t('cards.roomSpell.stopsPart')}: ${shown.part.join('; ')}`);
  }
  if (passage !== undefined && passage !== null) {
    lines.push(`${t('cards.roomSpell.passage')}: ${passageValue(passage)}`);
  }
  return lines;
}

function passageValue(passage: Corridor): string {
  return t('cards.roomSpell.passageValue', { spellName: passage.name, roomCount: passage.rooms });
}

export default function RoomSpellRows({
  spell,
  hazard,
  stoppedBy,
  passage,
  hpMax,
  inspect
}: RoomSpellRowsProps) {
  const shown = stoppersShown(hazard, stoppedBy);
  return (
    <>
      {spell !== null && (
        <>
          <dt title={t('cards.roomSpell.labelTitle')}>{t('cards.roomSpell.label')}</dt>
          <dd className="span">
            {inspect ? (
              <button
                className="lookup"
                onClick={(event) => inspect(spell.name, event.currentTarget)}
                onMouseDown={keepFocus}
                title={t('cards.roomSpell.lookupTooltip')}
                type="button"
              >
                {spell.name}
              </button>
            ) : (
              spell.name
            )}
            {/* Where it came from: the realm's own Spells row. */}
            <EntityNumber of={{ id: spell.id }} />
            {hazard !== undefined &&
              hazardWords(hazard, hpMax ?? null).map((word) => (
                <span
                  className={`chip ${word.loud ? 'bad' : 'warn'}`}
                  key={word.text}
                  title={word.title}
                >
                  {word.text}
                </span>
              ))}
          </dd>
        </>
      )}
      {shown.items.length > 0 && (
        <>
          <dt>{t('cards.roomSpell.stoppedBy')}</dt>
          <dd className="span">{shown.items.join(', ')}</dd>
        </>
      )}
      {shown.spells.length > 0 && (
        <>
          <dt>{t('cards.roomSpell.stoppedBySpell')}</dt>
          <dd className="span">{shown.spells.join(', ')}</dd>
        </>
      )}
      {shown.part.length > 0 && (
        <>
          <dt>{t('cards.roomSpell.stopsPart')}</dt>
          <dd className="span">{shown.part.join('; ')}</dd>
        </>
      )}
      {passage !== undefined && passage !== null && (
        <>
          <dt>{t('cards.roomSpell.passage')}</dt>
          <dd className="span" title={corridorTitle(passage)}>
            {passageValue(passage)}
          </dd>
        </>
      )}
    </>
  );
}
