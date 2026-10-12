/**
 * `web.log` in the log directory: what happened to each browser tab's link
 * (connected, dropped and why, came back, let go) and each tab's own report
 * of how it fared (`RpcReport`). The container's console dies with it; this
 * file is on the volume. Appended without holding the thread, one write at a
 * time, and started afresh as `web.log.1` past `tuning.web.logBytes`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { errorMessage } from '../../../shared/values';
import { tuning } from '../../app/tuning';

export class WebLog {
  private writing: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly directory: () => string) {}

  write(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    this.writing = this.writing.then(() => this.append(stamped));
  }

  private async append(text: string): Promise<void> {
    const file = path.join(this.directory(), 'web.log');
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const size = await fs.promises.stat(file).then(
        (info) => info.size,
        () => 0
      );
      if (size > tuning().web.logBytes) await fs.promises.rename(file, `${file}.1`);
      await fs.promises.appendFile(file, text, 'utf8');
      this.failed = false;
    } catch (error) {
      // Said once per run of failures: the log is for diagnosis, and a full
      // disk must not fill the console with the same sentence.
      if (!this.failed) console.error(`web: could not write ${file}: ${errorMessage(error)}`);
      this.failed = true;
    }
  }
}
