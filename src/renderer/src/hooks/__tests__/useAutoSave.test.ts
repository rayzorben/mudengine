import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement, type MutableRefObject } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoSave, type AutoSave } from '../useAutoSave';

/*
 * The form stands in for a character's, and the file for its profile: one
 * per identity, written whole, read back to see what the switch left behind.
 */
interface Form {
  name: string;
  note: string;
}

type Write = (identity: string, value: Form) => Promise<string | null>;

interface ProbeProps {
  identity: string;
  value: Form;
  write: Write;
  out: MutableRefObject<AutoSave | null>;
  /** Off when the form is not on screen — another page, or the blank new form. */
  enabled?: boolean;
}

/**
 * The shape `SettingsScreen` gives the hook: `save` is an inline arrow that
 * closes over the identity *as rendered*, which is what makes flushing before
 * the selection changes load-bearing — a flush after it would save the old
 * form under the new name.
 */
function Probe({ identity, value, write, out, enabled = true }: ProbeProps): null {
  out.current = useAutoSave<Form>({
    value,
    identity,
    enabled,
    same: (a, b) => a.name === b.name && a.note === b.note,
    save: (form) => write(identity, form)
  });
  return null;
}

const DELAY = 700;

describe('switching what is being edited before the delay has run', () => {
  let dir: string;
  let renderer: ReactTestRenderer | null = null;
  const out: MutableRefObject<AutoSave | null> = { current: null };

  const fileOf = (identity: string): string => join(dir, `${identity}.json`);
  const readBack = (identity: string): Form =>
    JSON.parse(readFileSync(fileOf(identity), 'utf8')) as Form;

  /** Writes to disk the moment it is asked, and says so. */
  const writeNow: Write = (identity, value) => {
    writeFileSync(fileOf(identity), JSON.stringify(value));
    return Promise.resolve(null);
  };

  const render = (identity: string, value: Form, write: Write, enabled = true): void => {
    const element = createElement(Probe, { identity, value, write, out, enabled });
    if (renderer === null) {
      act(() => {
        renderer = create(element);
      });
    } else {
      const live = renderer;
      act(() => live.update(element));
    }
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'mudengine-autosave-'));
  });

  afterEach(() => {
    if (renderer !== null) act(() => renderer?.unmount());
    renderer = null;
    out.current = null;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * The bug this exists for: `useAutoSave` debounces, and the identity change
   * clears the timer. An edit younger than the delay was discarded by the
   * switch, silently — the form had shown it, so it looked saved.
   */
  it('saves the edit under the character it was typed into', async () => {
    const aria: Form = { name: 'Aria', note: '' };
    render('aria', aria, writeNow);
    render('aria', { ...aria, note: 'runs at 40%' }, writeNow);
    expect(out.current?.state).toBe('pending');

    // What `choose()` does, in the order it does it: flush, then switch.
    await act(async () => {
      out.current?.flush();
      render('bram', { name: 'Bram', note: '' }, writeNow);
    });

    expect(readBack('aria')).toEqual({ name: 'Aria', note: 'runs at 40%' });
    expect(existsSync(fileOf('bram'))).toBe(false);
  });

  /*
   * The baseline is per identity. The flushed write resolves after the next
   * character's form has been adopted as "already on disk", and recording it
   * then would compare Bram's form against Aria's and spend a save on a form
   * nobody touched — so waiting out the delay must write nothing.
   */
  it('does not spend a save on the character switched to', async () => {
    render('aria', { name: 'Aria', note: '' }, writeNow);
    render('aria', { name: 'Aria', note: 'edited' }, writeNow);
    await act(async () => {
      out.current?.flush();
      render('bram', { name: 'Bram', note: '' }, writeNow);
    });
    await act(async () => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(existsSync(fileOf('bram'))).toBe(false);
    expect(out.current?.state).toBe('saved');

    // And an edit to Bram is still Bram's.
    render('bram', { name: 'Bram', note: 'rests at 60%' }, writeNow);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(readBack('bram')).toEqual({ name: 'Bram', note: 'rests at 60%' });
    expect(readBack('aria')).toEqual({ name: 'Aria', note: 'edited' });
  });

  /*
   * A save already in flight when the switch happens. The flush cannot run at
   * once, so it is queued — and the queued write has to be the one asked for,
   * not whatever the form holds when the first save finally answers, which by
   * then is the other character's untouched form under the other name.
   */
  it('queues the flushed edit as it was, behind a save already in flight', async () => {
    let release: (() => void) | null = null;
    const writes: Array<{ identity: string; value: Form }> = [];
    const writeSlowly: Write = (identity, value) => {
      writes.push({ identity, value });
      writeFileSync(fileOf(identity), JSON.stringify(value));
      if (writes.length === 1) {
        return new Promise((resolve) => {
          release = () => resolve(null);
        });
      }
      return Promise.resolve(null);
    };

    render('aria', { name: 'Aria', note: '' }, writeSlowly);
    render('aria', { name: 'Aria', note: 'first' }, writeSlowly);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(out.current?.state).toBe('saving');
    expect(writes).toHaveLength(1);

    render('aria', { name: 'Aria', note: 'second' }, writeSlowly);
    await act(async () => {
      out.current?.flush();
      render('bram', { name: 'Bram', note: '' }, writeSlowly);
    });
    expect(writes).toHaveLength(1);

    await act(async () => {
      release?.();
    });
    await act(async () => {
      vi.advanceTimersByTime(DELAY * 3);
    });

    expect(writes.map((write) => write.identity)).toEqual(['aria', 'aria']);
    expect(readBack('aria')).toEqual({ name: 'Aria', note: 'second' });
    expect(existsSync(fileOf('bram'))).toBe(false);
  });

  /*
   * Waiting behind a save in flight is not a wedge. A review read it as one:
   * with the queued write itself slow, the next character's edits sit at
   * `pending`. They do — until the queued write settles, and then the latest
   * of them is written. What must never happen is that they are lost.
   */
  it('writes the latest edit once a slow queued save has settled', async () => {
    const releases: Array<() => void> = [];
    const writes: string[] = [];
    const writeSlowly: Write = (identity, value) => {
      writes.push(`${identity}:${value.note}`);
      writeFileSync(fileOf(identity), JSON.stringify(value));
      return new Promise((resolve) => releases.push(() => resolve(null)));
    };

    render('aria', { name: 'Aria', note: '' }, writeSlowly);
    render('aria', { name: 'Aria', note: 'first' }, writeSlowly);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    render('aria', { name: 'Aria', note: 'second' }, writeSlowly);
    await act(async () => {
      out.current?.flush();
      render('bram', { name: 'Bram', note: '' }, writeSlowly);
    });
    await act(async () => {
      releases[0]?.();
    });
    expect(writes).toEqual(['aria:first', 'aria:second']);

    render('bram', { name: 'Bram', note: 'one' }, writeSlowly);
    render('bram', { name: 'Bram', note: 'two' }, writeSlowly);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(out.current?.state).toBe('pending');

    await act(async () => {
      releases[1]?.();
    });
    expect(writes).toEqual(['aria:first', 'aria:second', 'bram:two']);
    await act(async () => {
      releases[2]?.();
    });
    expect(out.current?.state).toBe('saved');
    expect(readBack('bram')).toEqual({ name: 'Bram', note: 'two' });
  });
});

describe('taking the form away before the delay has run', () => {
  let dir: string;
  let renderer: ReactTestRenderer | null = null;
  const out: MutableRefObject<AutoSave | null> = { current: null };
  const fileOf = (identity: string): string => join(dir, `${identity}.json`);
  const writeNow: Write = (identity, value) => {
    writeFileSync(fileOf(identity), JSON.stringify(value));
    return Promise.resolve(null);
  };
  const render = (identity: string, value: Form, enabled: boolean): void => {
    const element = createElement(Probe, { identity, value, write: writeNow, out, enabled });
    if (renderer === null) {
      act(() => {
        renderer = create(element);
      });
    } else {
      const live = renderer;
      act(() => live.update(element));
    }
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'mudengine-autosave-'));
  });

  afterEach(() => {
    if (renderer !== null) act(() => renderer?.unmount());
    renderer = null;
    out.current = null;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * The sibling of the switch bug. A crumb to another page does not change
   * the selection; it flips `enabled`, and the reset that followed threw the
   * pending edit away just the same. The form is the same character's on
   * that render, so the hook saves it itself.
   */
  it('saves the edit when the page it was typed on is left', async () => {
    render('aria', { name: 'Aria', note: '' }, true);
    render('aria', { name: 'Aria', note: 'hangs up at 30%' }, true);
    expect(out.current?.state).toBe('pending');
    await act(async () => {
      render('aria', { name: 'Aria', note: 'hangs up at 30%' }, false);
    });
    expect(JSON.parse(readFileSync(fileOf('aria'), 'utf8'))).toEqual({
      name: 'Aria',
      note: 'hangs up at 30%'
    });
  });

  /*
   * Opening the blank new-character form changes the identity and disables
   * the hook in one render. The caller is expected to have flushed; if it
   * did not, the edit is lost — but the blank form must never be written
   * under the previous character's name, or under its own.
   */
  it('never writes the blank form that replaced a real one', async () => {
    render('aria', { name: 'Aria', note: '' }, true);
    render('aria', { name: 'Aria', note: 'edited' }, true);
    // Committed before the clock moves: a timer firing before the switch has
    // rendered would save under the old name, which is not this case.
    await act(async () => {
      render('new', { name: '', note: '' }, false);
    });
    await act(async () => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(existsSync(fileOf('aria'))).toBe(false);
    expect(existsSync(fileOf('new'))).toBe(false);
  });
});
