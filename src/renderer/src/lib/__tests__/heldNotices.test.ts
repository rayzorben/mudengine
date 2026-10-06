import { describe, expect, it } from 'vitest';

import { heldNotices, type NoticeConsole } from '../heldNotices';

/*
 * A character's notice is printed in that character's console and no other
 * (user, 2026-10-06): at launch every notice waiting for a console was
 * printed into the one on screen, so Rayzor's tab showed Festus's notices.
 */
describe('the held notices', () => {
  function consoles(...ids: string[]): {
    map: Map<string, NoticeConsole>;
    printed: Record<string, string[]>;
  } {
    const printed: Record<string, string[]> = {};
    const map = new Map<string, NoticeConsole>();
    for (const id of ids) {
      printed[id] = [];
      map.set(id, { notice: (message) => printed[id]!.push(message) });
    }
    return { map, printed };
  }

  it("prints a character's notice in its own console, never the one on screen", () => {
    const held = heldNotices();
    const { map, printed } = consoles('rayzor', 'festus');
    held.deliver({ session: 'festus', message: 'f1' }, map, 'rayzor');
    expect(printed).toEqual({ rayzor: [], festus: ['f1'] });
  });

  it('keeps a notice for a console not yet there until that console arrives', () => {
    const held = heldNotices();
    const before = consoles('rayzor');
    held.deliver({ session: 'festus', message: 'f1' }, before.map, 'rayzor');
    held.deliver({ session: 'festus', message: 'f2' }, before.map, 'rayzor');
    held.deliver({ session: 'rayzor', message: 'r1' }, before.map, 'rayzor');
    held.release(before.map, 'rayzor', ['rayzor', 'festus']);
    expect(before.printed).toEqual({ rayzor: ['r1'] });

    const after = consoles('rayzor', 'festus');
    held.release(after.map, 'rayzor', ['rayzor', 'festus']);
    expect(after.printed).toEqual({ rayzor: [], festus: ['f1', 'f2'] });
    // Printed once: a later release has nothing left for it.
    held.release(after.map, 'rayzor', ['rayzor', 'festus']);
    expect(after.printed.festus).toEqual(['f1', 'f2']);
  });

  it('keeps a notice for a character whose tab has not arrived yet', () => {
    const held = heldNotices();
    const none = consoles();
    held.deliver({ session: 'festus', message: 'f1' }, none.map, '');
    held.release(none.map, '', []);
    const later = consoles('festus');
    held.release(later.map, 'festus', ['festus']);
    expect(later.printed.festus).toEqual(['f1']);
  });

  it('drops what was waiting for a character whose tab left the window', () => {
    const held = heldNotices();
    const none = consoles();
    held.release(none.map, '', ['rayzor', 'festus']);
    held.deliver({ session: 'festus', message: 'f1' }, none.map, 'rayzor');
    held.release(none.map, 'rayzor', ['rayzor']);
    const back = consoles('rayzor', 'festus');
    held.release(back.map, 'rayzor', ['rayzor', 'festus']);
    expect(back.printed).toEqual({ rayzor: [], festus: [] });
  });

  it('prints what waited before a newer notice when the console arrives between releases', () => {
    const held = heldNotices();
    const none = consoles();
    held.deliver({ session: 'festus', message: 'f1' }, none.map, 'rayzor');
    held.deliver({ session: null, message: 'c1' }, none.map, 'rayzor');
    const now = consoles('rayzor', 'festus');
    held.deliver({ session: 'festus', message: 'f2' }, now.map, 'rayzor');
    held.deliver({ session: null, message: 'c2' }, now.map, 'rayzor');
    expect(now.printed).toEqual({ rayzor: ['c1', 'c2'], festus: ['f1', 'f2'] });
  });

  it('prints a notice about the client in the console on screen, waiting for one', () => {
    const held = heldNotices();
    const none = consoles();
    held.deliver({ session: null, message: 'config' }, none.map, '');
    const later = consoles('rayzor', 'festus');
    held.release(later.map, '', ['rayzor', 'festus']);
    expect(later.printed).toEqual({ rayzor: [], festus: [] });
    held.release(later.map, 'festus', ['rayzor', 'festus']);
    expect(later.printed).toEqual({ rayzor: [], festus: ['config'] });
    held.deliver({ session: null, message: 'again' }, later.map, 'rayzor');
    expect(later.printed.rayzor).toEqual(['again']);
  });
});
