/**
 * What a gear plan could not do, as the notices that say so: the items the
 * pack no longer holds and the cap. One reading for the gear buttons and
 * `@equip-all`, so the two cannot report the same plan differently.
 */
import { canRestore, type GearPlan, type Loadout } from '../../shared/gear';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

/** Missing items and the cap, for any bulk plan. */
export function planNotices(plan: GearPlan): string[] {
  const said: string[] = [];
  if (plan.missing.length > 0) {
    said.push(
      t('automation.gear.missing', { count: plan.missing.length, items: plan.missing.join(', ') })
    );
  }
  if (plan.overflow > 0) {
    said.push(t('automation.gear.capped', { max: tuning().spending.maxGear, more: plan.overflow }));
  }
  return said;
}

/**
 * A `restorePlan`'s notices. With no slot recorded nothing is known to be on,
 * and that is said; a press that finds every recorded item already on says
 * so, since the button is lit whenever a slot is recorded (todo 18).
 */
export function restoreNotices(plan: GearPlan, loadout: Loadout): string[] {
  if (!canRestore(loadout)) return [t('automation.gear.noneRecorded')];
  const idle = plan.commands.length === 0 && plan.missing.length === 0;
  return idle ? [t('automation.gear.allOn')] : planNotices(plan);
}
