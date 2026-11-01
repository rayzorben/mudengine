/**
 * One member of the party as the Party card draws them: a ring of their health
 * and mana around their initial, then as much of who they are and what they
 * are doing as the card's drawing (`fit`) has room for. `PartyCard` decides
 * the drawing by measurement; this decides only what each drawing shows. See
 * `mudengine-ui` › `parts/cards.md` › *The Party card*.
 */
import { memo, type CSSProperties } from 'react';

import Icon from './Icon';
import Ring from './viz/Ring';
import type { VizTone } from './viz/tones';
import {
  vitalLevel,
  type MemberSheet,
  type PartyActivity,
  type PartyMember
} from '@shared/character';
import type { VitalsUiConfig } from '@shared/config';
import { TRAINED_ATTRIBUTES, type TrainedAttribute } from '@shared/training';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { levelWord, meterValue } from '../lib/vitals';

/** The drawings a row can take, fullest first (`useFitTier` on the card). */
export const PARTY_FITS = ['full', 'detail', 'brief', 'compact'] as const;
export type PartyFit = (typeof PARTY_FITS)[number];

/** A sheet figure the stat line draws: the six, Traps and Picklocks. */
export type SheetFigure = TrainedAttribute | 'traps' | 'picklocks';
export const SHEET_FIGURES: readonly SheetFigure[] = [...TRAINED_ATTRIBUTES, 'traps', 'picklocks'];

/** The party's highest of each figure and who holds it: the scale each member's is drawn against. */
export type PartyBest = Readonly<Partial<Record<SheetFigure, { name: string; value: number }>>>;

/** Who a member is, beyond the listing's name and class. */
export interface Who {
  race: string | null;
  className: string | null;
  level: number | null;
}

/** Who as scalars, so a memoised row holds between equal pushes. */
export interface PartyMemberRowProps extends Who {
  member: PartyMember;
  fit: PartyFit;
  best: PartyBest;
  thresholds: VitalsUiConfig;
  /** Whether this is whoever the party follows. */
  head: boolean;
  /** This character's own row: its name is text, and it has no Follow. */
  self: boolean;
  /** Whether the name opens the Player flyout. */
  person: boolean;
  selected: boolean;
  /** What they were last seen fighting, and what was last seen hitting them, while fresh. */
  fighting: string | null;
  hitBy: string | null;
  onSelect?(name: string, anchor: PopoverAnchor): void;
  ask?(command: string): void;
}

const STAT_LABELS: Readonly<Record<SheetFigure, string>> = {
  strength: t('cards.party.stat.strength'),
  intellect: t('cards.party.stat.intellect'),
  willpower: t('cards.party.stat.willpower'),
  agility: t('cards.party.stat.agility'),
  health: t('cards.party.stat.health'),
  charm: t('cards.party.stat.charm'),
  traps: t('cards.party.stat.traps'),
  picklocks: t('cards.party.stat.picklocks')
};

/**
 * What the roster's flag says, in the server's words where it has said them.
 * An unrecognised letter is drawn as the letter, because expanding it would
 * put a condition on the card the server never stated (`PartyActivity`).
 */
function activityWord(activity: PartyActivity): string {
  return activity.state === 'unknown' ? activity.flag : activity.state;
}

/**
 * A fraction against a track, with the number and the level in words beside
 * it. The roster gives percentages and no absolutes; the maximum, once this
 * member's client has answered `@health`, goes beside the percentage
 * (`meterValue` says why not the pair). A null fraction is an empty track.
 */
function Bar({
  label,
  fraction,
  max,
  thresholds,
  tone
}: {
  label: string;
  fraction: number | null;
  max: number | null;
  thresholds: VitalsUiConfig['hp'];
  tone: string;
}) {
  const level = vitalLevel(fraction, 1, thresholds);
  const word = levelWord(level);
  return (
    <span className={`party-meter ${tone}`} data-level={level}>
      <span className="party-meter-label">{label}</span>
      <span className="party-bar">
        <span style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </span>
      <span className="party-meter-value">
        <span className="party-meter-full">
          {meterValue(fraction, max)}
          {word === null ? '' : ` ${word}`}
        </span>
        {/* The narrowest one-line drawing has room for the percentage alone. */}
        <span className="party-meter-short">{meterValue(fraction, null)}</span>
      </span>
    </span>
  );
}

/**
 * A member's six stats, Traps and Picklocks off their `@stats` answer (todo
 * 86), each over a hairline drawn against the party's best, so who is the
 * party's strongest or its best hand at a lock reads without comparing
 * numbers. A MegaMUD member never answers `@stats`, and the row says so once.
 */
function StatLine({ sheet, best }: { sheet: MemberSheet | null; best: PartyBest }) {
  if (sheet === null) return <span className="party-stats none">{t('cards.party.noSheet')}</span>;
  return (
    <span className="party-stats" title={t('cards.party.statScale')}>
      {SHEET_FIGURES.map((figure) => {
        const value = sheet[figure];
        const top = best[figure]?.value;
        return (
          <span
            className="stat-cell"
            data-best={value !== null && value === top ? 'true' : undefined}
            key={figure}
            style={{ '--share': value === null || !top ? 0 : value / top } as CSSProperties}
          >
            <em>{STAT_LABELS[figure]}</em>
            <b>{value ?? t('cards.party.sheetUnknown')}</b>
            {value !== null && <i />}
          </span>
        );
      })}
    </span>
  );
}

function PartyMemberRow({
  member,
  race: listedRace,
  className,
  level,
  fit,
  best,
  thresholds,
  head,
  self,
  person,
  selected,
  fighting,
  hitBy,
  onSelect,
  ask
}: PartyMemberRowProps) {
  const hpLevel = vitalLevel(member.health, 1, thresholds.hp);
  const manaTone: VizTone = member.pool === 'KAI' ? 'kai' : 'mana';
  const listed = !member.invited && member.health !== null;
  const ringLabel = listed
    ? t('cards.party.ringAria', { name: member.name, value: meterValue(member.health, null) })
    : undefined;
  const race = member.invited ? null : (listedRace ?? t('cards.party.raceUnknown'));

  return (
    <li
      className="party-member"
      data-hurt={hpLevel === 'critical' ? 'true' : undefined}
      data-invited={member.invited ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
    >
      <Ring
        arcs={[
          { fraction: listed ? member.health : null, tone: 'hp', level: hpLevel },
          ...(member.mana === null || member.invited
            ? []
            : [
                {
                  fraction: member.mana,
                  tone: manaTone,
                  level: vitalLevel(member.mana, 1, thresholds.mana)
                }
              ])
        ]}
        label={ringLabel}
      >
        {member.name.slice(0, 1).toUpperCase()}
      </Ring>
      <div className="party-member-main">
        <div className="party-who">
          {/* A member the registry or roster knows is a person, and their name
              opens their card, as on the Realm and Players listings. This
              character's own row stays text: its numbers are on Vitals. */}
          <span className="party-name" data-leader={head}>
            {onSelect && person ? (
              <PlayerName className="name" name={member.name} onSelect={onSelect} self={self} />
            ) : (
              member.name
            )}
          </span>
          {member.activity !== null && (
            <span className="party-activity" data-state={member.activity.state}>
              {member.activity.state === 'resting' && <Icon name="bed" />}
              {member.activity.state === 'meditating' && <Icon name="moon" />}
              <span className="party-activity-word">{activityWord(member.activity)}</span>
            </span>
          )}
          {/* `follow <name>` is how a leader is made on this realm; there is no
              verb for the other direction, so there is no other button. */}
          {ask && !member.invited && !self && !head && (
            <button
              aria-label={t('cards.party.followAria', { name: member.name })}
              className="quiet party-follow"
              onClick={() => ask(`follow ${member.name}`)}
              onMouseDown={keepFocus}
              title={t('cards.party.followAria', { name: member.name })}
              type="button"
            >
              <Icon name="users" />
            </button>
          )}
        </div>
        {(race !== null || className !== null || level !== null) && (
          <span className="party-what">
            {race !== null && <span className="party-race">{race}</span>}
            {className !== null && <span className="party-class">{className}</span>}
            {level !== null && (
              <span className="party-level">{t('cards.party.level', { level })}</span>
            )}
          </span>
        )}
        {/* The fact `assistLeader` acts on, and the monster a heal or a defence
            is for, while each sighting is fresh. */}
        {(fighting !== null || hitBy !== null) && (
          <span className="party-fight">
            {fighting !== null && (
              <span className="chip quiet party-fighting" title={fighting}>
                <Icon name="sword" />
                <span>{fighting}</span>
              </span>
            )}
            {hitBy !== null && (
              <span className="chip bad party-hit-by" title={hitBy}>
                <Icon name="shield" />
                <span>{hitBy}</span>
              </span>
            )}
          </span>
        )}
        {/* A member the announcements added has no numbers until the next
            listing, and empty tracks would read as resources at zero. An
            invited member has none either; the heading above says why. */}
        {member.invited ? null : member.health === null ? (
          <span className="hint party-unlisted">{t('cards.party.notYetListed')}</span>
        ) : (
          <div className="party-meters">
            <Bar
              fraction={member.health}
              label={t('cards.party.bar.hp')}
              max={member.vitals?.hpMax ?? null}
              thresholds={thresholds.hp}
              tone="hp"
            />
            {/* No mana track for a class that has none: the roster omits the
                column, and an empty one would imply a resource that does not exist. */}
            {member.mana !== null && (
              <Bar
                fraction={member.mana}
                label={member.pool === 'KAI' ? t('cards.party.bar.kai') : t('cards.party.bar.mana')}
                max={member.vitals?.manaMax ?? null}
                thresholds={thresholds.mana}
                tone={member.pool === 'KAI' ? 'mana kai' : 'mana'}
              />
            )}
          </div>
        )}
        {fit === 'full' && !member.invited && <StatLine best={best} sheet={member.sheet} />}
      </div>
    </li>
  );
}

export default memo(PartyMemberRow);
