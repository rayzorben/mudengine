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
import type { NavFieldset, NavSection } from './SettingsNav';
import GearSetList from './GearSetList';
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
import BlessingList from './BlessingList';
import CureFields from './CureFields';
import FleeGotoFields from './FleeGotoFields';
import ConditionWaitFields from './ConditionWaitFields';
import SpellField, { castableOn, refusesTarget } from './SpellPicker';
import { castsOnOthers, castsOnSelf } from '@shared/spellcraft';
import LoopSection, { type LoopShelf } from './LoopSection';
import PlayerGrants from './PlayerGrants';
import RemoteList from './RemoteList';
import RewritesDesigner from './RewriteDesigner';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import {
  barOf,
  figureOf,
  joinNames,
  LOCATE_OPTIONS,
  penaltiesChoice,
  penaltiesOf,
  splitNames
} from '../lib/form';
import {
  CHARACTER_SECTIONS,
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
import {
  PVP_ACTIONS,
  RETREAT_STRATEGIES,
  type EngagePolicy,
  type Server,
  type VitalsUiConfig
} from '@shared/config';
import { ACTIONABLE_REMOTES } from '@shared/remotes';

const SECTION_LABEL: Record<CharacterSection, string> = {
  profile: t('settings.sections.character'),
  login: t('settings.sections.login'),
  combat: t('settings.tabs.combat'),
  health: t('settings.tabs.health'),
  spells: t('settings.tabs.spells'),
  party: t('settings.tabs.party'),
  movement: t('settings.tabs.movement'),
  gear: t('settings.tabs.gear'),
  train: t('settings.tabs.train'),
  quests: t('settings.tabs.quests'),
  remotes: t('settings.tabs.remotes'),
  talk: t('settings.tabs.talk'),
  alerts: t('settings.tabs.alerts'),
  rewrites: t('settings.tabs.rewrites')
};

/**
 * The fieldsets inside each section, as the rail's jump targets (todo 02).
 *
 * Written down rather than read off the DOM: a fieldset drawn only when a
 * switch is on — Combat's three — would come and go from a list built by
 * counting, and the rail would then scroll to whichever fieldset happened to
 * be third today. Each `id` matches the `data-fieldset` on the fieldset
 * itself, which is the whole of the contract between the two.
 *
 * A section with one fieldset lists none: the section's own row already goes
 * there, and a single child under it would be the same press written twice.
 * `profile` has no fieldsets at all — its fields sit directly in the section.
 */
const SECTION_FIELDSETS: Record<CharacterSection, readonly NavFieldset[]> = {
  profile: [],
  login: [{ id: 'login', label: t('settings.login.legend') }],
  combat: [
    { id: 'combat-attack', label: t('settings.combat.attackLegend') },
    { id: 'combat-attacks', label: t('settings.combat.attacksLegend') },
    { id: 'combat-monsters', label: t('settings.combat.monstersLegend') },
    { id: 'combat-mob-rules', label: t('settings.combat.mobRuleLegend') }
  ],
  health: [
    { id: 'health-recover', label: t('settings.health.recoverLegend') },
    { id: 'health-retreat', label: t('settings.health.retreatLegend') },
    { id: 'health-hangup', label: t('settings.health.hangUpLegend') },
    { id: 'health-potions', label: t('settings.health.potionRuleLegend') }
  ],
  spells: [
    { id: 'spells-round', label: t('settings.spells.legend') },
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
  gear: [
    { id: 'gear', label: t('settings.gear.legend') },
    { id: 'gear-offround', label: t('settings.gear.offRoundLegend') }
  ],
  train: [{ id: 'train', label: t('settings.train.legend') }],
  quests: [{ id: 'quests', label: t('settings.quests.legend') }],
  remotes: [{ id: 'remotes', label: t('settings.remotes.legend') }],
  talk: [
    { id: 'talk', label: t('settings.talk.legend') },
    { id: 'talk-pvp', label: t('settings.health.pvpLegend') }
  ],
  alerts: [
    { id: 'alerts-rules', label: t('settings.alerts.ruleLegend') },
    { id: 'alerts-afk', label: t('settings.afk.legend') }
  ],
  rewrites: [{ id: 'rewrites-statline', label: t('settings.statline.legend') }]
};

/** The rail's rows for the character page, in the order the form draws them. */
export const CHARACTER_NAV: readonly NavSection[] = CHARACTER_SECTIONS.map((id) => ({
  id,
  label: SECTION_LABEL[id],
  fieldsets: SECTION_FIELDSETS[id]
}));

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
  /** What the percentage thresholds are percentages of; null is unknown. */
  maxima: { hpMax: number | null; manaMax: number | null };
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
  creating,
  copy,
  shown,
  servers,
  onManageRealms,
  firstFieldRef,
  maxima,
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
      gates: shown?.cureGates ?? null,
      /*
       * The two heal fields offer different halves of the book, because the
       * realm marks who each spell may be cast on: `way of the swan` reaches
       * the caster alone, so offering it for the party heal would arm
       * `c swan <name>` once a round for a refusal printed in the room. Both
       * predicates say yes to a spell whose targeting this build cannot read,
       * so a derivative realm loses no options.
       */
      selfHeals: castableOn(spells, castsOnSelf),
      partyHeals: castableOn(spells, castsOnOthers)
    };
  }, [shown]);
  /*
   * A threshold field holds the percent as typed, so the figure is composed
   * from the string rather than from the stored fraction: what somebody wants
   * to see beside a half-typed `7` is what `7` would mean, not what the last
   * saved value meant.
   */
  const ofHealth = (typed: string): string | null =>
    figureOf(Number.parseInt(typed, 10) || 0, maxima.hpMax);
  const ofMana = (typed: string): string | null =>
    figureOf(Number.parseInt(typed, 10) || 0, maxima.manaMax);
  const barOfHealth = (typed: string): ReturnType<typeof barOf> =>
    barOf(Number.parseInt(typed, 10) || 0, bands.hp);
  const barOfMana = (typed: string): ReturnType<typeof barOf> =>
    barOf(Number.parseInt(typed, 10) || 0, bands.mana);

  return (
    <form className="settings-form" data-section={section} onSubmit={onSubmit}>
      {section === 'profile' && (
        <>
          {/*
            Start from a character that already works.

            The second character on a realm otherwise means
            retyping a realm, a login script, four combat verbs
            and every threshold — all of which the first one
            already states, and all of which can be got subtly
            wrong the second time. A select rather than a
            duplicate-this-character button on each row, because
            the question is asked while making one, and this is
            where somebody already is.
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

          <CheckField
            checked={form.autoConnect}
            label={t('settings.profile.autoConnectLabel')}
            name="auto-connect"
            onChange={(value) => patch({ autoConnect: value })}
          />

          <CheckField
            checked={form.autoReconnect}
            hint={t('settings.profile.autoReconnectHint')}
            label={t('settings.profile.autoReconnectLabel')}
            name="auto-reconnect"
            onChange={(value) => patch({ autoReconnect: value })}
          />

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
        </>
      )}

      {section === 'login' && (
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
              onChange={(value) => patch({ locate: asLocateWord(value) })}
              options={[{ value: '', label: t('settings.locate.realm') }, ...LOCATE_OPTIONS()]}
              value={form.locate ?? ''}
            />
          </div>
        </fieldset>
      )}

      {section === 'combat' && (
        <>
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
              onChange={(value) => patch({ combat: value })}
            />
            {/* Drawn whether the switch is on or off: it is the
                one combat setting that acts while it is off. */}
            <div className="settings-inline">
              <NumberField
                hint={t('settings.combat.defendAfterRoundsHint')}
                label={t('settings.combat.defendAfterRounds')}
                name="defend-after-rounds"
                onChange={(value) => patch({ combatDefendAfterRounds: value })}
                value={form.combatDefendAfterRounds}
              />
            </div>
            {form.combat && (
              <>
                <CheckField
                  checked={form.combatRetaliate}
                  hint={t('settings.combat.hitBackHint')}
                  label={t('settings.combat.hitBack')}
                  name="retaliate"
                  onChange={(value) => patch({ combatRetaliate: value })}
                />
                <CheckField
                  checked={form.combatPoliteAttacks}
                  hint={t('settings.combat.politeAttacksHint')}
                  label={t('settings.combat.politeAttacks')}
                  name="polite-attacks"
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
                    onChange={(value) => patch({ combatMaxMobs: value })}
                    value={form.combatMaxMobs}
                  />
                  <NumberField
                    hint={t('settings.combat.minMobsHint')}
                    label={t('settings.combat.minMobsLabel')}
                    name="min-mobs"
                    onChange={(value) => patch({ combatMinMobs: value })}
                    value={form.combatMinMobs}
                  />
                </div>
              </>
            )}
          </fieldset>

          {form.combat && (
            <>
              <fieldset className="settings-menus" data-fieldset="combat-attacks">
                <legend>{t('settings.combat.attacksLegend')}</legend>
                <div className="settings-inline">
                  <TextField
                    hint={t('settings.combat.attackVerbHint')}
                    label={t('settings.combat.attackVerbLabel')}
                    name="attack"
                    onChange={(value) => patch({ combatAttack: value })}
                    placeholder={t('settings.combat.attackVerbPlaceholder')}
                    spellCheck={false}
                    value={form.combatAttack}
                  />
                  <TextField
                    hint={t('settings.combat.openerHint')}
                    label={t('settings.combat.openerLabel')}
                    name="opener"
                    onChange={(value) => patch({ combatOpener: value })}
                    placeholder={t('settings.combat.openerPlaceholder')}
                    spellCheck={false}
                    value={form.combatOpener}
                  />
                </div>
                <CheckField
                  checked={form.combatHideForOpener}
                  hint={t('settings.combat.hideForOpenerHint')}
                  label={t('settings.combat.hideForOpener')}
                  name="hide-for-opener"
                  onChange={(value) => patch({ combatHideForOpener: value })}
                />
                <NumberField
                  hint={t('settings.combat.refreshHint')}
                  label={t('settings.combat.refreshLabel')}
                  name="refresh"
                  onChange={(value) => patch({ combatRefresh: value })}
                  value={form.combatRefresh}
                />
              </fieldset>

              <fieldset className="settings-menus" data-fieldset="combat-monsters">
                <legend>{t('settings.combat.monstersLegend')}</legend>
                <NumberField
                  hint={t('settings.combat.maxTargetHealthHint')}
                  label={t('settings.combat.maxTargetHealthLabel')}
                  name="max-target-health"
                  onChange={(value) => patch({ combatMaxTargetHealth: value })}
                  value={form.combatMaxTargetHealth}
                />
                <NumberField
                  hint={t('settings.combat.maxMonsterExpHint')}
                  label={t('settings.combat.maxMonsterExpLabel')}
                  name="max-monster-exp"
                  onChange={(value) => patch({ combatMaxMonsterExp: value })}
                  value={form.combatMaxMonsterExp}
                />
              </fieldset>

              <fieldset className="settings-menus" data-fieldset="combat-mob-rules">
                <legend>{t('settings.combat.mobRuleLegend')}</legend>
                {/* In the open rather than behind a hint: that the band skips the
                    weighing is the one thing about this control somebody could
                    otherwise have wrong for a whole evening. */}
                <p className="settings-note">{t('settings.combat.mobRuleNote')}</p>
                <MobRuleList
                  known={mobs}
                  namePrefix="mob-rule"
                  spells={shownBook.spells}
                  onChange={(rows) => patch({ combatMobRules: rows })}
                  rows={form.combatMobRules}
                />
              </fieldset>
            </>
          )}
        </>
      )}

      {section === 'health' && (
        <>
          <fieldset className="settings-menus" data-fieldset="health-recover">
            <legend>{t('settings.health.recoverLegend')}</legend>
            <p className="settings-note">{t('settings.health.restingNote')}</p>
            <div className="settings-inline">
              <NumberField
                hint={t('settings.health.restBelowHint')}
                label={t('settings.health.restBelowLabel')}
                name="rest-below"
                bar={barOfHealth(form.restBelow)}
                figure={ofHealth(form.restBelow)}
                onChange={(value) => patch({ restBelow: value })}
                value={form.restBelow}
              />
              <NumberField
                hint={t('settings.health.restToHint')}
                label={t('settings.health.restToLabel')}
                name="rest-to"
                bar={barOfHealth(form.restTo)}
                figure={ofHealth(form.restTo)}
                onChange={(value) => patch({ restTo: value })}
                value={form.restTo}
              />
              <NumberField
                hint={t('settings.health.restBeforeTrapsHint')}
                label={t('settings.health.restBeforeTrapsLabel')}
                name="rest-before-traps"
                bar={barOfHealth(form.restBeforeTraps)}
                figure={ofHealth(form.restBeforeTraps)}
                onChange={(value) => patch({ restBeforeTraps: value })}
                value={form.restBeforeTraps}
              />
              <NumberField
                hint={t('settings.health.meditateBelowHint')}
                label={t('settings.health.meditateBelowLabel')}
                name="med-below"
                bar={barOfMana(form.meditateBelow)}
                figure={ofMana(form.meditateBelow)}
                onChange={(value) => patch({ meditateBelow: value })}
                value={form.meditateBelow}
              />
            </div>
            <CheckField
              checked={form.restNextDoor}
              hint={t('settings.health.restNextDoorHint')}
              label={t('settings.health.restNextDoor')}
              name="rest-next-door"
              onChange={(value) => patch({ restNextDoor: value })}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="health-retreat">
            <legend>{t('settings.health.retreatLegend')}</legend>
            {/*
              The switch and its figures are one row: a switch is two
              columns and a threshold one, and a check alone above them
              spent a band saying what the legend had said.
            */}
            <div className="settings-inline">
              <CheckField
                checked={form.retreat}
                hint={t('settings.health.retreatHint')}
                label={t('settings.health.retreatLabel')}
                name="retreat"
                onChange={(value) => patch({ retreat: value })}
              />
              {form.retreat && (
                <>
                  <NumberField
                    label={t('settings.health.belowHealthLabel')}
                    name="retreat-health"
                    bar={barOfHealth(form.retreatBelow)}
                    figure={ofHealth(form.retreatBelow)}
                    onChange={(value) => patch({ retreatBelow: value })}
                    value={form.retreatBelow}
                  />
                  <NumberField
                    hint={t('settings.health.belowManaHint')}
                    label={t('settings.health.belowManaLabel')}
                    name="retreat-mana"
                    bar={barOfMana(form.retreatBelowMana)}
                    figure={ofMana(form.retreatBelowMana)}
                    onChange={(value) => patch({ retreatBelowMana: value })}
                    value={form.retreatBelowMana}
                  />
                  <NumberField
                    hint={t('settings.health.outnumberedHint')}
                    label={t('settings.health.outnumberedLabel')}
                    name="outnumbered"
                    onChange={(value) => patch({ retreatOutnumbered: value })}
                    value={form.retreatOutnumbered}
                  />
                </>
              )}
            </div>
            {form.retreat && (
              <>
                <SelectField
                  hint={t('settings.health.retreatStrategyHint')}
                  label={t('settings.health.retreatStrategyLabel')}
                  name="retreat-strategy"
                  onChange={(value) => patch({ retreatStrategy: value })}
                  options={RETREAT_STRATEGIES.map((s) => ({ value: s, label: s }))}
                  value={form.retreatStrategy}
                />
                {form.retreatStrategy === 'safe-haven' && (
                  <TextField
                    hint={t('settings.health.safeHavenHint')}
                    label={t('settings.health.safeHavenLabel')}
                    name="retreat-haven"
                    onChange={(value) => patch({ retreatHaven: value })}
                    placeholder={t('settings.health.safeHavenPlaceholder')}
                    spellCheck={false}
                    value={form.retreatHaven}
                    wide
                  />
                )}
              </>
            )}
            <FleeGotoFields bar={barOfHealth} figure={ofHealth} form={form} patch={patch} />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="health-hangup">
            <legend>{t('settings.health.hangUpLegend')}</legend>
            {/*
              The second and last warning left in the open. Every
              MegaMUD-era client offers this; on this server family
              it is one of the more reliable ways to die.
            */}
            <p className="settings-warn">{t('settings.health.hangUpWarning')}</p>
            <div className="settings-inline">
              <CheckField
                checked={form.hangUp}
                label={t('settings.health.hangUpLabel')}
                name="hangup"
                onChange={(value) => patch({ hangUp: value })}
              />
              {form.hangUp && (
                <NumberField
                  label={t('settings.health.belowHealthLabel')}
                  name="hangup-health"
                  bar={barOfHealth(form.hangUpBelow)}
                  figure={ofHealth(form.hangUpBelow)}
                  onChange={(value) => patch({ hangUpBelow: value })}
                  value={form.hangUpBelow}
                />
              )}
            </div>
            {form.hangUp && (
              <>
                <SelectField
                  hint={t('settings.health.hangPenaltiesHint')}
                  label={t('settings.health.hangPenaltiesLabel')}
                  name="hang-penalties"
                  onChange={(value) => patch({ hangUpPenalties: penaltiesOf(value) })}
                  options={[
                    { value: '', label: t('settings.health.hangPenaltiesRealm') },
                    { value: 'yes', label: t('settings.health.hangPenaltiesYes') },
                    { value: 'no', label: t('settings.health.hangPenaltiesNo') }
                  ]}
                  value={penaltiesChoice(form.hangUpPenalties)}
                />
                <CheckField
                  checked={form.hangUpOnPlayer}
                  label={t('settings.health.hangUpOnPlayer')}
                  name="hangup-player"
                  onChange={(value) => patch({ hangUpOnPlayer: value })}
                />
              </>
            )}
          </fieldset>

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
              onChange={(value) => patch({ useWards: value })}
            />
            <WardRules rules={wards} />
          </fieldset>
        </>
      )}

      {section === 'spells' && (
        <>
          {shownBook.unread && (
            <p className="settings-note">{t('settings.spells.bookUnreadNote')}</p>
          )}
          <fieldset className="settings-menus" data-fieldset="spells-round">
            <legend>{t('settings.spells.legend')}</legend>
            <CheckField
              checked={form.spellAutoChoose}
              hint={t('settings.spells.autoChooseHint')}
              label={t('settings.spells.autoChoose')}
              name="spell-auto-choose"
              onChange={(value) => patch({ spellAutoChoose: value })}
            />
            <SpellField
              hint={t('settings.spells.castHint')}
              label={t('settings.spells.castLabel')}
              name="spell"
              onChange={(value) => patch({ spellAttack: value })}
              spells={shownBook.spells}
              value={form.spellAttack}
            />
            <SpellField
              hint={t('settings.spells.fallbackCastHint')}
              label={t('settings.spells.fallbackCastLabel')}
              name="spell-fallback"
              onChange={(value) => patch({ spellAttackFallback: value })}
              spells={shownBook.spells}
              value={form.spellAttackFallback}
            />
            <NumberField
              hint={t('settings.spells.attackCastsHint')}
              label={t('settings.spells.attackCastsLabel')}
              name="attack-casts"
              onChange={(value) => patch({ spellAttackCasts: value })}
              value={form.spellAttackCasts}
            />
            <NumberField
              hint={t('settings.spells.minManaHint')}
              label={t('settings.spells.minManaLabel')}
              name="min-mana"
              onChange={(value) => patch({ spellMinMana: value })}
              bar={barOfMana(form.spellMinMana)}
              figure={ofMana(form.spellMinMana)}
              value={form.spellMinMana}
            />
            <SpellField
              hint={t('settings.spells.areaCastHint')}
              label={t('settings.spells.areaCastLabel')}
              name="area-spell"
              onChange={(value) => patch({ spellAreaAttack: value })}
              spells={shownBook.spells}
              value={form.spellAreaAttack}
            />
            <NumberField
              hint={t('settings.spells.areaMinMobsHint')}
              label={t('settings.spells.areaMinMobsLabel')}
              name="area-min-mobs"
              onChange={(value) => patch({ spellAreaMinMobs: value })}
              value={form.spellAreaMinMobs}
            />
            <NumberField
              hint={t('settings.spells.areaMinManaHint')}
              label={t('settings.spells.areaMinManaLabel')}
              name="area-min-mana"
              onChange={(value) => patch({ spellAreaMinMana: value })}
              bar={barOfMana(form.spellAreaMinMana)}
              figure={ofMana(form.spellAreaMinMana)}
              value={form.spellAreaMinMana}
            />
            <NumberField
              hint={t('settings.spells.areaCastsHint')}
              label={t('settings.spells.areaCastsLabel')}
              name="area-casts"
              onChange={(value) => patch({ spellAreaCasts: value })}
              value={form.spellAreaCasts}
            />
            <p className="settings-note">{t('settings.spells.note')}</p>
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="spells-heal">
            <legend>{t('settings.spells.healLegend')}</legend>
            <div className="settings-inline">
              <SpellField
                hint={t('settings.spells.healHint')}
                label={t('settings.spells.healLabel')}
                name="heal"
                onChange={(value) => patch({ spellHeal: value })}
                spells={shownBook.selfHeals}
                value={form.spellHeal}
                warning={
                  refusesTarget(shownBook.spells, castsOnSelf, form.spellHeal)
                    ? t('settings.spells.healNoSelfCast')
                    : undefined
                }
              />
              <NumberField
                label={t('settings.spells.healBelowLabel')}
                name="heal-below"
                onChange={(value) => patch({ spellHealBelow: value })}
                bar={barOfHealth(form.spellHealBelow)}
                figure={ofHealth(form.spellHealBelow)}
                value={form.spellHealBelow}
              />
              <NumberField
                hint={t('settings.spells.healBelowInCombatHint')}
                label={t('settings.spells.healBelowInCombatLabel')}
                name="heal-below-combat"
                onChange={(value) => patch({ spellHealBelowInCombat: value })}
                bar={barOfHealth(form.spellHealBelowInCombat)}
                figure={ofHealth(form.spellHealBelowInCombat)}
                value={form.spellHealBelowInCombat}
              />
              <NumberField
                hint={t('settings.spells.healToHint')}
                label={t('settings.spells.healToLabel')}
                name="heal-to"
                onChange={(value) => patch({ spellHealTo: value })}
                bar={barOfHealth(form.spellHealTo)}
                figure={ofHealth(form.spellHealTo)}
                value={form.spellHealTo}
              />
            </div>
            <CheckField
              checked={form.spellHealParty}
              hint={t('settings.spells.healPartyHint')}
              label={t('settings.spells.healParty')}
              name="heal-party"
              onChange={(value) => patch({ spellHealParty: value })}
            />
            <SpellField
              hint={t('settings.spells.healPartyWithHint')}
              label={t('settings.spells.healPartyWithLabel')}
              name="heal-party-with"
              onChange={(value) => patch({ spellHealPartyWith: value })}
              spells={shownBook.partyHeals}
              value={form.spellHealPartyWith}
              warning={
                refusesTarget(shownBook.spells, castsOnOthers, form.spellHealPartyWith)
                  ? t('settings.spells.healNoPartyCast')
                  : undefined
              }
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
            <CheckField
              checked={form.spellAutoBless}
              hint={t('settings.spells.autoBlessHint')}
              label={t('settings.spells.autoBlessLabel')}
              name="auto-bless"
              onChange={(value) => patch({ spellAutoBless: value })}
            />
            <BlessingList
              blessings={form.spellBlessings}
              namePrefix="blessing"
              onChange={(spellBlessings) => patch({ spellBlessings })}
              spells={shownBook.spells}
            />
            <CheckField
              checked={form.spellNotifyWearOff}
              hint={t('settings.spells.notifyWearOffHint')}
              label={t('settings.spells.notifyWearOffLabel')}
              name="notify-wear-off"
              onChange={(value) => patch({ spellNotifyWearOff: value })}
            />
            {/*
              Beside the blessings this character *casts*, because
              it answers the same question from the other side: a
              weapon that blesses is a blessing nobody had to
              configure, and the list above is where somebody looks
              for one.
            */}
            <CheckField
              checked={form.spellInvokeItems}
              hint={t('settings.spells.invokeItemsHint')}
              label={t('settings.spells.invokeItemsLabel')}
              name="invoke-items"
              onChange={(value) => patch({ spellInvokeItems: value })}
            />
          </fieldset>
        </>
      )}

      {section === 'party' && (
        <>
          <fieldset className="settings-menus" data-fieldset="party-follow">
            <legend>{t('settings.party.legend')}</legend>
            <p className="settings-warn">{t('settings.party.warning')}</p>
            <CheckField
              checked={form.partyAssist}
              hint={t('settings.party.assistHint')}
              label={t('settings.party.assistLabel')}
              name="party-assist"
              onChange={(value) => patch({ partyAssist: value })}
            />
            <CheckField
              checked={form.partyDefend}
              hint={t('settings.party.defendHint')}
              label={t('settings.party.defendLabel')}
              name="party-defend"
              onChange={(value) => patch({ partyDefend: value })}
            />
            <CheckField
              checked={form.partyRest}
              hint={t('settings.party.restHint')}
              label={t('settings.party.restLabel')}
              name="party-rest"
              onChange={(value) => patch({ partyRest: value })}
            />
          </fieldset>
          <fieldset className="settings-menus" data-fieldset="party-healing">
            <legend>{t('settings.party.healLegend')}</legend>
            <p className="settings-note">{t('settings.party.healNote')}</p>
            <div className="settings-inline">
              <NumberField
                hint={t('settings.party.askHealHint')}
                label={t('settings.party.askHealLabel')}
                name="party-ask-heal"
                onChange={(value) => patch({ partyAskHeal: value })}
                bar={barOfHealth(form.partyAskHeal)}
                figure={ofHealth(form.partyAskHeal)}
                value={form.partyAskHeal}
              />
            </div>
          </fieldset>
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
              subject={t('settings.party.remotesLegend')}
            />
          </fieldset>
          <p className="settings-note">{t('settings.party.blessingsMoved')}</p>
        </>
      )}

      {section === 'train' && (
        <fieldset className="settings-menus" data-fieldset="train">
          <legend>{t('settings.train.legend')}</legend>
          <p className="settings-warn">{t('settings.train.warning')}</p>
          {/*
            Going to collect the level, and where (todo 18).
            Above the stat screen's own switch because it comes
            first in time: the points this spends are awarded by
            the level this collects.
          */}
          <CheckField
            checked={form.trainLevels}
            hint={t('settings.train.levelsHint')}
            label={t('settings.train.levels')}
            name="train-levels"
            onChange={(value) => patch({ trainLevels: value })}
          />
          {form.trainLevels && (
            <>
              {/*
                Only the rooms the realm says will take this
                character at this level — a trainer that refuses
                is a walk across two maps to be told so. The class
                room stops at level 10 and every band has a
                ceiling, so the list shrinks as the character
                grows and a stated room can stop being offered.
              */}
              <SelectField
                hint={t('settings.train.trainerHint')}
                label={t('settings.train.trainerLabel')}
                name="train-trainer"
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
          <CheckField
            checked={form.trainStats}
            hint={t('settings.train.statsHint')}
            label={t('settings.train.stats')}
            name="train-stats"
            onChange={(value) => patch({ trainStats: value })}
          />
          <p className="settings-note">{t('settings.train.wantedNote')}</p>
          <div className="settings-inline">
            <NumberField
              label={t('settings.train.strength')}
              name="train-strength"
              onChange={(value) => patch({ trainWanted: { ...form.trainWanted, strength: value } })}
              value={form.trainWanted.strength}
            />
            <NumberField
              label={t('settings.train.intellect')}
              name="train-intellect"
              onChange={(value) =>
                patch({ trainWanted: { ...form.trainWanted, intellect: value } })
              }
              value={form.trainWanted.intellect}
            />
            <NumberField
              label={t('settings.train.willpower')}
              name="train-willpower"
              onChange={(value) =>
                patch({ trainWanted: { ...form.trainWanted, willpower: value } })
              }
              value={form.trainWanted.willpower}
            />
            <NumberField
              label={t('settings.train.agility')}
              name="train-agility"
              onChange={(value) => patch({ trainWanted: { ...form.trainWanted, agility: value } })}
              value={form.trainWanted.agility}
            />
            <NumberField
              label={t('settings.train.health')}
              name="train-health"
              onChange={(value) => patch({ trainWanted: { ...form.trainWanted, health: value } })}
              value={form.trainWanted.health}
            />
            <NumberField
              label={t('settings.train.charm')}
              name="train-charm"
              onChange={(value) => patch({ trainWanted: { ...form.trainWanted, charm: value } })}
              value={form.trainWanted.charm}
            />
          </div>
        </fieldset>
      )}

      {section === 'gear' && (
        <>
          {/*
            The kit, and when to be in it (todo 00). The sets are
            the section; the off-round invocation is its own
            fieldset because it is a different verb — `use` rather
            than `wear` — and the only control here that spends a
            round of a fight.
          */}
          <fieldset className="settings-menus" data-fieldset="gear">
            <legend>{t('settings.gear.legend')}</legend>
            <p className="settings-note">{t('settings.gear.note')}</p>
            <CheckField
              checked={form.gearEnabled}
              hint={t('settings.gear.enabledHint')}
              label={t('settings.gear.enabled')}
              name="gear-enabled"
              onChange={(value) => patch({ gearEnabled: value })}
            />
            <GearSetList
              mobs={mobs}
              namePrefix="gear-set"
              onChange={(gearSets) => patch({ gearSets })}
              sets={form.gearSets}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="gear-offround">
            <legend>{t('settings.gear.offRoundLegend')}</legend>
            <p className="settings-note">{t('settings.gear.offRoundNote')}</p>
            <div className="settings-inline">
              <TextField
                hint={t('settings.gear.offRoundItemHint')}
                label={t('settings.gear.offRoundItem')}
                name="gear-offround-item"
                onChange={(value) => patch({ gearOffRoundItem: value })}
                value={form.gearOffRoundItem}
              />
              <NumberField
                hint={t('settings.gear.offRoundEveryHint')}
                label={t('settings.gear.offRoundEvery')}
                name="gear-offround-every"
                onChange={(value) => patch({ gearOffRoundEvery: value })}
                value={form.gearOffRoundEvery}
              />
            </div>
          </fieldset>
        </>
      )}

      {section === 'quests' && (
        <fieldset className="settings-menus" data-fieldset="quests">
          <legend>{t('settings.quests.legend')}</legend>
          <p className="settings-warn">{t('settings.quests.warning')}</p>
          <CheckField
            checked={form.questsEnabled}
            hint={t('settings.quests.enabledHint')}
            label={t('settings.quests.enabled')}
            name="quests-enabled"
            onChange={(value) => patch({ questsEnabled: value })}
          />
        </fieldset>
      )}

      {section === 'remotes' && (
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
            onChange={(value) => patch({ answerRemotes: value })}
          />
          {/*
            The gate. Only drawn with the switch on: grants for a
            channel nobody is listening on are a form asking a
            question that cannot matter yet.
          */}
          {form.answerRemotes && (
            <>
              <CheckField
                checked={form.remoteGangpath}
                hint={t('settings.remotes.gangpathHint')}
                label={t('settings.remotes.gangpathLabel')}
                name="remotes-gangpath"
                onChange={(value) => patch({ remoteGangpath: value })}
              />
              {/*
                Nothing on the wire establishes who shares a gang
                on its own: a gangpath does not prove it, and this
                character's own outgoing one comes back naming
                itself. Said where the grant is made, not only when
                it silently fails to allow somebody.
              */}
              <p className="settings-warn">{t('settings.remotes.gangWarning')}</p>
              <h4 className="settings-subhead">{t('settings.remotes.gangLegend')}</h4>
              <RemoteList
                allow={form.remoteGang}
                mode="gang"
                onSet={(remote, stance) =>
                  patch({
                    remoteGang:
                      stance === 'allow'
                        ? [...form.remoteGang, remote]
                        : form.remoteGang.filter((entry) => entry !== remote)
                  })
                }
                onSetAll={(stance) =>
                  patch({
                    remoteGang: stance === 'allow' ? [...ACTIONABLE_REMOTES] : []
                  })
                }
                subject={t('settings.remotes.gangLegend')}
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
      )}

      {section === 'talk' && (
        <>
          <fieldset className="settings-menus" data-fieldset="talk">
            <legend>{t('settings.talk.legend')}</legend>
            {/*
            The cost is stated above the switch rather than behind a
            hover, the way the remotes warning is: this one spends a
            command per stranger *and* tells them they were looked
            at, which on a PvP realm is the half somebody would want
            to know before turning it on rather than after.
          */}
            <p className="settings-warn">{t('settings.talk.lookWarning')}</p>
            <CheckField
              checked={form.lookAtPlayers}
              hint={t('settings.talk.lookHint')}
              label={t('settings.talk.lookLabel')}
              name="talk-look"
              onChange={(value) => patch({ lookAtPlayers: value })}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="talk-pvp">
            <legend>{t('settings.health.pvpLegend')}</legend>
            <CheckField
              checked={form.pvpNotifyGang}
              hint={t('settings.health.pvpNotifyHint')}
              label={t('settings.health.pvpNotifyLabel')}
              name="pvp-notify"
              onChange={(value) => patch({ pvpNotifyGang: value })}
            />
            <SelectField
              hint={t('settings.health.pvpActionHint')}
              label={t('settings.health.pvpActionLabel')}
              name="pvp-action"
              onChange={(value) => patch({ pvpAction: value === 'retreat' ? 'retreat' : 'none' })}
              options={PVP_ACTIONS.map((action) => ({
                value: action,
                label: action
              }))}
              value={form.pvpAction}
            />
          </fieldset>
        </>
      )}

      {section === 'rewrites' && (
        <>
          <fieldset className="settings-menus" data-fieldset="rewrites-statline">
            <legend>{t('settings.statline.legend')}</legend>
            <CheckField
              checked={form.statlineControl}
              hint={t('settings.statline.controlHint')}
              label={t('settings.statline.controlLabel')}
              name="statline-control"
              onChange={(value) => patch({ statlineControl: value })}
            />
            <p className="settings-note">{t('settings.statline.templateNote')}</p>
          </fieldset>
          <RewritesDesigner
            figures={figures}
            idPrefix="rewrites"
            onChange={(next) => patch({ rewrites: next })}
            palette={palette}
            value={form.rewrites}
          />
        </>
      )}

      {section === 'alerts' && (
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
      )}

      {/*
        Beside the alerts, because both are about a player who is
        not looking: alerts are what they hear about the character,
        and this is what the character says for them.
      */}
      {section === 'alerts' && (
        <fieldset className="settings-menus" data-fieldset="alerts-afk">
          <legend>{t('settings.afk.legend')}</legend>
          <div className="settings-inline">
            <CheckField
              checked={form.afkEnabled}
              hint={t('settings.afk.enabledHint')}
              label={t('settings.afk.enabled')}
              name="afk-enabled"
              onChange={(value) => patch({ afkEnabled: value })}
            />
            <NumberField
              hint={t('settings.afk.afterHint')}
              label={t('settings.afk.afterLabel')}
              name="afk-after"
              onChange={(value) => patch({ afkAfterMinutes: value })}
              value={form.afkAfterMinutes}
            />
            <TextField
              hint={t('settings.afk.replyHint')}
              label={t('settings.afk.replyLabel')}
              name="afk-reply"
              onChange={(value) => patch({ afkReply: value })}
              value={form.afkReply}
            />
          </div>
        </fieldset>
      )}

      {section === 'movement' && (
        <>
          {/*
            Four questions, four fieldsets (todo 00). This was one
            fieldset of fourteen controls under a single *Walking a
            Route* legend, which is a list rather than a form: doors,
            the shadows, light, the kit and what a condition stops
            are four separate decisions, and a reader looking for one
            of them had to read all of it. The groups are the
            questions, in the order a step asks them.
          */}
          <fieldset className="settings-menus" data-fieldset="movement-doors">
            <legend>{t('settings.movement.doorsLegend')}</legend>
            <div className="settings-inline">
              <CheckField
                checked={form.openDoors}
                hint={t('settings.movement.openDoorsHint')}
                label={t('settings.movement.openDoors')}
                name="open-doors"
                onChange={(value) => patch({ openDoors: value })}
              />
              {form.openDoors && (
                <NumberField
                  label={t('settings.movement.openTries')}
                  name="open-tries"
                  onChange={(value) => patch({ openTries: value })}
                  value={form.openTries}
                />
              )}
            </div>
            {/*
              Picking above bashing, in the order the walker tries
              them — and for the reason it does: one costs a
              command and the other costs a command and some
              health.
            */}
            <div className="settings-inline">
              <CheckField
                checked={form.pickLocks}
                hint={t('settings.movement.pickLocksHint')}
                label={t('settings.movement.pickLocks')}
                name="pick-locks"
                onChange={(value) => patch({ pickLocks: value })}
              />
              {form.pickLocks && (
                <NumberField
                  label={t('settings.movement.pickTries')}
                  name="pick-tries"
                  onChange={(value) => patch({ pickTries: value })}
                  value={form.pickTries}
                />
              )}
            </div>
            <div className="settings-inline">
              <CheckField
                checked={form.bashDoors}
                hint={t('settings.movement.bashDoorsHint')}
                label={t('settings.movement.bashDoors')}
                name="bash-doors"
                onChange={(value) => patch({ bashDoors: value })}
              />
              {form.bashDoors && (
                <NumberField
                  label={t('settings.movement.bashTries')}
                  name="bash-tries"
                  onChange={(value) => patch({ bashTries: value })}
                  value={form.bashTries}
                />
              )}
            </div>
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="movement-stealth">
            <legend>{t('settings.movement.stealthLegend')}</legend>
            <CheckField
              checked={form.sneak}
              hint={t('settings.movement.sneakHint')}
              label={t('settings.movement.sneak')}
              name="sneak"
              onChange={(value) => patch({ sneak: value })}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="movement-light">
            <legend>{t('settings.movement.lightLegend')}</legend>
            <CheckField
              checked={form.provideLight}
              hint={t('settings.movement.provideLightHint')}
              label={t('settings.movement.provideLight')}
              name="provide-light"
              onChange={(value) => patch({ provideLight: value })}
            />
            {form.provideLight && (
              <>
                <CheckField
                  checked={form.lightDimRooms}
                  hint={t('settings.movement.lightDimRoomsHint')}
                  label={t('settings.movement.lightDimRooms')}
                  name="light-dim-rooms"
                  onChange={(value) => patch({ lightDimRooms: value })}
                />
                <CheckField
                  checked={form.extinguishInLight}
                  hint={t('settings.movement.extinguishInLightHint')}
                  label={t('settings.movement.extinguishInLight')}
                  name="extinguish-in-light"
                  onChange={(value) => patch({ extinguishInLight: value })}
                />
              </>
            )}
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="movement-afflictions">
            <legend>{t('settings.movement.afflictionsLegend')}</legend>
            <ConditionWaitFields namePrefix="" onChange={patch} value={form} />
            <CheckField
              checked={form.fightOnArrival}
              hint={t('settings.movement.fightOnArrivalHint')}
              label={t('settings.movement.fightOnArrival')}
              name="fight-on-arrival"
              onChange={(value) => patch({ fightOnArrival: value })}
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="movement-keep-out">
            <legend>{t('settings.movement.keepOutLegend')}</legend>
            <TextField
              hint={t('settings.movement.keepOutOfHint')}
              label={t('settings.movement.keepOutOf')}
              name="keep-out-of"
              onChange={(value) => patch({ keepOutOf: splitNames(value) })}
              placeholder={t('settings.movement.keepOutOfPlaceholder')}
              value={joinNames(form.keepOutOf)}
              wide
            />
          </fieldset>

          <fieldset className="settings-menus" data-fieldset="movement-carry">
            <legend>{t('settings.movement.carryLegend')}</legend>
            <CheckField
              checked={form.recoverGear}
              hint={t('settings.movement.recoverGearHint')}
              label={t('settings.movement.recoverGear')}
              name="recover-gear"
              onChange={(value) => patch({ recoverGear: value })}
            />
            {/*
              The bounds, drawn only where the switch is on: two
              numbers limiting a feature nobody has turned on are
              two controls that do nothing (todo 21).
            */}
            {form.recoverGear && (
              <div className="settings-inline">
                <NumberField
                  hint={t('settings.movement.recoverGearFloorHint')}
                  label={t('settings.movement.recoverGearFloorLabel')}
                  name="recover-gear-floor"
                  onChange={(value) => patch({ recoverGearFloor: value })}
                  value={form.recoverGearFloor}
                />
                <NumberField
                  hint={t('settings.movement.recoverGearTriesHint')}
                  label={t('settings.movement.recoverGearTriesLabel')}
                  name="recover-gear-tries"
                  onChange={(value) => patch({ recoverGearTries: value })}
                  value={form.recoverGearTries}
                />
              </div>
            )}
            <CheckField
              checked={form.collectKeys}
              hint={t('settings.movement.collectKeysHint')}
              label={t('settings.movement.collectKeys')}
              name="collect-keys"
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
          <CarrySections
            banking={form.banking}
            banks={banks}
            drop={form.drop}
            idPrefix=""
            loot={form.loot}
            onChange={patch}
            search={form.search}
          />

          {/*
            Where the character should be at all (todo 05), beside
            the loops rather than under Training: what it decides
            is a place, and the loop it runs when it gets there is
            built from the survey rather than taken off the shelf
            above.
          */}
          <fieldset className="settings-menus" data-fieldset="hunting">
            <legend>{t('settings.hunting.legend')}</legend>
            <p className="settings-note">{t('settings.hunting.note')}</p>
            <div className="settings-inline">
              <CheckField
                checked={form.huntAuto}
                hint={t('settings.hunting.autoHint')}
                label={t('settings.hunting.auto')}
                name="hunt-auto"
                onChange={(value) => patch({ huntAuto: value })}
              />
              {form.huntAuto && (
                <NumberField
                  hint={t('settings.hunting.radiusHint')}
                  label={t('settings.hunting.radius')}
                  name="hunt-radius"
                  onChange={(value) => patch({ huntRadius: value })}
                  value={form.huntRadius}
                />
              )}
            </div>
          </fieldset>

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
        </>
      )}

      <div className="settings-actions">{actions}</div>
    </form>
  );
}
