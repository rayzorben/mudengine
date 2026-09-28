import { CheckField } from './FormField';
import RemoteList from './RemoteList';

import { t } from '../lib/i18n';
import { ACTIONABLE_REMOTES, type RemoteName } from '@shared/remotes';

/**
 * What `automation.remotes` asks once the switch is on: the gangpath, joining
 * when invited, and the gang's list. The character page and the Global page
 * draw the same controls, so they are drawn here once; each page maps them
 * onto its own draft.
 */
export interface RemoteSwitchesProps {
  /** Prefix for each control's `name`, so the two pages' fields stay distinct. */
  name: string;
  gangpath: boolean;
  autoJoin: boolean;
  gang: readonly RemoteName[];
  onGangpath(value: boolean): void;
  onAutoJoin(value: boolean): void;
  onGang(value: RemoteName[]): void;
}

export default function RemoteSwitches(props: RemoteSwitchesProps) {
  const { gang, onGang } = props;
  return (
    <>
      <CheckField
        checked={props.gangpath}
        hint={t('settings.remotes.gangpathHint')}
        label={t('settings.remotes.gangpathLabel')}
        name={`${props.name}-gangpath`}
        onChange={props.onGangpath}
      />
      <CheckField
        checked={props.autoJoin}
        hint={t('settings.remotes.autoJoinHint')}
        label={t('settings.remotes.autoJoinLabel')}
        name={`${props.name}-auto-join`}
        onChange={props.onAutoJoin}
      />
      {/*
        Nothing on the wire establishes who shares a gang on its own: a
        gangpath does not prove it, and this character's own outgoing one
        comes back naming itself. Said where the grant is made, not only when
        it silently fails to allow somebody.
      */}
      <p className="settings-warn">{t('settings.remotes.gangWarning')}</p>
      <h4 className="settings-subhead">{t('settings.remotes.gangLegend')}</h4>
      {/*
        The same grid the Gang card draws, through the same component: a
        permission that read one way on a card and another in Settings is one
        somebody sets in whichever place happens to be wrong.
      */}
      <RemoteList
        allow={gang}
        mode="gang"
        onSet={(remote, stance) =>
          onGang(stance === 'allow' ? [...gang, remote] : gang.filter((entry) => entry !== remote))
        }
        onSetAll={(stance) => onGang(stance === 'allow' ? [...ACTIONABLE_REMOTES] : [])}
        subject={t('settings.remotes.gangLegend')}
      />
    </>
  );
}
