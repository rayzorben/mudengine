import { describe, expect, it } from 'vitest';

import { newEd25519Pair } from '../../../node/ed25519';
import type { SafetyDecision } from '../../../shared/automation';
import type { PeerGrant } from '../../../shared/peerGrant';
import type { ControlAction, ControlAnswer } from '../../../shared/peerControl';
import type { ShareLevel } from '../../../shared/peers';
import { ControlDesk } from '../ControlDesk';
import { Controlling } from '../Controlling';
import { sharedSheet } from '../../../shared/__tests__/sharedSheets';
import { peerSheetOf } from '../peerSheet';
import { brakkle, install, soul, state, until, useGateway, type ControlHooks } from './peerHarness';

useGateway();

/**
 * Brakkle's install shares him with Soul's; Soul's install opens him and
 * sends actions. Brakkle's row for Soul (`grant`) is what his desk checks on
 * every frame, apart from what his link last told the gateway.
 */
function controlled(level: Exclude<ShareLevel, 'off'>) {
  const brakklePair = newEd25519Pair();
  const soulPair = newEd25519Pair();
  const grant: PeerGrant = { share: level, receive: false, keys: [soulPair.publicKey] };
  const ran: Array<{ action: ControlAction; by: string }> = [];
  const notices: string[] = [];
  const refusals: SafetyDecision[] = [];
  const sharerHooks: ControlHooks = {};
  const controllerHooks: ControlHooks = {};
  const sharer = install(sharerHooks);
  const controller = install(controllerHooks);
  const character = {
    id: 'b',
    peer: brakkle,
    grantFor: (name: string) => (name === 'Soul' ? grant : null)
  };
  const desk = new ControlDesk({
    characterOf: () => character,
    characterAt: () => character,
    run: (_id, action, by): Promise<ControlAnswer> => {
      ran.push({ action, by });
      return Promise.resolve({ r: 'done' });
    },
    link: sharer.link,
    notice: (_id, message) => notices.push(message),
    refused: (_id, decision) => refusals.push(decision),
    changed: sharer.wake,
    backlogChars: () => 1000,
    now: Date.now
  });
  sharerHooks.controlled = (frame) => desk.heard(frame);
  const accepts = (): { receive: boolean; keys: string[] } => ({
    receive: true,
    keys: [brakklePair.publicKey]
  });
  const controlling = new Controlling({
    peerOf: () => soul,
    sheetsFor: () => controller.book.sheetsFor(soul, accepts),
    link: controller.link,
    text: controller.wake,
    notice: (_id, message) => notices.push(message),
    changed: controller.wake,
    backlogChars: () => 1000,
    answerMs: () => 5000
  });
  controllerHooks.controlling = (frame) => controlling.heard(frame);
  const shareAt = (at: Exclude<ShareLevel, 'off'>): void => {
    grant.share = at;
    sharer.link.want([
      { peer: brakkle, pair: brakklePair, shares: [{ name: 'Soul', share: at, keys: grant.keys }] }
    ]);
  };
  shareAt(level);
  sharer.link.observe(brakkle, peerSheetOf(state(70)));
  controller.link.want([{ peer: soul, pair: soulPair, shares: [] }]);
  /** Soul opens Brakkle, once his sheet has come, and Brakkle's desk has him as controller. */
  const open = async (): Promise<void> => {
    await until(() => controlling.open('s', 'Brakkle') === null, controller.changed);
    await until(() => desk.controlledBy('b').length > 0, sharer.changed);
  };
  const sheets = () => controller.book.sheetsFor(soul, accepts);
  return {
    sharer,
    controller,
    desk,
    controlling,
    grant,
    ran,
    notices,
    refusals,
    shareAt,
    open,
    sheets
  };
}

describe('remote control between two installs', () => {
  it('refuses to open a character shared at state, and opens the same at control', async () => {
    const atState = controlled('state');
    // The sheet has come, so the refusal is about the level and not a share not heard yet.
    await until(() => atState.sheets().length > 0, atState.controller.changed);
    expect(atState.sheets()[0]!.control).toBe(false);
    expect(atState.controlling.open('s', 'Brakkle')).toMatch(/does not give/);
    expect(await atState.controlling.act('s', { a: 'rest' })).toEqual({
      r: 'refused',
      why: expect.stringMatching(/not controlling/) as string
    });

    const atControl = controlled('control');
    await atControl.open();
    expect(atControl.desk.controlledBy('b')).toEqual(['Soul']);
    expect(atControl.controlling.view('s')).toMatchObject({ name: 'Brakkle' });
  });

  it('runs an action through the sharer and sends its terminal text back', async () => {
    const set = controlled('control');
    await set.open();
    set.desk.painted('b', 'You are in the plaza.\r\n');
    await until(() => set.controlling.backlog('s').includes('plaza'), set.controller.changed);
    expect(await set.controlling.act('s', { a: 'move', dir: 'n' })).toEqual({ r: 'done' });
    expect(set.ran).toEqual([{ action: { a: 'move', dir: 'n' }, by: 'Soul' }]);
    expect(set.notices.some((line) => line.includes('Soul sent the move n'))).toBe(true);
  });

  it('refuses an action another build added, and ignores a field it does not know', async () => {
    const set = controlled('control');
    await set.open();
    const dance = { a: 'dance', with: 'Soul' } as unknown as ControlAction;
    expect(await set.controlling.act('s', dance)).toEqual({
      r: 'refused',
      why: expect.stringContaining('"dance"') as string
    });
    expect(set.refusals).toHaveLength(1);
    const rest = { a: 'rest', quietly: true } as unknown as ControlAction;
    expect(await set.controlling.act('s', rest)).toEqual({ r: 'done' });
    expect(set.ran.map((each) => each.action)).toEqual([{ a: 'rest' }]);
  });

  it('checks the row on every action, whatever the gateway last heard', async () => {
    const set = controlled('control');
    await set.open();
    // Lowered on Brakkle's own row, not yet told to the gateway: the next action is refused there.
    set.grant.share = 'state';
    expect(await set.controlling.act('s', { a: 'rest' })).toEqual({
      r: 'refused',
      why: expect.stringContaining('no remote control') as string
    });
    expect(set.ran).toEqual([]);
    expect(set.refusals[0]).toMatchObject({ acted: false });
  });

  it('ends control when the share drops to state', async () => {
    const set = controlled('control');
    await set.open();
    set.shareAt('state');
    await until(() => set.controlling.view('s') === null, set.controller.changed);
    expect(set.notices).toContain('Brakkle no longer gives this character remote control.');
    expect((await set.controlling.act('s', { a: 'rest' })).r).toBe('refused');
    expect(set.ran).toEqual([]);
  });

  it('ends control at Stop, and keeps it ended until the row is set again', async () => {
    const set = controlled('control');
    await set.open();
    set.desk.stop('b');
    await until(() => set.controlling.view('s') === null, set.controller.changed);
    expect(set.notices).toContain('Brakkle stopped your remote control.');
    // Opened again: the gateway lets the watch through, and the desk releases it.
    expect(set.controlling.open('s', 'Brakkle')).toBeNull();
    await until(() => set.controlling.view('s') === null, set.controller.changed);
    expect(set.desk.controlledBy('b')).toEqual([]);
    // Turned off and on again on the row: control is given again.
    set.grant.share = 'state';
    set.desk.regrant(['b']);
    set.grant.share = 'control';
    set.desk.regrant(['b']);
    await set.open();
    expect(set.desk.controlledBy('b')).toEqual(['Soul']);
  });
});

describe('a control the sharer ended', () => {
  it('is no longer watched, so a reconnect does not bring it back', () => {
    const watches: unknown[] = [];
    const controlling = new Controlling({
      peerOf: () => soul,
      sheetsFor: () => [{ ...sharedSheet('Brakkle', { key: 'K', control: true }), from: brakkle }],
      link: { watch: (_peer, watched) => watches.push(watched), sendAction: () => true },
      text: () => undefined,
      notice: () => undefined,
      changed: () => undefined,
      backlogChars: () => 1000,
      answerMs: () => 5000
    });
    expect(controlling.open('s', 'Brakkle')).toBeNull();
    expect(watches).toEqual([{ from: brakkle, key: 'K' }]);
    controlling.heard({ k: 'released', from: brakkle, key: 'K', why: 'unshared' });
    expect(watches).toEqual([{ from: brakkle, key: 'K' }, null]);
    expect(controlling.view('s')).toBeNull();
  });
});
