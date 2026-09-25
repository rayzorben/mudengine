/**
 * One character's own resolved settings, read off its profile summary: its
 * remotes, its supplies, its tab name, its automation switches and the
 * ceiling it rests to. Per character, never off the options file's global
 * block, since a pinned float and the tab rail report on characters nobody
 * is looking at.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/cards.md`.
 */
import { useCallback } from 'react';

import {
  automationSwitches,
  DEFAULT_CONFIG,
  type AutomationSwitches,
  type RemotesConfig,
  type SupplyItem
} from '@shared/config';
import type { ProfileSummary, SessionId } from '@shared/ipc';

/** A character whose file names no supplies. One list, so a card's props hold still. */
const NO_SUPPLIES: SupplyItem[] = [];

export function useProfileReaders(
  profiles: readonly Pick<
    ProfileSummary,
    'id' | 'name' | 'remotes' | 'supplies' | 'switches' | 'restTo'
  >[]
) {
  /**
   * One character's resolved `automation.remotes`, for the Player flyout and
   * the Gang card.
   *
   * Off the *profile*, not off `config`: a character states this sparsely over
   * the options file, and the global block alone would tell a pinned float that
   * somebody is trusted when the character it belongs to trusts nobody. The
   * float rule — every control on it bound to its own character — is the same
   * reason `theme` is read this way.
   *
   * A character with no summary yet falls back to the shipped default, which
   * trusts nobody: an unknown permission must never read as an allowance.
   */
  const remotesFor = useCallback(
    (id: SessionId): RemotesConfig =>
      profiles.find((profile) => profile.id === id)?.remotes ?? DEFAULT_CONFIG.automation.remotes,
    [profiles]
  );
  /**
   * This character's supplies list, resolved, and its display name — read the
   * way `remotesFor` is and for its reason: a list drawn off the global block
   * would show every character the same one.
   */
  const suppliesFor = useCallback(
    (id: SessionId): SupplyItem[] =>
      profiles.find((profile) => profile.id === id)?.supplies.items ?? NO_SUPPLIES,
    [profiles]
  );
  const profileNameFor = useCallback(
    (id: SessionId): string => profiles.find((profile) => profile.id === id)?.name ?? id,
    [profiles]
  );
  /**
   * This character's own automation switches, resolved, for the toolbar.
   *
   * Read the same way and for the same reason as `remotesFor`: a character
   * states these sparsely over the options file, so the global block alone
   * would draw a pinned float's toolbar with the *shown* character's answers.
   *
   * A character with no summary yet falls back to the shipped default, which
   * has everything off — the safe direction, and the same one an unknown
   * permission takes.
   */
  const switchesFor = useCallback(
    (id: SessionId): AutomationSwitches =>
      profiles.find((profile) => profile.id === id)?.switches ??
      automationSwitches(DEFAULT_CONFIG.automation),
    [profiles]
  );
  /**
   * The ceiling this character rests to, resolved, for the rail's mark.
   *
   * Read the same way and for the same reason as `remotesFor` and
   * `switchesFor`: the rail reports on the characters nobody is looking at, so
   * a figure taken from the global block would say the same thing for all four
   * whatever their own files state.
   *
   * A character with no summary yet falls back to **0**, and deliberately not
   * to the shipped default. 0 draws the bare word `resting`, which is the
   * modest claim; the shipped ceiling is 0.7, and drawing `resting to 70%` for
   * a character whose file has not arrived would put a specific figure on a tab
   * on the strength of a guess. Unknown is not the reassuring answer, and here
   * the reassuring answer is the precise one.
   */
  const restToFor = useCallback(
    (id: SessionId): number => profiles.find((profile) => profile.id === id)?.restTo ?? 0,
    [profiles]
  );

  return { remotesFor, suppliesFor, profileNameFor, switchesFor, restToFor };
}
