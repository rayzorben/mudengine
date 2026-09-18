/**
 * Answers the login sequence.
 *
 * Without this the client connects, shows a username prompt, and stops — which
 * is where it sat until now, because every test harness drove the login itself
 * and hid the gap.
 *
 * Every prompt arrives as a `flush`-terminated line — a prompt is a line that
 * ends because the server stopped talking — which is exactly what Phase 2's
 * idle flush exists to surface. What is answered, and with what, is the
 * configured script: a list of `{ when, send }` matched on the prompt's own
 * text. So this is a lookup from what the realm said to what the player
 * configured, not another parser.
 *
 * **The account is in that list too, as `{user}` and `{password}`.** It used to
 * be answered from the block vocabulary instead, keyed on `prompt-username` and
 * `prompt-password` — which are two of *this* realm family's sentences, so a
 * BBS that asks anything else got no answer and no way to describe the prompt.
 * See `src/shared/login.ts`; the values still live on the character's own file
 * and never in the script.
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
 *   the answer was refused; a step that carries a credential stops the sequence
 *   rather than answering twice, and a menu is simply not answered again. A row
 *   the realm's script marks `repeat` is the exception and answers every time,
 *   for a **pager** — which asks once per screenful and so comes back because
 *   the answer worked. Never for a credential: see `LoginStep.repeat`.
 * - **Nothing is sent if the answer is not configured.** A missing password
 *   leaves the prompt for the player rather than sending an empty line, and a
 *   placeholder the client cannot fill in is refused rather than typed.
 * - **The account-creation prompts are never answered.** `prompt-new-password`
 *   is *choose a password*, and answering it makes an account.
 *
 * Answers go through the arbiter at `user` priority: they are on the player's
 * behalf, and must outrank anything automated.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { commandOf } from '../../shared/commands';
import { credentialsNamed, fillLogin, type Credential } from '../../shared/login';
import { isPrompt, type Block } from '../../shared/blocks';
import type { LoginConfig, LoginStep } from '../../shared/config';

export interface LoginEvents {
  notice?(message: string): void;
}

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

/** Whether two scripts are the same rows in the same order. */
function sameScript(before: readonly LoginStep[], after: readonly LoginStep[]): boolean {
  return (
    before.length === after.length &&
    before.every(
      (step, index) =>
        step.when === after[index]?.when &&
        step.send === after[index]?.send &&
        (step.repeat ?? false) === (after[index]?.repeat ?? false)
    )
  );
}

export class LoginAutomator {
  /** Menu rows already used this connection, by index. */
  private used = new Set<number>();
  /**
   * Credentials already sent this connection.
   *
   * The account's own *used once*, kept per credential rather than per row
   * because a row is not the unit: two rows may answer one prompt in two
   * spellings, and a realm may re-ask in wording neither of them matched the
   * first time. Which credential is about to go out is the only test that does
   * not depend on how the script happens to be written or ordered.
   */
  private sentCredentials = new Set<Credential>();
  /** The script names no credential and the account is set: said once. */
  private saidAccountUnsent = false;
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
    /*
     * A changed script invalidates what has been used, because `used` is keyed
     * by *index*.
     *
     * The file is hot-reloaded, and `noAccountRow` sends the player to edit it
     * — while sitting at the prompt it names. Reindexed underneath, an
     * untouched row reads as used (the sequence stalls silently) or a menu
     * reprint reads as the account coming back (the sequence stops). Keyed by
     * index rather than by wording because two rows may legitimately share a
     * `when`; clearing is the cheaper half of that trade, and the cost of it is
     * one prompt answered twice across an edit the player just made.
     */
    if (!sameScript(this.config.steps, config.steps)) this.used.clear();
    this.config = config;
  }

  reset(): void {
    this.used.clear();
    this.sentCredentials.clear();
    this.saidAccountUnsent = false;
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
   * Only a **completed** exit counts: MajorMUD's `Your character has been
   * saved.`, or the menu arriving after the request. The request is not
   * leaving — the realm refuses one and interrupts another — and read early
   * it stood down a link lost three hours after an exit a kobold had broken
   * (2026-09-18). It lasts while the character is out of the realm.
   */
  get standDown(): StandDown | null {
    return this.why;
  }

  /** What the player typed. `break` cancels a pending exit. */
  observeCommand(command: string): void {
    if (commandOf(command.trim().split(/\s+/)[0] ?? '') === 'Break') this.leaving = false;
  }

  onBlock(block: Block): void {
    /*
     * The player asked to leave. A request, not the leaving: what it arms is
     * the reading of the menu that follows, which is the same menu the script
     * answers on the way in — and answering it would put them straight back
     * in a realm they just left.
     */
    if (block.type === 'user-exits-realm') {
      this.leaving = true;
      return;
    }
    // And the realm called it off: a blow, a spell, a player's attack.
    if (block.type === 'user-exit-interrupted') {
      this.leaving = false;
      return;
    }
    // MajorMUD says the exit completed (bearfather's wire, 2026-09-17); the
    // GreaterMUD family says nothing and draws the menu.
    if (block.type === 'user-left-realm') {
      this.leftTheRealm();
      return;
    }
    if (this.leaving && (block.type === 'prompt-menu' || block.type === 'prompt-selection')) {
      this.leftTheRealm();
      return;
    }
    /*
     * Back in the realm on the same connection — `E` at the menu — so nothing
     * has been left. Kept, the stand-down outlived its truth as `leaving` did,
     * and a link lost hours later was not dialled back. A refused login stays:
     * a player who typed their way in has not fixed the script's password.
     */
    if (block.type === 'status-line' && this.why === 'left-realm') this.why = null;
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

    /*
     * *Choose a password*, which is the account-creation path.
     *
     * Refused ahead of the script rather than left to it: the prompt says
     * `password`, so a perfectly reasonable row (`when: password`) matches it,
     * and answering would create an account with the player's credentials on a
     * realm they have one on already. The classifier types it separately for
     * exactly this reason (`patterns.ts`), and this is now the only thing that
     * reads that type.
     */
    if (block.type === 'prompt-new-password') return;

    /*
     * Every prompt, matched on its own text — the account's two included.
     *
     * Matched rather than *sequenced*, and each step used once. A BBS does not
     * always ask everything — a realm with one character skips the character
     * menu — so a script that insisted on its own order would stall on the
     * first prompt that did not arrive. First unused match wins, which handles
     * a skipped menu for free and still cannot answer the same menu twice.
     */
    const text = block.text.toLowerCase();
    /** A credential row matched but its credential has already gone out. */
    let repeated = false;
    /*
     * Whether this line is a *prompt*, which is what a credential may answer.
     *
     * A menu answer is `P` or `1` and costs nothing if a stray line matches it.
     * The account is different: matched on text alone it would go out at any
     * line containing the row's wording, and a BBS prints plenty pre-login —
     * `(C)hange Password`, `Forgot your password? mail sysop`. That is the
     * password in the clear at a live service, one line before the prompt that
     * asks for it, and it is a hazard this module did not have while the
     * credentials were keyed on a block type.
     *
     * Two ways to be one, because two things can know. A typed prompt is the
     * strong one, for a realm whose prompts are in `patterns.ts`; it holds
     * whatever the framing did, which is why nothing that works today changed.
     * `flush` is the other, and it is the only fact available on a BBS the
     * classifier has never met.
     *
     * **`flush` is evidence, not proof**, and `SessionManager`'s own framing
     * note says so in terms: it means the tokenizer found no terminator before
     * the idle window, which is *usually* the server waiting and occasionally a
     * line genuinely split across a pause — measured on bearfather at 88ms
     * minimum and 686ms maximum for one logical line in two socket writes. So
     * this narrows the hazard rather than closing it: a banner fragment ending
     * mid-pause can still be flushed. What closes the rest is the row's own
     * wording, which is why the shipped rows say `Please enter your password`
     * and not `Password` — a `when` short enough to appear inside a menu line
     * is a `when` that can answer one.
     */
    const isPromptLine = block.terminator === 'flush' || isPrompt(block.type);

    /*
     * An account configured that the script has no row to send.
     *
     * `enabled` is only true with both credentials, so this is a player who
     * filled the account in and will watch the client sit at the username
     * prompt doing nothing — and every other refusal here is silent by design,
     * so nothing else would say why. The way in is a character that states its
     * own `login.steps` to change one row: that **replaces** the realm's list,
     * taking the account's two rows with it.
     *
     * Reported, not stopped: the menus below may still be worth answering, and
     * the player may be logging in by hand on purpose.
     */
    if (
      !this.saidAccountUnsent &&
      !this.config.steps.some((step) => credentialsNamed(step.send).length > 0)
    ) {
      this.saidAccountUnsent = true;
      this.events.notice?.(t('automation.login.noAccountRow'));
    }

    for (const [index, step] of this.config.steps.entries()) {
      // Case-insensitively: a menu is a sentence somebody typed into a BBS
      // config, and `Please Select A Realm` is the same prompt as
      // `Please select a realm`. Being strict here would fail silently.
      if (step.when.length === 0 || !text.includes(step.when.toLowerCase())) continue;
      const names = credentialsNamed(step.send);
      if (names.length > 0) {
        // A credential answers a *prompt* and nothing else. See `isPromptLine`.
        if (!isPromptLine) continue;
        /*
         * And it goes out once per connection.
         *
         * The account coming back means the realm refused it, and answering
         * again loops towards a lockout. Asked **before** the used-row check
         * and keyed on the credential rather than the row, because the row is
         * not the unit: a script may hold two rows that both send
         * `{password}` in different wordings, and the realm may re-ask in the
         * one that did not match the first time — so *this row has been used*
         * answers no while the password has plainly gone out. Recorded and
         * skipped rather than stopped here, because a later row may still be a
         * menu worth answering on this same line.
         */
        if (names.some((name) => this.sentCredentials.has(name))) {
          repeated = true;
          continue;
        }
      } else if (this.used.has(index) && !step.repeat) {
        /*
         * A menu that came back. Ordinary — a BBS reprints one after an
         * unrelated line — and skipping to the next unused row handles it.
         *
         * Unless the row says it is a **pager**, which is asked once per
         * screenful rather than once per way in: see `LoginStep.repeat`. Such
         * a row is answered every time, and never reports the prompt as having
         * come back — coming back is what it is for.
         */
        continue;
      }

      const filled = fillLogin(step.send, this.config);
      if (filled.kind === 'unknown') {
        this.stopped = true;
        this.events.notice?.(
          t('automation.login.unknownPlaceholder', {
            placeholder: filled.placeholder,
            promptText: step.when
          })
        );
        return;
      }
      if (filled.kind === 'missing') {
        this.stopped = true;
        this.events.notice?.(
          t('automation.login.credentialMissing', { credentialType: filled.credential })
        );
        return;
      }

      this.used.add(index);
      for (const name of filled.credentials) this.sentCredentials.add(name);
      this.send(
        filled.command,
        // The reason is written down; a step carrying a credential is named by
        // what it asked for rather than by the answer it produced.
        filled.credentials.length > 0
          ? t('automation.login.reasonCredential', {
              credentialType: filled.credentials.join(', ')
            })
          : t('automation.login.reasonMenu', { promptText: step.when }),
        /*
         * The record, not the wire. `reportable` arms on a password prompt the
         * classifier typed and falls back to an exact match against the
         * configured password; neither survives a realm this client cannot
         * type, answered with `login {user} {password}`. The module doing the
         * filling in is the one place that knows for certain.
         */
        filled.credentials.includes('password')
      );
      return;
    }

    if (repeated) {
      this.stopped = true;
      this.events.notice?.(t('automation.login.promptRepeated', { promptText: block.text.trim() }));
    }
  }

  private send(command: string, reason: string, secret = false): void {
    this.queue.enqueue({
      command,
      priority: 'user',
      reason,
      ...(secret ? { secret: true } : {}),
      /*
       * An answer means what it means only at the screen it answers. The
       * queue can hold one — behind the player's half-typed line, then behind
       * the combat band that outranks `user` — and past the status line it is
       * a game command: bearfather's pager answer `Q` reached the realm twice
       * on 2026-09-17, and MajorMUD v1.11p read it as the exit both times
       * (the GreaterMUD family's table has no `q`). A stopped or switched-off
       * sequence sends nothing either.
       */
      stillWanted: () => this.config.enabled && !this.done && !this.stopped
    });
  }

  /** An exit completed: stand down, and say so once per exit. */
  private leftTheRealm(): void {
    this.leaving = false;
    if (this.why === 'left-realm') return;
    this.stopped = true;
    this.why = 'left-realm';
    this.events.notice?.(t('automation.login.leftOnPurpose'));
  }
}
