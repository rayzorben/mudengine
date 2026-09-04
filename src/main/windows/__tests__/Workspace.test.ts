import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Workspace } from '../Workspace';
import type { SessionId } from '../../../shared/ipc';

let dir = '';
let file = '';
let all: SessionId[] = [];
let main: number | null = 1;

const workspace = (): Workspace =>
  new Workspace({ mainWindowId: () => main, allSessions: () => all, file });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-workspace-'));
  file = path.join(dir, 'workspace.json');
  all = ['vaelor', 'thorn', 'soul'];
  main = 1;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/*
 * The ordinary case needs no bookkeeping at all: one window, every character.
 */
describe('one window', () => {
  it('shows every character without anything having been arranged', () => {
    const space = workspace();
    space.open(1);
    expect(space.sessionsFor(1)).toEqual(['vaelor', 'thorn', 'soul']);
  });

  it('picks up a character that appears later', () => {
    const space = workspace();
    space.open(1);
    all = [...all, 'newcomer'];
    expect(space.sessionsFor(1)).toContain('newcomer');
  });

  /* A remembered arrangement naming a character that has been deleted must not
     put a tab on screen for nothing. */
  it('drops a character that no longer exists', () => {
    const space = workspace();
    space.open(1);
    space.move('thorn', 1);
    all = ['vaelor', 'soul'];
    expect(space.sessionsFor(1)).not.toContain('thorn');
  });
});

describe('a character moved to its own window', () => {
  const popped = (): Workspace => {
    const space = workspace();
    space.open(1);
    space.open(2);
    space.move('thorn', 2);
    return space;
  };

  /* Two tabs for one character in two windows is two places to type at it, and
     typing has to reach exactly one session. */
  it('appears in exactly one window', () => {
    const space = popped();
    expect(space.sessionsFor(2)).toEqual(['thorn']);
    expect(space.sessionsFor(1)).not.toContain('thorn');
  });

  it('leaves the others where they were', () => {
    expect(popped().sessionsFor(1)).toEqual(['vaelor', 'soul']);
  });

  it('can be moved back', () => {
    const space = popped();
    space.move('thorn', 1);
    expect(space.sessionsFor(2)).toEqual([]);
    expect(space.sessionsFor(1)).toContain('thorn');
  });

  it('says which window holds it', () => {
    expect(popped().windowOf('thorn')).toBe(2);
  });
});

/*
 * Closing a window must never disconnect a character (docs/profiles.md §4), and
 * a character with a live socket and no tab anywhere is one nobody can reach.
 */
describe('a window that goes away', () => {
  it('hands its characters back rather than taking them with it', () => {
    const space = workspace();
    space.open(1);
    space.open(2);
    space.move('thorn', 2);
    expect(space.close(2)).toEqual(['thorn']);
    expect(space.sessionsFor(1)).toContain('thorn');
  });

  /* A pop-out that was force-closed, or crashed, must not strand anybody. */
  it('leaves nobody stranded even if it was never emptied', () => {
    const space = workspace();
    space.open(1);
    space.open(2);
    space.move('thorn', 2);
    space.move('soul', 2);
    space.close(2);
    expect(space.sessionsFor(1).sort()).toEqual(['soul', 'thorn', 'vaelor']);
  });

  /* Closing the *main* window while a pop-out is open must not lose anybody
     either — the remaining window answers for whatever nobody claims. */
  it('does not lose the main window’s characters when it is the one that closed', () => {
    const space = workspace();
    space.open(1);
    space.open(2);
    space.move('thorn', 2);
    space.close(1);
    main = 2;
    expect(space.sessionsFor(2).sort()).toEqual(['soul', 'thorn', 'vaelor']);
  });
});

/*
 * Chrome state, in its own file. Not the options file: it changes constantly,
 * and writing it into a hand-annotated YAML the user edits would mean the
 * client fighting them for it.
 */
describe('remembering the arrangement', () => {
  it('restores which characters were popped out', () => {
    const space = workspace();
    space.open(1);
    space.open(2);
    space.move('thorn', 2);
    space.save();

    expect(workspace().restore()).toEqual([['thorn']]);
  });

  it('says nothing about the main window, because that is whatever is left', () => {
    const space = workspace();
    space.open(1);
    space.save();
    expect(workspace().restore()).toEqual([]);
  });

  it('drops a remembered window whose characters have all gone', () => {
    const space = workspace();
    space.open(1);
    space.open(2);
    space.move('thorn', 2);
    space.save();

    all = ['vaelor', 'soul'];
    expect(workspace().restore()).toEqual([]);
  });

  it('reads a missing or damaged file as no arrangement at all', () => {
    expect(workspace().restore()).toEqual([]);
    fs.writeFileSync(file, '{ not json', 'utf8');
    expect(workspace().restore()).toEqual([]);
    fs.writeFileSync(file, '[]', 'utf8');
    expect(workspace().restore()).toEqual([]);
  });

  /* An arrangement that cannot be written is a convenience lost, not a reason
     to fail: everything still works, in one window. */
  it('does not throw when it cannot write', () => {
    const space = new Workspace({
      mainWindowId: () => 1,
      allSessions: () => all,
      file: path.join(dir, 'no-such-dir', '\0bad', 'workspace.json')
    });
    space.open(1);
    expect(() => space.save()).not.toThrow();
  });
});

/*
 * The rail is the player's arrangement of their characters, and it used to be
 * whatever order the profile directory sorted in — alphabetical by filename,
 * which has nothing to do with which character somebody plays.
 */
describe('the order the rail was dragged into', () => {
  it('is what the window is asked for afterwards', () => {
    const space = workspace();
    space.open(1);
    space.reorder(1, ['soul', 'vaelor', 'thorn']);
    expect(space.sessionsFor(1)).toEqual(['soul', 'vaelor', 'thorn']);
  });

  /*
   * It used to be written on every save and read back never: `restore()` skipped
   * the `main: true` entry on the reasoning that the main window's characters
   * are "whatever is left" — true of *which* characters, and silent about what
   * order they are in.
   */
  it('comes back on the next launch', () => {
    const first = workspace();
    first.open(1);
    first.reorder(1, ['soul', 'vaelor', 'thorn']);
    first.save();

    const second = workspace();
    second.open(1);
    expect(second.sessionsFor(1)).toEqual(['soul', 'vaelor', 'thorn']);
  });

  /* A character made since the arrangement joins the end rather than
     displacing it. */
  it('appends a character the remembered order has never heard of', () => {
    const first = workspace();
    first.open(1);
    first.reorder(1, ['soul', 'vaelor', 'thorn']);
    first.save();

    all = [...all, 'newcomer'];
    const second = workspace();
    second.open(1);
    expect(second.sessionsFor(1)).toEqual(['soul', 'vaelor', 'thorn', 'newcomer']);
  });

  /* A remembered order naming a deleted character must not reserve it a place. */
  it('drops a character that no longer exists', () => {
    const first = workspace();
    first.open(1);
    first.reorder(1, ['soul', 'vaelor', 'thorn']);
    first.save();

    all = ['soul', 'thorn'];
    const second = workspace();
    second.open(1);
    expect(second.sessionsFor(1)).toEqual(['soul', 'thorn']);
  });

  /*
   * A window may not reorder — or quietly adopt — a tab that lives somewhere
   * else. That is the same rule that stops it holding two tabs for one
   * character, applied to a list arriving from a renderer that may be stale.
   */
  it('ignores a character the window does not own', () => {
    const space = workspace();
    space.open(1);
    space.open(2);
    space.move('thorn', 2);
    space.reorder(2, ['thorn', 'vaelor', 'soul']);
    expect(space.sessionsFor(2)).toEqual(['thorn']);
    expect(space.sessionsFor(1)).toEqual(['vaelor', 'soul']);
  });

  /* A roster that grew between the drag starting and the order landing loses
     nobody: what the list does not name keeps its place at the end. */
  it('keeps a tab the order forgot to mention', () => {
    const space = workspace();
    space.open(1);
    space.reorder(1, ['soul', 'vaelor', 'thorn']);
    space.reorder(1, ['thorn', 'soul']);
    expect(space.sessionsFor(1)).toEqual(['thorn', 'soul', 'vaelor']);
  });

  it('does nothing for a window that was never opened', () => {
    const space = workspace();
    space.open(1);
    space.reorder(9, ['soul']);
    expect(space.sessionsFor(1)).toEqual(['vaelor', 'thorn', 'soul']);
  });

  /* The pop-outs are still restored, and their own order with them. */
  it('restores a pop-out beside the main window order', () => {
    const first = workspace();
    first.open(1);
    first.open(2);
    first.move('thorn', 2);
    first.move('soul', 2);
    first.reorder(2, ['soul', 'thorn']);
    first.save();

    const second = workspace();
    second.open(1);
    expect(second.restore()).toEqual([['soul', 'thorn']]);
  });
});
