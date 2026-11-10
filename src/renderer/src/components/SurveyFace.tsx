/**
 * The Room card's `RM` face: what the server's `rm` printed about the room
 * the character stands in, row for row, in the server's words.
 *
 * Only MajorMUD Plus prints these rows (`src/shared/survey.ts`); the face is
 * offered only while a survey of this room is held (`surveyHere`).
 */
import { Fragment } from 'react';

import EntityName from './EntityName';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';
import type { RoomSurvey, SurveyGroup, SurveyLight, SurveyMob } from '@shared/survey';

export interface SurveyFaceProps {
  survey: RoomSurvey;
  /** Opens the realm's answer beside a clicked monster; absent, a name is text. */
  inspect?(name: string, anchor: HTMLElement): void;
}

/** A part of the light as the server signs it: `+75`, `-175`, `0`. */
function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function lightText(light: SurveyLight): string {
  return t('cards.room.survey.lightFigure', {
    seen: light.seen,
    phrase: light.phrase,
    ambient: light.ambient,
    own: signed(light.own),
    others: signed(light.others)
  });
}

function groupHead(group: SurveyGroup): string {
  return group.levels === null
    ? String(group.id)
    : t('cards.room.survey.groupLevels', {
        id: group.id,
        low: group.levels.low,
        high: group.levels.high
      });
}

function mobText(mob: SurveyMob): string {
  return mob.id === null
    ? mob.name
    : `${mob.name} ${t('cards.room.survey.number', { id: mob.id })}`;
}

function shopText(shop: RoomSurvey['shop']): string | null {
  if (shop === null) return null;
  return shop === 'none' ? t('cards.room.survey.none') : String(shop);
}

function flagsText(flags: string[]): string {
  return flags.length === 0 ? t('cards.room.survey.none') : flags.join(', ');
}

/** The rows the face draws, as `label: value` lines, for pasting. */
export function surveyCopyText(survey: RoomSurvey): string {
  const rows: Array<[string, string | null]> = [
    [t('cards.room.survey.location'), `${survey.map},${survey.room}`],
    [t('cards.room.survey.light'), survey.light === null ? null : lightText(survey.light)],
    [
      t('cards.room.survey.spawn'),
      survey.spawn === null ? null : `${survey.spawn.present}/${survey.spawn.max}`
    ],
    [
      t('cards.room.survey.group'),
      survey.group === null
        ? null
        : [groupHead(survey.group), survey.group.mobs.join(', ')].filter(Boolean).join(': ')
    ],
    [
      t('cards.room.survey.lair'),
      survey.lair === null ? null : survey.lair.map(mobText).join(', ')
    ],
    [
      t('cards.room.survey.type'),
      survey.type === null ? null : `${survey.type.name} [${survey.type.glyph}]`
    ],
    [t('cards.room.survey.flags'), survey.flags === null ? null : flagsText(survey.flags)],
    [t('cards.room.survey.shop'), shopText(survey.shop)],
    [t('cards.room.survey.trap'), survey.trap]
  ];
  return rows
    .filter((row): row is [string, string] => row[1] !== null)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

/** Monster names the realm can be asked about, comma-separated, each with its number where printed. */
function Names({
  mobs,
  inspect
}: {
  mobs: readonly SurveyMob[];
  inspect?: SurveyFaceProps['inspect'];
}) {
  return (
    <>
      {mobs.map((mob, index) => (
        <Fragment key={`${mob.name}-${index}`}>
          {index > 0 && ', '}
          <EntityName inspect={inspect} name={mob.name} />
          {mob.id !== null && (
            <span className="quiet"> {t('cards.room.survey.number', { id: mob.id })}</span>
          )}
        </Fragment>
      ))}
    </>
  );
}

export default function SurveyFace({ survey, inspect }: SurveyFaceProps) {
  const { light, spawn, group, lair, type, flags, trap } = survey;
  const shop = shopText(survey.shop);
  return (
    <dl className="readout">
      <dt>{t('cards.room.survey.location')}</dt>
      <dd>{`${survey.map},${survey.room}`}</dd>
      {/* `Spawn:` moves while nobody asks, so the answer says how old it is. */}
      <dt>{t('cards.room.survey.asked')}</dt>
      <dd>{ago(survey.at, Date.now())}</dd>
      {light !== null && (
        <>
          <dt>{t('cards.room.survey.light')}</dt>
          <dd>{lightText(light)}</dd>
        </>
      )}
      {spawn !== null && (
        <>
          <dt>{t('cards.room.survey.spawn')}</dt>
          <dd>{`${spawn.present}/${spawn.max}`}</dd>
        </>
      )}
      {group !== null && (
        <>
          <dt>{t('cards.room.survey.group')}</dt>
          <dd>
            {groupHead(group)}
            {group.mobs.length > 0 && (
              <>
                {': '}
                <Names inspect={inspect} mobs={group.mobs.map((name) => ({ name, id: null }))} />
              </>
            )}
            {group.shown !== null && (
              <span className="quiet"> {t('cards.room.survey.shown', { shown: group.shown })}</span>
            )}
          </dd>
        </>
      )}
      {lair !== null && (
        <>
          <dt>{t('cards.room.survey.lair')}</dt>
          <dd>
            <Names inspect={inspect} mobs={lair} />
          </dd>
        </>
      )}
      {type !== null && (
        <>
          <dt>{t('cards.room.survey.type')}</dt>
          <dd>{`${type.name} [${type.glyph}]`}</dd>
        </>
      )}
      {flags !== null && (
        <>
          <dt>{t('cards.room.survey.flags')}</dt>
          <dd>{flagsText(flags)}</dd>
        </>
      )}
      {shop !== null && (
        <>
          <dt>{t('cards.room.survey.shop')}</dt>
          <dd>{shop}</dd>
        </>
      )}
      {trap !== null && (
        <>
          <dt>{t('cards.room.survey.trap')}</dt>
          <dd>{trap}</dd>
        </>
      )}
    </dl>
  );
}
