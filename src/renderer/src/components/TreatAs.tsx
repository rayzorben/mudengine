import { useState } from 'react';

import Icon, { type IconName } from './Icon';
import PopupMenu, { type MenuItem } from './PopupMenu';
import type { MenuAnchor } from './Popup';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { TREATMENT_WORD } from '../lib/mobRuleWords';
import { MOB_TREATMENTS, type MobTreatment } from '@shared/mobRules';

/** Each treatment's glyph in the menu; a `Record`, so a new treatment must be drawn. */
const TREATMENT_ICON: Record<MobTreatment, IconName> = {
  never: 'shield',
  friend: 'heart',
  escape: 'run',
  hangup: 'unplug',
  first: 'sword',
  high: 'sword',
  default: 'sword',
  low: 'sword',
  last: 'sword'
};

/**
 * *Treat this monster as…* beside its name on the Combat card (todo 817): one
 * press writes its row into the character's realm list, which wins over the
 * options file's and MegaMUD's; the last entry takes the realm's row out so
 * the broader lists hold again. The settings screen shows the same row.
 */
export default function TreatAs({
  name,
  onTreat
}: {
  name: string;
  onTreat(name: string, treat: MobTreatment | null): void;
}): React.JSX.Element {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const choose = (treat: MobTreatment | null) => () => {
    setMenu(null);
    onTreat(name, treat);
  };
  const items: MenuItem[] = [
    ...MOB_TREATMENTS.map((treat) => ({
      label: TREATMENT_WORD[treat](),
      icon: TREATMENT_ICON[treat],
      run: choose(treat)
    })),
    { label: t('cards.combat.treatAsClear'), icon: 'undo', divided: true, run: choose(null) }
  ];
  return (
    <>
      <button
        aria-label={t('cards.combat.treatAsAria', { target: name })}
        className="quiet treat-as"
        onClick={(event) => setMenu(event.currentTarget)}
        onMouseDown={keepFocus}
        title={t('cards.combat.treatAsTitle', { target: name })}
        type="button"
      >
        <Icon name="flag" />
      </button>
      {menu !== null && <PopupMenu at={menu} items={items} onDismiss={() => setMenu(null)} />}
    </>
  );
}
