/**
 * The settings screen's doors into main, bundled once (moved out of `App`,
 * todo 140).
 *
 * Stable callbacks: inline arrows would be a new function on every render, and
 * a child that keys an effect on one then runs it on every render, which is
 * how a refused save came to flash and vanish before anybody could read it.
 */
import { useMemo, useRef } from 'react';

import type { GlobalDraft, ProfileDraft, ServerDraft } from '@shared/drafts';
import type { IpcApi, Revealed, SessionId, SessionSummary, SettingsSnapshot } from '@shared/ipc';
import { isRemoteSessionId } from '@shared/peerRelay';

/** Who a controlled character is called here: its tab's name, since its file is the sharer's. */
type OpenedShare = Pick<SessionSummary, 'id' | 'name' | 'remote'>;

/**
 * This client's own characters, then each one another player shares that is
 * open here, read through the sharer's client without its account. A share the
 * sharer's client does not answer for is left out, not shown broken.
 */
async function withShared(
  api: IpcApi,
  own: SettingsSnapshot,
  opened: readonly OpenedShare[]
): Promise<SettingsSnapshot> {
  const forms = await Promise.all(
    opened.map(async (share) => {
      // A share the sharer's client will not answer for (link down, control stopped) is left out
      // of the list, and the reason goes to the console rather than nowhere.
      const form = await api.sharedSettings(share.id).catch((error: unknown) => {
        console.warn(`Settings of ${share.name} are not available: ${String(error)}`);
        return null;
      });
      return form === null ? null : { ...form, id: share.id, name: share.name };
    })
  );
  const shared = forms.filter((form) => form !== null);
  return shared.length === 0 ? own : { ...own, characters: [...own.characters, ...shared] };
}

export function useSettingsApi(
  api: IpcApi,
  reveal: (ask: () => Promise<Revealed>) => void,
  roster: readonly SessionSummary[]
) {
  // Read at the moment a screen asks, so a share opened since does not make every callback new.
  const opened = useRef<readonly OpenedShare[]>([]);
  opened.current = roster.filter((entry) => entry.remote !== null);

  return useMemo(
    () => ({
      load: async () => withShared(api, await api.settingsSnapshot(), opened.current),
      saveProfile: (id: string, draft: ProfileDraft) =>
        isRemoteSessionId(id) ? api.saveSharedSettings(id, draft) : api.saveProfile(id, draft),
      deleteProfile: (id: string) => api.deleteProfile(id),
      saveServer: (previous: string | null, draft: ServerDraft) => api.saveServer(previous, draft),
      deleteServer: (name: string) => api.deleteServer(name),
      saveGlobal: (draft: GlobalDraft) => api.saveGlobal(draft),
      revealConfig: () => reveal(() => api.revealConfig()),
      revealProfiles: () => reveal(() => api.revealProfiles()),
      chooseRealm: () => api.chooseRealm(),
      // The shelf of shipped loops, for the Movement tab, asked when that picker opens:
      // four hundred loops, and most visits to that screen are about a password.
      loadLoops: () => api.loopCatalogue(),
      // And the trainers that will take a character, for the Train tab, by level and class.
      loadTrainers: (session: SessionId) => api.trainers(session),
      loadBanks: (session: SessionId) => api.banks(session),
      // And what the realm says would serve each condition, for the potion
      // rule list's suggestions.
      loadServing: (session: SessionId) => api.itemsServing(session),
      // And the realm's own rules of the same kind, for the rows under it.
      loadWards: (session: SessionId) => api.wards(session),
      // And the monsters the realm names, for the priority list's picker.
      loadMobNames: (session: SessionId) => api.mobNames(session),
      // And what the inventory holds that can bless, for the Spells page.
      loadInvokeChoices: (session: SessionId) => api.invokeChoices(session),
      loadBlessingChoice: (session: SessionId) => api.blessingChoice(session),
      loadChosenWords: (session: SessionId) => api.chosenWords(session)
    }),
    [api, reveal]
  );
}
