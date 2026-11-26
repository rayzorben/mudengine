import Advanced from './Advanced';
import DialFields from './DialFields';
import FormField, { NumberField, PasswordField, SelectField, TextField } from './FormField';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { CharacterFields } from '../lib/characterForm';
import type { Server } from '@shared/config';
import type { ProfileEditable } from '@shared/ipc';
import { ENCODINGS, type StreamEncoding } from '@shared/types';

export interface AccountFieldsProps {
  form: CharacterFields;
  patch(change: Partial<CharacterFields>): void;
  servers: readonly Pick<Server, 'name'>[];
  onManageRealms(): void;
  /** What the file on disk says about the character on screen; absent while creating. */
  shown: Pick<ProfileEditable, 'hasPassword'> | undefined;
}

/**
 * The realm a character plays on, the account it logs in with and the
 * switches for dialling it: the part of the profile section a player
 * controlling somebody else's character never sees.
 */
export default function AccountFields({
  form,
  patch,
  servers,
  onManageRealms,
  shown
}: AccountFieldsProps): React.JSX.Element {
  return (
    <>
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
    </>
  );
}
