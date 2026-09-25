import { useCallback, useMemo, useState } from 'react';
import Advanced from './Advanced';
import AlertList from './AlertList';
import BlessingList from './BlessingList';
import CureFields from './CureFields';
import FleeGotoFields from './FleeGotoFields';
import ConditionWaitFields from './ConditionWaitFields';
import MobRuleList from './MobRuleList';
import GearSetList from './GearSetList';
import PotionList from './PotionList';
import SettingsNav, { type NavFieldset } from './SettingsNav';
import SpellField, { castableOn, refusesTarget } from './SpellPicker';
import { castsOnOthers, castsOnSelf } from '@shared/spellcraft';
import CarrySections from './CarrySections';
import Icon from './Icon';
import { CheckField, NumberField, SelectField, TextField } from './FormField';
import RemoteList from './RemoteList';
import { ACTIONABLE_REMOTES } from '@shared/remotes';
import LoopSection from './LoopSection';
import RewritesDesigner from './RewriteDesigner';

import { t } from '../lib/i18n';
import {
  RETREAT_STRATEGIES,
  PVP_ACTIONS,
  type EngagePolicy,
  type RetreatStrategy
} from '@shared/config';
import type { GlobalDraft } from '@shared/drafts';
import type { SpellOption } from '@shared/ipc';
import type { Loop } from '@shared/loops';
import {
  TERMINAL_THEME_IDS,
  TERMINAL_THEMES,
  THEME_IDS,
  THEMES,
  themesOfAppearance,
  type TerminalPalette
} from '@shared/themes';
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
 * Built to the same test the character form is (see `CharacterForm`'s doc
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
  /** The console's palette, which the status line's preview is drawn against. */
  palette: TerminalPalette;
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
  defaults: [
    'realm',
    'combat',
    'health',
    'spells',
    'party',
    'movement',
    'gear',
    'train',
    'quests',
    'remotes',
    'alerts',
    'rewrites'
  ]
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
  | 'gear'
  | 'train'
  | 'quests'
  | 'remotes'
  | 'alerts'
  | 'rewrites';

/**
 * The fieldsets inside each section, as the rail's jump targets (todo 02).
 *
 * Its own table rather than the character screen's, because the two pages
 * genuinely differ: Global has no wrapper fieldset around the round spell, its
 * Combat fieldsets are not gated on the switch, and its three Alerts fieldsets
 * are in a different order. A shared table would have to be wrong for one of
 * them. See `SECTION_FIELDSETS` in `CharacterForm`.
 */
const SECTION_FIELDSETS: Record<Section, readonly NavFieldset[]> = {
  appearance: [{ id: 'appearance-vitals', label: t('settings.client.appearance.vitalsLegend') }],
  records: [],
  realm: [{ id: 'realm-login', label: t('settings.realms.loginLegend') }],
  combat: [
    { id: 'combat-monsters', label: t('settings.combat.monstersLegend') },
    { id: 'combat-mob-rules', label: t('settings.combat.mobRuleLegend') }
  ],
  health: [
    { id: 'health-recover', label: t('settings.health.recoverLegend') },
    { id: 'health-potions', label: t('settings.health.potionRuleLegend') },
    { id: 'health-retreat', label: t('settings.health.retreatLegend') },
    { id: 'health-hangup', label: t('settings.health.hangUpLegend') },
    { id: 'health-pvp', label: t('settings.health.pvpLegend') }
  ],
  spells: [
    { id: 'spells-heal', label: t('settings.spells.healLegend') },
    { id: 'spells-cures', label: t('settings.spells.cureLegend') },
    { id: 'spells-blessings', label: t('settings.spells.blessingsLegend') }
  ],
  party: [
    { id: 'party-follow', label: t('settings.party.legend') },
    { id: 'party-healing', label: t('settings.party.healLegend') },
    { id: 'party-remotes', label: t('settings.party.remotesLegend') }
  ],
  movement: [
    { id: 'movement-doors', label: t('settings.movement.doorsLegend') },
    { id: 'movement-stealth', label: t('settings.movement.stealthLegend') },
    { id: 'movement-light', label: t('settings.movement.lightLegend') },
    { id: 'movement-afflictions', label: t('settings.movement.afflictionsLegend') },
    { id: 'movement-keep-out', label: t('settings.movement.keepOutLegend') },
    { id: 'movement-carry', label: t('settings.movement.carryLegend') },
    { id: 'hunting', label: t('settings.hunting.legend') }
  ],
  train: [{ id: 'train', label: t('settings.train.legend') }],
  gear: [
    { id: 'gear', label: t('settings.gear.legend') },
    { id: 'gear-offround', label: t('settings.gear.offRoundLegend') }
  ],
  quests: [{ id: 'quests', label: t('settings.quests.legend') }],
  remotes: [{ id: 'remotes', label: t('settings.remotes.legend') }],
  alerts: [
    { id: 'alerts-rules', label: t('settings.alerts.ruleLegend') },
    { id: 'alerts-afk', label: t('settings.afk.legend') }
  ],
  rewrites: [{ id: 'rewrites-statline', label: t('settings.statline.legend') }]
};

const SECTION_LABEL: Record<Section, string> = {
  appearance: t('settings.client.tabs.appearance'),
  records: t('settings.client.tabs.records'),
  realm: t('settings.global.tabs.realm'),
  combat: t('settings.tabs.combat'),
  health: t('settings.tabs.health'),
  spells: t('settings.tabs.spells'),
  party: t('settings.tabs.party'),
  movement: t('settings.tabs.movement'),
  gear: t('settings.tabs.gear'),
  train: t('settings.tabs.train'),
  quests: t('settings.tabs.quests'),
  remotes: t('settings.tabs.remotes'),
  alerts: t('settings.tabs.alerts'),
  rewrites: t('settings.tabs.rewrites')
};

import {
  barOf,
  fractionOf as fraction,
  joinNames,
  percentOf as percent,
  splitNames
} from '../lib/form';

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
  palette,
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
  /*
   * The bar under a percentage field, on the bands this very page sets.
   *
   * No `figure` beside it here and that is right rather than missing: Global is
   * edited with no character in the realm, so there is no maximum to state and
   * `0/0` would be the lie `figureOf` refuses. A bar needs no maximum — a
   * percentage is already the whole of it.
   *
   * The two fields that define the bands are deliberately left plain: a control
   * that sets where amber starts, drawn in amber by its own answer, is a mirror
   * rather than a reading.
   */
  const barOfHealth = (fraction: number): ReturnType<typeof barOf> =>
    barOf(percent(fraction), draft.ui.vitals.hp);
  const barOfMana = (fraction: number): ReturnType<typeof barOf> =>
    barOf(percent(fraction), draft.ui.vitals.mana);
  /*
   * Only the dark ones, because that is the whole of what this setting means.
   * A select that offered a light theme here would be offering to keep the
   * console dark and then hand it a light palette — `normalizeConsoleUi` coerces
   * that away, and a form must not offer what the file refuses.
   */
  const darkThemes = useMemo(
    () => themesOfAppearance('dark').map((id) => ({ id, label: THEMES[id].label })),
    []
  );
  /*
   * `theme` first because it is the default and the only entry that is not a
   * palette, then the seven in registration order, each labelled with the way
   * it reads. Built here rather than inline so the memoised form is not handed
   * a new array every keystroke.
   */
  const consolePalettes = useMemo(
    () => [
      {
        value: 'theme',
        label: t('settings.client.appearance.consolePaletteFollow')
      },
      ...TERMINAL_THEME_IDS.map((id) => ({
        value: id,
        // Two literal calls rather than one on a conditional key: the coverage
        // test reads only the literal after `t(`.
        label:
          TERMINAL_THEMES[id].appearance === 'dark'
            ? t('settings.client.appearance.consolePaletteDark', {
                paletteLabel: TERMINAL_THEMES[id].label
              })
            : t('settings.client.appearance.consolePaletteLight', {
                paletteLabel: TERMINAL_THEMES[id].label
              })
      }))
    ],
    []
  );

  return (
    /*
      The rail and the form are siblings, not nested: `.settings-body` is the
      grid, so the rail has to be one of its children to have a column of its
      own. The character page puts them side by side the same way.
    */
    <>
      <SettingsNav
        onSection={(id: string) => setSection(id as Section)}
        section={shown}
        sections={SECTIONS[scope].map((id) => ({
          id,
          label: SECTION_LABEL[id],
          fieldsets: SECTION_FIELDSETS[id]
        }))}
      />
      <form
        className="settings-form"
        data-section={shown}
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
                onChange={(value) =>
                  patch('terminal', { fontSize: Number.parseInt(value, 10) || 0 })
                }
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
                onChange={(value) =>
                  patch('ui', { density: value as GlobalDraft['ui']['density'] })
                }
                options={[
                  { value: 'auto', label: t('settings.client.appearance.densityAuto') },
                  {
                    value: 'comfortable',
                    label: t('settings.client.appearance.densityComfortable')
                  },
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
                  { value: 'right', label: t('settings.client.appearance.tabsRight') },
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
            <CheckField
              checked={draft.ui.showLogo}
              label={t('settings.client.appearance.showLogo')}
              name="global-show-logo"
              onChange={(value) => patch('ui', { showLogo: value })}
            />

            {/*
            The console's own colours, above the pair below because it outranks
            them: naming a palette settles what the console looks like, and the
            two keys under it only answer the case where nothing was named. The
            offer is grouped by which way round each palette reads, since a
            light palette on a dark theme is a decision, not an accident.
          */}
            <SelectField
              hint={t('settings.client.appearance.consolePaletteHint')}
              label={t('settings.client.appearance.consolePaletteLabel')}
              name="global-console-palette"
              onChange={(value) =>
                patch('ui', { consolePalette: value as GlobalDraft['ui']['consolePalette'] })
              }
              options={consolePalettes}
              value={draft.ui.consolePalette}
            />

            {/*
            The switch and the choice it discloses, on one row — the pattern
            Auto-Retreat and Anti-Idle already use. Both are drawn under every
            theme, not only a light one: a setting that vanished when you
            switched to a dark theme would be one nobody could find again.

            The hint says outright when the palette above outranks them, rather
            than the pair quietly ceasing to do anything: a control that stops
            working without saying so is the worse of the two failures.
          */}
            <div className="settings-inline">
              <CheckField
                checked={draft.ui.consoleKeepDark}
                hint={
                  draft.ui.consolePalette === 'theme'
                    ? t('settings.client.appearance.consoleKeepDarkHint')
                    : t('settings.client.appearance.consoleKeepDarkOutranked')
                }
                label={t('settings.client.appearance.consoleKeepDarkLabel')}
                name="global-console-keep-dark"
                onChange={(value) => patch('ui', { consoleKeepDark: value })}
              />
              {draft.ui.consoleKeepDark && (
                <SelectField
                  label={t('settings.client.appearance.consoleDarkThemeLabel')}
                  name="global-console-dark-theme"
                  onChange={(value) =>
                    patch('ui', {
                      consoleDarkTheme: value as GlobalDraft['ui']['consoleDarkTheme']
                    })
                  }
                  options={darkThemes.map((theme) => ({ value: theme.id, label: theme.label }))}
                  value={draft.ui.consoleDarkTheme}
                />
              )}
            </div>

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
                <CheckField
                  checked={draft.terminal.cursorBlink}
                  label={t('settings.client.appearance.cursorBlink')}
                  name="global-cursor-blink"
                  onChange={(value) => patch('terminal', { cursorBlink: value })}
                />
              </div>
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

              <fieldset className="settings-menus" data-fieldset="appearance-vitals">
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
              <fieldset className="settings-menus" data-fieldset="realm-login">
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
                        <input
                          aria-label={t('settings.login.stepRepeatAria', { stepNumber: index + 1 })}
                          checked={step.repeat ?? false}
                          className="repeat"
                          onChange={(event) =>
                            patch('connection', {
                              login: {
                                ...draft.connection.login,
                                steps: draft.connection.login.steps.map((entry, at) =>
                                  at === index ? { ...entry, repeat: event.target.checked } : entry
                                )
                              }
                            })
                          }
                          title={t('settings.login.stepRepeatTitle')}
                          type="checkbox"
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
            <div className="settings-inline">
              <NumberField
                hint={t('settings.combat.defendAfterRoundsHint')}
                label={t('settings.combat.defendAfterRounds')}
                name="global-defend-after-rounds"
                onChange={(value) =>
                  automation({
                    combat: {
                      ...draft.automation.combat,
                      defendAfterRounds: Number.parseInt(value, 10) || 0
                    }
                  })
                }
                value={String(draft.automation.combat.defendAfterRounds)}
              />
            </div>
            <CheckField
              checked={draft.automation.combat.retaliate}
              hint={t('settings.combat.hitBackHint')}
              label={t('settings.combat.hitBack')}
              name="global-retaliate"
              onChange={(value) =>
                automation({ combat: { ...draft.automation.combat, retaliate: value } })
              }
            />
            <CheckField
              checked={draft.automation.combat.politeAttacks}
              hint={t('settings.combat.politeAttacksHint')}
              label={t('settings.combat.politeAttacks')}
              name="global-polite-attacks"
              onChange={(value) =>
                automation({ combat: { ...draft.automation.combat, politeAttacks: value } })
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
            <CheckField
              checked={draft.automation.combat.hideForOpener}
              hint={t('settings.combat.hideForOpenerHint')}
              label={t('settings.combat.hideForOpener')}
              name="global-hide-for-opener"
              onChange={(value) =>
                automation({ combat: { ...draft.automation.combat, hideForOpener: value } })
              }
            />

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
                value={String(draft.automation.combat.maxMobs)}
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
            </div>

            <fieldset className="settings-menus" data-fieldset="combat-monsters">
              <legend>{t('settings.combat.monstersLegend')}</legend>
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
            <fieldset className="settings-menus" data-fieldset="combat-mob-rules">
              <legend>{t('settings.combat.mobRuleLegend')}</legend>
              <p className="settings-note">{t('settings.combat.mobRuleNote')}</p>
              {/* No suggestions here, and deliberately: this page belongs to no
                character and therefore to no realm, and the monsters one realm
                names mean nothing on another. The field is typable, which is
                what it is for a character on a realm the client holds no data
                for either. */}
              <MobRuleList
                known={[]}
                namePrefix="global-mob-rule"
                spells={realmSpells}
                onChange={(rows) =>
                  automation({ combat: { ...draft.automation.combat, mobRules: rows } })
                }
                rows={draft.automation.combat.mobRules}
              />
            </fieldset>
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
            <fieldset className="settings-menus" data-fieldset="health-recover">
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
                  bar={barOfHealth(draft.automation.health.restBelow)}
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
                  bar={barOfHealth(draft.automation.health.restTo)}
                  value={percent(draft.automation.health.restTo)}
                />
                <NumberField
                  hint={t('settings.health.restBeforeTrapsHint')}
                  label={t('settings.health.restBeforeTrapsLabel')}
                  name="global-rest-before-traps"
                  onChange={(value) =>
                    automation({
                      health: { ...draft.automation.health, restBeforeTraps: fraction(value) }
                    })
                  }
                  bar={barOfHealth(draft.automation.health.restBeforeTraps)}
                  value={percent(draft.automation.health.restBeforeTraps)}
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
                  bar={barOfMana(draft.automation.health.meditateBelow)}
                  value={percent(draft.automation.health.meditateBelow)}
                />
              </div>
              <CheckField
                checked={draft.automation.health.restNextDoor}
                hint={t('settings.health.restNextDoorHint')}
                label={t('settings.health.restNextDoor')}
                name="global-rest-next-door"
                onChange={(value) =>
                  automation({ health: { ...draft.automation.health, restNextDoor: value } })
                }
              />
            </fieldset>

            {/*
            The player's own *use this when that* list, on this page too
            (todo 00). It was the character page's alone, which made it the one
            overlay-able list a new character could never be given a starting
            point for — the two named slots that used to stand here are gone,
            and this says everything they said.

            No `serving` suggestions: the realm's item list is a session's
            answer about a character's realm, and this page is every realm.
          */}
            <fieldset className="settings-menus" data-fieldset="health-potions">
              <legend>{t('settings.health.potionRuleLegend')}</legend>
              <p className="settings-note">{t('settings.health.potionRuleNote')}</p>
              <PotionList
                namePrefix="global-potion"
                onChange={(potions) =>
                  automation({ health: { ...draft.automation.health, potions } })
                }
                potions={draft.automation.health.potions}
                serving={{}}
              />
              {/* The realm's own half of the same list. No rows drawn beside
                  it here: which wards exist is a property of a realm, and this
                  page is every realm. */}
              <CheckField
                checked={draft.automation.health.useWards}
                hint={t('settings.health.useWardsHint')}
                label={t('settings.health.useWards')}
                name="global-use-wards"
                onChange={(value) =>
                  automation({ health: { ...draft.automation.health, useWards: value } })
                }
              />
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="health-retreat">
              <legend>{t('settings.health.retreatLegend')}</legend>
              <p className="settings-note">{t('settings.health.retreatHint')}</p>
              {/* The switch and the two figures it runs on are one row, the same
                shape a character's own Health tab draws them in. */}
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.retreat.enabled}
                  label={t('settings.health.retreatLabel')}
                  name="global-retreat"
                  onChange={(value) =>
                    automation({ retreat: { ...draft.automation.retreat, enabled: value } })
                  }
                />
                <NumberField
                  label={t('settings.health.belowHealthLabel')}
                  name="global-retreat-health"
                  onChange={(value) =>
                    automation({
                      retreat: { ...draft.automation.retreat, belowHealth: fraction(value) }
                    })
                  }
                  bar={barOfHealth(draft.automation.retreat.belowHealth)}
                  value={percent(draft.automation.retreat.belowHealth)}
                />
                <NumberField
                  hint={t('settings.health.belowManaHint')}
                  label={t('settings.health.belowManaLabel')}
                  name="global-retreat-mana"
                  onChange={(value) =>
                    automation({
                      retreat: { ...draft.automation.retreat, belowMana: fraction(value) }
                    })
                  }
                  bar={barOfMana(draft.automation.retreat.belowMana)}
                  value={percent(draft.automation.retreat.belowMana)}
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
              {/* The command is the realm's own, so Global states none (todo 813). */}
              <FleeGotoFields
                bar={(typed) => barOfHealth(fraction(typed))}
                form={{
                  fleeGoto: draft.automation.fleeGoto.enabled,
                  fleeGotoBelow: String(percent(draft.automation.fleeGoto.belowHealth)),
                  fleeGotoCommand: draft.automation.fleeGoto.command
                }}
                namePrefix="global-"
                patch={(change) =>
                  automation({
                    fleeGoto: {
                      ...draft.automation.fleeGoto,
                      ...(change.fleeGoto === undefined ? {} : { enabled: change.fleeGoto }),
                      ...(change.fleeGotoBelow === undefined
                        ? {}
                        : { belowHealth: fraction(change.fleeGotoBelow) })
                    }
                  })
                }
                withoutCommand
              />
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="health-hangup">
              <legend>{t('settings.health.hangUpLegend')}</legend>
              <p className="settings-warn">{t('settings.health.hangUpWarning')}</p>
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.hangUp.enabled}
                  label={t('settings.health.hangUpLabel')}
                  name="global-hangup"
                  onChange={(value) =>
                    automation({ hangUp: { ...draft.automation.hangUp, enabled: value } })
                  }
                />
                <NumberField
                  label={t('settings.health.belowHealthLabel')}
                  name="global-hangup-health"
                  onChange={(value) =>
                    automation({
                      hangUp: { ...draft.automation.hangUp, belowHealth: fraction(value) }
                    })
                  }
                  bar={barOfHealth(draft.automation.hangUp.belowHealth)}
                  value={percent(draft.automation.hangUp.belowHealth)}
                />
              </div>
              <CheckField
                checked={draft.automation.hangUp.penalties}
                hint={t('settings.health.hangPenaltiesHint')}
                label={t('settings.health.hangPenaltiesLabel')}
                name="global-hang-penalties"
                onChange={(value) =>
                  automation({ hangUp: { ...draft.automation.hangUp, penalties: value } })
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

            <fieldset className="settings-menus" data-fieldset="health-pvp">
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
            <CheckField
              checked={draft.automation.spells.autoChoose}
              hint={t('settings.spells.autoChooseHint')}
              label={t('settings.spells.autoChoose')}
              name="global-spell-auto-choose"
              onChange={(value) =>
                automation({ spells: { ...draft.automation.spells, autoChoose: value } })
              }
            />
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
              <SpellField
                hint={t('settings.spells.fallbackCastHint')}
                label={t('settings.spells.fallbackCastLabel')}
                name="global-spell-fallback"
                onChange={(value) =>
                  automation({ spells: { ...draft.automation.spells, attackFallback: value } })
                }
                spells={realmSpells}
                value={draft.automation.spells.attackFallback}
              />
              <NumberField
                hint={t('settings.spells.attackCastsHint')}
                label={t('settings.spells.attackCastsLabel')}
                name="global-attack-casts"
                onChange={(value) =>
                  automation({
                    spells: {
                      ...draft.automation.spells,
                      attackCasts: Math.max(0, Number.parseInt(value, 10) || 0)
                    }
                  })
                }
                value={String(draft.automation.spells.attackCasts)}
              />
              <NumberField
                hint={t('settings.spells.minManaHint')}
                label={t('settings.spells.minManaLabel')}
                name="global-min-mana"
                onChange={(value) =>
                  automation({ spells: { ...draft.automation.spells, minMana: fraction(value) } })
                }
                bar={barOfMana(draft.automation.spells.minMana)}
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
                bar={barOfMana(draft.automation.spells.areaMinMana)}
                value={percent(draft.automation.spells.areaMinMana)}
              />
              <NumberField
                hint={t('settings.spells.areaCastsHint')}
                label={t('settings.spells.areaCastsLabel')}
                name="global-area-casts"
                onChange={(value) =>
                  automation({
                    spells: {
                      ...draft.automation.spells,
                      areaCasts: Math.max(0, Number.parseInt(value, 10) || 0)
                    }
                  })
                }
                value={String(draft.automation.spells.areaCasts)}
              />
            </div>
            <fieldset className="settings-menus" data-fieldset="spells-heal">
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
                  bar={barOfHealth(draft.automation.spells.healBelow)}
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
                  bar={barOfHealth(draft.automation.spells.healBelowInCombat)}
                  value={percent(draft.automation.spells.healBelowInCombat)}
                />
                <NumberField
                  hint={t('settings.spells.healToHint')}
                  label={t('settings.spells.healToLabel')}
                  name="global-heal-to"
                  onChange={(value) =>
                    automation({ spells: { ...draft.automation.spells, healTo: fraction(value) } })
                  }
                  bar={barOfHealth(draft.automation.spells.healTo)}
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
              <CheckField
                checked={draft.automation.spells.invokeItems}
                hint={t('settings.spells.invokeItemsHint')}
                label={t('settings.spells.invokeItemsLabel')}
                name="global-invoke-items"
                onChange={(value) =>
                  automation({ spells: { ...draft.automation.spells, invokeItems: value } })
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

            <fieldset className="settings-menus" data-fieldset="spells-cures">
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

            <fieldset className="settings-menus" data-fieldset="spells-blessings">
              <legend>{t('settings.spells.blessingsLegend')}</legend>
              <p className="settings-note">{t('settings.spells.blessingsNote')}</p>
              <CheckField
                checked={draft.automation.spells.autoBless}
                hint={t('settings.spells.autoBlessHint')}
                label={t('settings.spells.autoBlessLabel')}
                name="global-auto-bless"
                onChange={(value) =>
                  automation({ spells: { ...draft.automation.spells, autoBless: value } })
                }
              />
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
            <fieldset className="settings-menus" data-fieldset="party-follow">
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
            <fieldset className="settings-menus" data-fieldset="party-healing">
              <legend>{t('settings.party.healLegend')}</legend>
              <p className="settings-note">{t('settings.party.healNote')}</p>
              <div className="settings-inline">
                <NumberField
                  hint={t('settings.party.askHealHint')}
                  label={t('settings.party.askHealLabel')}
                  name="global-party-ask-heal"
                  onChange={(value) =>
                    automation({
                      party: { ...draft.automation.party, askForHealBelow: fraction(value) }
                    })
                  }
                  bar={barOfHealth(draft.automation.party.askForHealBelow)}
                  value={percent(draft.automation.party.askForHealBelow)}
                />
              </div>
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
            <fieldset className="settings-menus" data-fieldset="party-remotes">
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
            {/* Four questions, four fieldsets (todo 00) -- the character page
              groups them the same way, because one setting keeps one shape on
              every page that shows it. */}
            <fieldset className="settings-menus" data-fieldset="movement-doors">
              <legend>{t('settings.movement.doorsLegend')}</legend>
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.movement.openDoors}
                  hint={t('settings.movement.openDoorsHint')}
                  label={t('settings.movement.openDoors')}
                  name="global-open-doors"
                  onChange={(value) =>
                    automation({ movement: { ...draft.automation.movement, openDoors: value } })
                  }
                />
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
              </div>
              {/*
              Picking above bashing, in the order the walker tries them: one
              costs a command and the other costs a command and some health.
            */}
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.movement.pickLocks}
                  hint={t('settings.movement.pickLocksHint')}
                  label={t('settings.movement.pickLocks')}
                  name="global-pick-locks"
                  onChange={(value) =>
                    automation({ movement: { ...draft.automation.movement, pickLocks: value } })
                  }
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
              </div>
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.movement.bashDoors}
                  hint={t('settings.movement.bashDoorsHint')}
                  label={t('settings.movement.bashDoors')}
                  name="global-bash-doors"
                  onChange={(value) =>
                    automation({ movement: { ...draft.automation.movement, bashDoors: value } })
                  }
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
              </div>
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="movement-stealth">
              <legend>{t('settings.movement.stealthLegend')}</legend>
              <CheckField
                checked={draft.automation.movement.sneak}
                hint={t('settings.movement.sneakHint')}
                label={t('settings.movement.sneak')}
                name="global-sneak"
                onChange={(value) =>
                  automation({ movement: { ...draft.automation.movement, sneak: value } })
                }
              />
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="movement-light">
              <legend>{t('settings.movement.lightLegend')}</legend>
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
                      automation({
                        movement: { ...draft.automation.movement, lightDimRooms: value }
                      })
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
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="movement-afflictions">
              <legend>{t('settings.movement.afflictionsLegend')}</legend>
              <ConditionWaitFields
                namePrefix="global-"
                onChange={(waits) =>
                  automation({ movement: { ...draft.automation.movement, ...waits } })
                }
                value={draft.automation.movement}
              />
              <CheckField
                checked={draft.automation.movement.fightOnArrival}
                hint={t('settings.movement.fightOnArrivalHint')}
                label={t('settings.movement.fightOnArrival')}
                name="global-fight-on-arrival"
                onChange={(value) =>
                  automation({ movement: { ...draft.automation.movement, fightOnArrival: value } })
                }
              />
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="movement-keep-out">
              <legend>{t('settings.movement.keepOutLegend')}</legend>
              <TextField
                hint={t('settings.movement.keepOutOfHint')}
                label={t('settings.movement.keepOutOf')}
                name="global-keep-out-of"
                onChange={(value) =>
                  automation({
                    movement: { ...draft.automation.movement, keepOutOf: splitNames(value) }
                  })
                }
                placeholder={t('settings.movement.keepOutOfPlaceholder')}
                value={joinNames(draft.automation.movement.keepOutOf)}
                wide
              />
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="movement-carry">
              <legend>{t('settings.movement.carryLegend')}</legend>
              <CheckField
                checked={draft.automation.movement.recoverGear}
                hint={t('settings.movement.recoverGearHint')}
                label={t('settings.movement.recoverGear')}
                name="global-recover-gear"
                onChange={(value) =>
                  automation({ movement: { ...draft.automation.movement, recoverGear: value } })
                }
              />
              <CheckField
                checked={draft.automation.movement.collectKeys}
                hint={t('settings.movement.collectKeysHint')}
                label={t('settings.movement.collectKeys')}
                name="global-collect-keys"
                onChange={(value) =>
                  automation({ movement: { ...draft.automation.movement, collectKeys: value } })
                }
              />
            </fieldset>

            <CarrySections
              banking={draft.automation.banking}
              drop={draft.automation.drop}
              idPrefix="global-"
              loot={draft.automation.loot}
              onChange={automation}
              search={draft.automation.search}
            />

            <LoopSection
              catalogue={catalogue}
              loops={draft.loops}
              note={t('settings.global.movement.loopsNote')}
              onDonePicking={onDonePicking}
              onOpenPicker={onOpenPicker}
              onToggle={onToggleLoop}
              picking={picking}
            />

            {/*
              Where a character should be at all (todo 05). Beside the loops
              and the floor below, because the three answer one question: where
              this character spends its night, and what it takes to be worth
              staying.
            */}
            <fieldset className="settings-menus" data-fieldset="hunting">
              <legend>{t('settings.hunting.legend')}</legend>
              <p className="settings-note">{t('settings.hunting.note')}</p>
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.hunting.enabled}
                  hint={t('settings.hunting.autoHint')}
                  label={t('settings.hunting.auto')}
                  name="global-hunt-auto"
                  onChange={(value) =>
                    automation({ hunting: { ...draft.automation.hunting, enabled: value } })
                  }
                />
                {draft.automation.hunting.enabled && (
                  <NumberField
                    hint={t('settings.hunting.radiusHint')}
                    label={t('settings.hunting.radius')}
                    name="global-hunt-radius"
                    onChange={(value) =>
                      automation({
                        hunting: {
                          ...draft.automation.hunting,
                          radius: Math.max(0, Number.parseInt(value, 10) || 0)
                        }
                      })
                    }
                    value={
                      draft.automation.hunting.radius > 0
                        ? String(draft.automation.hunting.radius)
                        : ''
                    }
                  />
                )}
              </div>
            </fieldset>

            {/*
            Not behind Advanced: a floor that stops the lap is a decision about
            the character's night, not a number with a right answer already.
          */}
            <div className="settings-inline">
              <NumberField
                hint={t('settings.global.movement.minExpRateHint')}
                label={t('settings.global.movement.minExpRateLabel')}
                name="global-min-exp-rate"
                onChange={(value) =>
                  automation({
                    walk: {
                      ...draft.automation.walk,
                      minExpPerHour: Math.max(0, Number.parseInt(value, 10) || 0)
                    }
                  })
                }
                value={String(draft.automation.walk.minExpPerHour)}
              />
            </div>
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
              {/* The switch, when it fires and what it sends: one row, because
                the two figures mean nothing without the switch above them. */}
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.idle.enabled}
                  label={t('settings.global.movement.idleEnabled')}
                  name="global-idle"
                  onChange={(value) =>
                    automation({ idle: { ...draft.automation.idle, enabled: value } })
                  }
                />
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

        {shown === 'train' && (
          <fieldset className="settings-menus" data-fieldset="train">
            <legend>{t('settings.train.legend')}</legend>
            <p className="settings-warn">{t('settings.train.warning')}</p>
            <CheckField
              checked={draft.automation.train.stats}
              hint={t('settings.train.statsHint')}
              label={t('settings.train.stats')}
              name="global-train-stats"
              onChange={(value) =>
                automation({ train: { ...draft.automation.train, stats: value } })
              }
            />
            <p className="settings-note">{t('settings.train.wantedNote')}</p>
            <div className="settings-inline">
              <NumberField
                label={t('settings.train.strength')}
                name="global-train-strength"
                onChange={(value) =>
                  automation({
                    train: {
                      ...draft.automation.train,
                      wanted: {
                        ...draft.automation.train.wanted,
                        strength: Number.parseInt(value, 10) || 0
                      }
                    }
                  })
                }
                value={draft.automation.train.wanted.strength}
              />
              <NumberField
                label={t('settings.train.intellect')}
                name="global-train-intellect"
                onChange={(value) =>
                  automation({
                    train: {
                      ...draft.automation.train,
                      wanted: {
                        ...draft.automation.train.wanted,
                        intellect: Number.parseInt(value, 10) || 0
                      }
                    }
                  })
                }
                value={draft.automation.train.wanted.intellect}
              />
              <NumberField
                label={t('settings.train.willpower')}
                name="global-train-willpower"
                onChange={(value) =>
                  automation({
                    train: {
                      ...draft.automation.train,
                      wanted: {
                        ...draft.automation.train.wanted,
                        willpower: Number.parseInt(value, 10) || 0
                      }
                    }
                  })
                }
                value={draft.automation.train.wanted.willpower}
              />
              <NumberField
                label={t('settings.train.agility')}
                name="global-train-agility"
                onChange={(value) =>
                  automation({
                    train: {
                      ...draft.automation.train,
                      wanted: {
                        ...draft.automation.train.wanted,
                        agility: Number.parseInt(value, 10) || 0
                      }
                    }
                  })
                }
                value={draft.automation.train.wanted.agility}
              />
              <NumberField
                label={t('settings.train.health')}
                name="global-train-health"
                onChange={(value) =>
                  automation({
                    train: {
                      ...draft.automation.train,
                      wanted: {
                        ...draft.automation.train.wanted,
                        health: Number.parseInt(value, 10) || 0
                      }
                    }
                  })
                }
                value={draft.automation.train.wanted.health}
              />
              <NumberField
                label={t('settings.train.charm')}
                name="global-train-charm"
                onChange={(value) =>
                  automation({
                    train: {
                      ...draft.automation.train,
                      wanted: {
                        ...draft.automation.train.wanted,
                        charm: Number.parseInt(value, 10) || 0
                      }
                    }
                  })
                }
                value={draft.automation.train.wanted.charm}
              />
            </div>
          </fieldset>
        )}

        {shown === 'gear' && (
          <>
            {/*
              The kit, and when to be in it (todo 00). No monster suggestions
              here: which monsters exist is a property of a realm, and this
              page is every realm — the field stays typable, as the potion
              rules' does.
            */}
            <fieldset className="settings-menus" data-fieldset="gear">
              <legend>{t('settings.gear.legend')}</legend>
              <p className="settings-note">{t('settings.gear.note')}</p>
              <CheckField
                checked={draft.automation.gear.enabled}
                hint={t('settings.gear.enabledHint')}
                label={t('settings.gear.enabled')}
                name="global-gear-enabled"
                onChange={(value) =>
                  automation({ gear: { ...draft.automation.gear, enabled: value } })
                }
              />
              <GearSetList
                mobs={[]}
                namePrefix="global-gear-set"
                onChange={(sets) => automation({ gear: { ...draft.automation.gear, sets } })}
                sets={draft.automation.gear.sets}
              />
            </fieldset>

            <fieldset className="settings-menus" data-fieldset="gear-offround">
              <legend>{t('settings.gear.offRoundLegend')}</legend>
              <p className="settings-note">{t('settings.gear.offRoundNote')}</p>
              <div className="settings-inline">
                <TextField
                  hint={t('settings.gear.offRoundItemHint')}
                  label={t('settings.gear.offRoundItem')}
                  name="global-gear-offround-item"
                  onChange={(value) =>
                    automation({
                      gear: {
                        ...draft.automation.gear,
                        offRound: { ...draft.automation.gear.offRound, item: value }
                      }
                    })
                  }
                  value={draft.automation.gear.offRound.item}
                />
                <NumberField
                  hint={t('settings.gear.offRoundEveryHint')}
                  label={t('settings.gear.offRoundEvery')}
                  name="global-gear-offround-every"
                  onChange={(value) =>
                    automation({
                      gear: {
                        ...draft.automation.gear,
                        offRound: {
                          ...draft.automation.gear.offRound,
                          everyRounds: Number.parseInt(value, 10) || 0
                        }
                      }
                    })
                  }
                  value={String(draft.automation.gear.offRound.everyRounds)}
                />
              </div>
            </fieldset>
          </>
        )}

        {shown === 'quests' && (
          <fieldset className="settings-menus" data-fieldset="quests">
            <legend>{t('settings.quests.legend')}</legend>
            {/*
              In the open, like opening fights unasked: a run has the character
              for as long as a chain takes, and the sentence that says so is
              not a tooltip.
            */}
            <p className="settings-warn">{t('settings.quests.warning')}</p>
            <CheckField
              checked={draft.automation.quests.enabled}
              hint={t('settings.quests.enabledHint')}
              label={t('settings.quests.enabled')}
              name="global-quests-enabled"
              onChange={(value) => automation({ quests: { enabled: value } })}
            />
          </fieldset>
        )}

        {shown === 'remotes' && (
          <fieldset className="settings-menus" data-fieldset="remotes">
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

        {shown === 'rewrites' && (
          <>
            <fieldset className="settings-menus" data-fieldset="rewrites-statline">
              <legend>{t('settings.statline.legend')}</legend>
              <CheckField
                checked={draft.automation.statline.control}
                hint={t('settings.statline.controlHint')}
                label={t('settings.statline.controlLabel')}
                name="global-statline-control"
                onChange={(value) => automation({ statline: { control: value } })}
              />
              <p className="settings-note">{t('settings.statline.templateNote')}</p>
            </fieldset>
            <RewritesDesigner
              figures={null}
              idPrefix="global-rewrites"
              onChange={(next) => patch('ui', { rewrites: next })}
              palette={palette}
              value={draft.ui.rewrites}
            />
          </>
        )}

        {shown === 'alerts' && (
          <>
            {/*
            The player's own rows, and the only thing that decides what is
            alerted (todo 02). The same fieldset the character page draws, from
            the same component: this page is where a new character's alerts are
            copied from, so a list that existed on one page only was a starting
            point nobody could set.
          */}
            <fieldset className="settings-menus" data-fieldset="alerts-rules">
              <legend>{t('settings.alerts.ruleLegend')}</legend>
              <p className="settings-note">{t('settings.alerts.ruleNote')}</p>
              <AlertList
                namePrefix="global-alert-rule"
                onChange={(rules) => patch('ui', { alerts: { ...draft.ui.alerts, rules } })}
                rules={draft.ui.alerts.rules}
              />
            </fieldset>
            {/*
            Beside the alerts, because both are about a player who is not
            looking: alerts are what they hear about the character, and this
            is what the character says for them.
          */}
            <fieldset className="settings-menus" data-fieldset="alerts-afk">
              <legend>{t('settings.afk.legend')}</legend>
              <div className="settings-inline">
                <CheckField
                  checked={draft.automation.afk.enabled}
                  hint={t('settings.afk.enabledHint')}
                  label={t('settings.afk.enabled')}
                  name="global-afk-enabled"
                  onChange={(value) =>
                    automation({ afk: { ...draft.automation.afk, enabled: value } })
                  }
                />
                <NumberField
                  hint={t('settings.afk.afterHint')}
                  label={t('settings.afk.afterLabel')}
                  name="global-afk-after"
                  onChange={(value) =>
                    automation({
                      afk: {
                        ...draft.automation.afk,
                        afterMinutes: Math.max(1, Number.parseInt(value, 10) || 5)
                      }
                    })
                  }
                  value={String(draft.automation.afk.afterMinutes)}
                />
                <TextField
                  hint={t('settings.afk.replyHint')}
                  label={t('settings.afk.replyLabel')}
                  name="global-afk-reply"
                  onChange={(value) =>
                    automation({ afk: { ...draft.automation.afk, reply: value } })
                  }
                  value={draft.automation.afk.reply}
                />
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
                onChange={(value) =>
                  patch('logging', { maxBytes: Number.parseInt(value, 10) || 0 })
                }
                value={draft.logging.maxBytes}
              />
            </Advanced>
          </>
        )}

        <div className="settings-actions">{actions}</div>
      </form>
    </>
  );
}
