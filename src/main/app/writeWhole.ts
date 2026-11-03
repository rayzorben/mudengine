/**
 * A file written whole through a temporary beside it, so a reader never sees
 * half of it. The temporary is a dotfile, which the character export and a
 * hidden-name filter pass over, and each write has its own, so two writes of
 * one file at once never rename each other's.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface WholeOptions {
  /** The file's permissions, for a file holding a secret. */
  readonly mode?: number;
  /**
   * Asked once the temporary is written: false leaves the file as it stands,
   * for a write a newer one has overtaken meanwhile.
   */
  readonly stillWanted?: () => boolean;
}

let writes = 0;

export async function writeWhole(
  file: string,
  data: string | Uint8Array,
  options: WholeOptions = {}
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = temporaryFor(file);
  try {
    await fs.promises.writeFile(
      temporary,
      data,
      options.mode === undefined ? {} : { mode: options.mode }
    );
    if (options.stillWanted?.() === false) return;
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

/** The same, written synchronously, for startup and for a quit. */
export function writeWholeSync(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = temporaryFor(file);
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The name of the file a temporary in a listing was being written over, or null for any other name. */
export function writtenOver(entry: string): string | null {
  return /^\.(.+)\.\d+-\d+\.tmp$/.exec(entry)?.[1] ?? null;
}

function temporaryFor(file: string): string {
  writes += 1;
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${writes}.tmp`);
}
