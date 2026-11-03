import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteConsole, { type RemoteConsoleApi } from '../RemoteConsole';
import type { TerminalHandle } from '../TerminalView';
import { mount } from '../../hooks/__tests__/mount';
import { DEFAULT_CONFIG } from '@shared/config';
import type { Addressed } from '@shared/ipc';
import type { ControlAnswer, ControlText } from '@shared/peerControl';
import { DEFAULT_THEME, THEMES } from '@shared/themes';

/*
 * Todo 20261031-1156-01, the reviewer's two leftovers: a backlog or an
 * action's answer that comes after the console closed draws nothing into the
 * terminal it had, and the backlog joins the text held behind it exactly.
 */
interface FakeTerminal {
  written: string[];
  notices: string[];
  /** What reached it after it was disposed. */
  late: string[];
  disposed: boolean;
}

const terminals: FakeTerminal[] = [];

vi.mock('../TerminalView', () => ({
  default: function FakeTerminalView(props: { onReady(handle: TerminalHandle): void }) {
    useEffect(() => {
      const terminal: FakeTerminal = { written: [], notices: [], late: [], disposed: false };
      terminals.push(terminal);
      const handle = {
        write: (chunk: { text: string }) =>
          (terminal.disposed ? terminal.late : terminal.written).push(chunk.text),
        notice: (message: string) =>
          (terminal.disposed ? terminal.late : terminal.notices).push(message)
      } as unknown as TerminalHandle;
      props.onReady(handle);
      return () => {
        terminal.disposed = true;
      };
    }, []);
    return null;
  }
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeApi() {
  const backlogs: Array<Deferred<ControlText>> = [];
  const answers: Array<Deferred<ControlAnswer>> = [];
  const listeners = new Set<(message: Addressed<ControlText>) => void>();
  const api: RemoteConsoleApi = {
    controlBacklog: () => {
      const next = deferred<ControlText>();
      backlogs.push(next);
      return next.promise;
    },
    controlAct: () => {
      const next = deferred<ControlAnswer>();
      answers.push(next);
      return next.promise;
    },
    controlClose: () => Promise.resolve(),
    onControlText: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
  const push = (payload: ControlText): void => {
    for (const listener of listeners) listener({ session: 's', payload });
  };
  return { api, backlogs, answers, push };
}

const probe = mount();
beforeEach(() => {
  terminals.length = 0;
});
afterEach(() => probe.unmount());

function draw(api: RemoteConsoleApi, name: string): void {
  probe.render(
    createElement(RemoteConsole, {
      api,
      key: name,
      session: 's',
      name,
      settings: DEFAULT_CONFIG.terminal,
      fontStack: 'monospace',
      palette: THEMES[DEFAULT_THEME].terminal
    })
  );
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe('a remote console closed while main answers', () => {
  it('draws a late backlog into nothing, and the next console asks again', async () => {
    const { api, backlogs } = fakeApi();
    draw(api, 'Brakkle');
    draw(api, 'Soul');
    expect(backlogs).toHaveLength(2);
    expect(terminals.map((each) => each.disposed)).toEqual([true, false]);
    backlogs[1]!.resolve({ text: 'Soul stands here.\r\n', end: 19 });
    // Positive control: the console still open draws its backlog.
    await settle();
    expect(terminals[1]!.written).toEqual(['Soul stands here.\r\n']);
    backlogs[0]!.resolve({ text: 'Brakkle stands here.\r\n', end: 22 });
    await settle();
    expect(terminals[0]!.late).toEqual([]);
  });

  it("says nothing of a late action's answer into the closed one", async () => {
    const { api, answers } = fakeApi();
    draw(api, 'Brakkle');
    const rest = probe
      .root()
      .findAll((node) => node.type === 'button' && node.props['children'] === 'Rest');
    (rest[0]!.props['onClick'] as () => void)();
    (rest[0]!.props['onClick'] as () => void)();
    expect(answers).toHaveLength(2);
    answers[0]!.resolve({ r: 'refused', why: 'not now' });
    // Positive control: an answer while it is open is said.
    await settle();
    expect(terminals[0]!.notices).toHaveLength(1);
    draw(api, 'Soul');
    answers[1]!.resolve({ r: 'refused', why: 'not now' });
    await settle();
    expect(terminals[0]!.late).toEqual([]);
  });
});

describe('the backlog and the text held behind it', () => {
  it('draws each character once when more came than the backlog holds', async () => {
    const { api, backlogs, push } = fakeApi();
    draw(api, 'Brakkle');
    // Main kept only "b" and "c" of what it sent while the console opened.
    push({ text: 'a\r\n', end: 3 });
    push({ text: 'b\r\n', end: 6 });
    push({ text: 'c\r', end: 8 });
    push({ text: '\nd\r\n', end: 12 });
    backlogs[0]!.resolve({ text: 'b\r\nc\r\n', end: 9 });
    await settle();
    push({ text: 'e\r\n', end: 15 });
    expect(terminals[0]!.written.join('')).toBe('b\r\nc\r\nd\r\ne\r\n');
  });

  it('draws the held text after a backlog that came before it', async () => {
    const { api, backlogs, push } = fakeApi();
    draw(api, 'Brakkle');
    push({ text: 'b\r\n', end: 6 });
    backlogs[0]!.resolve({ text: 'a\r\n', end: 3 });
    await settle();
    expect(terminals[0]!.written.join('')).toBe('a\r\nb\r\n');
  });
});
