/**
 * A console gear opens the character page narrowed to the settings behind
 * one decision (todo 119). Where that page draws none of them (pacing and
 * idle are only on the Global page), the screen moves on to the Global page,
 * then the MudEngine page, narrowed the same way (user, 2026-10-14).
 */
import { useEffect, useRef, type RefObject } from 'react';

import { fieldSettingsOf } from '@shared/decisionSettings';
import type { SettingsFocus } from '../lib/settingPlaces';

type Page = 'characters' | 'defaults' | 'client';

export function useDecisionPage(
  focus: SettingsFocus | null,
  body: RefObject<HTMLElement>,
  tab: Page | 'servers',
  selected: string | null,
  openGlobal: (page: Exclude<Page, 'characters'>) => void
): void {
  // The door whose page is found: a page the player picks after it is theirs.
  const settled = useRef<SettingsFocus | null>(null);
  useEffect(() => {
    // Read off the page drawn for `tab`, not off the find's marks, which
    // follow the form a beat later and would still be the last page's.
    const form = body.current?.querySelector('.settings-form');
    if (focus === null || settled.current === focus || !form || tab === 'servers') return;
    // The character page is judged once it holds the door's character, not the one before it.
    if (tab === 'characters' && selected !== focus.character) return;
    const fields = fieldSettingsOf(focus.decision).map((path) => `[data-setting="${path}"]`);
    const drawn = fields.length === 0 || form.querySelector(fields.join(',')) !== null;
    if (!drawn && tab === 'characters') openGlobal('defaults');
    else if (!drawn && tab === 'defaults') openGlobal('client');
    else settled.current = focus;
  }, [body, focus, openGlobal, selected, tab]);
}
