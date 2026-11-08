import { memo, useCallback, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { SessionId } from '@shared/ipc';
import type { DigStatus, DigView, TaskId, TaskView } from '@shared/tasks';

export interface AutomationsCardProps extends CardChrome {
  session: SessionId;
  tasks: readonly TaskView[];
}

/** The dig's state in words, and the chip's tone. */
function digStatus(status: DigStatus): { words: string; tone: 'on' | 'warn' | 'off' | 'info' } {
  switch (status) {
    case 'off':
      return { words: t('cards.automations.dig.status.off'), tone: 'off' };
    case 'counting':
      return { words: t('cards.automations.dig.status.counting'), tone: 'info' };
    case 'digging':
      return { words: t('cards.automations.dig.status.digging'), tone: 'on' };
    case 'fighting':
      return { words: t('cards.automations.dig.status.fighting'), tone: 'info' };
    case 'unfought':
      return { words: t('cards.automations.dig.status.unfought'), tone: 'warn' };
    case 'resting':
      return { words: t('cards.automations.dig.status.resting'), tone: 'info' };
    case 'climbing':
      return { words: t('cards.automations.dig.status.climbing'), tone: 'info' };
    case 'unswitched':
      return { words: t('cards.automations.dig.status.unswitched'), tone: 'warn' };
    case 'no-ground':
      return { words: t('cards.automations.dig.status.noGround'), tone: 'warn' };
    case 'done':
      return { words: t('cards.automations.dig.status.done'), tone: 'off' };
    case 'refused':
      return { words: t('cards.automations.dig.status.refused'), tone: 'warn' };
    default: {
      const never: never = status;
      return never;
    }
  }
}

/** One task's row: its name, where it stands, its switch and its figures. */
function TaskRow({ task, onSwitch }: { task: TaskView; onSwitch(id: TaskId, on: boolean): void }) {
  switch (task.id) {
    case 'treasure-dig':
      return <DigRow dig={task} onSwitch={onSwitch} />;
    default: {
      const never: never = task.id;
      return never;
    }
  }
}

function DigRow({ dig, onSwitch }: { dig: DigView; onSwitch(id: TaskId, on: boolean): void }) {
  const status = digStatus(dig.status);
  const unknown = t('cards.automations.unknown');
  return (
    <section className="task-row" data-task={dig.id}>
      <div className="task-head">
        <span className="task-name">{t('cards.automations.dig.name')}</span>
        <span className={`chip ${status.tone}`} data-status={dig.status}>
          {status.words}
        </span>
        <button
          aria-pressed={dig.on}
          className="chip pick task-switch"
          data-action="switch-task"
          onClick={() => onSwitch(dig.id, !dig.on)}
          onMouseDown={keepFocus}
          title={dig.on ? t('cards.automations.switchOff') : t('cards.automations.switchOn')}
          type="button"
        >
          {dig.on ? t('cards.automations.on') : t('cards.automations.off')}
        </button>
      </div>
      <p className="task-about">{t('cards.automations.dig.about')}</p>
      {dig.detail === null ? null : <p className="task-detail">{dig.detail}</p>}
      <div className="readout-box">
        <dl className="readout columns">
          <dt>{t('cards.automations.dig.spades')}</dt>
          <dd>{dig.spades === null ? unknown : dig.spades}</dd>
          <dt>{t('cards.automations.dig.dug')}</dt>
          <dd>{dig.dug}</dd>
          <dt>{t('cards.automations.dig.falls')}</dt>
          <dd>{dig.falls}</dd>
          <dt>{t('cards.automations.dig.finds')}</dt>
          <dd className="span">
            {dig.finds.length === 0 ? t('cards.automations.dig.noFinds') : dig.finds.join(', ')}
          </dd>
        </dl>
      </div>
    </section>
  );
}

/**
 * The automations a player switches on and off for this character (the
 * treasure dig, for now). A switch asks main, which turns the master switch on
 * if it was off and says why if it would not switch; the answer is drawn under
 * the rows until the next press.
 */
function AutomationsCard({ session, tasks, ...chrome }: AutomationsCardProps) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const onSwitch = useCallback(
    (id: TaskId, on: boolean) => {
      setRefusal(null);
      void window.mudengine.setTask(session, id, on).then(setRefusal);
    },
    [session]
  );
  return (
    <BentoCard {...chrome} className="automations-card" title={t('cards.automations.title')}>
      {tasks.map((task) => (
        <TaskRow key={task.id} onSwitch={onSwitch} task={task} />
      ))}
      {refusal === null ? null : (
        <p className="task-detail" role="status">
          {refusal}
        </p>
      )}
    </BentoCard>
  );
}

export default memo(AutomationsCard);
