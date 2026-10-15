/**
 * A character's own form, section by section: every field of `CharacterFields`
 * drawn as the section on screen asks. The screen owns the form's history, its
 * saving and which character it is; this draws the one it is handed and reports
 * each edit through `patch`. The why is in `mudengine-settings`.
 */
import { useMemo, type FormEvent } from 'react';
import type { StatlineFigures } from '@shared/statline';
import type { TerminalPalette } from '@shared/themes';
import AlertList from './AlertList';
import MobRuleList from './MobRuleList';
import SettingsSection from './SettingsSection';
import { CHARACTER_SECTION_LABEL } from './characterNav';
import BetterGearFields from './BetterGearFields';
import GearSetList from './GearSetList';
import OffRoundFields from './OffRoundFields';
import GearSwitches from './GearSwitches';
import HangUpFieldset from './HangUpFieldset';
import LaidSettings from './LaidSettings';
import AfkFieldset from './AfkFieldset';
import AsksFieldset from './AsksFieldset';
import PotionList, { WardRules } from './PotionList';
import Icon from './Icon';
import LoginStepRows from './LoginStepRows';
import FormField, {
  CheckField,
  NumberField,
  PasswordField,
  SelectField,
  TextField
} from './FormField';
import Advanced from './Advanced';
import CarrySections from './CarrySections';
import BlessingFields from './BlessingFields';
import CureFields from './CureFields';
import RestFields from './RestFields';
import DoorsFieldset from './DoorsFieldset';
import RoutingFieldset from './RoutingFieldset';
import KeepOutFieldset from './KeepOutFieldset';
import type { MovementChoices } from '@shared/walkChoices';
import type { LiveSheet } from '../lib/liveSheet';
import HuntingFieldset from './HuntingFieldset';
import QuestsFieldset from './QuestsFieldset';
import PartyFields from './PartyFields';
import RetreatFieldset from './RetreatFieldset';
import ConditionWaitFields from './ConditionWaitFields';
import SneakAndRunFields from './SneakAndRunFields';
import LightFields from './LightFields';
import RecoverFields from './RecoverFields';
import DialFields from './DialFields';
import MonsterFields from './MonsterFields';
import FightOddsFields from './FightOddsFields';
import InvokeFields from './InvokeFields';
import AttackFields from './AttackFields';
import AttacksFieldset from './AttacksFieldset';
import DrainFields from './DrainFields';
import HealFields from './HealFields';
import LoopSection, { type LoopShelf } from './LoopSection';
import PlayerGrants from './PlayerGrants';
import RemoteList from './RemoteList';
import RemoteSwitches from './RemoteSwitches';
import AliasFields from './AliasFields';
import TrainStatFields from './TrainStatFields';
import RewritesDesigner from './RewriteDesigner';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { barOf, figureOf, LOCATE_OPTIONS } from '../lib/form';
import {
  ATTACK_KEYS,
  BLESSING_KEYS,
  blessingValuesOf,
  attackValuesOf,
  DRAIN_KEYS,
  drainValuesOf,
  HEAL_KEYS,
  healValuesOf,
  walksAnotherWorld,
  type CharacterFields,
  type CharacterSection
} from '../lib/characterForm';
import type { CharacterRealm } from '../hooks/useCharacterRealm';
import { PROFILE_ACCENTS } from '@shared/profiles';
import { asLocateWord } from '@shared/locate';
import { isThemePreference, THEME_IDS, THEMES } from '@shared/themes';
import type { ProfileEditable } from '@shared/ipc';
import type { Loop, ScopedLoop } from '@shared/loops';
import { ENCODINGS, type StreamEncoding } from '@shared/types';
import { type EngagePolicy, type Server, type VitalsUiConfig } from '@shared/config';
import { PVP_ACTIONS } from '@shared/safety';
import { ACTIONABLE_REMOTES } from '@shared/remotes';

/** Starting a new character from one that already works: see `copyOf`. */
export interface CopySource {
  /** The character chosen, or '' for the blank form. */
  from: string;
  choices: readonly Pick<ProfileEditable, 'id' | 'name' | 'error'>[];
  onChoose(id: string): void;
}

export interface CharacterFormProps {
  form: CharacterFields;
  /** One edit, recorded as one step of the screen's history. */
  patch(change: Partial<CharacterFields>): void;
  onSubmit(event: FormEvent): void;
  section: CharacterSection;
  /** A query is typed in the rail's find field: every section is drawn. */
  searching: boolean;
  /** A character not yet on disk: its id is chosen here, and saving takes a press. */
  creating: boolean;
  /** Offered only while creating, and only with a character to copy. */
  copy: CopySource | null;
  /** What the file on disk says about the character on screen; absent while creating. */
  shown: Pick<ProfileEditable, 'spellbook' | 'cureGates' | 'hasPassword'> | undefined;
  /** The realms a character may play on, and whose script and world it inherits. */
  servers: readonly Pick<Server, 'name' | 'login' | 'database'>[];
  onManageRealms(): void;
  firstFieldRef: React.RefObject<HTMLInputElement>;
  /** The live sheet: what the thresholds are percentages of, picklocks, Meditate. */
  sheet: LiveSheet;
  /** The vitals bands this character inherits, which each threshold's bar wears. */
  bands: VitalsUiConfig;
  /** The status line's preview figures, null for a sample. */
  figures: StatlineFigures | null;
  palette: TerminalPalette;
  realm: CharacterRealm;
  shelf: LoopShelf;
  inheritedLoops: ScopedLoop[];
  onToggleLoop(loop: Loop): void;
  /** The row under the form: the create button, or the way back and the removal. */
  actions: React.ReactNode;
}

/**
 * A character's own settings, drawn one section at a time.
 *
 * ## Two rules, and both have been broken here before
 *
 * **A section exists when there is a typed config block behind it, and not
 * because the nouns sort cleanly.** That is why there was no Combat section for
 * four phases: attack *rules* are `automation.rules`, and a form field for one
 * is a second representation of something the YAML already states precisely,
 * with its own comments explaining why.
 *
 * The sections are now **MegaMUD's own tabs** — Combat, Health, Spells,
 * Movement — and that is a change to the *labels*, not to the test. Each one
 * has a typed block behind it that a rule could not hold:
 *
 * - `automation.combat` — the question in the middle of it, *is the thing in
 *   front of me going to attack me, and is it a person*, is not one a guard
 *   expression can ask.
 * - `automation.health` — resting is not a condition, it is a *state the
 *   character is in* that the status line reports, that blocks nothing, and
 *   that moving or attacking ends by itself.
 * - `automation.spells` — one cast, at the mid-round tick, which is the one
 *   thing about a spell a rule genuinely cannot express: ~100 ms after the last
 *   swing, inside the round rather than after it.
 * - `automation.movement` — what a route may do on the way, which belongs to
 *   the walker's state machine rather than to a condition over character state.
 *
 * Everything else a caster or a healer wants — buffs, heals, when to loot, when
 * to give up — is still `automation.rules`, and the Spells section says so in
 * one line rather than not existing.
 *
 * **And a control is a label, a value and at most one sentence.** See
 * docs/terminology.md, which exists because this screen grew into a help
 * system one true paragraph at a time. The explanation moved to
 * `default.yaml`, where somebody editing YAML is actually asking for it; what
 * is left here is `Hint` — a mark that opens one sentence on hover, on focus
 * and on click. Two things stay in the open, both because they can cost a
 * character: opening fights unasked, and hanging up.
 */
export default function CharacterForm({
  form,
  patch,
  onSubmit,
  section,
  searching,
  creating,
  copy,
  shown,
  servers,
  onManageRealms,
  firstFieldRef,
  sheet,
  bands,
  figures,
  palette,
  realm,
  shelf,
  inheritedLoops,
  onToggleLoop,
  actions
}: CharacterFormProps): React.JSX.Element {
  const { trainers, serving, wards, mobs, banks } = realm;
  const shows = (id: CharacterSection): boolean => searching || section === id;
  const sectionOf = (id: CharacterSection) => ({
    id,
    label: CHARACTER_SECTION_LABEL[id],
    searching
  });
  const moveChoice = (change: Partial<MovementChoices>): void =>
    patch({ moveChoices: { ...form.moveChoices, ...change } });
  /**
   * What the character form's spell pickers offer: the shown character's own
   * book, read by `sp`/`pow` and persisted with its belongings. Null is
   * *never read* — the form says so and gates nothing on it.
   */
  const shownBook = useMemo(() => {
    const spells = shown?.spellbook ?? [];
    return {
      spells,
      unread: (shown?.spellbook ?? null) === null,
      gates: shown?.cureGates ?? null
    };
  }, [shown]);
  /*
   * A threshold field holds the percent as typed, so the figure is composed
   * from the string rather than from the stored fraction: what somebody wants
   * to see beside a half-typed `7` is what `7` would mean, not what the last
   * saved value meant.
   */
  const ofHealth = (typed: string): string | null =>
    figureOf(Number.parseInt(typed, 10) || 0, sheet.hpMax);
  const ofMana = (typed: string): string | null =>
    figureOf(Number.parseInt(typed, 10) || 0, sheet.manaMax);
  const barOfHealth = (typed: string): ReturnType<typeof barOf> =>
    barOf(Number.parseInt(typed, 10) || 0, bands.hp);
  const barOfMana = (typed: string): ReturnType<typeof barOf> =>
    barOf(Number.parseInt(typed, 10) || 0, bands.mana);

  return (
    <form className="settings-form" data-section={section} onSubmit={onSubmit}>
      <LaidSettings laid={sheet.laid} />
      {shows('profile') && (
        <SettingsSection {...sectionOf('profile')}>
          {/*
            Start from a character that already works, rather than retyping
            a realm, a login script and every threshold. A select, because
            the question is asked while making one, and this is where
            somebody already is.
          */}
          {copy !== null && (
            <SelectField
              hint={t('settings.profile.copyFromHint')}
              label={t('settings.profile.copyFromLabel')}
              name="copy-from"
              onChange={copy.onChoose}
              options={[
                { value: '', label: t('settings.profile.copyFromNone') },
                ...copy.choices
                  .filter((entry) => entry.error === undefined)
                  .map((entry) => ({ value: entry.id, label: entry.name }))
              ]}
              value={copy.from}
            />
          )}

          {creating && (
            // The id is the session id, the log name, the capture
            // name and the key every remembered preference hangs
            // off — so it is worth saying it is not the display
            // name, once, where somebody is choosing it.
            <TextField
              hint={t('settings.profile.idHint')}
              inputRef={firstFieldRef}
              label={t('settings.profile.idLabel')}
              name="id"
              onChange={(value) => patch({ id: value })}
              placeholder={t('settings.profile.idPlaceholder')}
              spellCheck={false}
              value={form.id}
            />
          )}

          <TextField
            inputRef={creating ? undefined : firstFieldRef}
            label={t('settings.realms.nameLabel')}
            name="name"
            onChange={(value) => patch({ name: value })}
            placeholder={form.id || t('settings.profile.namePlaceholder')}
            value={form.name}
          />

          <FormField label={t('settings.profile.realmLabel')} name="realm" wide>
            {() => (
              <div className="settings-file">
                <select
                  onChange={(event) =>
                    patch({
                      serverName: event.target.value === '' ? null : event.target.value
                    })
                  }
                  value={form.serverName ?? ''}
                >
                  {servers.map((server) => (
                    <option key={server.name} value={server.name}>
                      {server.name}
                    </option>
                  ))}
                  <option value="">{t('settings.profile.realmElsewhere')}</option>
                </select>
                {/*
                  The other way to a realm, beside the field that
                  names one -- not only from the command palette. A
                  realm edited here is one that every character
                  referring to it by name plays on next connection.
                */}
                <button
                  className="quiet"
                  onClick={onManageRealms}
                  onMouseDown={keepFocus}
                  type="button"
                >
                  {t('settings.profile.manageRealms')}
                </button>
              </div>
            )}
          </FormField>

          {form.serverName === null && (
            <div className="settings-inline">
              <TextField
                label={t('settings.profile.hostLabel')}
                name="host"
                onChange={(value) => patch({ host: value })}
                placeholder={t('settings.profile.hostPlaceholder')}
                spellCheck={false}
                value={form.host}
              />
              <NumberField
                label={t('settings.profile.portLabel')}
                name="port"
                onChange={(value) => patch({ port: value })}
                value={form.port}
              />
            </div>
          )}

          {/*
            The encoding is the right answer already, and it is one
            nobody can choose well without knowing what CP437 is --
            so it sits behind a press rather than beside the
            username on the form somebody opened to type a
            password. Only for a character that spells its address
            out: one playing on a saved realm takes the realm's.
          */}
          {form.serverName === null && (
            <Advanced label={t('settings.advancedWire')}>
              <SelectField
                hint={t('settings.profile.encodingHint')}
                label={t('settings.profile.encodingLabel')}
                name="character-encoding"
                onChange={(value) => patch({ encoding: value as StreamEncoding })}
                options={ENCODINGS.map((encoding) => ({
                  value: encoding,
                  label: encoding
                }))}
                value={form.encoding}
              />
            </Advanced>
          )}

          <TextField
            autoComplete="off"
            label={t('settings.profile.usernameLabel')}
            name="username"
            onChange={(value) => patch({ username: value })}
            spellCheck={false}
            value={form.username}
          />

          {/* Never read back out of the file: a password that has
              crossed to a window can end up in a devtools
              snapshot, a crash report or a screenshot. */}
          <PasswordField
            hint={t('settings.profile.passwordHint')}
            label={t('settings.profile.passwordLabel')}
            name="password"
            onChange={(value) => patch({ password: value, changePassword: true })}
            placeholder={
              form.changePassword
                ? ''
                : shown?.hasPassword
                  ? t('settings.profile.passwordPlaceholderSet')
                  : t('settings.profile.passwordPlaceholderUnset')
            }
            value={form.password}
          />

          <DialFields onChange={patch} value={form} />

          <FormField label={t('settings.profile.accentLabel')} name="accent">
            {() => (
              <div className="settings-accents">
                {PROFILE_ACCENTS.map((accent) => (
                  <button
                    aria-label={accent}
                    className="accent-swatch"
                    data-accent={accent}
                    data-active={form.accent === accent ? 'true' : 'false'}
                    key={accent}
                    onClick={() => patch({ accent })}
                    onMouseDown={keepFocus}
                    type="button"
                  />
                ))}
              </div>
            )}
          </FormField>

          {/* Named for the page it is set on, not for the file
              behind it: somebody who wants to change it needs to
              know where to go, and "the options file" is a path
              rather than a place in the client. */}
          <SelectField
            label={t('settings.profile.themeLabel')}
            name="theme"
            onChange={(value) => patch({ theme: isThemePreference(value) ? value : '' })}
            options={[
              { value: '', label: t('settings.profile.themeInherit') },
              { value: 'system', label: t('settings.profile.themeSystem') },
              ...THEME_IDS.map((id) => ({ value: id, label: THEMES[id].label }))
            ]}
            value={form.theme}
          />
        </SettingsSection>
      )}

      {shows('login') && (
        <SettingsSection {...sectionOf('login')}>
          <fieldset className="settings-menus" data-fieldset="login">
            <legend>{t('settings.login.legend')}</legend>
            {/*
              Empty is the ordinary case and says so, rather than
              being an empty box somebody feels obliged to fill in.
              The script belongs to the realm -- every character on
              one meets the same menus -- and a character states its
              own only to differ, which in practice means a different
              character slot.
            */}
            <p className="settings-note">
              {t('settings.login.note', {
                realmOrAddress:
                  form.serverName === null
                    ? t('settings.login.noteFallbackAddress')
                    : form.serverName,
                /*
                  The placeholders, passed as values so they survive.
                  This is the one login string whose call site has
                  params, and `makeT` interpolates every `{name}` in
                  a string it is given any -- so a literal `{user}`
                  written in the copy would be reported as a value
                  nobody supplied. A replacement is not re-scanned,
                  so handing them in prints them.
                */
                user: '{user}',
                password: '{password}'
              })}
            </p>

            <LoginStepRows
              setting="connection.login.steps"
              onChange={(login) => patch({ login })}
              sendPlaceholder={t('settings.login.stepSendPlaceholder')}
              steps={form.login}
              whenPlaceholder={t('settings.login.stepWhenPlaceholder')}
            />

            {/*
              The first row on an empty list copies the realm's
              script, then adds the blank one.

              A character's list **replaces** the realm's, so adding
              one row to change a character slot used to leave a
              script of exactly that row -- and with the account now
              two rows of the script rather than two fields beside
              it, that silently took the login with it. Copying is
              what the player meant: the realm's menus plus my one
              change. The realm's own rows are the right source
              rather than a guessed pair, since a realm that words
              its username prompt differently says so there.
            */}
            <button
              className="quiet add-step"
              onClick={() =>
                patch({
                  login: [
                    ...(form.login.length === 0
                      ? (servers.find((entry) => entry.name === form.serverName)?.login ?? [])
                      : form.login),
                    { when: '', send: '' }
                  ]
                })
              }
              type="button"
            >
              <Icon name="plus" />
              <span>{t('settings.login.addStep')}</span>
            </button>

            {/* Its own locate word over its realm's, as its own script is (todo 811). */}
            <div className="settings-inline">
              <SelectField
                hint={t('settings.locate.hint')}
                label={t('settings.locate.label')}
                name="locate"
                setting="profile.locate"
                onChange={(value) => patch({ locate: asLocateWord(value) })}
                options={[{ value: '', label: t('settings.locate.realm') }, ...LOCATE_OPTIONS()]}
                value={form.locate ?? ''}
              />
            </div>
          </fieldset>
        </SettingsSection>
      )}

      {shows('combat') && (
        <SettingsSection {...sectionOf('combat')}>
          {/*
            The one warning left in the open on this screen, and the
            rule for why: a sentence stays out of a tooltip when the
            thing it warns about can cost a character. One sentence.
            docs/terminology.md §1.
          */}
          <fieldset className="settings-menus" data-fieldset="combat-attack">
            <legend>{t('settings.combat.attackLegend')}</legend>
            <p className="settings-warn">{t('settings.combat.openWarning')}</p>
            <CheckField
              checked={form.combat}
              label={t('settings.combat.attackForMe')}
              name="combat"
              setting="automation.combat.enabled"
              onChange={(value) => patch({ combat: value })}
            />
            {form.combat && (
              <>
                <CheckField
                  checked={form.combatRetaliate}
                  hint={t('settings.combat.hitBackHint')}
                  label={t('settings.combat.hitBack')}
                  name="retaliate"
                  setting="automation.combat.retaliate"
                  onChange={(value) => patch({ combatRetaliate: value })}
                />
                <CheckField
                  checked={form.combatPoliteAttacks}
                  hint={t('settings.combat.politeAttacksHint')}
                  label={t('settings.combat.politeAttacks')}
                  name="polite-attacks"
                  setting="automation.combat.politeAttacks"
                  onChange={(value) => patch({ combatPoliteAttacks: value })}
                />
                {/* What it opens fights with, and the three limits
                    that qualify it, on one row: each of the
                    numbers is meaningless without the policy
                    beside it. */}
                <div className="settings-inline">
                  <SelectField
                    hint={t('settings.combat.engageHint')}
                    label={t('settings.combat.engageLabel')}
                    name="engage"
                    setting="automation.combat.engage"
                    onChange={(value) => patch({ combatEngage: value as EngagePolicy })}
                    options={[
                      { value: 'none', label: t('settings.combat.engageNone') },
                      { value: 'hostile', label: t('settings.combat.engageHostile') },
                      { value: 'likely', label: t('settings.combat.engageLikely') },
                      { value: 'all', label: t('settings.combat.engageAll') }
                    ]}
                    value={form.combatEngage}
                  />
                  <NumberField
                    hint={t('settings.combat.maxMobsHint')}
                    label={t('settings.combat.maxMobsLabel')}
                    name="max-mobs"
                    setting="automation.combat.maxMobs"
                    onChange={(value) => patch({ combatMaxMobs: value })}
                    value={form.combatMaxMobs}
                  />
                  <NumberField
                    hint={t('settings.combat.minMobsHint')}
                    label={t('settings.combat.minMobsLabel')}
                    name="min-mobs"
                    setting="automation.combat.minMobs"
                    onChange={(value) => patch({ combatMinMobs: value })}
                    value={form.combatMinMobs}
                  />
                </div>
              </>
            )}
          </fieldset>

          {form.combat && (
            <>
              <AttacksFieldset chosen={realm.chosen} form={form} patch={patch} />

              <MonsterFields
                namePrefix=""
                caps={form.combatCaps}
                choices={form.combatChoices}
                onCaps={(next) => patch({ combatCaps: next })}
                onChoices={(next) => patch({ combatChoices: next })}
              />

              <fieldset className="settings-menus" data-fieldset="combat-mob-rules">
                <legend>{t('settings.combat.mobRuleLegend')}</legend>
                {/* In the open: the band skips the weighing, and somebody could have
                    that wrong for a whole evening. */}
                <p className="settings-note">{t('settings.combat.mobRuleNote')}</p>
                <MobRuleList
                  setting="automation.combat.mobRules"
                  known={mobs}
                  namePrefix="mob-rule"
                  spells={shownBook.spells}
                  onChange={(rows) => patch({ combatMobRules: rows })}
                  rows={form.combatMobRules}
                />
              </fieldset>
            </>
          )}
          <FightOddsFields
            namePrefix=""
            choices={form.combatChoices}
            onChoices={(next) => patch({ combatChoices: next })}
          />
        </SettingsSection>
      )}

      {shows('health') && (
        <SettingsSection {...sectionOf('health')}>
          <fieldset className="settings-menus" data-fieldset="health-recover">
            <legend>{t('settings.health.recoverLegend')}</legend>
            <p className="settings-note">{t('settings.health.restingNote')}</p>
            <RestFields
              bands={bands}
              checks={form}
              maxima={sheet}
              meditate={sheet.meditate}
              namePrefix=""
              onChange={(field, value) => patch({ [field]: value })}
              onCheck={(field, value) => patch({ [field]: value })}
              spells={shownBook.spells}
              values={form}
            />
          </fieldset>

          <RetreatFieldset
            bar={{ hp: barOfHealth, mana: barOfMana }}
            figure={{ hp: ofHealth, mana: ofMana }}
            form={form}
            patch={patch}
          />

          <HangUpFieldset bar={barOfHealth} figure={ofHealth} form={form} patch={patch} />

          {/*
            *Use this item when that is true* (todo 19), and since
            todo 00 the only potion setting there is: two named
            slots stood above this with a name, a threshold and a
            shared verb each, and this says all of it plus the
            things they could not. The name field's suggestions are
            filtered by each row's own condition, from the realm.
          */}
          <fieldset className="settings-menus" data-fieldset="health-potions">
            <legend>{t('settings.health.potionRuleLegend')}</legend>
            <p className="settings-note">{t('settings.health.potionRuleNote')}</p>
            <PotionList
              setting="automation.health.potions"
              namePrefix="potion-rule"
              onChange={(potionRules) => patch({ potionRules })}
              potions={form.potionRules}
              serving={serving}
            />
            {/*
              And the realm's own rows of the same list (todo 02).
              A player writes *drink the antidote when poisoned*;
              the realm has already written *use the waterskin
              where the desert spell is cast*, and the switch is
              whether that half is obeyed. The rows are drawn
              because a switch over a rule nobody can read is the
              invisible setting this project refuses everywhere
              else — they say which realm's rules these are.
            */}
            <CheckField
              checked={form.useWards}
              hint={t('settings.health.useWardsHint')}
              label={t('settings.health.useWards')}
              name="use-wards"
              setting="automation.health.useWards"
              onChange={(value) => patch({ useWards: value })}
            />
            <WardRules rules={wards} />
          </fieldset>
        </SettingsSection>
      )}

      {shows('spells') && (
        <SettingsSection {...sectionOf('spells')}>
          {shownBook.unread && (
            <p className="settings-note">{t('settings.spells.bookUnreadNote')}</p>
          )}
          <fieldset className="settings-menus" data-fieldset="spells-round">
            <legend>{t('settings.spells.legend')}</legend>
            <AttackFields
              bands={bands.mana}
              manaMax={sheet.manaMax}
              namePrefix=""
              onChange={(field, value) => patch({ [ATTACK_KEYS[field]]: value })}
              onToggle={(field, value) => patch({ [ATTACK_KEYS[field]]: value })}
              spells={shownBook.spells}
              values={attackValuesOf(form)}
            />
            <p className="settings-note">{t('settings.spells.note')}</p>
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="spells-drain">
            <legend>{t('settings.spells.drainLegend')}</legend>
            <DrainFields
              bands={bands.hp}
              hpMax={sheet.hpMax}
              namePrefix=""
              onChange={(field, value) => patch({ [DRAIN_KEYS[field]]: value })}
              spells={shownBook.spells}
              values={drainValuesOf(form)}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="spells-heal">
            <legend>{t('settings.spells.healLegend')}</legend>
            <HealFields
              bands={bands}
              maxima={sheet}
              namePrefix=""
              onChange={(field, value) => patch({ [HEAL_KEYS[field]]: value })}
              onToggle={(field, value) => patch({ [HEAL_KEYS[field]]: value })}
              spells={shownBook.spells}
              values={healValuesOf(form)}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="spells-cures">
            <legend>{t('settings.spells.cureLegend')}</legend>
            <p className="settings-note">{t('settings.spells.cureNote')}</p>
            <CureFields
              cures={form.spellCures}
              gates={shownBook.gates}
              namePrefix="character"
              onChange={(spellCures) => patch({ spellCures })}
              spells={shownBook.spells}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="spells-blessings">
            <legend>{t('settings.spells.blessingsLegend')}</legend>
            <p className="settings-note">{t('settings.spells.blessingsNote')}</p>
            <BlessingFields
              namePrefix=""
              onBlessings={(spellBlessings) => patch({ spellBlessings })}
              onChange={(field, value) => patch({ [BLESSING_KEYS[field]]: value })}
              onToggle={(field, value) => patch({ [BLESSING_KEYS[field]]: value })}
              spells={shownBook.spells}
              values={blessingValuesOf(form)}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="spells-invoke">
            <legend>{t('settings.spells.invokeLegend')}</legend>
            <InvokeFields
              chosen={form.spellInvokeWith}
              enabled={form.spellInvokeItems}
              onChosen={(spellInvokeWith) => patch({ spellInvokeWith })}
              onEnabled={(spellInvokeItems) => patch({ spellInvokeItems })}
              realm={realm}
            />
          </fieldset>
        </SettingsSection>
      )}

      {shows('party') && (
        <SettingsSection {...sectionOf('party')}>
          <PartyFields
            bands={bands.hp}
            hpMax={sheet.hpMax}
            namePrefix=""
            onChange={(party) => patch({ party })}
            party={form.party}
          />
          {/*
            The party's `@` commands, here rather than beside the
            gang's on the Remotes page, because this is where
            somebody is thinking about what a party does together —
            and the Remotes page says the list is here.

            Drawn whether or not this character answers remotes at
            all: that switch is on another page, and a grid that
            vanished when it was off would be a control somebody
            has to already know about to find. The warning says so
            instead, the way the Gang card's does.
          */}
          <fieldset className="settings-menus" data-fieldset="party-remotes">
            <legend>{t('settings.party.remotesLegend')}</legend>
            <p className="settings-note">{t('settings.party.remotesNote')}</p>
            {form.answerRemotes ? null : (
              <p className="settings-warn">{t('settings.party.remotesOffWarning')}</p>
            )}
            <RemoteList
              allow={form.remoteParty}
              mode="party"
              onSet={(remote, stance) =>
                patch({
                  remoteParty:
                    stance === 'allow'
                      ? [...form.remoteParty, remote]
                      : form.remoteParty.filter((entry) => entry !== remote)
                })
              }
              onSetAll={(stance) =>
                patch({
                  remoteParty: stance === 'allow' ? [...ACTIONABLE_REMOTES] : []
                })
              }
              setting="automation.remotes.party"
              subject={t('settings.party.remotesLegend')}
            />
          </fieldset>
          <p className="settings-note">{t('settings.party.blessingsMoved')}</p>
        </SettingsSection>
      )}

      {shows('train') && (
        <SettingsSection {...sectionOf('train')}>
          <fieldset className="settings-menus" data-fieldset="train">
            <legend>{t('settings.train.legend')}</legend>
            <p className="settings-warn">{t('settings.train.warning')}</p>
            {/* Collecting the level (todo 18), first: its points are what the stat screen spends. */}
            <CheckField
              checked={form.trainLevels}
              hint={t('settings.train.levelsHint')}
              label={t('settings.train.levels')}
              name="train-levels"
              setting="automation.train.levels"
              onChange={(value) => patch({ trainLevels: value })}
            />
            {form.trainLevels && (
              <>
                {/* Only the rooms the realm says take this character at this level. */}
                <SelectField
                  hint={t('settings.train.trainerHint')}
                  label={t('settings.train.trainerLabel')}
                  name="train-trainer"
                  setting="automation.train.trainer"
                  onChange={(value) => patch({ trainTrainer: value })}
                  options={[
                    { value: '', label: t('settings.train.trainerCheapest') },
                    ...(trainers ?? []).map((entry) => ({
                      value: String(entry.shop),
                      label: t('settings.train.trainerOption', {
                        name: entry.name,
                        room: entry.roomName,
                        cost: entry.cost.toLocaleString()
                      })
                    }))
                  ]}
                  value={form.trainTrainer}
                />
                <NumberField
                  hint={t('settings.train.upToHint')}
                  label={t('settings.train.upToLabel')}
                  name="train-up-to"
                  setting="automation.train.upTo"
                  onChange={(value) => patch({ trainUpTo: value })}
                  value={form.trainUpTo}
                />
                {/*
                  Said out loud, because an empty picker and a
                  picker still loading look the same and mean
                  opposite things. And a stated room no longer in
                  the list is the case the reviewer asked about:
                  the errand refuses rather than quietly walking
                  somewhere else.
                */}
                {trainers !== null && trainers.length === 0 && (
                  <p className="settings-warn">{t('settings.train.trainerNowhere')}</p>
                )}
                {trainers !== null &&
                  form.trainTrainer !== '' &&
                  !trainers.some((entry) => String(entry.shop) === form.trainTrainer) && (
                    <p className="settings-warn">{t('settings.train.trainerStale')}</p>
                  )}
              </>
            )}
            <TrainStatFields
              horizon={form.trainStatHorizon}
              name="train"
              onHorizon={(trainStatHorizon) => patch({ trainStatHorizon })}
              onPick={(pick) => patch({ trainPick: pick })}
              onStats={(trainStats) => patch({ trainStats })}
              onWanted={(attribute, value) =>
                patch({ trainWanted: { ...form.trainWanted, [attribute]: value } })
              }
              pick={form.trainPick}
              stats={form.trainStats}
              wanted={form.trainWanted}
            />
          </fieldset>
        </SettingsSection>
      )}

      {shows('gear') && (
        <SettingsSection {...sectionOf('gear')}>
          {/*
            The kit, and when to be in it (todo 00). The off-round
            invocation is its own fieldset: another verb (`use`),
            and the only control that spends a round.
          */}
          <fieldset className="settings-menus" data-fieldset="gear">
            <legend>{t('settings.gear.legend')}</legend>
            <p className="settings-note">{t('settings.gear.note')}</p>
            <GearSwitches
              enabled={form.gearEnabled}
              namePrefix="gear"
              onEnabled={(value) => patch({ gearEnabled: value })}
              onResists={(value) => patch({ gearResists: value })}
              minSaved={form.gearResistMinSaved}
              onMinSaved={(value) => patch({ gearResistMinSaved: value })}
              resists={form.gearResists}
            />
            <GearSetList
              mobs={mobs}
              namePrefix="gear-set"
              onChange={(gearSets) => patch({ gearSets })}
              sets={form.gearSets}
            />
          </fieldset>

          <BetterGearFields
            namePrefix="gear"
            onUpgrades={(upgrades) => patch({ loot: { ...form.loot, upgrades } })}
            onWeights={(gearWeights) => patch({ loot: { ...form.loot, gearWeights } })}
            onPerSlot={(gearOffersPerSlot) => patch({ gearOffersPerSlot })}
            perSlot={form.gearOffersPerSlot}
            upgrades={form.loot.upgrades}
            weights={form.loot.gearWeights}
          />

          <OffRoundFields
            every={form.gearOffRoundEvery}
            item={form.gearOffRoundItem}
            namePrefix="gear"
            onEvery={(value) => patch({ gearOffRoundEvery: value })}
            onItem={(value) => patch({ gearOffRoundItem: value })}
          />
        </SettingsSection>
      )}

      {shows('quests') && (
        <SettingsSection {...sectionOf('quests')}>
          <QuestsFieldset
            enabled={form.questsEnabled}
            namePrefix=""
            onEnabled={(questsEnabled) => patch({ questsEnabled })}
            onRollTries={(questsRollTries) => patch({ questsRollTries })}
            rollTries={form.questsRollTries}
          />
        </SettingsSection>
      )}

      {shows('remotes') && (
        <SettingsSection {...sectionOf('remotes')}>
          <fieldset className="settings-menus" data-fieldset="remotes">
            <legend>{t('settings.remotes.legend')}</legend>
            {/*
              The third warning in the open, and it earns the place
              the other two do: what this switch turns on is a channel
              by which somebody else's typing moves this character.
              Above the control, because a warning behind a hover is
              one nobody reads until afterwards.
            */}
            <p className="settings-warn">{t('settings.remotes.channelWarning')}</p>
            <CheckField
              checked={form.answerRemotes}
              hint={t('settings.remotes.answerHint')}
              label={t('settings.remotes.enabledLabel')}
              name="remotes-enabled"
              setting="automation.remotes.enabled"
              onChange={(value) => patch({ answerRemotes: value })}
            />
            {/*
              The gate. Only drawn with the switch on: grants for a
              channel nobody is listening on are a form asking a
              question that cannot matter yet.
            */}
            {form.answerRemotes && (
              <>
                <RemoteSwitches
                  autoJoin={form.remoteAutoJoin}
                  gang={form.remoteGang}
                  gangpath={form.remoteGangpath}
                  killAndHangup={form.remoteKillAndHangup}
                  maxGets={form.remoteMaxGets}
                  name="remotes"
                  onAutoJoin={(value) => patch({ remoteAutoJoin: value })}
                  onMaxGets={(remoteMaxGets) => patch({ remoteMaxGets })}
                  onGang={(value) => patch({ remoteGang: value })}
                  onGangpath={(value) => patch({ remoteGangpath: value })}
                  onKillAndHangup={(value) => patch({ remoteKillAndHangup: value })}
                />

                {/*
                  The per-player half, which the Player flyout also
                  writes — and it is here because the flyout can only
                  be opened on somebody the client has *seen*. A pair
                  of characters set up before either has logged in is
                  the ordinary case, and a permission reachable only
                  once the person is standing in front of you is one
                  you cannot prepare.
                */}
                <PlayerGrants
                  grants={form.remotePlayers}
                  onChange={(players) => patch({ remotePlayers: players })}
                />
              </>
            )}
            {/*
              Where the third list is. A permission page showing two
              of the three grants would have somebody auditing who
              can drive this character conclude they had seen it all.
            */}
            <p className="settings-note">{t('settings.remotes.partyListNote')}</p>
            <p className="settings-note">{t('settings.remotes.remoteControlNote')}</p>
            <p className="settings-note">{t('settings.remotes.replyRoutingNote')}</p>
          </fieldset>
        </SettingsSection>
      )}

      {shows('talk') && (
        <SettingsSection {...sectionOf('talk')}>
          <fieldset className="settings-menus" data-fieldset="talk">
            <legend>{t('settings.talk.legend')}</legend>
            {/* In the open, as the remotes warning is: a look costs a command and is seen. */}
            <p className="settings-warn">{t('settings.talk.lookWarning')}</p>
            <CheckField
              checked={form.lookAtPlayers}
              hint={t('settings.talk.lookHint')}
              label={t('settings.talk.lookLabel')}
              name="talk-look"
              setting="automation.talk.lookAtPlayers"
              onChange={(value) => patch({ lookAtPlayers: value })}
            />
          </fieldset>

          <AliasFields
            aliases={form.aliases}
            character
            onChange={(aliases) => patch({ aliases })}
          />
          <fieldset className="settings-menus" data-fieldset="talk-pvp">
            <legend>{t('settings.health.pvpLegend')}</legend>
            <CheckField
              checked={form.pvpNotifyGang}
              hint={t('settings.health.pvpNotifyHint')}
              label={t('settings.health.pvpNotifyLabel')}
              name="pvp-notify"
              setting="automation.safety.pvp.notifyGang"
              onChange={(value) => patch({ pvpNotifyGang: value })}
            />
            <SelectField
              hint={t('settings.health.pvpActionHint')}
              label={t('settings.health.pvpActionLabel')}
              name="pvp-action"
              setting="automation.safety.pvp.action"
              onChange={(value) =>
                patch({ pvpAction: PVP_ACTIONS.find((action) => action === value) ?? 'none' })
              }
              options={PVP_ACTIONS.map((action) => ({ value: action, label: action }))}
              value={form.pvpAction}
            />
          </fieldset>
        </SettingsSection>
      )}

      {shows('rewrites') && (
        <SettingsSection {...sectionOf('rewrites')}>
          <fieldset className="settings-menus" data-fieldset="rewrites-statline">
            <legend>{t('settings.statline.legend')}</legend>
            <CheckField
              checked={form.statlineControl}
              hint={t('settings.statline.controlHint')}
              label={t('settings.statline.controlLabel')}
              name="statline-control"
              setting="automation.statline.control"
              onChange={(value) => patch({ statlineControl: value })}
            />
            <p className="settings-note">{t('settings.statline.templateNote')}</p>
          </fieldset>
          <AsksFieldset asks={form.asks} namePrefix="" onChange={(asks) => patch({ asks })} />
          <RewritesDesigner
            figures={figures}
            idPrefix="rewrites"
            onChange={(next) => patch({ rewrites: next })}
            palette={palette}
            value={form.rewrites}
          />
        </SettingsSection>
      )}

      {shows('alerts') && (
        <SettingsSection {...sectionOf('alerts')}>
          <fieldset className="settings-menus" data-fieldset="alerts-rules">
            {/*
            The player's own rows first, because they decide before
            the floor and the mute list below do — reading the
            screen top to bottom should be reading the order the
            client asks in (todo 29).
          */}
            <legend>{t('settings.alerts.ruleLegend')}</legend>
            <p className="settings-note">{t('settings.alerts.ruleNote')}</p>
            <AlertList
              namePrefix="alert-rule"
              onChange={(alertRules) => patch({ alertRules })}
              rules={form.alertRules}
            />
          </fieldset>
          <AfkFieldset
            after={form.afkAfterMinutes}
            enabled={form.afkEnabled}
            namePrefix=""
            onAfter={(afkAfterMinutes) => patch({ afkAfterMinutes })}
            onEnabled={(afkEnabled) => patch({ afkEnabled })}
            onReply={(afkReply) => patch({ afkReply })}
            reply={form.afkReply}
          />
        </SettingsSection>
      )}

      {shows('movement') && (
        <SettingsSection {...sectionOf('movement')}>
          {/*
            Four questions, four fieldsets (todo 00). This was one
            fieldset of fourteen controls under a single *Walking a
            Route* legend, which is a list rather than a form: doors,
            the shadows, light, the kit and what a condition stops
            are four separate decisions, and a reader looking for one
            of them had to read all of it. The groups are the
            questions, in the order a step asks them.
          */}
          <DoorsFieldset
            choices={form.moveChoices}
            namePrefix=""
            onChange={patch}
            onChoice={moveChoice}
            picklocks={sheet.picklocks}
            value={form}
          />

          <fieldset className="settings-menus" data-fieldset="movement-stealth">
            <legend>{t('settings.movement.stealthLegend')}</legend>
            <SneakAndRunFields
              choices={form.moveChoices}
              namePrefix=""
              onChange={patch}
              onChoice={moveChoice}
              value={form}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="movement-light">
            <legend>{t('settings.movement.lightLegend')}</legend>
            <LightFields
              choices={form.moveChoices}
              namePrefix=""
              onChange={patch}
              onChoice={moveChoice}
              value={form}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="movement-afflictions">
            <legend>{t('settings.movement.afflictionsLegend')}</legend>
            <ConditionWaitFields namePrefix="" onChange={patch} value={form} />
          </fieldset>

          <KeepOutFieldset
            namePrefix=""
            onChange={(keepOutOf) => patch({ keepOutOf })}
            value={form.keepOutOf}
          />
          <RoutingFieldset choices={form.moveChoices} namePrefix="" onChoice={moveChoice} />

          <fieldset className="settings-menus" data-fieldset="movement-carry">
            <legend>{t('settings.movement.carryLegend')}</legend>
            <RecoverFields onChange={patch} value={form} />
            <CheckField
              checked={form.collectKeys}
              hint={t('settings.movement.collectKeysHint')}
              label={t('settings.movement.collectKeys')}
              name="collect-keys"
              setting="automation.movement.collectKeys"
              onChange={(value) => patch({ collectKeys: value })}
            />
          </fieldset>

          {/*
            What this character picks up, puts down, searches for
            and banks — the same four fieldsets the Global page has
            always had, which this page had none of (todo 03).
            `resolveProfile` overlays whatever `automation:` a
            profile states, so a character could hold its own
            answers all along and no screen could write one.
          */}
          <CarrySections banks={banks} blocks={form} idPrefix="" onChange={patch} />

          {/*
            Where the character should be at all (todo 05), beside
            the loops rather than under Training: what it decides
            is a place, and the loop it runs when it gets there is
            built from the survey rather than taken off the shelf
            above.
          */}
          <HuntingFieldset
            cash={form.huntCash}
            choices={form.huntChoices}
            enabled={form.huntAuto}
            namePrefix=""
            onChange={(change) =>
              patch({
                ...(change.enabled !== undefined && { huntAuto: change.enabled }),
                ...(change.radius !== undefined && { huntRadius: change.radius }),
                ...(change.cash !== undefined && { huntCash: change.cash })
              })
            }
            onChoices={(huntChoices) => patch({ huntChoices })}
            radius={form.huntRadius}
          />

          {/*
            The loops this character owns, and the ones it merely
            walks. A separate fieldset from the two switches above
            rather than three more rows in one, because they answer
            different questions: those are what a route may do on
            the way, and this is where the character goes at all.
          */}
          <LoopSection
            {...shelf}
            inherited={inheritedLoops}
            loops={form.loops}
            note={t('settings.movement.loopsNote')}
            onToggle={onToggleLoop}
            /*
              The one thing about this that can be wrong without
              looking wrong. The shipped loops name rooms by
              `map/room` in Paradigm's world, the one they were
              recorded in; a realm pinned to the other bundled
              world or to its own database has different rooms
              behind the same numbers, and a route planned from
              one goes somewhere nobody chose.
            */
            warning={
              walksAnotherWorld(
                servers.find((entry) => entry.name === form.serverName)?.database ?? ''
              ) && form.loops.length > 0
                ? t('settings.movement.loopsWarning')
                : undefined
            }
          />
        </SettingsSection>
      )}

      <div className="settings-actions">{actions}</div>
    </form>
  );
}
