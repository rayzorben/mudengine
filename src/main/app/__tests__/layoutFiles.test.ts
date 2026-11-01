import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LAYOUT_FILE_KIND } from '../../../shared/cardLayoutFile';
import { Invoke, type SavedFile, type TextFileRead } from '../../../shared/ipc';
import { handleLayoutFiles } from '../layoutFiles';

type Handler = (caller: unknown, ...args: unknown[]) => Promise<unknown>;

const LAYOUT = `${JSON.stringify({ kind: LAYOUT_FILE_KIND, name: 'Hunting', layout: { rail: [] } })}\n`;

describe('card layout files', () => {
  let dir: string;
  let picked: string | null;
  const handlers = new Map<string, Handler>();
  const read = (file: unknown) =>
    handlers.get(Invoke.readCardLayout)!({ windowId: 1 }, file) as Promise<TextFileRead>;
  const save = (name: unknown, text: unknown) =>
    handlers.get(Invoke.saveCardLayout)!({ windowId: 1 }, name, text) as Promise<SavedFile>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-files-'));
    picked = path.join(dir, 'hunting-layout.json');
    handleLayoutFiles({
      host: {
        transport: {
          handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
        } as never,
        chooseFile: async () => picked,
        chooseSaveFile: async () => picked,
        deliver: () => null
      }
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes a layout where the player picked, and reads it back', async () => {
    expect(await save('Hunting', LAYOUT)).toEqual({
      kind: 'written',
      file: picked,
      download: null
    });
    expect(await read(picked)).toEqual({ kind: 'read', text: LAYOUT });
  });

  it('never hands back the text of a file that is not a card layout', async () => {
    const profile = path.join(dir, 'hero.yaml');
    fs.writeFileSync(profile, 'login:\n  password: hunter2\n');
    const answer = await read(profile);
    expect(answer.kind).toBe('refused');
    expect(JSON.stringify(answer)).not.toContain('hunter2');
    const other = path.join(dir, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ password: 'hunter2' }));
    expect((await read(other)).kind).toBe('refused');
  });

  it('refuses to write text that is not a card layout', async () => {
    expect((await save('Hunting', 'password: hunter2')).kind).toBe('refused');
    expect(fs.existsSync(picked!)).toBe(false);
  });

  it('says where and why for a file that cannot be read', async () => {
    const answer = await read(path.join(dir, 'gone.json'));
    expect(answer.kind).toBe('refused');
    expect(answer.kind === 'refused' && answer.error).toContain('gone.json');
  });

  it('throws for a request no bridge makes', async () => {
    await expect(save(1, LAYOUT)).rejects.toThrow(TypeError);
  });
});
