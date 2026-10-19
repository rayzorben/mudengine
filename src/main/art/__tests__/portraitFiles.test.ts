import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pngOfDataUrl } from '../pngOfDataUrl';
import { handlePortraitFiles } from '../portraitFiles';
import { Invoke, type SavedFile } from '../../../shared/ipc';
import type { Picture } from '../portraitCache';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('a picture for the clipboard', () => {
  it('takes a PNG data URL and nothing else', () => {
    const url = `data:image/png;base64,${PNG.toString('base64')}`;
    expect(pngOfDataUrl(url, 100)).toEqual(new Uint8Array(PNG));
    expect(pngOfDataUrl(url, 4)).toBeNull();
    expect(pngOfDataUrl(`data:image/webp;base64,${PNG.toString('base64')}`, 100)).toBeNull();
    expect(
      pngOfDataUrl(`data:image/png;base64,${Buffer.from('not a png').toString('base64')}`, 100)
    ).toBeNull();
    expect(pngOfDataUrl('data:image/png;base64,***', 100)).toBeNull();
    expect(pngOfDataUrl(42, 100)).toBeNull();
  });
});

describe('saving the portrait', () => {
  let dir: string;
  let picked: string | null;
  let shown: Picture | null;
  let save: (caller: unknown, session: unknown) => Promise<SavedFile>;
  const names: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-save-'));
    picked = path.join(dir, 'probe-portrait.webp');
    shown = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), type: 'image/webp' };
    handlePortraitFiles({
      host: {
        transport: {
          handle: (channel: string, handler: typeof save) => {
            if (channel === Invoke.savePortrait) save = handler;
          }
        } as never,
        chooseSaveFile: async (_caller, choice) => {
          names.push(choice.defaultName);
          return picked;
        },
        deliver: () => null
      },
      picture: () => shown,
      nameOf: () => 'Probe'
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the picture as drawn where the player picked, named after the character', async () => {
    const result = await save({ windowId: 1 }, 'probe');
    expect(result).toEqual({ kind: 'written', file: picked, download: null });
    expect(fs.readFileSync(picked!)).toEqual(Buffer.from(shown!.bytes));
    expect(names.at(-1)).toBe('probe-portrait.webp');
  });

  it('writes nothing when the player dismisses the dialog, or there is no picture', async () => {
    picked = null;
    expect(await save({ windowId: 1 }, 'probe')).toEqual({ kind: 'dismissed' });
    shown = null;
    expect((await save({ windowId: 1 }, 'probe')).kind).toBe('refused');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
