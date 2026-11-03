import { createElement, createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CharacterForm, { type CharacterFormProps } from '../CharacterForm';
import { mount } from '../../hooks/__tests__/mount';
import { emptyForm } from '../../lib/characterForm';
import { NO_SHEET } from '../../lib/liveSheet';
import { DEFAULT_CONFIG } from '@shared/config';
import { DEFAULT_THEME, THEMES } from '@shared/themes';

/*
 * Todo 20261102-1830-01: auto-combat is a switch the session holds, so the
 * character's Combat section has no checkbox for it and draws every setting
 * whatever the switch says. A run hid the whole page behind the unticked box.
 */
const probe = mount();
beforeEach(() => {
  // The monster list asks main for the rows beneath it; nothing answers here.
  vi.stubGlobal('window', {
    mudengine: { inheritedMobRules: () => new Promise(() => undefined) },
    localStorage: { getItem: () => null, setItem: () => undefined }
  });
});
afterEach(() => {
  probe.unmount();
  vi.unstubAllGlobals();
});

const noop = (): void => undefined;

function draw(): void {
  const props: CharacterFormProps = {
    form: emptyForm([], null),
    patch: noop,
    onSubmit: noop,
    section: 'combat',
    searching: false,
    creating: false,
    copy: null,
    shown: undefined,
    servers: [],
    onManageRealms: noop,
    firstFieldRef: createRef<HTMLInputElement>(),
    sheet: NO_SHEET,
    bands: DEFAULT_CONFIG.ui.vitals,
    figures: null,
    palette: THEMES[DEFAULT_THEME].terminal,
    realm: {
      trainers: null,
      serving: {},
      wards: [],
      mobs: [],
      banks: null,
      invokeChoices: null,
      blessingChoice: null,
      chosen: null
    },
    shelf: { catalogue: [], picking: false, onOpenPicker: noop, onDonePicking: noop },
    inheritedLoops: [],
    onToggleLoop: noop,
    actions: null
  };
  probe.render(createElement(CharacterForm, props));
}

/** The `data-fieldset` of every fieldset drawn. */
const fieldsets = (): string[] =>
  probe
    .root()
    .findAll((node) => node.type === 'fieldset')
    .map((node) => String(node.props['data-fieldset']));

/** The setting every field drawn edits (`data-setting`). */
const settings = (): string[] =>
  probe
    .root()
    .findAll((node) => typeof node.type === 'string' && node.props['data-setting'] !== undefined)
    .map((node) => String(node.props['data-setting']));

describe("the character's Combat section", () => {
  it('draws the attack, the monsters and the monster rules, with no auto-combat checkbox', () => {
    draw();
    // Positive control: the section is drawn, its own fields among it.
    expect(fieldsets()).toEqual(
      expect.arrayContaining([
        'combat-attack',
        'combat-attacks',
        'combat-monsters',
        'combat-mob-rules'
      ])
    );
    expect(settings()).toEqual(
      expect.arrayContaining([
        'automation.combat.retaliate',
        'automation.combat.engage',
        'automation.combat.attack',
        'automation.combat.mobRules'
      ])
    );
    // The checkbox that hid them is gone.
    expect(settings().filter((path) => path.startsWith('automation.combat.enabled'))).toEqual([]);
  });
});
