/**
 * The Automation card's head, over its trace: the queue and the refusals as
 * figures from medium, and on a large card what the sent commands were for (by
 * priority) and how the decisions went (acted, refused, held by a guard).
 * Counted off the snapshot the trace is drawn from. See `mudengine-ui` ›
 * `parts/cards.md`.
 */
import { memo, useMemo } from 'react';

import Kpi from './viz/Kpi';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import type { VizTone } from './viz/tones';
import { t } from '../lib/i18n';
import { PRIORITY, type AutomationSnapshot, type Priority } from '@shared/automation';

/** Each priority's colour, the gravest the warmest. */
const PRIORITY_TONE: Readonly<Record<Priority, VizTone>> = {
  emergency: 'bad',
  combat: 'warn',
  user: 'ok',
  movement: 'accent',
  probe: 'd',
  idle: 'quiet'
};

/** The priorities, highest first, as the queue ranks them. */
const PRIORITIES = (Object.keys(PRIORITY) as Priority[]).sort((a, b) => PRIORITY[b] - PRIORITY[a]);

function AutomationHead({ automation }: { automation: AutomationSnapshot }) {
  const { queue, sent, firings, safety, engagements } = automation;
  const drawn = useMemo(() => {
    const byPriority = new Map<Priority, number>();
    for (const entry of sent)
      byPriority.set(entry.priority, (byPriority.get(entry.priority) ?? 0) + 1);
    // Only the priorities that sent anything: six names under a bar of two is a legend of nothing.
    const purposes: SplitPart[] = PRIORITIES.filter((priority) => byPriority.has(priority)).map(
      (priority) => ({
        key: priority,
        label: priority,
        value: byPriority.get(priority) ?? 0,
        tone: PRIORITY_TONE[priority]
      })
    );
    const decided = [...safety, ...engagements];
    const acted = decided.filter((decision) => decision.acted).length;
    const refused = decided.length - acted;
    const blocked = firings.filter((firing) => firing.blockedBy !== undefined).length;
    const decisions: SplitPart[] = [
      {
        key: 'acted',
        label: t('cards.automation.head.acted'),
        value: acted + firings.length - blocked,
        tone: 'ok'
      },
      { key: 'refused', label: t('cards.automation.head.refused'), value: refused, tone: 'bad' },
      { key: 'blocked', label: t('cards.automation.head.blocked'), value: blocked, tone: 'quiet' }
    ];
    return { purposes, decisions, refused };
  }, [sent, firings, safety, engagements]);

  return (
    <div className="automation-head from-medium">
      <div className="kpis">
        <Kpi
          label={t('cards.automation.headings.queued')}
          tone={queue.suppressed ? 'warn' : undefined}
          value={queue.depth}
        />
        <Kpi label={t('cards.automation.head.inFlight')} value={queue.inFlight} />
        <Kpi
          label={t('cards.automation.head.refused')}
          tone={drawn.refused > 0 ? 'bad' : undefined}
          value={drawn.refused}
        />
      </div>
      <div className="automation-splits from-large">
        <section>
          <em>{t('cards.automation.head.purposes')}</em>
          <SplitBar parts={drawn.purposes} />
        </section>
        <section>
          <em>{t('cards.automation.head.decisions')}</em>
          <SplitBar parts={drawn.decisions} />
        </section>
      </div>
    </div>
  );
}

export default memo(AutomationHead);
