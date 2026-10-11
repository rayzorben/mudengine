import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement, type MutableRefObject } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAutoSave, type AutoSave } from '../useAutoSave';
import { mount } from './mount';

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
  const probe = mount();
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
    probe.render(element);
  };

  /**
   * Writes the file at once and answers each write when released, in order, as
   * `saveProfile` renames the file into place and `refresh()` answers later.
   */
  const slowWriter = (
    refusal: string | null = null
  ): { write: Write; writes: string[]; release: () => void } => {
    const writes: string[] = [];
    const releases: Array<() => void> = [];
    const write: Write = (identity, value) => {
      writes.push(`${identity}:${value.note}`);
      if (refusal === null) writeFileSync(fileOf(identity), JSON.stringify(value));
      return new Promise((resolve) => releases.push(() => resolve(refusal)));
    };
    return { write, writes, release: () => releases.shift()?.() };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'mudengine-autosave-'));
  });

  afterEach(() => {
    probe.unmount();
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
    const { write: writeSlowly, writes, release } = slowWriter();

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
      release();
    });
    expect(writes).toEqual(['aria:first', 'aria:second']);

    render('bram', { name: 'Bram', note: 'one' }, writeSlowly);
    render('bram', { name: 'Bram', note: 'two' }, writeSlowly);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(out.current?.state).toBe('pending');

    await act(async () => {
      release();
    });
    expect(writes).toEqual(['aria:first', 'aria:second', 'bram:two']);
    await act(async () => {
      release();
    });
    expect(out.current?.state).toBe('saved');
    expect(readBack('bram')).toEqual({ name: 'Bram', note: 'two' });
  });

  /*
   * Todo 35: the smoke's Remotes switch, unticked and ticked again after the
   * file was renamed into place and before the save's `refresh()` answered.
   * The second tick matched the baseline from before the first write, so
   * nothing was saved, and the box showed on while the file said off.
   */
  it('writes a setting changed back while its save is on its way', async () => {
    const { write, writes, release } = slowWriter();
    render('aria', { name: 'Aria', note: 'on' }, write);
    render('aria', { name: 'Aria', note: 'off' }, write);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    // Positive control: the first write is on disk and has not answered.
    expect(writes).toEqual(['aria:off']);
    expect(out.current?.state).toBe('saving');

    render('aria', { name: 'Aria', note: 'on' }, write);
    expect(out.current?.state).toBe('pending');
    await act(async () => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(writes).toEqual(['aria:off']);

    await act(async () => {
      release();
    });
    expect(writes).toEqual(['aria:off', 'aria:on']);
    await act(async () => {
      release();
    });
    expect(readBack('aria')).toEqual({ name: 'Aria', note: 'on' });
    expect(out.current?.state).toBe('saved');
  });

  /*
   * The same gap with a character chosen in it: `choose()` flushes, and the
   * flush has to see the change back as an edit, since the write answers
   * after the switch and is no longer the form's baseline by then.
   */
  it('writes a setting changed back on the way out to another character', async () => {
    const { write, writes, release } = slowWriter();
    render('aria', { name: 'Aria', note: 'on' }, write);
    render('aria', { name: 'Aria', note: 'off' }, write);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(writes).toEqual(['aria:off']);

    render('aria', { name: 'Aria', note: 'on' }, write);
    await act(async () => {
      out.current?.flush();
      render('bram', { name: 'Bram', note: '' }, write);
    });
    expect(writes).toEqual(['aria:off']);

    await act(async () => {
      release();
    });
    expect(writes).toEqual(['aria:off', 'aria:on']);
    await act(async () => {
      release();
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(readBack('aria')).toEqual({ name: 'Aria', note: 'on' });
    expect(existsSync(fileOf('bram'))).toBe(false);
  });

  /*
   * Changed back, the delay run out behind the write on its way, then changed
   * again to what that write sends: the change back queued while the write was
   * out must not be written over it.
   */
  it('drops a queued change once the form matches the write on its way', async () => {
    const { write, writes, release } = slowWriter();
    render('aria', { name: 'Aria', note: 'on' }, write);
    render('aria', { name: 'Aria', note: 'off' }, write);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(writes).toEqual(['aria:off']);

    render('aria', { name: 'Aria', note: 'on' }, write);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    // Positive control: the change back was seen and its timer has run.
    expect(out.current?.state).toBe('pending');
    expect(writes).toEqual(['aria:off']);

    render('aria', { name: 'Aria', note: 'off' }, write);
    await act(async () => {
      release();
    });
    await act(async () => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(writes).toEqual(['aria:off']);
    expect(readBack('aria')).toEqual({ name: 'Aria', note: 'off' });
    expect(out.current?.state).toBe('saved');
  });

  /*
   * A refused write is not sent again by itself: the refusal stays on screen
   * and the next edit tries again, so a file that stays locked is not
   * hammered.
   */
  it('sends a refused write once', async () => {
    const { write, writes, release } = slowWriter('the file is locked');
    render('aria', { name: 'Aria', note: 'on' }, write);
    render('aria', { name: 'Aria', note: 'off' }, write);
    await act(async () => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(writes).toEqual(['aria:off']);
    await act(async () => {
      release();
    });
    expect(out.current?.state).toBe('refused');
    await act(async () => {
      vi.advanceTimersByTime(DELAY * 3);
    });
    expect(writes).toEqual(['aria:off']);
    expect(out.current?.state).toBe('refused');
  });
});

describe('taking the form away before the delay has run', () => {
  let dir: string;
  const probe = mount();
  const out: MutableRefObject<AutoSave | null> = { current: null };
  const fileOf = (identity: string): string => join(dir, `${identity}.json`);
  const writeNow: Write = (identity, value) => {
    writeFileSync(fileOf(identity), JSON.stringify(value));
    return Promise.resolve(null);
  };
  const render = (identity: string, value: Form, enabled: boolean): void => {
    const element = createElement(Probe, { identity, value, write: writeNow, out, enabled });
    probe.render(element);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'mudengine-autosave-'));
  });

  afterEach(() => {
    probe.unmount();
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
