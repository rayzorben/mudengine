import { memo, useState } from 'react';

import Icon from './Icon';
import { dayAndTime } from '../lib/clock';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  goalIcon,
  goalText,
  lessonDetail,
  outcomeIcon,
  outcomeText,
  outcomeTone
} from '../lib/konami';
import type { KonamiSnapshot } from '@shared/konamiRecords';

export interface KonamiLessonsProps {
  konami: KonamiSnapshot;
  onForget(at: number): void;
}

/**
 * What past plans came to, newest first: the character as it was, the goal,
 * and how it ended. The ones still sent with each ask are marked, since only
 * those near the character's level are; any can be forgotten.
 */
function KonamiLessons({ konami, onForget }: KonamiLessonsProps) {
  const [onlyNow, setOnlyNow] = useState(true);
  const applying = konami.lessons.filter((lesson) => lesson.applies);
  const shown = onlyNow ? applying : konami.lessons;
  return (
    <>
      <div className="konami-lessons-head">
        <div className="konami-filter" role="group">
          <button
            aria-pressed={onlyNow}
            className="chip pick"
            onClick={() => setOnlyNow(true)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('cards.konami.lessonsNow', { count: applying.length })}
          </button>
          <button
            aria-pressed={!onlyNow}
            className="chip pick"
            onClick={() => setOnlyNow(false)}
            onMouseDown={keepFocus}
            type="button"
          >
            {t('cards.konami.lessonsAll', { count: konami.lessonsKept })}
          </button>
        </div>
        {konami.level !== null && (
          <span className="konami-hint">
            {t('cards.konami.lessonsApply', {
              count: applying.length,
              kept: konami.lessonsKept,
              band: konami.lessonLevels,
              level: konami.level
            })}
          </span>
        )}
      </div>
      <div className="scroller">
        {shown.length === 0 ? (
          <div className="empty">{t('cards.konami.emptyLessons')}</div>
        ) : (
          <ul className="konami-lessons">
            {shown.map((lesson) => (
              <li
                className="konami-lesson"
                data-applies={lesson.applies}
                data-tone={outcomeTone(lesson.outcome)}
                key={lesson.at}
              >
                <span className="konami-level-badge">
                  {lesson.level === null ? '?' : t('cards.konami.level', { level: lesson.level })}
                </span>
                <div className="konami-lesson-main">
                  <div className="konami-lesson-title">
                    <Icon name={goalIcon(lesson.goal)} />
                    <span className="konami-lesson-goal">{goalText(lesson.goal)}</span>
                    <span className={`chip ${outcomeTone(lesson.outcome)}`}>
                      <Icon name={outcomeIcon(lesson.outcome)} />
                      {outcomeText(lesson.outcome)}
                    </span>
                  </div>
                  <div className="konami-lesson-why">{lessonDetail(lesson)}</div>
                  <div className="konami-lesson-when">
                    <span>{dayAndTime(lesson.at)}</span>
                    {lesson.hpMax !== null && (
                      <span>
                        {t('cards.konami.lesson.stats', {
                          hp: lesson.hpMax,
                          ac: lesson.armourClass ?? '?'
                        })}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  aria-label={t('cards.konami.forget')}
                  className="quiet konami-forget"
                  onClick={() => onForget(lesson.at)}
                  onMouseDown={keepFocus}
                  title={t('cards.konami.forgetHint')}
                  type="button"
                >
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export default memo(KonamiLessons);
