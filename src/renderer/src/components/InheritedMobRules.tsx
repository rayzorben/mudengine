import { useEffect, useState } from 'react';

import { TextField } from './FormField';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { SOURCE_WORD, TREATMENT_WORD } from '../lib/mobRuleWords';
import {
  inheritedRows,
  MOB_RULES_MOST,
  type MobRule,
  type MobRuleLayer,
  type MobRuleScope
} from '@shared/mobRules';
import { errorMessage } from '@shared/values';

/** The most matches drawn at once: MegaMUD's table alone is hundreds of rows. */
const SHOWN = 40;

/**
 * The monster rows beneath a form's own list (todo 817): MegaMUD's table,
 * the options file's and the realm's, one per monster, the narrowest holding,
 * each with where it comes from. Override copies a row into the list above,
 * where it is edited like any other and wins. Read off what is saved, like
 * the realm page's world note, so a broader list edited elsewhere shows once
 * saved.
 */
export default function InheritedMobRules({
  scope,
  realm,
  own,
  namePrefix,
  onOverride
}: {
  scope: MobRuleScope;
  /** The realm whose list sits beneath a character's; ignored elsewhere. */
  realm: string;
  own: readonly MobRule[];
  namePrefix: string;
  onOverride(row: MobRule): void;
}): React.JSX.Element {
  const [layers, setLayers] = useState<MobRuleLayer[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let current = true;
    setProblem(null);
    window.mudengine
      .inheritedMobRules(scope, realm)
      .then((found) => {
        if (current) setLayers(found);
      })
      .catch((error: unknown) => {
        if (current) setProblem(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, [scope, realm]);

  if (problem !== null) return <p className="settings-warn">{problem}</p>;
  if (layers === null)
    return <p className="quiet-note">{t('settings.combat.mobRuleInheritedLoading')}</p>;

  const rows = inheritedRows(layers, own);
  if (rows.length === 0)
    return <p className="quiet-note">{t('settings.combat.mobRuleInheritedNone')}</p>;
  // A list is read back at most this long, so a row copied past it would be lost on the next read.
  const full = own.length >= MOB_RULES_MOST;
  const wanted = query.trim().toLowerCase();
  const matches = wanted.length === 0 ? rows : rows.filter(({ row }) => row.mob.includes(wanted));

  return (
    <div className="mob-rules-inherited">
      <p className="settings-note">
        {t('settings.combat.mobRuleInheritedNote', {
          counts: layers
            .filter((layer) => layer.rows.length > 0)
            .map((layer) => `${SOURCE_WORD[layer.source]()} ${layer.rows.length}`)
            .join(', ')
        })}
      </p>
      <TextField
        hint={t('settings.combat.mobRuleInheritedFindHint')}
        label={t('settings.combat.mobRuleInheritedFind')}
        name={`${namePrefix}-inherited-find`}
        onChange={setQuery}
        placeholder={t('settings.combat.mobRuleNamePlaceholder')}
        spellCheck={false}
        value={query}
      />
      {full && (
        <p className="settings-warn">
          {t('settings.combat.mobRuleListFull', { most: MOB_RULES_MOST })}
        </p>
      )}
      <ul className="mob-rules-inherited-list">
        {matches.slice(0, SHOWN).map(({ row, source, replaced }) => (
          <li
            className="mob-rule-inherited"
            data-replaced={replaced ? 'true' : 'false'}
            key={row.mob}
          >
            <span className="mob-rule-name">{row.mob}</span>
            <span>{TREATMENT_WORD[row.treat]()}</span>
            <span className="chip info">{SOURCE_WORD[source]()}</span>
            {replaced ? (
              <span className="quiet-note">{t('settings.combat.mobRuleReplacedHere')}</span>
            ) : full ? null : (
              <button
                className="quiet"
                onClick={() => onOverride(row)}
                onMouseDown={keepFocus}
                title={t('settings.combat.mobRuleOverrideTitle', { mob: row.mob })}
                type="button"
              >
                {t('settings.combat.mobRuleOverride')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {matches.length > SHOWN && (
        <p className="quiet-note">
          {t('settings.combat.mobRuleInheritedMore', { more: matches.length - SHOWN })}
        </p>
      )}
    </div>
  );
}
