/**
 * The six attributes as tiles, each figure over a hairline drawn to its place
 * in the range its race runs (`CharacterState.attributeSpans`), and tinted by
 * the same share (`--stat-share`), so no threshold is picked anywhere. From
 * large the range itself is written under the figure. An attribute with no
 * stated range is drawn plainly with no hairline; one not printed is a dash.
 */
import { memo, type CSSProperties } from 'react';

import type { AttributeSpans, Progress } from '@shared/character';
import { t } from '../lib/i18n';
import { figure } from '../lib/stats';

type Attribute = keyof AttributeSpans;

const ATTRIBUTES: ReadonlyArray<[Attribute, string]> = [
  ['strength', t('cards.self.labels.strength')],
  ['intellect', t('cards.self.labels.intellect')],
  ['willpower', t('cards.self.labels.willpower')],
  ['agility', t('cards.self.labels.agility')],
  ['health', t('cards.self.labels.health')],
  ['charm', t('cards.self.labels.charm')]
];

/** Where a figure sits between its race's floor and ceiling, or null with no range. */
function shareOf(value: number | null, span: [number, number] | undefined): number | null {
  return value === null || span === undefined || span[1] <= span[0]
    ? null
    : Math.min(1, Math.max(0, (value - span[0]) / (span[1] - span[0])));
}

function SelfAttributes({ progress, spans }: { progress: Progress; spans: AttributeSpans | null }) {
  return (
    <div aria-label={t('cards.self.groups.attributes')} className="self-attrs" role="group">
      {ATTRIBUTES.map(([id, label]) => {
        const value = progress[id];
        const span = spans?.[id];
        const share = shareOf(value, span);
        return (
          <div
            className="stat-cell"
            data-tone="accent"
            key={id}
            style={
              share === null
                ? undefined
                : ({ '--share': share, '--stat-share': share } as CSSProperties)
            }
            title={
              span === undefined
                ? undefined
                : t('cards.self.statRange', { low: span[0], high: span[1] })
            }
          >
            <em>{label}</em>
            <b className={value === null ? 'inert' : share !== null ? 'stat' : undefined}>
              {figure(value)}
            </b>
            {share !== null && <i />}
            {span !== undefined && (
              <small className="from-large">
                {t('cards.self.statRangeShort', { low: span[0], high: span[1] })}
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default memo(SelfAttributes);
