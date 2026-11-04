/**
 * Learns the login from what the player types between the socket opening and
 * the realm's menu, and hands it to `LoginAutomator` to answer from the next
 * connection. What is never kept, when a row is forgotten and when a script
 * row stops being used are in `shared/loginLearning.ts` and
 * `mudengine-automation` › `parts/login.md` › *The login is learned*.
 *
 * It sends nothing. Rows learned on a connection are used from the next one,
 * so a prompt the player just answered is not answered again behind them.
 */
import { tuning } from '../app/tuning';
import { t } from '../app/i18n';
import { isPrompt, type Block } from '../../shared/blocks';
import type { LoginConfig, LoginStep } from '../../shared/config';
import type { NoticeSink } from '../../shared/decisionSettings';
import { credentialsNamed, stepMatches } from '../../shared/login';
import { dayOf } from '../../shared/values';
import {
  asksForPassword,
  learn,
  lessonOf,
  NOTHING_LEARNED,
  promptWhen,
  retire,
  wayInCompleted,
  type LearnedLogin,
  type LearnedLoginRecord,
  type LearnedWayIn
} from '../../shared/loginLearning';
import type { SessionModule } from './Module';

/** The lines since the prompt before, and whether the automator's answer to one of them went out. */
interface Lines {
  lines: Block[];
  spent: boolean;
}

/** The last prompt, with the lines of its screen. Spent, a typed line answers the next screen. */
interface Screen extends Lines {
  text: string;
  password: boolean;
}

/** The most lines a screen keeps for matching: a banner is long and the menu row is near its prompt. */
const SCREEN_LINES = 200;

const fresh = (): Lines => ({ lines: [], spent: false });

const NO_RECORD: LearnedLoginRecord = { read: () => NOTHING_LEARNED, write: () => undefined };

/** A login row's answer as a sentence shows it: quoted, or Enter for a bare one. */
function shown(send: string): string {
  return send.length === 0 ? t('automation.login.learn.enter') : `"${send}"`;
}

export class LoginLearner implements SessionModule, LearnedWayIn {
  /** The record as this connection began, which is what the automator answers from. */
  private using: LearnedLogin = NOTHING_LEARNED;
  /** The record as saved. */
  private record: LearnedLogin = NOTHING_LEARNED;
  /**
   * What this connection taught, kept only once it reaches the realm's menu:
   * a line typed on a login that never got in (`X` at the BBS's menu, a door
   * game, a lost link) is not the way to the realm.
   */
  private taught: LearnedLogin = NOTHING_LEARNED;
  private screen: Screen | null = null;
  /** The screen being drawn, up to its prompt. */
  private building: Lines = fresh();
  /** Every line read this connection, to tell the one being read from an older one. */
  private read = new WeakSet<Block>();
  /** `new` was typed: an account is being made on this connection. */
  private creating = false;
  /** The `when` of every learned row whose prompt came up on this login. */
  private seen = new Set<string>();
  /** How many times the player answered each prompt alike on this login. */
  private answeredAlike = new Map<string, { send: string; times: number }>();
  /** The realm's menu or the game was reached: nothing more is the login. */
  private done = false;

  constructor(
    private config: LoginConfig,
    private readonly store: LearnedLoginRecord = NO_RECORD,
    private readonly notice: NoticeSink = () => undefined
  ) {}

  configure(config: LoginConfig): void {
    this.config = config;
  }

  /** A connection is being made: what it answers from is the record as it stands. */
  reset(): void {
    if (this.taught !== NOTHING_LEARNED && !this.done) {
      this.notice(t('automation.login.learn.dropped'), 'login-learn');
    }
    this.taught = NOTHING_LEARNED;
    this.record = this.store.read();
    this.using = this.config.learn ? this.record : NOTHING_LEARNED;
    this.screen = null;
    this.building = fresh();
    this.read = new WeakSet();
    this.creating = false;
    this.seen = new Set();
    this.answeredAlike = new Map();
    this.done = false;
  }

  rows(): readonly LoginStep[] {
    return this.using.rows;
  }

  retires(step: LoginStep): boolean {
    return this.using.retired.includes(step.when);
  }

  answered(line: Block): void {
    if (this.screen?.lines.includes(line) === true) this.screen.spent = true;
    // The line being read now (answered before this learner reads it) or one of its screen's.
    else if (!this.read.has(line) || this.building.lines.includes(line)) this.building.spent = true;
  }

  /** After `LoginAutomator.onBlock`, so an answer it sent to this line is on its screen. */
  onBlock(block: Block): void {
    if (!this.config.learn || this.done) return;
    // `[MAJORMUD]:` or `[PARADIGM]:`, or the game itself on a realm whose menu is not typed.
    if (block.type === 'prompt-menu' || block.type === 'status-line') {
      this.completed();
      return;
    }
    for (const row of this.record.rows) if (stepMatches(row, block.text)) this.seen.add(row.when);
    this.read.add(block);
    this.building.lines = [...this.building.lines, block].slice(-SCREEN_LINES);
    if (block.terminator !== 'flush' && !isPrompt(block.type)) return;
    this.screen = {
      ...this.building,
      text: block.text,
      password:
        block.type === 'prompt-password' ||
        block.type === 'prompt-new-password' ||
        asksForPassword(block.text)
    };
    this.building = fresh();
  }

  /** A line the player typed, a bare Enter included. Never written down unless it is learned. */
  noteTyped(typed: string): void {
    if (!this.config.learn || this.done) return;
    const screen = this.screen;
    // One answer per prompt: a second line before the next prompt answers nothing.
    this.screen = null;
    // Whatever screen it lands on, or none: what follows `new` is making an account.
    if (/^new$/i.test(typed)) {
      if (!this.creating) this.notice(t('automation.login.learn.newAccount'), 'login-learn');
      this.creating = true;
      return;
    }
    if (screen === null) return;
    /*
     * The automator's answer to this screen went out first, so this line
     * reaches whatever the realm draws next: which prompt it answers is not
     * known, and it is said rather than guessed.
     */
    if (screen.spent) {
      this.notice(
        t('automation.login.learn.answeredFirst', { promptText: promptWhen(screen.text) }),
        'login-learn'
      );
      return;
    }
    const lesson = lessonOf({
      prompt: screen.text,
      typed,
      password: screen.password,
      creating: this.creating,
      account: this.config,
      script: this.config.steps.filter((step) => !this.retires(step))
    });
    const promptText = promptWhen(screen.text);
    switch (lesson.kind) {
      case 'new-account':
        // Taken above, whatever the screen.
        return;
      case 'too-short':
        this.notice(t('automation.login.learn.tooShort', { promptText }), 'login-learn');
        return;
      case 'one-time':
        this.notice(t('automation.login.learn.oneTime', { promptText }), 'login-learn');
        return;
      case 'secret':
        this.notice(t('automation.login.learn.secret', { promptText }), 'login-learn');
        return;
      case 'unsendable':
        this.notice(t('automation.login.learn.unsendable', { promptText }), 'login-learn');
        return;
      case 'account':
      case 'known':
        return;
      case 'learned':
        this.learned(lesson.row, screen);
        return;
      default: {
        const never: never = lesson;
        throw new Error(`unhandled lesson ${String(never)}`);
      }
    }
  }

  private learned(row: LoginStep, screen: Screen): void {
    /*
     * A script row matching this screen that the player answered otherwise:
     * spent earlier on this connection (the menu came back after it was
     * wrong), or still queued behind the player's own line.
     */
    for (const step of this.config.steps) {
      if (credentialsNamed(step.send).length > 0 || step.send === row.send) continue;
      if ([...this.record.retired, ...this.taught.retired].includes(step.when)) continue;
      if (!screen.lines.some((line) => stepMatches(step, line.text))) continue;
      this.taught = retire(this.taught, step.when);
    }
    // The same answer at the same prompt twice on one login is a pager, asked once per screenful.
    const before = this.answeredAlike.get(row.when);
    const times = before?.send === row.send ? before.times + 1 : 1;
    this.answeredAlike.set(row.when, { send: row.send, times });
    const repeat = times > 1;
    const held = [...this.taught.rows, ...this.record.rows].find((kept) => kept.when === row.when);
    if (held?.send === row.send && (held.repeat === true) === repeat) return;
    this.taught = learn(this.taught, { ...row, ...(repeat ? { repeat: true } : {}) }, '');
    this.seen.add(row.when);
  }

  /** The login reached the realm: keep what it taught, count what was seen, forget what has gone. */
  private completed(): void {
    this.done = true;
    let kept = this.record;
    for (const when of this.taught.retired) {
      kept = retire(kept, when);
      const step = this.config.steps.find((script) => script.when === when);
      this.notice(
        t('automation.login.learn.retired', { when, answer: shown(step?.send ?? '') }),
        'login-learn'
      );
    }
    for (const row of this.taught.rows) {
      kept = learn(kept, row, dayOf(Date.now()));
      const told = { promptText: row.when, answer: shown(row.send) };
      this.notice(
        row.repeat === true
          ? t('automation.login.learn.pager', told)
          : t('automation.login.learn.learned', told),
        'login-learn'
      );
    }
    const forgetAfter = Math.max(1, tuning().login.forgetAfterMisses);
    const { record, forgotten } = wayInCompleted(kept, this.seen, forgetAfter);
    const changed =
      kept !== this.record ||
      forgotten.length > 0 ||
      record.rows.some((row, index) => row.missed !== kept.rows[index]?.missed);
    this.record = record;
    this.taught = NOTHING_LEARNED;
    if (changed) this.store.write(record);
    for (const row of forgotten) {
      this.notice(
        t('automation.login.learn.forgot', {
          promptText: row.when,
          answer: shown(row.send),
          count: forgetAfter
        }),
        'login-learn'
      );
    }
  }
}
