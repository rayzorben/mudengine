import { describe, expect, it } from 'vitest';

import { newEd25519Pair } from '../../../node/ed25519';
import type { SafetyDecision } from '../../../shared/automation';
import { Invoke, Push, Send, type Addressed } from '../../../shared/ipc';
import type { PeerGrant } from '../../../shared/peerGrant';
import { remoteSessionId } from '../../../shared/peerRelay';
import type { ShareLevel } from '../../../shared/peers';
import type { Caller, Handler } from '../../host/Host';
import { WindowRegistry } from '../../windows/WindowRegistry';
import { ControlDesk } from '../ControlDesk';
import { RelayDesk } from '../RelayDesk';
import { RemoteSessions } from '../RemoteSessions';
import { relayTransport } from '../relayTransport';
import { screenLine } from '../screenLine';
import { peerSheetOf } from '../peerSheet';
import { brakkle, install, soul, state, until, useGateway, type ControlHooks } from './peerHarness';

useGateway();

/** Soul's window, and what reaches it. */
const SOUL_WINDOW = 7;
const REMOTE = remoteSessionId('s', 'Brakkle');

/**
 * Brakkle's install shares him with Soul's; Soul's install opens him as a
 * session of its own and calls him through the gateway. Brakkle's row for
 * Soul (`grant`) is what his desk checks on every frame, apart from what his
 * link last told the gateway. Brakkle's handlers record each call.
 */
function controlled(level: Exclude<ShareLevel, 'off'>) {
  const brakklePair = newEd25519Pair();
  const soulPair = newEd25519Pair();
  const grant: PeerGrant = { share: level, receive: false, keys: [soulPair.publicKey] };
  const notices: string[] = [];
  const refusals: SafetyDecision[] = [];
  const calls: Array<{ args: unknown[]; windowId: number }> = [];
  const sharerHooks: ControlHooks = {};
  const controllerHooks: ControlHooks = {};
  const sharer = install(sharerHooks);
  const controller = install(controllerHooks);

  // Brakkle's client: a registry, and handlers that answer as main does.
  const sharerWindows = new WindowRegistry();
  const recorded = relayTransport({ handle: () => undefined, on: () => undefined }, () => null);
  const record =
    (answer: (caller: Caller, args: unknown[]) => unknown): Handler =>
    (caller, ...args) => {
      calls.push({ args, windowId: caller.windowId });
      return answer(caller, args);
    };
  recorded.transport.handle(
    Invoke.attach,
    record((caller, [session]) => {
      sharerWindows.attach(caller.windowId, session as string);
      return { attached: session };
    })
  );
  recorded.transport.handle(
    Invoke.getCharacter,
    record(() => ({ name: 'Brakkle', big: 'x'.repeat(200_000) }))
  );
  recorded.transport.handle(
    Invoke.connect,
    record(() => 'dialled')
  );
  recorded.transport.handle(
    Invoke.ask,
    record(() => true)
  );
  recorded.transport.handle(
    Invoke.addLoop,
    record(() => ({ ok: true }))
  );
  recorded.transport.on(
    Send.input,
    record(() => undefined)
  );
  const character = {
    id: 'b',
    peer: brakkle,
    grantFor: (name: string) => (name === 'Soul' ? grant : null)
  };
  const relay = new RelayDesk({
    handlers: recorded.handlers,
    windows: sharerWindows,
    link: sharer.link,
    screen: (_id, line, by) => screenLine(line, by, {}),
    notice: (_id, message) => notices.push(message),
    refused: (_id, decision) => refusals.push(decision),
    say: (message) => notices.push(message),
    now: Date.now
  });
  const desk = new ControlDesk({
    characterOf: () => character,
    characterAt: () => character,
    link: sharer.link,
    relay,
    notice: (_id, message) => notices.push(message),
    changed: sharer.wake
  });
  sharerHooks.controlled = (frame) => desk.heard(frame);

  // Soul's client: what its window is pushed.
  const pushed: Array<{ channel: string; payload: unknown }> = [];
  const soulWindows = new WindowRegistry();
  soulWindows.add({
    id: SOUL_WINDOW,
    isDestroyed: () => false,
    send: (channel, payload) => {
      pushed.push({ channel, payload });
      controller.wake();
    }
  });
  const accepts = (): { receive: boolean; keys: string[] } => ({
    receive: true,
    keys: [brakklePair.publicKey]
  });
  const remotes = new RemoteSessions({
    peerOf: () => soul,
    sheetsFor: () => controller.book.sheetsFor(soul, accepts),
    nameOf: () => 'Soul',
    link: controller.link,
    windows: soulWindows,
    notice: (_id, message) => notices.push(message),
    changed: controller.wake,
    say: (message) => notices.push(message),
    answerMs: () => 5000
  });
  controllerHooks.controlling = (frame) => remotes.heard(frame);
  const soulCaller: Caller = { windowId: SOUL_WINDOW, send: () => undefined };
  /** A call Soul's window makes, as the transport hands it over. */
  const call = (kind: 'invoke' | 'send', channel: string, ...args: unknown[]): unknown =>
    remotes.intercept(kind, channel, soulCaller, args)?.value;

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
    await until(() => remotes.open('s', 'Brakkle') === null, controller.changed);
    await until(() => desk.controlledBy('b').length > 0, sharer.changed);
  };
  const sheets = () => controller.book.sheetsFor(soul, accepts);
  return {
    sharer,
    controller,
    desk,
    remotes,
    sharerWindows,
    grant,
    calls,
    notices,
    refusals,
    pushed,
    call,
    shareAt,
    open,
    sheets
  };
}

describe('remote control between two installs', () => {
  it('refuses to open a character shared at state, and opens the same at control as a session', async () => {
    const atState = controlled('state');
    // The sheet has come, so the refusal is about the level and not a share not heard yet.
    await until(() => atState.sheets().length > 0, atState.controller.changed);
    expect(atState.remotes.open('s', 'Brakkle')).toMatch(/does not give/);
    expect(atState.remotes.summaries()).toEqual([]);

    const atControl = controlled('control');
    await atControl.open();
    expect(atControl.desk.controlledBy('b')).toEqual(['Soul']);
    expect(atControl.remotes.summaries()).toEqual([
      expect.objectContaining({
        id: REMOTE,
        name: 'Brakkle',
        remote: { via: 's', viaName: 'Soul' }
      })
    ]);
  });

  it("runs a call through the sharer's handler under its own session, and answers it", async () => {
    const set = controlled('control');
    await set.open();
    const answer = (await set.call('invoke', Invoke.getCharacter, REMOTE)) as {
      name: string;
      big: string;
    };
    // Two hundred thousand characters cross in parts and come back whole.
    expect(answer.name).toBe('Brakkle');
    expect(answer.big).toHaveLength(200_000);
    expect(set.calls[0]!.args).toEqual(['b']);
  });

  it('pushes what the character is pushed to the controller under its session here, and nothing else', async () => {
    const set = controlled('control');
    await set.open();
    await set.call('invoke', Invoke.attach, REMOTE);
    const message = (session: string, hp: number): Addressed<unknown> => ({
      session,
      payload: { hp }
    });
    set.sharerWindows.toAll(Push.character, message('another', 1));
    set.sharerWindows.toAll(Push.config, { hp: 2 });
    set.sharerWindows.toAll(Push.character, message('b', 3));
    set.sharerWindows.toAttached(Push.data, message('b', 4));
    await until(
      () => set.pushed.some((each) => each.channel === Push.data),
      set.controller.changed
    );
    // Positive control above; the push about another character and the global one never came.
    expect(set.pushed).toEqual([
      { channel: Push.character, payload: { session: REMOTE, payload: { hp: 3 } } },
      { channel: Push.data, payload: { session: REMOTE, payload: { hp: 4 } } }
    ]);
  });

  it('refuses a call the rules keep from crossing, and runs nothing', async () => {
    const set = controlled('control');
    await set.open();
    await expect(set.call('invoke', Invoke.connect, REMOTE)).rejects.toThrow(
      /not done by remote control/
    );
    expect(set.calls).toEqual([]);
  });

  it('erases a typed line that logs the character out instead of sending its Enter', async () => {
    const set = controlled('control');
    await set.open();
    set.call('send', Send.input, REMOTE, 'q');
    set.call('send', Send.input, REMOTE, 'uit\r');
    set.call('send', Send.input, REMOTE, 'exp\r');
    await until(() => set.calls.length === 3, set.sharer.changed);
    expect(set.calls.map((each) => each.args[1])).toEqual(['q', 'uit\b\b\b\b', 'exp\r']);
    expect(set.refusals).toEqual([expect.objectContaining({ acted: false })]);
    expect(set.notices.some((line) => line.includes('"quit" logs the character off'))).toBe(true);
  });

  it('screens a card command on the end of what was typed without an Enter', async () => {
    const set = controlled('control');
    await set.open();
    set.call('send', Send.input, REMOTE, 'qui');
    await until(() => set.calls.length === 1, set.sharer.changed);
    await expect(set.call('invoke', Invoke.ask, REMOTE, 't')).rejects.toThrow(/"quit"/);
    // The keys went; the command that would have ended the line did not.
    expect(set.calls.map((each) => each.args[1])).toEqual(['qui']);
  });

  it("saves a loop into the character's own file, and refuses one for every character", async () => {
    const set = controlled('control');
    await set.open();
    const loop = { name: 'Plaza' };
    await expect(set.call('invoke', Invoke.addLoop, 'global', REMOTE, loop)).rejects.toThrow(
      /not done by remote control/
    );
    expect(set.calls).toEqual([]);
    await set.call('invoke', Invoke.addLoop, 'profile', REMOTE, loop);
    expect(set.calls.map((each) => each.args)).toEqual([['profile', 'b', loop]]);
  });

  it('checks the row on every call, whatever the gateway last heard', async () => {
    const set = controlled('control');
    await set.open();
    // Lowered on Brakkle's own row, not yet told to the gateway: the call goes nowhere there.
    set.grant.share = 'state';
    await expect(set.call('invoke', Invoke.getCharacter, REMOTE)).rejects.toThrow();
    expect(set.calls).toEqual([]);
  }, 10_000);

  it('ends control when the share drops to state', async () => {
    const set = controlled('control');
    await set.open();
    set.shareAt('state');
    await until(() => set.remotes.summaries().length === 0, set.controller.changed);
    expect(set.notices).toContain('Brakkle no longer gives this character remote control.');
    await expect(set.call('invoke', Invoke.getCharacter, REMOTE)).rejects.toThrow();
  });

  it('ends control at Stop, and keeps it ended until the row is set again', async () => {
    const set = controlled('control');
    await set.open();
    set.desk.stop('b');
    await until(() => set.remotes.summaries().length === 0, set.controller.changed);
    expect(set.notices).toContain('Brakkle stopped your remote control.');
    // Opened again: the gateway lets the watch through, and the desk releases it.
    expect(set.remotes.open('s', 'Brakkle')).toBeNull();
    await until(() => set.remotes.summaries().length === 0, set.controller.changed);
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
