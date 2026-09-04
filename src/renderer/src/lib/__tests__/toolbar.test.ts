import { describe, expect, it, vi } from 'vitest';

import { AUTOMATION_SWITCH_NAMES, automationSwitches, DEFAULT_CONFIG } from '@shared/config';
import { DEFAULT_INTERNAL } from '@shared/internal';

import { shippedToolbar } from '../../hooks/useToolbarPins';
import { TOOLBAR_ACTIONS, toolbarButtons, type ToolbarSubject } from '../toolbar';

const subject = (over: Partial<ToolbarSubject> = {}): ToolbarSubject => ({
  switches: automationSwitches(DEFAULT_CONFIG.automation),
  connected: false,
  dialling: false,
  loop: 'idle',
  walking: false,
  canRestoreGear: false,
  setSwitch: vi.fn(),
  restoreGear: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  pauseLoop: vi.fn(),
  resumeLoop: vi.fn(),
  stopLoop: vi.fn(),
  stopWalk: vi.fn(),
  openLoops: vi.fn(),
  ...over
});

describe('the toolbar vocabulary', () => {
  /*
   * The Loops modal belongs to the character on screen: it files a loop into a
   * scope and starts it, and both are addressed at whoever it was opened for.
   * A pinned float's toolbar is somebody else's, so the button is absent
   * rather than drawn and wired to the wrong character — the rule this client
   * states for every control bound to nowhere, and here the cost of getting it
   * wrong is the wrong character walking.
   */
  it('leaves the loop shelf off a toolbar that cannot open one', () => {
    const ids = toolbarButtons(subject({ openLoops: null })).map((button) => button.id);
    expect(ids).not.toContain('loop:open');
    // The rest of the transport still addresses the float's own character.
    expect(ids).toContain('loop:stop');
    expect(ids).toContain('walk:stop');
  });

  it('offers every automation switch and every action, exactly once', () => {
    const ids = toolbarButtons(subject()).map((button) => button.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const name of AUTOMATION_SWITCH_NAMES) expect(ids).toContain(name);
    for (const action of TOOLBAR_ACTIONS) expect(ids).toContain(action);
  });

  /*
   * Unpinning one button must never move another out from under the pointer,
   * which is the map legend's rule and the Room card's faces' rule.
   */
  it('keeps the same order whatever is on the row', () => {
    const first = toolbarButtons(subject()).map((button) => button.id);
    const second = toolbarButtons(subject({ connected: true, loop: 'running' })).map(
      (button) => button.id
    );
    expect(second).toEqual(first);
  });

  it('gives every button a label and a glyph', () => {
    for (const button of toolbarButtons(subject())) {
      expect(button.label.length, `${button.id} has no label`).toBeGreaterThan(0);
      // A label that renders as its own key is a missing dictionary entry.
      expect(button.label, `${button.id} label is a key`).not.toMatch(/^toolbar\./);
      expect(button.icon.length).toBeGreaterThan(0);
    }
  });

  it('states the action rather than the state on the dial', () => {
    const off = toolbarButtons(subject()).find((button) => button.id === 'connect')!;
    const on = toolbarButtons(subject({ connected: true })).find(
      (button) => button.id === 'connect'
    )!;
    expect(off.label).not.toBe(on.label);
    expect(off.on).toBe(false);
    expect(on.on).toBe(true);
    // Refused while a dial is in flight: a button that stays pressable through
    // a fifteen-second connect reads as one that did nothing.
    expect(
      toolbarButtons(subject({ dialling: true })).find((button) => button.id === 'connect')!
        .disabled
    ).toBe(true);
  });

  it('flips a switch to the opposite of what the character says', () => {
    const setSwitch = vi.fn();
    const on = automationSwitches(DEFAULT_CONFIG.automation);
    on.combat = true;
    const buttons = toolbarButtons(subject({ switches: on, setSwitch }));
    buttons.find((button) => button.id === 'combat')!.run();
    expect(setSwitch).toHaveBeenCalledWith('combat', false);
    buttons.find((button) => button.id === 'retreat')!.run();
    expect(setSwitch).toHaveBeenCalledWith('retreat', true);
  });

  /* One button, two words: a loop is either running or held. */
  it('turns the loop button round rather than offering two', () => {
    const running = toolbarButtons(subject({ loop: 'running' })).find(
      (button) => button.id === 'loop:toggle'
    )!;
    const paused = toolbarButtons(subject({ loop: 'paused' })).find(
      (button) => button.id === 'loop:toggle'
    )!;
    expect(running.icon).toBe('pause');
    expect(paused.icon).toBe('play');
    expect(running.label).not.toBe(paused.label);
  });

  /*
   * Greyed, never absent. A toolbar whose buttons come and go as the game
   * moves is one nobody can reach for.
   */
  it('greys the transport when there is nothing to transport', () => {
    const idle = toolbarButtons(subject());
    expect(idle.find((button) => button.id === 'loop:toggle')!.disabled).toBe(true);
    expect(idle.find((button) => button.id === 'loop:stop')!.disabled).toBe(true);
    expect(idle.find((button) => button.id === 'walk:stop')!.disabled).toBe(true);

    const busy = toolbarButtons(subject({ loop: 'running', walking: true }));
    expect(busy.find((button) => button.id === 'loop:stop')!.disabled).toBe(false);
    expect(busy.find((button) => button.id === 'walk:stop')!.disabled).toBe(false);
  });
});

describe('the shipped toolbar row', () => {
  const ids = [...AUTOMATION_SWITCH_NAMES, ...TOOLBAR_ACTIONS];

  it('names only buttons this build actually has', () => {
    const shipped = shippedToolbar(
      ['connect', 'automation', 'combat', 'retaliate', 'loot', 'loop:toggle', 'loop:stop'],
      ids
    );
    expect([...shipped].sort()).toEqual(
      ['automation', 'combat', 'connect', 'loop:stop', 'loop:toggle', 'loot', 'retaliate'].sort()
    );
  });

  /*
   * A pattern naming nothing is how `search` came to be pinned in the file and
   * unpinned in the client — the kind of disagreement that reads as the
   * feature being broken.
   */
  it('every pattern the client ships names a button', () => {
    const { toolbar } = DEFAULT_INTERNAL;
    const named = shippedToolbar(toolbar.pinned, ids);
    expect([...toolbar.pinned].filter((pattern) => !named.has(pattern))).toEqual([]);
  });
});
