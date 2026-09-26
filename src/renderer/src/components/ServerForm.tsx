/**
 * A realm's own form, whole: its name and address, the world its characters
 * walk, its menu script and locate word, its loops, its monster rules and
 * whether a hang-up there is charged. The screen owns the draft's history, its saving and which
 * realm it is; this draws the one it is handed. The why is in
 * `mudengine-settings`.
 */
import type { FormEvent } from 'react';
import Icon from './Icon';
import LoginStepRows from './LoginStepRows';
import FormField, { NumberField, SelectField, TextField } from './FormField';
import Advanced from './Advanced';
import LoopSection, { type LoopShelf } from './LoopSection';
import MobRuleList from './MobRuleList';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { LOCATE_OPTIONS, penaltiesChoice, penaltiesOf } from '../lib/form';
import type { ServerDraft } from '@shared/drafts';
import { asLocateWord, DEFAULT_LOCATE } from '@shared/locate';
import type { Loop } from '@shared/loops';
import { ENCODINGS, type StreamEncoding } from '@shared/types';

export interface ServerFormProps {
  draft: ServerDraft;
  /** One edit, recorded as one step of the screen's history. */
  onChange(next: ServerDraft): void;
  onSubmit(event: FormEvent): void;
  firstFieldRef: React.RefObject<HTMLInputElement>;
  /** The native picker for a world database; null when dismissed. */
  chooseRealm(): Promise<string | null>;
  shelf: LoopShelf;
  onToggleLoop(loop: Loop): void;
  /** The row under the form: the create button, or the way back and the removal. */
  actions: React.ReactNode;
}

export default function ServerForm({
  draft,
  onChange,
  onSubmit,
  firstFieldRef,
  chooseRealm,
  shelf,
  onToggleLoop,
  actions
}: ServerFormProps): React.JSX.Element {
  return (
    <form className="settings-form" data-section="realm" onSubmit={onSubmit}>
      {/*
        A realm form has no sections, so it states its subject
        instead: it is the same thing the Global page's Realm
        section edits, and it reads in the same hue.
      */}
      {/* What the realm is called and where it is: one row, since
          neither half identifies it on its own. */}
      <div className="settings-inline">
        <TextField
          hint={t('settings.realms.nameHint')}
          inputRef={firstFieldRef}
          label={t('settings.realms.nameLabel')}
          name="server-name"
          onChange={(value) => onChange({ ...draft, name: value })}
          placeholder={t('settings.realms.namePlaceholder')}
          value={draft.name}
        />
        <TextField
          label={t('settings.profile.hostLabel')}
          name="server-host"
          onChange={(value) => onChange({ ...draft, host: value })}
          placeholder={t('settings.profile.hostPlaceholder')}
          spellCheck={false}
          value={draft.host}
        />
        <NumberField
          label={t('settings.profile.portLabel')}
          name="server-port"
          onChange={(value) =>
            onChange({
              ...draft,
              port: Number.parseInt(value, 10) || 0
            })
          }
          value={draft.port || ''}
        />
      </div>

      {/*
        The map every character here walks.

        On the realm rather than on the character, for the same
        reason the menu script below is: two characters on one realm
        cannot be walking two different maps, and stated per
        character it was the same answer written out once each with
        as many places to drift -- a third character added later
        silently got the shipped world instead.
      */}
      <FormField
        hint={t('settings.worldDatabaseHint')}
        label={t('settings.worldDatabaseLabel')}
        name="server-database"
        wide
      >
        {({ describedBy }) => (
          <div className="settings-file">
            <input
              aria-describedby={describedBy}
              onChange={(event) => onChange({ ...draft, database: event.target.value })}
              placeholder={t('settings.worldDatabasePlaceholder')}
              spellCheck={false}
              value={draft.database}
            />
            <button
              className="quiet"
              onClick={() => {
                void chooseRealm().then((file) => {
                  if (file !== null) onChange({ ...draft, database: file });
                });
              }}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('settings.realms.databaseBrowse')}
            </button>
            {draft.database.length > 0 && (
              <button
                className="quiet"
                onClick={() => onChange({ ...draft, database: '' })}
                onMouseDown={keepFocus}
                type="button"
              >
                {t('settings.realms.databaseClear')}
              </button>
            )}
          </div>
        )}
      </FormField>

      {/*
        Behind a press, because it has a right answer already and
        is not one anybody can choose well without knowing what
        CP437 is. Not taste: the game lays out maps and stat
        columns in character cells, and both reference realms open
        with block glyphs that are invalid UTF-8.
      */}
      <Advanced label={t('settings.advancedWire')}>
        <SelectField
          hint={t('settings.profile.encodingHint')}
          label={t('settings.profile.encodingLabel')}
          name="encoding"
          onChange={(value) => onChange({ ...draft, encoding: value as StreamEncoding })}
          options={ENCODINGS.map((encoding) => ({ value: encoding, label: encoding }))}
          value={draft.encoding}
        />
      </Advanced>

      {/*
        How to get through this realm's menus.

        On the realm rather than on the character, because that is
        what it is a property of: every character on one realm
        meets the same menus, and a script stored per character is
        the same answer written out four times with four places to
        drift. What is genuinely per character is the account, and
        the character slot -- which a character overrides with its
        own script when it needs to.

        A list rather than named fields. The four this screen used
        to show were *Paradigm's* menus; MajorMUD, GreaterMUD and a
        WorldGroup front end all differ, and a client with four
        slots cannot describe them at all.
      */}
      <fieldset className="settings-menus" data-fieldset="realm-login">
        <legend>{t('settings.realms.loginLegend')}</legend>
        <p className="settings-note">{t('settings.realms.loginNote')}</p>

        <LoginStepRows
          onChange={(login) => onChange({ ...draft, login })}
          sendPlaceholder={t('settings.realms.stepSendPlaceholder')}
          steps={draft.login}
          whenPlaceholder={t('settings.realms.stepWhenPlaceholder')}
        />

        <button
          className="quiet add-step"
          onClick={() =>
            onChange({
              ...draft,
              login: [...draft.login, { when: '', send: '' }]
            })
          }
          type="button"
        >
          <Icon name="plus" />
          <span>{t('settings.login.addStep')}</span>
        </button>

        {/* How the realm is asked where you stand, a fact about the place (todo 811). */}
        <div className="settings-inline">
          <SelectField
            hint={t('settings.locate.hint')}
            label={t('settings.locate.label')}
            name="realm-locate"
            onChange={(value) =>
              onChange({ ...draft, locate: asLocateWord(value) ?? DEFAULT_LOCATE })
            }
            options={LOCATE_OPTIONS()}
            value={draft.locate}
          />
        </div>
      </fieldset>

      {/*
        The loops that belong to the *place*.

        A loop names rooms in a realm, so it is a fact about where
        you are playing rather than about who is walking it — and
        one recorded here is worth having on every character that
        plays here, rather than pasted into each of their files and
        then kept in step by hand.
      */}
      <LoopSection
        {...shelf}
        loops={draft.loops}
        note={t('settings.realms.loopsNote')}
        onToggle={onToggleLoop}
      />

      {/*
        And the monsters that belong to the place, for the same
        reason: a ranking names monsters as *this* realm's data
        spells them, so it means nothing on another realm and
        everything to every character playing here. A character's
        own row for a monster still wins over this one.
      */}
      <fieldset className="settings-menus" data-fieldset="realm-mob-rules">
        <legend>{t('settings.combat.mobRuleLegend')}</legend>
        <p className="settings-note">{t('settings.realms.mobRuleNote')}</p>
        {/* No suggestions: the realm page is reached without a
            session, and the monster names come from the realm a
            *session* has loaded. The field is typable, as it is
            for a realm the client holds no data for. */}
        <MobRuleList
          known={[]}
          namePrefix="realm-mob-rule"
          spells={[]}
          onChange={(rows) => onChange({ ...draft, mobRules: rows })}
          rows={draft.mobRules}
        />
      </fieldset>

      {/* Whether a hang-up here is charged: a fact about the place (todo 01). */}
      <fieldset data-fieldset="realm-hang-penalties">
        <legend>{t('settings.health.hangUpLegend')}</legend>
        <div className="settings-inline">
          <SelectField
            hint={t('settings.health.hangPenaltiesHint')}
            label={t('settings.health.hangPenaltiesLabel')}
            name="realm-hang-penalties"
            onChange={(value) => onChange({ ...draft, hangPenalties: penaltiesOf(value) })}
            options={[
              { value: '', label: t('settings.health.hangPenaltiesGlobal') },
              { value: 'yes', label: t('settings.health.hangPenaltiesYes') },
              { value: 'no', label: t('settings.health.hangPenaltiesNo') }
            ]}
            value={penaltiesChoice(draft.hangPenalties)}
          />
        </div>
      </fieldset>

      {/* The realm's teleport, literally: each realm spells it its own way (todo 813). */}
      <fieldset data-fieldset="realm-flee-goto">
        <legend>{t('settings.health.retreatLegend')}</legend>
        <TextField
          hint={t('settings.health.fleeGotoRealmHint')}
          label={t('settings.health.fleeGotoCommandLabel')}
          name="realm-flee-goto"
          onChange={(value) => onChange({ ...draft, fleeGoto: value })}
          placeholder={t('settings.health.fleeGotoCommandPlaceholder')}
          spellCheck={false}
          value={draft.fleeGoto}
          wide
        />
      </fieldset>

      <div className="settings-actions">{actions}</div>
    </form>
  );
}
