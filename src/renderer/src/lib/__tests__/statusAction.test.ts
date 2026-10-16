import { describe, expect, it } from 'vitest';

import { statusAction } from '../statusAction';
import { t } from '../i18n';
import { IDLE_WALK, type WalkProgress } from '@shared/walk';

const queue = { depth: 0, pending: [] } as never;
const walking = (pace: WalkProgress['pace']): WalkProgress => ({
  ...IDLE_WALK,
  status: 'walking',
  done: 1,
  total: 4,
  pace
});

// Todo 129: the status rail says running for a walk with auto-combat off.
describe('the status rail line', () => {
  it('says walking or running by the walk’s pace', () => {
    expect(statusAction(walking('walking'), queue)).toBe(
      t('statusRail.action.walking', { done: 1, total: 4 })
    );
    expect(statusAction(walking('running'), queue)).toBe(
      t('statusRail.action.running', { done: 1, total: 4 })
    );
  });

  it('says nothing with nothing walking or queued', () => {
    expect(statusAction(IDLE_WALK, queue)).toBeNull();
  });
});
