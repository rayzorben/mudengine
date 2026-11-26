/**
 * The settings of a character another player controls (`shared/peerRelay.ts`):
 * its form read without the account, and a save that leaves the realm, the
 * account, the login script and the connect switches as the sharer wrote them.
 * The controller's client sends both over the gateway; the sharer's client
 * answers here, as it answers its own window.
 */
import { asProfileDraft, asProfileId } from '../../shared/drafts';
import { Invoke } from '../../shared/ipc';
import type { SettingsEditor } from '../config/SettingsEditor';
import type { Host } from '../host/Host';
import { t } from '../app/i18n';

/** What the shared character's settings need of the editor. */
export type SharedSettingsEditor = Pick<SettingsEditor, 'sharedCharacter' | 'saveProfile'>;

export interface SharedSettingsDeps {
  host: Pick<Host, 'transport'>;
  editor: () => SharedSettingsEditor;
}

export function handleSharedSettings({ host, editor }: SharedSettingsDeps): void {
  const { handle } = host.transport;

  handle(Invoke.sharedSettings, (_caller, rawId: unknown) => {
    const id = asProfileId(rawId);
    return id === null ? null : editor().sharedCharacter(id);
  });

  handle(Invoke.saveSharedSettings, (_caller, rawId: unknown, rawDraft: unknown) => {
    const id = asProfileId(rawId);
    if (id === null) return t('app.profiles.noSuchCharacter');
    const draft = asProfileDraft(rawDraft);
    if (draft === null) return t('app.profiles.incompleteDraft');
    const result = editor().saveProfile(id, draft, 'shared');
    return result.ok ? null : result.error;
  });
}
