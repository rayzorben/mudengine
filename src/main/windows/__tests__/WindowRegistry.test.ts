import { describe, expect, it } from 'vitest';

import { WindowRegistry, type WindowLike } from '../WindowRegistry';

interface Fake extends WindowLike {
  sent: { channel: string; payload: unknown }[];
  destroyed: boolean;
}

function fakeWindow(id: number): Fake {
  const window: Fake = {
    id,
    sent: [],
    destroyed: false,
    isDestroyed: () => window.destroyed,
    send: (channel, payload) => window.sent.push({ channel, payload })
  };
  return window;
}

describe('WindowRegistry', () => {
  it('sends the byte stream only to windows showing that session', () => {
    const registry = new WindowRegistry();
    const showing = fakeWindow(1);
    const other = fakeWindow(2);
    registry.add(showing);
    registry.add(other);
    registry.attach(showing.id, 'thorn');
    registry.attach(other.id, 'mara');

    registry.toAttached('session:data', { session: 'thorn', payload: 'bytes' });

    expect(showing.sent).toHaveLength(1);
    // The whole point: at four characters in combat, a window that is not
    // drawing a session must not pay to serialise its stream.
    expect(other.sent).toHaveLength(0);
  });

  it('sends coalesced facts to every window, attached or not', () => {
    const registry = new WindowRegistry();
    const showing = fakeWindow(1);
    const other = fakeWindow(2);
    registry.add(showing);
    registry.add(other);
    registry.attach(showing.id, 'thorn');

    // A tab rail renders vitals for characters whose terminals it is not
    // showing, so these cannot be gated on attachment.
    registry.toAll('session:character', { session: 'thorn', payload: {} });

    expect(showing.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(1);
  });

  it('sends the line feed only to attached windows that asked for it', () => {
    const registry = new WindowRegistry();
    const reading = fakeWindow(1);
    const quiet = fakeWindow(2);
    registry.add(reading);
    registry.add(quiet);
    registry.attach(reading.id, 'thorn');
    registry.attach(quiet.id, 'thorn');
    registry.setDiagnostics(reading.id, true);

    registry.toDiagnostics('session:line', { session: 'thorn', payload: 'framed' });

    expect(reading.sent).toHaveLength(1);
    // The common case: the Stream card is hidden, so a window showing the
    // session must still not pay a serialisation per framed line.
    expect(quiet.sent).toHaveLength(0);

    // Interest without attachment is not enough either — the feed is still
    // the byte stream, addressed to windows drawing that session.
    registry.setDiagnostics(quiet.id, true);
    registry.detach(quiet.id, 'thorn');
    registry.toDiagnostics('session:line', { session: 'thorn', payload: 'framed' });
    expect(quiet.sent).toHaveLength(0);

    // And closing the feed closes it.
    registry.setDiagnostics(reading.id, false);
    registry.toDiagnostics('session:line', { session: 'thorn', payload: 'framed' });
    expect(reading.sent).toHaveLength(2);
  });

  it('stops delivering once a window detaches', () => {
    const registry = new WindowRegistry();
    const window = fakeWindow(1);
    registry.add(window);
    registry.attach(window.id, 'thorn');
    registry.detach(window.id, 'thorn');

    registry.toAttached('session:data', { session: 'thorn', payload: 'bytes' });

    expect(window.sent).toHaveLength(0);
    expect(registry.viewers('thorn')).toEqual([]);
  });

  it('drops a destroyed window rather than sending to it', () => {
    const registry = new WindowRegistry();
    const window = fakeWindow(1);
    registry.add(window);
    registry.attach(window.id, 'thorn');

    // `closed` is not guaranteed to have fired before the next push, and
    // sending to a destroyed webContents throws.
    window.destroyed = true;
    registry.toAttached('session:data', { session: 'thorn', payload: 'bytes' });
    registry.toAll('config:changed', {});

    expect(window.sent).toHaveLength(0);
    expect(registry.size).toBe(0);
  });

  it('reports every window showing a session', () => {
    const registry = new WindowRegistry();
    const a = fakeWindow(1);
    const b = fakeWindow(2);
    registry.add(a);
    registry.add(b);
    registry.attach(a.id, 'thorn');
    registry.attach(b.id, 'thorn');

    expect(registry.viewers('thorn').sort()).toEqual([1, 2]);
    expect(registry.attachments(a.id)).toEqual(['thorn']);
  });
});
