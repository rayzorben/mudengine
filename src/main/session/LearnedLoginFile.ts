import {
  asLearnedLogin,
  NOTHING_LEARNED,
  type LearnedLogin,
  type LearnedLoginRecord
} from '../../shared/loginLearning';
import { errorMessage } from '../../shared/values';
import { t } from '../app/i18n';
import { DeferredFile } from '../world/DeferredFile';
import { readJsonRecord } from '../world/readJsonRecord';

/**
 * One character's learned login, `logins/<id>.json` (`CHARACTER_RECORDS`),
 * so it travels with an exported character. Read once when made; written a
 * while after a change and at once on `close`. An unreadable file is said
 * once, nothing in it is used, and it is never written over. It never holds a
 * password: the learner writes `{password}` (`shared/loginLearning.ts`).
 */
const VERSION = 1;

export class LearnedLoginFile implements LearnedLoginRecord {
  private held: LearnedLogin = NOTHING_LEARNED;
  /** True once the file was found unreadable; nothing is written over it. */
  private suspended = false;
  private readonly disk: DeferredFile;

  constructor(
    private readonly file: string,
    private readonly notify: (message: string) => void
  ) {
    this.disk = new DeferredFile(
      file,
      () => ({ v: VERSION, ...this.held }),
      (error) =>
        notify(t('notices.session.learnedLogin.writeError', { file, message: errorMessage(error) }))
    );
    this.load();
  }

  read(): LearnedLogin {
    return this.held;
  }

  write(next: LearnedLogin): void {
    this.held = next;
    if (!this.suspended) this.disk.schedule();
  }

  /** Writes anything outstanding. Called when the session goes. */
  close(): void {
    if (!this.suspended) this.disk.close();
  }

  private load(): void {
    const read = readJsonRecord(this.file);
    // No file yet is a character that has typed nothing on its login.
    if (read.kind === 'absent') return;
    const parsed = read.kind === 'read' ? asLearnedLogin(read.value) : null;
    if (parsed === null) {
      this.suspended = true;
      const message =
        read.kind === 'unreadable'
          ? errorMessage(read.error)
          : t('notices.session.learnedLogin.notARecord');
      this.notify(t('notices.session.learnedLogin.readError', { file: this.file, message }));
      return;
    }
    this.held = parsed;
  }
}
