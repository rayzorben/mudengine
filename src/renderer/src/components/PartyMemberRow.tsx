/**
 * One member of the party as the Party card draws them (the user, 2026-11-01):
 * the name and class in columns the whole card shares, what they are fighting
 * as pills on the same line, then a thin health bar and mana bar, each with a
 * pill in its middle holding the figure; the health pill also carries the
 * listing's flag. See `mudengine-ui` › `parts/cards.md` › *The Party card*.
 */
import { memo } from 'react';

import EntityName, { type Inspect } from './EntityName';
import Icon from './Icon';
import {
  vitalLevel,
  type PartyActivity,
  type PartyMember,
  type VitalLevel
} from '@shared/character';
import type { VitalsUiConfig } from '@shared/config';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { levelWord, meterValue } from '../lib/vitals';

export interface PartyMemberRowProps {
  member: PartyMember;
  /** The listing's class, else the player record's. */
  className: string | null;
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
  /** A class or a monster clicked: the realm's answer, beside it. */
  inspect?: Inspect;
  ask?(command: string): void;
}

/**
 * What the listing's flag says, in the server's words where it has said them.
 * An unrecognised letter is drawn as the letter, because expanding it would
 * put a condition on the card the server never stated (`PartyActivity`).
 */
function activityWord(activity: PartyActivity): string {
  return activity.state === 'unknown' ? activity.flag : activity.state;
}

/**
 * A thin bar with a pill in its middle holding the figure, and on the health
 * bar the member's flag. The level is the hue and, for a reader or a hover,
 * the word (`levelWord`); the badge counts who is critical.
 */
function Bar({
  label,
  fraction,
  current,
  max,
  level,
  tone,
  activity
}: {
  label: string;
  fraction: number | null;
  current: number | null;
  max: number | null;
  level: VitalLevel;
  /** The pool, as the smoke and the stylesheet read it (`.party-meter.hp`). */
  tone: 'hp' | 'mana' | 'kai';
  activity: PartyActivity | null;
}) {
  const figure = meterValue(fraction, current, max);
  const said = [label, figure, levelWord(level), activity && activityWord(activity)]
    .filter((part) => part !== null && part !== '')
    .join(' ');
  return (
    <span
      aria-label={said}
      className={`party-meter ${tone === 'kai' ? 'mana kai' : tone}`}
      data-level={level}
      role="img"
      title={said}
    >
      <span className="party-bar">
        <span style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </span>
      <span className="party-meter-value" data-state={activity?.state}>
        <span className="party-meter-figure">{figure}</span>
        {activity !== null && (
          <span className="party-activity" data-state={activity.state}>
            {activityWord(activity)}
          </span>
        )}
      </span>
    </span>
  );
}

function PartyMemberRow({
  member,
  className,
  thresholds,
  head,
  self,
  person,
  selected,
  fighting,
  hitBy,
  onSelect,
  inspect,
  ask
}: PartyMemberRowProps) {
  const hpLevel = vitalLevel(member.health, 1, thresholds.hp);
  const vitals = member.vitals;
  return (
    <li
      className="party-member"
      data-hurt={hpLevel === 'critical' ? 'true' : undefined}
      data-invited={member.invited ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
    >
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
      <span className="party-class">
        {className !== null && <EntityName inspect={inspect} name={className} />}
      </span>
      <span className="party-fight">
        {/* The fact `assistLeader` acts on, and the monster a heal or a
            defence is for, while each sighting is fresh. */}
        {fighting !== null && (
          <span className="party-pill party-fighting" title={fighting}>
            <Icon name="sword" />
            <EntityName inspect={inspect} name={fighting} />
          </span>
        )}
        {hitBy !== null && (
          <span className="party-pill party-hit-by" title={hitBy}>
            <Icon name="shield" />
            <EntityName inspect={inspect} name={hitBy} />
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
      </span>
      {/* A member the announcements added has no numbers until the next
          listing, and empty tracks would read as resources at zero. An
          invited member has none either; the heading above says why. */}
      {member.invited ? null : member.health === null ? (
        <span className="hint party-unlisted">{t('cards.party.notYetListed')}</span>
      ) : (
        <div className="party-meters">
          <Bar
            activity={member.activity}
            current={vitals?.hp ?? null}
            fraction={member.health}
            label={t('cards.party.bar.hp')}
            level={hpLevel}
            max={vitals?.hpMax ?? null}
            tone="hp"
          />
          {/* No mana track for a class that has none: the listing omits the
              column, and an empty one would imply a resource that does not exist. */}
          {member.mana !== null && (
            <Bar
              activity={null}
              current={vitals?.mana ?? null}
              fraction={member.mana}
              label={member.pool === 'KAI' ? t('cards.party.bar.kai') : t('cards.party.bar.mana')}
              level={vitalLevel(member.mana, 1, thresholds.mana)}
              max={vitals?.manaMax ?? null}
              tone={member.pool === 'KAI' ? 'kai' : 'mana'}
            />
          )}
        </div>
      )}
    </li>
  );
}

export default memo(PartyMemberRow);
