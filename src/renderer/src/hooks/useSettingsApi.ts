/**
 * The settings screen's doors into main, bundled once (moved out of `App`,
 * todo 140).
 *
 * Stable callbacks: inline arrows would be a new function on every render, and
 * a child that keys an effect on one then runs it on every render, which is
 * how a refused save came to flash and vanish before anybody could read it.
 */
import { useMemo } from 'react';

import type { GlobalDraft, ProfileDraft, ServerDraft } from '@shared/drafts';
import type { IpcApi, Revealed, SessionId } from '@shared/ipc';

export function useSettingsApi(api: IpcApi, reveal: (ask: () => Promise<Revealed>) => void) {
  return useMemo(
    () => ({
      load: () => api.settingsSnapshot(),
      saveProfile: (id: string, draft: ProfileDraft) => api.saveProfile(id, draft),
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
