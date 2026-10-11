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
  hazardFor,
  type Corridor,
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

/** One chip per effect, so a room that both hurts and moves says both. */
export function hazardWords(hazard: SpellHazard, hpMax: number | null = null): HazardWord[] {
  const words: HazardWord[] = [];
  if (hazard.damage !== undefined) {
    const share = damageShare(hazard.damage, hpMax);
    words.push({
      text: t('cards.roomSpell.damage', { damage: hazard.damage }),
      loud: true,
      ...(share === null ? {} : { title: share })
    });
  }
  if (hazard.relocates === true) words.push({ text: t('cards.roomSpell.moves'), loud: true });
  if (hazard.summons === true) words.push({ text: t('cards.roomSpell.summons'), loud: false });
  // Unknown is said as itself, never as harmless.
  if (hazard.unread === true) words.push({ text: t('cards.route.hazardUnread'), loud: false });
  // Everything the realm states was gated away from this level.
  if (words.length === 0) words.push({ text: t('cards.roomSpell.notAtYourLevel'), loud: false });
  return words;
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
  if (stoppedBy !== undefined && stoppedBy.items.length > 0) {
    lines.push(
      `${t('cards.roomSpell.stoppedBy')}: ${stoppedBy.items.map((item) => item.name).join(', ')}`
    );
  }
  if (stoppedBy !== undefined && stoppedBy.spells.length > 0) {
    lines.push(
      `${t('cards.roomSpell.stoppedBySpell')}: ${stoppedBy.spells.map((ward) => ward.name).join(', ')}`
    );
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
      {stoppedBy !== undefined && stoppedBy.items.length > 0 && (
        <>
          <dt>{t('cards.roomSpell.stoppedBy')}</dt>
          <dd className="span">{stoppedBy.items.map((item) => item.name).join(', ')}</dd>
        </>
      )}
      {stoppedBy !== undefined && stoppedBy.spells.length > 0 && (
        <>
          <dt>{t('cards.roomSpell.stoppedBySpell')}</dt>
          <dd className="span">{stoppedBy.spells.map((ward) => ward.name).join(', ')}</dd>
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
