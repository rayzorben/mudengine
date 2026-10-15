/**
 * When a running loop stops on its own, and when play asks before walking
 * back to one (todo 118): the exp rate floor and the minutes before it is
 * judged, the failed legs it gives up after, and how much further off the
 * character may be before play asks. The options page's alone, as `walk:` is.
 */
import ChoiceFields, { type ChoiceRow } from './ChoiceFields';
import { t } from '../lib/i18n';
import type { WalkConfig } from '@shared/config';
import { loopChoices, type LoopChoices } from '@shared/walkChoices';

export interface LoopFieldsProps {
  walk: WalkConfig;
  onChange(walk: WalkConfig): void;
}

function rows(): ReadonlyArray<ChoiceRow<keyof LoopChoices>> {
  return [
    {
      field: 'minExpPerHour',
      name: 'min-exp-rate',
      setting: 'automation.walk.minExpPerHour',
      label: t('settings.global.movement.minExpRateLabel'),
      hint: t('settings.global.movement.minExpRateHint')
    },
    {
      field: 'expRateGraceMinutes',
      name: 'exp-rate-grace',
      setting: 'automation.walk.expRateGraceMinutes',
      label: t('settings.global.movement.expRateGraceLabel'),
      hint: t('settings.global.movement.expRateGraceHint')
    },
    {
      field: 'failedLegs',
      name: 'failed-legs',
      setting: 'automation.walk.failedLegs',
      label: t('settings.global.movement.failedLegsLabel'),
      hint: t('settings.global.movement.failedLegsHint')
    },
    {
      field: 'resumeAskSteps',
      name: 'resume-ask',
      setting: 'automation.walk.resumeAskSteps',
      label: t('settings.global.movement.resumeAskLabel'),
      hint: t('settings.global.movement.resumeAskHint')
    }
  ];
}

export default function LoopFields({ walk, onChange }: LoopFieldsProps): React.JSX.Element {
  return (
    <ChoiceFields
      namePrefix="global-"
      onChange={(next) => onChange({ ...walk, ...next })}
      read={loopChoices}
      rows={rows()}
      values={walk}
    />
  );
}
