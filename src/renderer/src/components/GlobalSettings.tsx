import { useCallback, useMemo, useState } from 'react';
import Advanced from './Advanced';
import BlessingList from './BlessingList';
import CureFields from './CureFields';
import SpellField, { castableOn, refusesTarget } from './SpellPicker';
import { castsOnOthers, castsOnSelf } from '@shared/spellcraft';
import { DENOMINATIONS } from '@shared/character';
import type { EncumbranceGate } from '@shared/config';
import Icon from './Icon';
import FormField, { CheckField, NumberField, SelectField, TextField } from './FormField';
import RemoteList from './RemoteList';
import { ACTIONABLE_REMOTES } from '@shared/remotes';
import LoopSection from './LoopSection';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  RETREAT_STRATEGIES,
  PVP_ACTIONS,
  POTION_VERBS,
  type EngagePolicy,
  type RetreatStrategy
} from '@shared/config';
import type { GlobalDraft } from '@shared/drafts';
import type { SpellOption } from '@shared/ipc';
import type { Loop } from '@shared/loops';
import { THEME_IDS, THEMES } from '@shared/themes';
import { NOTICE_CHANNELS, type Severity } from '@shared/notifications';
import type { StreamEncoding } from '@shared/types';

/**
 * The two halves of `global/default.yaml`, drawn one at a time.
 *
 * The file holds two different kinds of thing and used to present them as one
 * list, which made "Global" mean everything and therefore nothing:
 *
 * - **`scope: 'client'` — MudEngine.** Settings about the client itself: how
 *   the console looks, which theme, where the tabs sit, what gets written to
 *   disk. Nothing here belongs to a realm or to a character.
 * - **`scope: 'defaults'` — Global.** The values a *new* realm and a *new*
 *   character start from. A realm or a character takes a copy of them when it
 *   is made and states them in its own file from then on, so changing one here
 *   changes what the next one starts with and leaves the ones already made
 *   alone.
 *
 * Both edit the same draft and save through the same call, because they are
 * one file; only which sections are offered differs.
 *
 * Built to the same test the character form is (see `SettingsScreen`'s doc
 * comment): **a section exists when there is a typed block behind it**, not
 * because the nouns sort cleanly.
 *
 * Two things it deliberately does not hold:
 *
 * - **`automation.rules` and `automation.events`.** Lists of guard expressions
 *   with comments explaining why, which is what YAML is genuinely good at.
 *   Every section that would have held them says where they live instead — a
 *   section with nothing behind it is worse than none, and a section that names
 *   where the rest is, is not that.
 * - **The realms themselves**, because a realm is a directory with a page of
 *   its own.
 * - **Any credential.** Every character carries its own username and password
 *   inline, on its own page — there is no shared or pre-character account for
 *   this screen to hold.
 */
export interface GlobalSettingsProps {
  /** Which half of the file to show — see the doc comment above. */
  scope: GlobalScope;
  draft: GlobalDraft;
  onChange(next: GlobalDraft): void;
  /** Save now rather than waiting out the debounce — Enter in a field. */
  onSubmit(): void;
  catalogue: Loop[] | null;
  picking: boolean;
  onOpenPicker(): void;
  onDonePicking(): void;
  onToggleLoop(loop: Loop): void;
  firstFieldRef: React.RefObject<HTMLInputElement>;
  /**
   * What the spell pickers offer here: the shipped realm's castable spells.
   * This form is the *starting point* a new character copies, so there is no
   * character whose own book could narrow the list — the character form
   * passes that character's book instead.
   */
  realmSpells: readonly SpellOption[];
  /**
   * The way back and how the saving is going, drawn by the screen that owns
   * both. There is no Save button: this file exists, so every change to it is
   * written on its own — see `useAutoSave`.
   */
  actions: React.ReactNode;
}

/** Which half of the file this form is showing. */
export type GlobalScope = 'client' | 'defaults';

/**
 * The sections each half offers, in order.
 *
 * The defaults half keeps MegaMUD's own tab names — Combat, Health, Spells,
 * Movement — because somebody configuring a MajorMUD client has been reading
 * those words for twenty years (docs/terminology.md §2.2). Realm and Character
 * are ours: MegaMUD ran behind a terminal somebody else had already dialled.
 */
const SECTIONS: Record<GlobalScope, readonly Section[]> = {
  client: ['appearance', 'records'],
  defaults: ['realm', 'combat', 'health', 'spells', 'party', 'movement', 'remotes', 'alerts']
};

type Section =
  | 'appearance'
  | 'records'
  | 'realm'
  | 'combat'
  | 'health'
  | 'spells'
  | 'party'
  | 'movement'
  | 'remotes'
  | 'alerts';

const SECTION_LABEL: Record<Section, string> = {
  appearance: t('settings.client.tabs.appearance'),
  records: t('settings.client.tabs.records'),
  realm: t('settings.global.tabs.realm'),
  combat: t('settings.tabs.combat'),
  health: t('settings.tabs.health'),
  spells: t('settings.tabs.spells'),
  party: t('settings.tabs.party'),
  movement: t('settings.tabs.movement'),
  remotes: t('settings.tabs.remotes'),
  alerts: t('settings.tabs.alerts')
};

import { fractionOf as fraction, joinNames, percentOf as percent, splitNames } from '../lib/form';

const ENCODINGS: readonly StreamEncoding[] = ['cp437', 'utf8', 'latin1'];

/**
 * Keys whose value is a block a spread-merge is sound for. Arrays are shut
 * out because `loops` is one, and object-spreading an array quietly turns it
 * into `{0: …}` — the constraint keeps that a compile error rather than a
 * cast's word.
 */
type BlockKey<T> = {
  [K in keyof T]: T[K] extends readonly unknown[] ? never : T[K] extends object ? K : never;
}[keyof T];

/**
 * The three load gates, in order — one list, so the two selects that offer them
 * cannot come to disagree about the words or their order.
 */
const GRADE_OPTIONS = (): Array<{ value: EncumbranceGate; label: string }> => [
  { value: 'never', label: t('settings.movement.lootGradeNever') },
  { value: 'medium', label: t('settings.movement.lootGradeMedium') },
  { value: 'heavy', label: t('settings.movement.lootGradeHeavy') }
];

export default function GlobalSettings({
  scope,
  draft,
  onChange,
  onSubmit,
  catalogue,
  picking,
  onOpenPicker,
  onDonePicking,
  onToggleLoop,
  firstFieldRef,
  realmSpells,
  actions
}: GlobalSettingsProps): React.JSX.Element {
  /*
   * The first section of whichever half is showing.
   *
   * Keyed on the scope so that switching from MudEngine to Global lands on
   * Realm rather than on nothing: a section belongs to the half it is in, and
   * a remembered one from the other half names a tab this list does not have.
   */
  const [section, setSection] = useState<Section>(() => SECTIONS[scope][0]!);
  const shown = SECTIONS[scope].includes(section) ? section : SECTIONS[scope][0]!;

  /*
   * The two heal fields offer different halves of the realm's spells: the
   * realm marks `way of the swan` castable on the caster alone, so offering it
   * for the party heal would arm `c swan <name>` once a round for a refusal
   * the server prints in the room. `castsOnSelf` / `castsOnOthers` both say
   * yes to a spell whose targeting this build cannot read, so a derivative
   * realm loses no options.
   */
  const selfHeals = useMemo(() => castableOn(realmSpells, castsOnSelf), [realmSpells]);
  const partyHeals = useMemo(() => castableOn(realmSpells, castsOnOthers), [realmSpells]);

  /**
   * One block at a time, merged onto the draft.
   *
   * Blocks rather than a flat field list because the draft mirrors the file's
   * own shape — which is what keeps this form and the YAML somebody may open
   * afterwards describing the same thing in the same words.
   */
  const patch = useCallback(
    <K extends BlockKey<GlobalDraft>>(key: K, value: Partial<GlobalDraft[K]>): void => {
      onChange({ ...draft, [key]: { ...draft[key], ...value } });
    },
    [draft, onChange]
  );

  const automation = useCallback(
    (value: Partial<GlobalDraft['automation']>): void => patch('automation', value),
    [patch]
  );

  const themes = useMemo(() => THEME_IDS.map((id) => ({ id, label: THEMES[id].label })), []);

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {/*
        Said once, above the sections, rather than at the head of each of the
        seven. A page whose every section opens with the same paragraph is a
        page nobody reads the paragraphs on.
      */}
      {scope === 'defaults' && (
        <p className="settings-note">{t('settings.global.startingValuesNote')}</p>
      )}

      <div className="crumbs settings-sections" role="tablist">
        {SECTIONS[scope].map((id) => (
          <button
            aria-selected={shown === id}
            className="crumb"
            data-active={shown === id ? 'true' : 'false'}
            key={id}
            onClick={() => setSection(id)}
            onMouseDown={keepFocus}
            role="tab"
            type="button"
          >
            {SECTION_LABEL[id]}
          </button>
        ))}
      </div>

      {shown === 'appearance' && (
        <>
          <TextField
            hint={t('settings.client.appearance.consoleFontHint')}
            inputRef={firstFieldRef}
            label={t('settings.client.appearance.consoleFontLabel')}
            name="global-font"
            onChange={(value) => patch('terminal', { fontFamily: value })}
            placeholder={t('settings.client.appearance.consoleFontPlaceholder')}
            spellCheck={false}
            value={draft.terminal.fontFamily}
            wide
          />

          <div className="settings-inline">
            <NumberField
              label={t('settings.client.appearance.fontSizeLabel')}
              name="global-font-size"
              onChange={(value) => patch('terminal', { fontSize: Number.parseInt(value, 10) || 0 })}
              value={draft.terminal.fontSize || ''}
            />
            <SelectField
              label={t('settings.profile.themeLabel')}
              name="global-theme"
              onChange={(value) => patch('ui', { theme: value as GlobalDraft['ui']['theme'] })}
              options={[
                { value: 'system', label: t('settings.profile.themeSystem') },
                ...themes.map((theme) => ({ value: theme.id, label: theme.label }))
              ]}
              value={draft.ui.theme}
            />
            <SelectField
              label={t('settings.client.appearance.densityLabel')}
              name="global-density"
              onChange={(value) => patch('ui', { density: value as GlobalDraft['ui']['density'] })}
              options={[
                { value: 'auto', label: t('settings.client.appearance.densityAuto') },
                { value: 'comfortable', label: t('settings.client.appearance.densityComfortable') },
                { value: 'compact', label: t('settings.client.appearance.densityCompact') }
              ]}
              value={draft.ui.density}
            />
            <SelectField
              label={t('settings.client.appearance.tabPlacementLabel')}
              name="global-tabs"
              onChange={(value) => patch('ui', { tabs: value as GlobalDraft['ui']['tabs'] })}
              options={[
                { value: 'left', label: t('settings.client.appearance.tabsLeft') },
                { value: 'top', label: t('settings.client.appearance.tabsTop') }
              ]}
              value={draft.ui.tabs}
            />
          </div>

          <CheckField
            checked={draft.ui.showHud}
            label={t('settings.client.appearance.showHud')}
            name="global-hud"
            onChange={(value) => patch('ui', { showHud: value })}
          />

          <Advanced label={t('settings.client.appearance.advancedConsole')}>
            <div className="settings-inline">
              <NumberField
                label={t('settings.client.appearance.scrollbackLabel')}
                name="global-scrollback"
                onChange={(value) =>
                  patch('terminal', { scrollback: Number.parseInt(value, 10) || 0 })
                }
                value={draft.terminal.scrollback || ''}
              />
              <SelectField
                label={t('settings.client.appearance.cursorStyleLabel')}
                name="global-cursor"
                onChange={(value) =>
                  patch('terminal', {
                    cursorStyle: value as GlobalDraft['terminal']['cursorStyle']
                  })
                }
                options={[
                  { value: 'block', label: t('settings.client.appearance.cursorBlock') },
                  { value: 'underline', label: t('settings.client.appearance.cursorUnderline') },
                  { value: 'bar', label: t('settings.client.appearance.cursorBar') }
                ]}
                value={draft.terminal.cursorStyle}
              />
            </div>
            <CheckField
              checked={draft.terminal.cursorBlink}
              label={t('settings.client.appearance.cursorBlink')}
              name="global-cursor-blink"
              onChange={(value) => patch('terminal', { cursorBlink: value })}
            />
            <TextField
              hint={t('settings.client.appearance.uiFontHint')}
              label={t('settings.client.appearance.uiFontLabel')}
              name="global-ui-font"
              onChange={(value) => patch('ui', { fontFamily: value })}
              placeholder={t('settings.client.appearance.uiFontPlaceholder')}
              spellCheck={false}
              value={draft.ui.fontFamily}
              wide
            />

            <fieldset className="settings-menus">
              <legend>{t('settings.client.appearance.vitalsLegend')}</legend>
              <p className="settings-note">{t('settings.client.appearance.vitalsNote')}</p>
              {(['hp', 'mana'] as const).map((vital) => (
                <div className="settings-inline" key={vital}>
                  <NumberField
                    label={t('settings.client.appearance.vitalCautionPercent', {
                      vitalName:
                        vital === 'hp'
                          ? t('settings.client.appearance.vitalHealth')
                          : t('settings.client.appearance.vitalMana')
                    })}
                    name={`global-${vital}-caution`}
                    onChange={(value) =>
                      patch('ui', {
                        vitals: {
                          ...draft.ui.vitals,
                          [vital]: { ...draft.ui.vitals[vital], caution: fraction(value) }
                        }
                      })
                    }
                    value={percent(draft.ui.vitals[vital].caution)}
                  />
                  <NumberField
                    label={t('settings.client.appearance.vitalCriticalPercent')}
                    name={`global-${vital}-critical`}
                    onChange={(value) =>
                      patch('ui', {
                        vitals: {
                          ...draft.ui.vitals,
                          [vital]: { ...draft.ui.vitals[vital], critical: fraction(value) }
                        }
                      })
                    }
                    value={percent(draft.ui.vitals[vital].critical)}
                  />
                </div>
              ))}
            </fieldset>
          </Advanced>
        </>
      )}

      {shown === 'realm' && (
        <>
          <p className="settings-note">{t('settings.global.realm.noteBeforeCharacter')}</p>

          <div className="settings-inline">
            <TextField
              label={t('settings.profile.hostLabel')}
              name="global-host"
              onChange={(value) => patch('connection', { host: value })}
              placeholder={t('settings.global.realm.hostPlaceholder')}
              spellCheck={false}
              value={draft.connection.host}
            />
            <NumberField
              label={t('settings.profile.portLabel')}
              name="global-port"
              onChange={(value) => patch('connection', { port: Number.parseInt(value, 10) || 0 })}
              value={draft.connection.port || ''}
            />
          </div>

          <Advanced label={t('settings.advancedWire')}>
            <SelectField
              hint={t('settings.profile.encodingHint')}
              label={t('settings.profile.encodingLabel')}
              name="global-encoding"
              onChange={(value) => patch('connection', { encoding: value as StreamEncoding })}
              options={ENCODINGS.map((encoding) => ({ value: encoding, label: encoding }))}
              value={draft.connection.encoding}
            />
            <fieldset className="settings-menus">
              <legend>{t('settings.realms.loginLegend')}</legend>
              <p className="settings-note">{t('settings.global.realm.loginMenusNote')}</p>
              {draft.connection.login.steps.length > 0 && (
                <ul className="settings-steps">
                  {draft.connection.login.steps.map((step, index) => (
                    <li key={index}>
                      <input
                        aria-label={t('settings.login.stepWhenAria', { stepNumber: index + 1 })}
                        onChange={(event) =>
                          patch('connection', {
                            login: {
                              ...draft.connection.login,
                              steps: draft.connection.login.steps.map((entry, at) =>
                                at === index ? { ...entry, when: event.target.value } : entry
                              )
                            }
                          })
                        }
                        placeholder={t('settings.realms.stepWhenPlaceholder')}
                        value={step.when}
                      />
                      <span aria-hidden="true" className="arrow">
                        →
                      </span>
                      <input
                        aria-label={t('settings.login.stepSendAria', { stepNumber: index + 1 })}
                        className="answer"
                        onChange={(event) =>
                          patch('connection', {
                            login: {
                              ...draft.connection.login,
                              steps: draft.connection.login.steps.map((entry, at) =>
                                at === index ? { ...entry, send: event.target.value } : entry
                              )
                            }
                          })
                        }
                        placeholder={t('settings.global.realm.loginMenuSendPlaceholder')}
                        value={step.send}
                      />
                      <button
                        aria-label={t('settings.login.removeStepAria', { stepNumber: index + 1 })}
                        className="quiet"
                        onClick={() =>
                          patch('connection', {
                            login: {
                              ...draft.connection.login,
                              steps: draft.connection.login.steps.filter((_, at) => at !== index)
                            }
                          })
                        }
                        title={t('settings.login.removeStepTitle')}
                        type="button"
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                className="quiet add-step"
                onClick={() =>
                  patch('connection', {
                    login: {
                      ...draft.connection.login,
                      steps: [...draft.connection.login.steps, { when: '', send: '' }]
                    }
                  })
                }
                type="button"
              >
                <Icon name="plus" />
                <span>{t('settings.login.addStep')}</span>
              </button>
            </fieldset>
          </Advanced>
        </>
      )}

      {shown === 'combat' && (
        <>
          <CheckField
            checked={draft.automation.enabled}
            hint={t('settings.combat.masterSwitchHint')}
            label={t('settings.combat.masterSwitch')}
            name="global-automation"
            onChange={(value) => automation({ enabled: value })}
          />

          <p className="settings-warn">{t('settings.combat.openingFightsWarning')}</p>

          <CheckField
            checked={draft.automation.combat.enabled}
            label={t('settings.combat.attackForMe')}
            name="global-combat"
            onChange={(value) =>
              automation({ combat: { ...draft.automation.combat, enabled: value } })
            }
          />
          <CheckField
            checked={draft.automation.combat.retaliate}
            hint={t('settings.combat.hitBackHint')}
            label={t('settings.combat.hitBack')}
            name="global-retaliate"
            onChange={(value) =>
              automation({ combat: { ...draft.automation.combat, retaliate: value } })
            }
          />

          <div className="settings-inline">
            <TextField
              hint={t('settings.combat.attackVerbHint')}
              label={t('settings.combat.attackVerbLabel')}
              name="global-attack"
              onChange={(value) =>
                automation({ combat: { ...draft.automation.combat, attack: value } })
              }
              placeholder={t('settings.combat.attackWithPlaceholder')}
              spellCheck={false}
              value={draft.automation.combat.attack}
            />
            <TextField
              hint={t('settings.combat.openerHint')}
              label={t('settings.combat.openerLabel')}
              name="global-opener"
              onChange={(value) =>
                automation({ combat: { ...draft.automation.combat, opener: value } })
              }
              placeholder={t('settings.combat.openerPlaceholder')}
              spellCheck={false}
              value={draft.automation.combat.opener}
            />
            {/*
              The same four words the character form shows, rather than the
              policy names out of the schema. `hostile` and `likely` are the
              config's vocabulary and mean nothing to somebody reading a
              form -- and two screens naming one setting two ways is how a
              player comes to believe they are two settings.
            */}
            <SelectField
              hint={t('settings.combat.engageHint')}
              label={t('settings.combat.engageLabel')}
              name="global-engage"
              onChange={(value) =>
                automation({
                  combat: { ...draft.automation.combat, engage: value as EngagePolicy }
                })
              }
              options={[
                { value: 'none', label: t('settings.combat.engageNone') },
                { value: 'hostile', label: t('settings.combat.engageHostile') },
                { value: 'likely', label: t('settings.combat.engageLikely') },
                { value: 'all', label: t('settings.combat.engageAll') }
              ]}
              value={draft.automation.combat.engage}
            />
          </div>

          <div className="settings-inline">
            <NumberField
              hint={t('settings.combat.maxMobsHint')}
              label={t('settings.combat.maxMobsLabel')}
              name="global-max-mobs"
              onChange={(value) =>
                automation({
                  combat: {
                    ...draft.automation.combat,
                    maxMobs: Number.parseInt(value, 10) || 0
                  }
                })
              }
              value={draft.automation.combat.maxMobs}
            />
            <NumberField
              hint={t('settings.combat.minMobsHint')}
              label={t('settings.combat.minMobsLabel')}
              name="global-min-mobs"
              onChange={(value) =>
                automation({
                  combat: {
                    ...draft.automation.combat,
                    minMobs: Math.max(0, Number.parseInt(value, 10) || 0)
                  }
                })
              }
              value={String(draft.automation.combat.minMobs)}
            />
            <NumberField
              hint={t('settings.combat.minHealthHint')}
              label={t('settings.combat.minHealthLabel')}
              name="global-min-health"
              onChange={(value) =>
                automation({
                  combat: { ...draft.automation.combat, minHealth: fraction(value) }
                })
              }
              value={percent(draft.automation.combat.minHealth)}
            />
          </div>

          <TextField
            hint={t('settings.combat.avoidHint')}
            label={t('settings.combat.avoidLabel')}
            name="global-avoid"
            onChange={(value) =>
              automation({ combat: { ...draft.automation.combat, avoid: splitNames(value) } })
            }
            placeholder={t('settings.combat.avoidPlaceholder')}
            value={joinNames(draft.automation.combat.avoid)}
            wide
          />
          <fieldset className="settings-menus">
            <legend>{t('settings.combat.avoidKindLegend')}</legend>
            <CheckField
              checked={draft.automation.combat.avoidUndead}
              hint={t('settings.combat.avoidUndeadHint')}
              label={t('settings.combat.avoidUndeadLabel')}
              name="global-avoid-undead"
              onChange={(value) =>
                automation({ combat: { ...draft.automation.combat, avoidUndead: value } })
              }
            />
            <CheckField
              checked={draft.automation.combat.avoidDeathSpell}
              hint={t('settings.combat.avoidDeathSpellHint')}
              label={t('settings.combat.avoidDeathSpellLabel')}
              name="global-avoid-death-spell"
              onChange={(value) =>
                automation({ combat: { ...draft.automation.combat, avoidDeathSpell: value } })
              }
            />
            <NumberField
              hint={t('settings.combat.maxTargetHealthHint')}
              label={t('settings.combat.maxTargetHealthLabel')}
              name="global-max-target-health"
              onChange={(value) =>
                automation({
                  combat: {
                    ...draft.automation.combat,
                    maxTargetHealth: Math.max(0, Number.parseInt(value, 10) || 0)
                  }
                })
              }
              value={String(draft.automation.combat.maxTargetHealth)}
            />
            <NumberField
              hint={t('settings.combat.maxMonsterExpHint')}
              label={t('settings.combat.maxMonsterExpLabel')}
              name="global-max-monster-exp"
              onChange={(value) =>
                automation({
                  combat: {
                    ...draft.automation.combat,
                    maxMonsterExperience: Math.max(0, Number.parseInt(value, 10) || 0)
                  }
                })
              }
              value={String(draft.automation.combat.maxMonsterExperience)}
            />
          </fieldset>
          <TextField
            hint={t('settings.combat.preferHint')}
            label={t('settings.combat.preferLabel')}
            name="global-prefer"
            onChange={(value) =>
              automation({ combat: { ...draft.automation.combat, prefer: splitNames(value) } })
            }
            placeholder={t('settings.combat.preferPlaceholder')}
            value={joinNames(draft.automation.combat.prefer)}
            wide
          />

          <Advanced label={t('settings.global.combat.advancedPacing')}>
            <div className="settings-inline">
              <NumberField
                hint={t('settings.combat.refreshHint')}
                label={t('settings.combat.refreshLabel')}
                name="global-refresh"
                onChange={(value) =>
                  automation({
                    combat: {
                      ...draft.automation.combat,
                      refreshRounds: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.combat.refreshRounds}
              />
              <CheckField
                checked={draft.automation.combat.whileWalking}
                label={t('settings.combat.whileWalking')}
                name="global-while-walking"
                onChange={(value) =>
                  automation({ combat: { ...draft.automation.combat, whileWalking: value } })
                }
              />
            </div>
            <p className="settings-note">{t('settings.global.combat.pacingNote')}</p>
            <div className="settings-inline">
              <NumberField
                label={t('settings.global.combat.pacingWindowLabel')}
                name="global-pacing-window"
                onChange={(value) =>
                  automation({
                    pacing: {
                      ...draft.automation.pacing,
                      window: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.pacing.window}
              />
              <NumberField
                label={t('settings.global.combat.pacingMinGapLabel')}
                name="global-pacing-gap"
                onChange={(value) =>
                  automation({
                    pacing: {
                      ...draft.automation.pacing,
                      minGapMs: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.pacing.minGapMs}
              />
              <NumberField
                label={t('settings.global.combat.pacingTimeoutLabel')}
                name="global-pacing-timeout"
                onChange={(value) =>
                  automation({
                    pacing: {
                      ...draft.automation.pacing,
                      ackTimeoutMs: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.pacing.ackTimeoutMs}
              />
            </div>
          </Advanced>

          <p className="settings-note">{t('settings.combat.rulesPointerNote')}</p>
        </>
      )}

      {shown === 'health' && (
        <>
          <fieldset className="settings-menus">
            <legend>{t('settings.health.recoverLegend')}</legend>
            <p className="settings-note">{t('settings.health.restingNote')}</p>
            <div className="settings-inline">
              <NumberField
                hint={t('settings.health.restBelowHint')}
                label={t('settings.health.restBelowLabel')}
                name="global-rest-below"
                onChange={(value) =>
                  automation({
                    health: { ...draft.automation.health, restBelow: fraction(value) }
                  })
                }
                value={percent(draft.automation.health.restBelow)}
              />
              <NumberField
                hint={t('settings.health.restToHint')}
                label={t('settings.health.restToLabel')}
                name="global-rest-to"
                onChange={(value) =>
                  automation({
                    health: { ...draft.automation.health, restTo: fraction(value) }
                  })
                }
                value={percent(draft.automation.health.restTo)}
              />
              <NumberField
                hint={t('settings.health.meditateBelowHint')}
                label={t('settings.health.meditateBelowLabel')}
                name="global-med-below"
                onChange={(value) =>
                  automation({
                    health: { ...draft.automation.health, meditateBelow: fraction(value) }
                  })
                }
                value={percent(draft.automation.health.meditateBelow)}
              />
            </div>
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.health.potionLegend')}</legend>
            <p className="settings-note">{t('settings.health.potionNote')}</p>
            <div className="settings-inline">
              <TextField
                label={t('settings.health.healingPotionLabel')}
                name="global-healing-potion"
                onChange={(value) =>
                  automation({ health: { ...draft.automation.health, healingPotionName: value } })
                }
                spellCheck={false}
                value={draft.automation.health.healingPotionName}
              />
              <NumberField
                hint={t('settings.health.potionBelowHint')}
                label={t('settings.health.drinkHealingBelowLabel')}
                name="global-healing-potion-below"
                onChange={(value) =>
                  automation({
                    health: { ...draft.automation.health, drinkHealingPotionBelow: fraction(value) }
                  })
                }
                value={percent(draft.automation.health.drinkHealingPotionBelow)}
              />
            </div>
            <div className="settings-inline">
              <TextField
                label={t('settings.health.manaPotionLabel')}
                name="global-mana-potion"
                onChange={(value) =>
                  automation({ health: { ...draft.automation.health, manaPotionName: value } })
                }
                spellCheck={false}
                value={draft.automation.health.manaPotionName}
              />
              <NumberField
                hint={t('settings.health.potionBelowHint')}
                label={t('settings.health.drinkManaBelowLabel')}
                name="global-mana-potion-below"
                onChange={(value) =>
                  automation({
                    health: { ...draft.automation.health, drinkManaPotionBelow: fraction(value) }
                  })
                }
                value={percent(draft.automation.health.drinkManaPotionBelow)}
              />
            </div>
            <SelectField
              hint={t('settings.health.potionVerbHint')}
              label={t('settings.health.potionVerbLabel')}
              name="global-potion-verb"
              onChange={(value) =>
                automation({
                  health: {
                    ...draft.automation.health,
                    potionVerb: value === 'use' ? 'use' : 'drink'
                  }
                })
              }
              options={POTION_VERBS.map((verb) => ({ value: verb, label: verb }))}
              value={draft.automation.health.potionVerb}
            />
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.health.retreatLegend')}</legend>
            <p className="settings-note">{t('settings.health.retreatHint')}</p>
            <CheckField
              checked={draft.automation.retreat.enabled}
              label={t('settings.health.retreatLabel')}
              name="global-retreat"
              onChange={(value) =>
                automation({ retreat: { ...draft.automation.retreat, enabled: value } })
              }
            />
            <div className="settings-inline">
              <NumberField
                label={t('settings.health.belowHealthLabel')}
                name="global-retreat-health"
                onChange={(value) =>
                  automation({
                    retreat: { ...draft.automation.retreat, belowHealth: fraction(value) }
                  })
                }
                value={percent(draft.automation.retreat.belowHealth)}
              />
              <NumberField
                hint={t('settings.health.outnumberedHint')}
                label={t('settings.health.outnumberedLabel')}
                name="global-outnumbered"
                onChange={(value) =>
                  automation({
                    retreat: {
                      ...draft.automation.retreat,
                      whenOutnumbered: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.retreat.whenOutnumbered}
              />
            </div>
            <SelectField
              hint={t('settings.health.retreatStrategyHint')}
              label={t('settings.health.retreatStrategyLabel')}
              name="global-retreat-strategy"
              onChange={(value) =>
                automation({
                  retreat: {
                    ...draft.automation.retreat,
                    strategy: RETREAT_STRATEGIES.includes(value as RetreatStrategy)
                      ? (value as RetreatStrategy)
                      : 'step-back'
                  }
                })
              }
              options={RETREAT_STRATEGIES.map((s) => ({ value: s, label: s }))}
              value={draft.automation.retreat.strategy}
            />
            {draft.automation.retreat.strategy === 'safe-haven' && (
              <TextField
                hint={t('settings.health.safeHavenHint')}
                label={t('settings.health.safeHavenLabel')}
                name="global-retreat-haven"
                onChange={(value) =>
                  automation({ retreat: { ...draft.automation.retreat, safeHavenRoom: value } })
                }
                placeholder={t('settings.health.safeHavenPlaceholder')}
                spellCheck={false}
                value={draft.automation.retreat.safeHavenRoom}
                wide
              />
            )}
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.health.hangUpLegend')}</legend>
            <p className="settings-warn">{t('settings.health.hangUpWarning')}</p>
            <CheckField
              checked={draft.automation.hangUp.enabled}
              label={t('settings.health.hangUpLabel')}
              name="global-hangup"
              onChange={(value) =>
                automation({ hangUp: { ...draft.automation.hangUp, enabled: value } })
              }
            />
            <div className="settings-inline">
              <NumberField
                label={t('settings.health.belowHealthLabel')}
                name="global-hangup-health"
                onChange={(value) =>
                  automation({
                    hangUp: { ...draft.automation.hangUp, belowHealth: fraction(value) }
                  })
                }
                value={percent(draft.automation.hangUp.belowHealth)}
              />
            </div>
            <CheckField
              checked={draft.automation.hangUp.onlyWhenClean}
              label={t('settings.health.hangUpCleanLabel')}
              name="global-hangup-clean"
              onChange={(value) =>
                automation({ hangUp: { ...draft.automation.hangUp, onlyWhenClean: value } })
              }
            />
            <CheckField
              checked={draft.automation.hangUp.onPlayerInRoom}
              label={t('settings.health.hangUpOnPlayer')}
              name="global-hangup-player"
              onChange={(value) =>
                automation({ hangUp: { ...draft.automation.hangUp, onPlayerInRoom: value } })
              }
            />
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.health.pvpLegend')}</legend>
            <CheckField
              checked={draft.automation.pvp.notifyGang}
              hint={t('settings.health.pvpNotifyHint')}
              label={t('settings.health.pvpNotifyLabel')}
              name="global-pvp-notify"
              onChange={(value) =>
                automation({ pvp: { ...draft.automation.pvp, notifyGang: value } })
              }
            />
            <SelectField
              hint={t('settings.health.pvpActionHint')}
              label={t('settings.health.pvpActionLabel')}
              name="global-pvp-action"
              onChange={(value) =>
                automation({
                  pvp: {
                    ...draft.automation.pvp,
                    action: value === 'retreat' ? 'retreat' : 'none'
                  }
                })
              }
              options={PVP_ACTIONS.map((action) => ({ value: action, label: action }))}
              value={draft.automation.pvp.action}
            />
          </fieldset>
        </>
      )}

      {shown === 'spells' && (
        <>
          <p className="settings-note">{t('settings.spells.rulesPointerNote')}</p>
          <div className="settings-inline">
            <SpellField
              hint={t('settings.spells.castHint')}
              label={t('settings.spells.castLabel')}
              name="global-spell"
              onChange={(value) =>
                automation({ spells: { ...draft.automation.spells, attack: value } })
              }
              spells={realmSpells}
              value={draft.automation.spells.attack}
            />
            <NumberField
              hint={t('settings.spells.minManaHint')}
              label={t('settings.spells.minManaLabel')}
              name="global-min-mana"
              onChange={(value) =>
                automation({ spells: { ...draft.automation.spells, minMana: fraction(value) } })
              }
              value={percent(draft.automation.spells.minMana)}
            />
          </div>
          <div className="settings-inline">
            <SpellField
              hint={t('settings.spells.areaCastHint')}
              label={t('settings.spells.areaCastLabel')}
              name="global-area-spell"
              onChange={(value) =>
                automation({ spells: { ...draft.automation.spells, areaAttack: value } })
              }
              spells={realmSpells}
              value={draft.automation.spells.areaAttack}
            />
            <NumberField
              hint={t('settings.spells.areaMinMobsHint')}
              label={t('settings.spells.areaMinMobsLabel')}
              name="global-area-min-mobs"
              onChange={(value) =>
                automation({
                  spells: {
                    ...draft.automation.spells,
                    areaMinMobs: Math.max(1, Number.parseInt(value, 10) || 1)
                  }
                })
              }
              value={String(draft.automation.spells.areaMinMobs)}
            />
            <NumberField
              hint={t('settings.spells.areaMinManaHint')}
              label={t('settings.spells.areaMinManaLabel')}
              name="global-area-min-mana"
              onChange={(value) =>
                automation({
                  spells: { ...draft.automation.spells, areaMinMana: fraction(value) }
                })
              }
              value={percent(draft.automation.spells.areaMinMana)}
            />
          </div>
          <fieldset className="settings-menus">
            <legend>{t('settings.spells.healLegend')}</legend>
            <div className="settings-inline">
              <SpellField
                hint={t('settings.spells.healHint')}
                label={t('settings.spells.healLabel')}
                name="global-heal"
                onChange={(value) =>
                  automation({ spells: { ...draft.automation.spells, heal: value } })
                }
                spells={selfHeals}
                value={draft.automation.spells.heal}
                warning={
                  refusesTarget(realmSpells, castsOnSelf, draft.automation.spells.heal)
                    ? t('settings.spells.healNoSelfCast')
                    : undefined
                }
              />
              <NumberField
                label={t('settings.spells.healBelowLabel')}
                name="global-heal-below"
                onChange={(value) =>
                  automation({
                    spells: { ...draft.automation.spells, healBelow: fraction(value) }
                  })
                }
                value={percent(draft.automation.spells.healBelow)}
              />
              <NumberField
                hint={t('settings.spells.healBelowInCombatHint')}
                label={t('settings.spells.healBelowInCombatLabel')}
                name="global-heal-below-combat"
                onChange={(value) =>
                  automation({
                    spells: { ...draft.automation.spells, healBelowInCombat: fraction(value) }
                  })
                }
                value={percent(draft.automation.spells.healBelowInCombat)}
              />
              <NumberField
                hint={t('settings.spells.healToHint')}
                label={t('settings.spells.healToLabel')}
                name="global-heal-to"
                onChange={(value) =>
                  automation({ spells: { ...draft.automation.spells, healTo: fraction(value) } })
                }
                value={percent(draft.automation.spells.healTo)}
              />
            </div>
            <CheckField
              checked={draft.automation.spells.healParty}
              hint={t('settings.spells.healPartyHint')}
              label={t('settings.spells.healParty')}
              name="global-healparty"
              onChange={(value) =>
                automation({ spells: { ...draft.automation.spells, healParty: value } })
              }
            />
            <SpellField
              hint={t('settings.spells.healPartyWithHint')}
              label={t('settings.spells.healPartyWithLabel')}
              name="global-heal-party-with"
              onChange={(value) =>
                automation({ spells: { ...draft.automation.spells, healPartyWith: value } })
              }
              spells={partyHeals}
              value={draft.automation.spells.healPartyWith}
              warning={
                refusesTarget(realmSpells, castsOnOthers, draft.automation.spells.healPartyWith)
                  ? t('settings.spells.healNoPartyCast')
                  : undefined
              }
            />
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.spells.cureLegend')}</legend>
            <p className="settings-note">{t('settings.spells.cureNote')}</p>
            <CureFields
              cures={draft.automation.spells.cures}
              // No character here to read a book from, so nothing to gate on.
              gates={null}
              namePrefix="global"
              onChange={(cures) => automation({ spells: { ...draft.automation.spells, cures } })}
              spells={realmSpells}
            />
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.spells.blessingsLegend')}</legend>
            <p className="settings-note">{t('settings.spells.blessingsNote')}</p>
            <BlessingList
              blessings={draft.automation.spells.blessings}
              namePrefix="global-blessing"
              onChange={(blessings) =>
                automation({ spells: { ...draft.automation.spells, blessings } })
              }
              spells={realmSpells}
            />
            <CheckField
              checked={draft.automation.spells.notifyPartyOnWearOff}
              hint={t('settings.spells.notifyWearOffHint')}
              label={t('settings.spells.notifyWearOffLabel')}
              name="global-notify-wear-off"
              onChange={(value) =>
                automation({
                  spells: { ...draft.automation.spells, notifyPartyOnWearOff: value }
                })
              }
            />
          </fieldset>
        </>
      )}

      {shown === 'party' && (
        <>
          <fieldset className="settings-menus">
            <legend>{t('settings.party.legend')}</legend>
            <p className="settings-warn">{t('settings.party.warning')}</p>
            <CheckField
              checked={draft.automation.party.assistLeader}
              hint={t('settings.party.assistHint')}
              label={t('settings.party.assistLabel')}
              name="global-party-assist"
              onChange={(value) =>
                automation({ party: { ...draft.automation.party, assistLeader: value } })
              }
            />
            <CheckField
              checked={draft.automation.party.defendParty}
              hint={t('settings.party.defendHint')}
              label={t('settings.party.defendLabel')}
              name="global-party-defend"
              onChange={(value) =>
                automation({ party: { ...draft.automation.party, defendParty: value } })
              }
            />
            <CheckField
              checked={draft.automation.party.restWithLeader}
              hint={t('settings.party.restHint')}
              label={t('settings.party.restLabel')}
              name="global-party-rest"
              onChange={(value) =>
                automation({ party: { ...draft.automation.party, restWithLeader: value } })
              }
            />
          </fieldset>
          {/*
            The party's `@` commands, on the Party page rather than beside the
            gang's on Remotes, because this is where somebody is thinking about
            what a party does together. The Remotes page says the list is here.

            Drawn whether or not `remotes.enabled` is on, with the warning the
            Gang card uses: the switch lives on another page, and a grid that
            vanished when it was off would be a control somebody has to already
            know about to find. These are also the values a new character
            **copies at creation**, which is the copied-once failure this
            project has written down once already.
          */}
          <fieldset className="settings-menus">
            <legend>{t('settings.party.remotesLegend')}</legend>
            <p className="settings-note">{t('settings.party.remotesNote')}</p>
            {draft.automation.remotes.enabled ? null : (
              <p className="settings-warn">{t('settings.party.remotesOffWarning')}</p>
            )}
            <RemoteList
              allow={draft.automation.remotes.party}
              mode="party"
              onSet={(remote, stance) =>
                automation({
                  remotes: {
                    ...draft.automation.remotes,
                    party:
                      stance === 'allow'
                        ? [...draft.automation.remotes.party, remote]
                        : draft.automation.remotes.party.filter((entry) => entry !== remote)
                  }
                })
              }
              onSetAll={(stance) =>
                automation({
                  remotes: {
                    ...draft.automation.remotes,
                    party: stance === 'allow' ? [...ACTIONABLE_REMOTES] : []
                  }
                })
              }
              subject={t('settings.party.remotesLegend')}
            />
          </fieldset>
          <p className="settings-note">{t('settings.party.blessingsMoved')}</p>
        </>
      )}

      {shown === 'movement' && (
        <>
          <fieldset className="settings-menus">
            <legend>{t('settings.movement.legend')}</legend>
            <CheckField
              checked={draft.automation.movement.openDoors}
              hint={t('settings.movement.openDoorsHint')}
              label={t('settings.movement.openDoors')}
              name="global-open-doors"
              onChange={(value) =>
                automation({ movement: { ...draft.automation.movement, openDoors: value } })
              }
            />
            {/*
              Picking above bashing, in the order the walker tries them: one
              costs a command and the other costs a command and some health.
            */}
            <CheckField
              checked={draft.automation.movement.pickLocks}
              hint={t('settings.movement.pickLocksHint')}
              label={t('settings.movement.pickLocks')}
              name="global-pick-locks"
              onChange={(value) =>
                automation({ movement: { ...draft.automation.movement, pickLocks: value } })
              }
            />
            <CheckField
              checked={draft.automation.movement.bashDoors}
              hint={t('settings.movement.bashDoorsHint')}
              label={t('settings.movement.bashDoors')}
              name="global-bash-doors"
              onChange={(value) =>
                automation({ movement: { ...draft.automation.movement, bashDoors: value } })
              }
            />
            <CheckField
              checked={draft.automation.movement.sneak}
              hint={t('settings.movement.sneakHint')}
              label={t('settings.movement.sneak')}
              name="global-sneak"
              onChange={(value) =>
                automation({ movement: { ...draft.automation.movement, sneak: value } })
              }
            />
            <CheckField
              checked={draft.automation.movement.provideLight}
              hint={t('settings.movement.provideLightHint')}
              label={t('settings.movement.provideLight')}
              name="global-provide-light"
              onChange={(value) =>
                automation({ movement: { ...draft.automation.movement, provideLight: value } })
              }
            />
            {/* Both depend on the switch above, and are disclosed behind it on
                this page exactly as on a character's — one setting, one shape,
                on every page that shows it. */}
            {draft.automation.movement.provideLight && (
              <>
                <CheckField
                  checked={draft.automation.movement.lightDimRooms}
                  hint={t('settings.movement.lightDimRoomsHint')}
                  label={t('settings.movement.lightDimRooms')}
                  name="global-light-dim-rooms"
                  onChange={(value) =>
                    automation({ movement: { ...draft.automation.movement, lightDimRooms: value } })
                  }
                />
                <CheckField
                  checked={draft.automation.movement.extinguishInLight}
                  hint={t('settings.movement.extinguishInLightHint')}
                  label={t('settings.movement.extinguishInLight')}
                  name="global-extinguish-in-light"
                  onChange={(value) =>
                    automation({
                      movement: { ...draft.automation.movement, extinguishInLight: value }
                    })
                  }
                />
              </>
            )}
            <NumberField
              label={t('settings.movement.openTries')}
              name="global-open-tries"
              onChange={(value) =>
                automation({
                  movement: {
                    ...draft.automation.movement,
                    openTries: Number.parseInt(value, 10) || 0
                  }
                })
              }
              value={draft.automation.movement.openTries}
            />
            <NumberField
              label={t('settings.movement.pickTries')}
              name="global-pick-tries"
              onChange={(value) =>
                automation({
                  movement: {
                    ...draft.automation.movement,
                    pickTries: Number.parseInt(value, 10) || 0
                  }
                })
              }
              value={draft.automation.movement.pickTries}
            />
            <NumberField
              label={t('settings.movement.bashTries')}
              name="global-bash-tries"
              onChange={(value) =>
                automation({
                  movement: {
                    ...draft.automation.movement,
                    bashTries: Number.parseInt(value, 10) || 0
                  }
                })
              }
              value={draft.automation.movement.bashTries}
            />
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.movement.lootLegend')}</legend>
            <CheckField
              checked={draft.automation.loot.coins}
              label={t('settings.movement.lootCoins')}
              name="global-loot-coins"
              onChange={(value) => automation({ loot: { ...draft.automation.loot, coins: value } })}
            />
            {/*
              Which coins, as a row of chips rather than five checkboxes: the
              question is "which of these five", and five boxes down a column
              reads as five unrelated settings.
            */}
            <FormField
              hint={t('settings.movement.lootCoinKindsHint')}
              label={t('settings.movement.lootCoinKindsLabel')}
              name="global-loot-coin-kinds"
              wide
            >
              {() => (
                <div className="chip-row">
                  {DENOMINATIONS.map((coin) => {
                    const on = draft.automation.loot.coinKinds.includes(coin);
                    return (
                      <button
                        aria-pressed={on}
                        className="chip"
                        key={coin}
                        onClick={() =>
                          automation({
                            loot: {
                              ...draft.automation.loot,
                              coinKinds: on
                                ? draft.automation.loot.coinKinds.filter((k) => k !== coin)
                                : DENOMINATIONS.filter(
                                    (k) => k === coin || draft.automation.loot.coinKinds.includes(k)
                                  )
                            }
                          })
                        }
                        onMouseDown={keepFocus}
                        type="button"
                      >
                        {coin}
                      </button>
                    );
                  })}
                </div>
              )}
            </FormField>
            <SelectField
              hint={t('settings.movement.lootStopAtGradeHint')}
              label={t('settings.movement.lootStopAtGradeLabel')}
              name="global-loot-stop-grade"
              onChange={(value) =>
                automation({
                  loot: { ...draft.automation.loot, stopAtGrade: value as EncumbranceGate }
                })
              }
              options={GRADE_OPTIONS()}
              value={draft.automation.loot.stopAtGrade}
            />
            <div className="settings-inline">
              <TextField
                hint={t('settings.movement.lootConvertWithHint')}
                label={t('settings.movement.lootConvertWithLabel')}
                name="global-loot-convert"
                onChange={(value) =>
                  automation({ loot: { ...draft.automation.loot, convertWith: value } })
                }
                value={draft.automation.loot.convertWith}
              />
              <SelectField
                label={t('settings.movement.lootConvertAtLabel')}
                name="global-loot-convert-at"
                onChange={(value) =>
                  automation({
                    loot: { ...draft.automation.loot, convertAt: value as EncumbranceGate }
                  })
                }
                options={GRADE_OPTIONS()}
                value={draft.automation.loot.convertAt}
              />
            </div>
            <TextField
              hint={t('settings.movement.lootItemsHint')}
              label={t('settings.movement.lootItemsLabel')}
              name="global-loot"
              onChange={(value) =>
                automation({ loot: { ...draft.automation.loot, items: splitNames(value) } })
              }
              placeholder={t('settings.movement.lootItemsPlaceholder')}
              value={joinNames(draft.automation.loot.items)}
              wide
            />
            <div className="settings-inline">
              <NumberField
                hint={t('settings.movement.lootMinPriceHint')}
                label={t('settings.movement.lootMinPriceLabel')}
                name="global-loot-min-price"
                onChange={(value) =>
                  automation({
                    loot: {
                      ...draft.automation.loot,
                      minPrice: Math.max(0, Number.parseInt(value, 10) || 0)
                    }
                  })
                }
                value={String(draft.automation.loot.minPrice)}
              />
              <NumberField
                hint={t('settings.movement.lootMaxEncumbranceHint')}
                label={t('settings.movement.lootMaxEncumbranceLabel')}
                name="global-loot-max-weight"
                onChange={(value) =>
                  automation({
                    loot: {
                      ...draft.automation.loot,
                      maxEncumbrance: Math.max(0, Number.parseInt(value, 10) || 0)
                    }
                  })
                }
                value={String(draft.automation.loot.maxEncumbrance)}
              />
            </div>
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.movement.dropLegend')}</legend>
            <CheckField
              checked={draft.automation.drop.enabled}
              hint={t('settings.movement.dropEnabledHint')}
              label={t('settings.movement.dropEnabledLabel')}
              name="global-drop-enabled"
              onChange={(value) =>
                automation({ drop: { ...draft.automation.drop, enabled: value } })
              }
            />
            <TextField
              hint={t('settings.movement.dropItemsHint')}
              label={t('settings.movement.dropItemsLabel')}
              name="global-drop"
              onChange={(value) =>
                automation({ drop: { ...draft.automation.drop, items: splitNames(value) } })
              }
              placeholder={t('settings.movement.dropItemsPlaceholder')}
              value={joinNames(draft.automation.drop.items)}
              wide
            />
            <CheckField
              checked={draft.automation.drop.whenEncumbered}
              hint={t('settings.movement.dropWhenEncumberedHint')}
              label={t('settings.movement.dropWhenEncumberedLabel')}
              name="global-drop-encumbered"
              onChange={(value) =>
                automation({ drop: { ...draft.automation.drop, whenEncumbered: value } })
              }
            />
            <CheckField
              checked={draft.automation.drop.worthless}
              hint={t('settings.movement.dropWorthlessHint')}
              label={t('settings.movement.dropWorthlessLabel')}
              name="global-drop-worthless"
              onChange={(value) =>
                automation({ drop: { ...draft.automation.drop, worthless: value } })
              }
            />
          </fieldset>

          {/*
            Searching every room, which is a *movement* setting rather than a
            combat one: what it finds is a way through, and the section it sits
            in is the one that already holds opening, picking and bashing the
            other kinds of blocked exit.
          */}
          <fieldset className="settings-menus">
            <legend>{t('settings.movement.searchLegend')}</legend>
            <CheckField
              checked={draft.automation.search.enabled}
              hint={t('settings.movement.searchEnabledHint')}
              label={t('settings.movement.searchEnabledLabel')}
              name="global-search-enabled"
              onChange={(value) =>
                automation({ search: { ...draft.automation.search, enabled: value } })
              }
            />
            <NumberField
              hint={t('settings.movement.searchTriesHint')}
              label={t('settings.movement.searchTriesLabel')}
              name="global-search-tries"
              onChange={(value) =>
                automation({
                  search: {
                    ...draft.automation.search,
                    tries: Number.parseInt(value, 10) || 1
                  }
                })
              }
              value={draft.automation.search.tries}
            />
          </fieldset>

          <fieldset className="settings-menus">
            <legend>{t('settings.movement.bankLegend')}</legend>
            <CheckField
              checked={draft.automation.banking.autoDeposit}
              hint={t('settings.movement.bankDepositHint')}
              label={t('settings.movement.bankDepositLabel')}
              name="global-bank-deposit"
              onChange={(value) =>
                automation({ banking: { ...draft.automation.banking, autoDeposit: value } })
              }
            />
            <div className="settings-inline">
              <NumberField
                hint={t('settings.movement.bankThresholdHint')}
                label={t('settings.movement.bankThresholdLabel')}
                name="global-bank-threshold"
                onChange={(value) =>
                  automation({
                    banking: {
                      ...draft.automation.banking,
                      depositThresholdCopper: Math.max(0, Number.parseInt(value, 10) || 0)
                    }
                  })
                }
                value={String(draft.automation.banking.depositThresholdCopper)}
              />
              <NumberField
                hint={t('settings.movement.bankKeepHint')}
                label={t('settings.movement.bankKeepLabel')}
                name="global-bank-keep"
                onChange={(value) =>
                  automation({
                    banking: {
                      ...draft.automation.banking,
                      keepCopper: Math.max(0, Number.parseInt(value, 10) || 0)
                    }
                  })
                }
                value={String(draft.automation.banking.keepCopper)}
              />
            </div>
          </fieldset>

          <LoopSection
            catalogue={catalogue}
            loops={draft.loops}
            note={t('settings.global.movement.loopsNote')}
            onDonePicking={onDonePicking}
            onOpenPicker={onOpenPicker}
            onToggle={onToggleLoop}
            picking={picking}
          />

          <Advanced label={t('settings.global.movement.advancedWalking')}>
            <div className="settings-inline">
              <NumberField
                hint={t('settings.global.movement.stepTimeoutHint')}
                label={t('settings.global.movement.stepTimeoutLabel')}
                name="global-step-timeout"
                onChange={(value) =>
                  automation({
                    walk: {
                      ...draft.automation.walk,
                      stepTimeoutMs: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.walk.stepTimeoutMs}
              />
              <NumberField
                label={t('settings.global.movement.clearRouteLabel')}
                name="global-route-clear"
                onChange={(value) =>
                  automation({
                    walk: {
                      ...draft.automation.walk,
                      clearAfterSeconds: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.walk.clearAfterSeconds}
              />
            </div>
            <CheckField
              checked={draft.automation.idle.enabled}
              label={t('settings.global.movement.idleEnabled')}
              name="global-idle"
              onChange={(value) =>
                automation({ idle: { ...draft.automation.idle, enabled: value } })
              }
            />
            <div className="settings-inline">
              <NumberField
                label={t('settings.global.movement.idleAfterLabel')}
                name="global-idle-after"
                onChange={(value) =>
                  automation({
                    idle: {
                      ...draft.automation.idle,
                      afterSeconds: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={draft.automation.idle.afterSeconds}
              />
              <TextField
                label={t('settings.global.movement.idleCommandLabel')}
                name="global-idle-command"
                onChange={(value) =>
                  automation({ idle: { ...draft.automation.idle, command: value } })
                }
                placeholder={t('settings.global.movement.idleCommandPlaceholder')}
                spellCheck={false}
                value={draft.automation.idle.command}
              />
            </div>
            <TextField
              hint={t('settings.global.movement.onEnterHint')}
              label={t('settings.global.movement.onEnterLabel')}
              name="global-enter"
              onChange={(value) => automation({ onEnterRealm: splitNames(value) })}
              placeholder={t('settings.global.movement.onEnterPlaceholder')}
              spellCheck={false}
              value={joinNames(draft.automation.onEnterRealm)}
              wide
            />
            <TextField
              label={t('settings.global.movement.onPartyChangeLabel')}
              name="global-party-change"
              onChange={(value) => automation({ onPartyChange: value })}
              placeholder={t('settings.global.movement.onPartyChangePlaceholder')}
              spellCheck={false}
              value={draft.automation.onPartyChange}
              wide
            />
          </Advanced>
        </>
      )}

      {shown === 'remotes' && (
        <fieldset className="settings-menus">
          <legend>{t('settings.remotes.legend')}</legend>
          {/*
            In the open, like Hang up and opening fights unasked, and for the
            same reason: what this turns on is a channel by which somebody
            else's typing moves a character.
          */}
          <p className="settings-warn">{t('settings.remotes.channelWarning')}</p>
          <CheckField
            checked={draft.automation.remotes.enabled}
            hint={t('settings.remotes.answerHint')}
            label={t('settings.remotes.enabledLabel')}
            name="global-remotes-enabled"
            onChange={(value) =>
              automation({ remotes: { ...draft.automation.remotes, enabled: value } })
            }
          />
          {/*
            The gate, here as well as on the character page.

            These are the values a character **copies at creation**, so a Global
            page that could set the switch and not the grants would hand every
            new character a feature switched on and answering nobody — with the
            only surface able to fix it being somewhere else. That is the
            copied-once template failure this project already wrote down.
          */}
          {draft.automation.remotes.enabled && (
            <>
              <CheckField
                checked={draft.automation.remotes.gangpath}
                hint={t('settings.remotes.gangpathHint')}
                label={t('settings.remotes.gangpathLabel')}
                name="global-remotes-gangpath"
                onChange={(value) =>
                  automation({ remotes: { ...draft.automation.remotes, gangpath: value } })
                }
              />
              <p className="settings-warn">{t('settings.remotes.gangWarning')}</p>
              <h4 className="settings-subhead">{t('settings.remotes.gangLegend')}</h4>
              {/*
                The same grid the Gang card draws, through the same component:
                a permission that read one way on a card and another in Settings
                is one somebody sets in whichever place happens to be wrong.
              */}
              <RemoteList
                allow={draft.automation.remotes.gang}
                mode="gang"
                onSet={(remote, stance) =>
                  automation({
                    remotes: {
                      ...draft.automation.remotes,
                      gang:
                        stance === 'allow'
                          ? [...draft.automation.remotes.gang, remote]
                          : draft.automation.remotes.gang.filter((entry) => entry !== remote)
                    }
                  })
                }
                onSetAll={(stance) =>
                  automation({
                    remotes: {
                      ...draft.automation.remotes,
                      gang: stance === 'allow' ? [...ACTIONABLE_REMOTES] : []
                    }
                  })
                }
                subject={t('settings.remotes.gangLegend')}
              />
            </>
          )}
          {/*
            Where the third list is. A permission page that showed two of the
            three grants would have somebody auditing who can drive this
            character conclude they had seen all of it.
          */}
          <p className="settings-note">{t('settings.remotes.partyListNote')}</p>
          <p className="settings-note">{t('settings.remotes.remoteControlNote')}</p>
          <p className="settings-note">{t('settings.remotes.replyRoutingNote')}</p>
        </fieldset>
      )}

      {shown === 'alerts' && (
        <>
          {/*
            The three words the character form shows, not the severity names
            out of the schema. One setting named two ways on two screens is
            how a player comes to believe there are two settings.
          */}
          <SelectField
            hint={t('settings.alerts.minimumHint')}
            label={t('settings.alerts.minimumLabel')}
            name="global-alert-min"
            onChange={(value) =>
              patch('ui', { alerts: { ...draft.ui.alerts, minimum: value as Severity } })
            }
            options={[
              { value: 'info', label: t('settings.alerts.minimumInfo') },
              { value: 'warning', label: t('settings.alerts.minimumWarning') },
              { value: 'critical', label: t('settings.alerts.minimumCritical') }
            ]}
            value={draft.ui.alerts.minimum}
          />
          <fieldset className="settings-menus">
            <legend>{t('settings.alerts.muteLabel')}</legend>
            <div className="settings-checks">
              {NOTICE_CHANNELS.map((channel) => (
                <CheckField
                  checked={draft.ui.alerts.mute.includes(channel)}
                  key={channel}
                  label={channel}
                  name={`global-mute-${channel}`}
                  onChange={(value) =>
                    patch('ui', {
                      alerts: {
                        ...draft.ui.alerts,
                        mute: value
                          ? [...draft.ui.alerts.mute, channel]
                          : draft.ui.alerts.mute.filter((entry) => entry !== channel)
                      }
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
        </>
      )}

      {shown === 'records' && (
        <>
          <p className="settings-note">{t('settings.client.records.note')}</p>
          <CheckField
            checked={draft.logging.enabled}
            label={t('settings.client.records.enabled')}
            name="global-logging"
            onChange={(value) => patch('logging', { enabled: value })}
          />
          <CheckField
            checked={draft.logging.capture}
            hint={t('settings.client.records.captureHint')}
            label={t('settings.client.records.captureLabel')}
            name="global-capture"
            onChange={(value) => patch('logging', { capture: value })}
          />
          <CheckField
            checked={draft.logging.fights}
            hint={t('settings.client.records.fightsHint')}
            label={t('settings.client.records.fightsLabel')}
            name="global-fights"
            onChange={(value) => patch('logging', { fights: value })}
          />
          <CheckField
            checked={draft.logging.conversations}
            hint={t('settings.client.records.conversationsHint')}
            label={t('settings.client.records.conversationsLabel')}
            name="global-conversations"
            onChange={(value) => patch('logging', { conversations: value })}
          />
          <NumberField
            hint={t('settings.client.records.conversationDaysHint')}
            label={t('settings.client.records.conversationDaysLabel')}
            name="global-conversation-days"
            onChange={(value) =>
              patch('logging', { conversationDays: Number.parseInt(value, 10) || 0 })
            }
            value={draft.logging.conversationDays}
          />
          <TextField
            label={t('settings.client.records.folderLabel')}
            name="global-log-folder"
            onChange={(value) => patch('logging', { directory: value })}
            placeholder={t('settings.client.records.folderPlaceholder')}
            spellCheck={false}
            value={draft.logging.directory}
            wide
          />
          <Advanced label={t('settings.client.records.advancedLogSize')}>
            <NumberField
              label={t('settings.client.records.maxBytesLabel')}
              name="global-log-bytes"
              onChange={(value) => patch('logging', { maxBytes: Number.parseInt(value, 10) || 0 })}
              value={draft.logging.maxBytes}
            />
          </Advanced>
        </>
      )}

      <div className="settings-actions">{actions}</div>
    </form>
  );
}
