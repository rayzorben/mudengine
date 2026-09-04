/**
 * Answers the login sequence.
 *
 * Without this the client connects, shows a username prompt, and stops — which
 * is where it sat until now, because every test harness drove the login itself
 * and hid the gap.
 *
 * The prompts are already classified: `prompt-username`, `prompt-password`,
 * `prompt-selection`, `prompt-realm`, `prompt-character`, `prompt-menu`. Each
 * one arrives as a `flush`-terminated line — a prompt is a line that ends
 * because the server stopped talking — which is exactly what Phase 2's idle
 * flush exists to surface. So this is a lookup from block type to configured
 * answer, not another parser.
 *
 * ## Safety
 *
 * Automated credentials against a live service need care, so:
 *
 * - **A rejected password is never retried.** `Invalid username/password!` stops
 *   the whole sequence and says so. Retrying is how an automated client walks
 *   into a lockout, and a wrong password will not become right on the second
 *   attempt.
 * - **Each prompt is answered once per connection.** A prompt that repeats means
 *   the answer was refused; answering again would loop.
 * - **Nothing is sent if the answer is not configured.** A missing password
 *   leaves the prompt for the player rather than sending an empty line.
 *
 * Answers go through the arbiter at `user` priority: they are on the player's
 * behalf, and must outrank anything automated.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { commandOf } from '../../shared/commands';
import type { Block, BlockType } from '../../shared/blocks';
import type { LoginConfig } from '../../shared/config';

export interface LoginEvents {
  notice?(message: string): void;
}

/**
 * The two prompts answered from the schema rather than from the script.
 *
 * Everything else a BBS asks is a *menu*, and menus differ per BBS — so they
 * come from `login.steps`, matched on the prompt's own text. These two do not:
 * they are the account, they are the same question on every system that has
 * ever run this game, and the password in particular must stay in one field
 * rather than in a list that is shared between characters and shown in a form.
 */
/**
 * Why a *lost* socket must not be dialled again.
 *
 * The login sequence already stands itself down for both of these, and both
 * are facts only this side of the client knows: the socket closing looks
 * identical either way. Auto-reconnect reads the same latch rather than
 * keeping a second copy of it — a second copy is how the two answers drift,
 * and the one that would drift here dials somebody back into a realm they
 * walked out of, with their password.
 *
 * - `left-realm` — the player typed their way out and the BBS then hung up.
 * - `login-refused` — the realm rejected the credentials. Redialling is how an
 *   automated client walks into a lockout, which is the reason the sequence
 *   stops rather than retries in the first place.
 */
export type StandDown = 'left-realm' | 'login-refused';

const CREDENTIALS: Array<{ type: BlockType; field: 'username' | 'password'; describe: string }> = [
  { type: 'prompt-username', field: 'username', describe: 'username' },
  { type: 'prompt-password', field: 'password', describe: 'password' }
];

export class LoginAutomator {
  /** Prompt types already answered this connection. */
  private answered = new Set<BlockType>();
  /** Extra steps already used, by index. */
  private usedExtra = new Set<number>();
  private stopped = false;
  /**
   * Why the sequence stopped, when the reason outlives this connection.
   *
   * `stopped` alone cannot say: it is set both by the player walking out and by
   * the realm refusing the password, and the two are different answers to
   * *should this connection be dialled again*. See `standDown`.
   */
  private why: StandDown | null = null;
  /** The player asked to leave; the next menu is them arriving there, not a way in. */
  private leaving = false;
  private done = false;

  constructor(
    private config: LoginConfig,
    private readonly queue: CommandQueue,
    private readonly events: LoginEvents = {}
  ) {}

  configure(config: LoginConfig): void {
    this.config = config;
  }

  reset(): void {
    this.answered.clear();
    this.usedExtra.clear();
    this.stopped = false;
    this.why = null;
    this.leaving = false;
    this.done = false;
  }

  /** True once a status line has been seen: the sequence is over. */
  get complete(): boolean {
    return this.done;
  }

  /**
   * Why a socket that has just been lost must not be dialled again, or null.
   *
   * `leaving` counts as well as the latched reason: the exit takes a few
   * seconds and the BBS may hang up before any menu prompt is classified, so
   * waiting for `why` alone would miss the ordinary way somebody leaves. The
   * cost of reading it early is a character that typed `x`, was interrupted,
   * and then lost its link — which is not dialled back and is told so.
   */
  get standDown(): StandDown | null {
    return this.why ?? (this.leaving ? 'left-realm' : null);
  }

  /** What the player typed. `break` cancels a pending exit. */
  observeCommand(command: string): void {
    if (commandOf(command.trim().split(/\s+/)[0] ?? '') === 'Break') this.leaving = false;
  }

  onBlock(block: Block): void {
    /*
     * The player typed `x`. The menu that follows is the same menu the script
     * answers on the way in, and answering it would put them straight back in
     * a realm they just left — for a reason this client cannot know. Stands
     * down until the next connection, and says so once.
     */
    if (block.type === 'user-exits-realm') {
      this.leaving = true;
      return;
    }
    if (
      this.leaving &&
      !this.stopped &&
      (block.type === 'prompt-menu' || block.type === 'prompt-selection')
    ) {
      this.stopped = true;
      this.why = 'left-realm';
      this.leaving = false;
      this.events.notice?.(t('automation.login.leftOnPurpose'));
      return;
    }
    if (!this.config.enabled || this.stopped) return;

    // The status line means we are in the realm. Nothing further to answer, and
    // continuing to match prompts in game would be a way to send `P` at a
    // conversation that happens to look like a menu.
    if (block.type === 'status-line') {
      this.done = true;
      return;
    }
    if (this.done) return;

    if (block.type === 'login-failed') {
      this.stopped = true;
      this.why = 'login-refused';
      this.events.notice?.(t('automation.login.rejected'));
      return;
    }

    const credential = CREDENTIALS.find((candidate) => candidate.type === block.type);
    if (credential) {
      this.respond(block.type, String(this.config[credential.field] ?? ''), credential.describe);
      return;
    }

    /*
     * Every menu, matched on the prompt's own text.
     *
     * Matched rather than *sequenced*, and each step used once. A BBS does not
     * always ask everything — a realm with one character skips the character
     * menu — so a script that insisted on its own order would stall on the
     * first prompt that did not arrive. First unused match wins, which handles
     * a skipped menu for free and still cannot answer the same menu twice.
     */
    const text = block.text.toLowerCase();
    for (const [index, step] of this.config.steps.entries()) {
      if (this.usedExtra.has(index)) continue;
      // Case-insensitively: a menu is a sentence somebody typed into a BBS
      // config, and `Please Select A Realm` is the same prompt as
      // `Please select a realm`. Being strict here would fail silently.
      if (step.when.length === 0 || !text.includes(step.when.toLowerCase())) continue;
      this.usedExtra.add(index);
      this.send(step.send, t('automation.login.reasonMenu', { promptText: step.when }));
      return;
    }
  }

  private respond(type: BlockType, value: string, describe: string): void {
    // A repeated prompt means the previous answer was refused; answering again
    // would loop against a live service.
    if (this.answered.has(type)) {
      this.stopped = true;
      this.events.notice?.(t('automation.login.promptRepeated', { credentialType: describe }));
      return;
    }

    if (value.length === 0) {
      this.stopped = true;
      this.events.notice?.(t('automation.login.credentialMissing', { credentialType: describe }));
      return;
    }

    this.answered.add(type);
    this.send(value, t('automation.login.reasonCredential', { credentialType: describe }));
  }

  private send(command: string, reason: string): void {
    this.queue.enqueue({ command, priority: 'user', reason });
  }
}
