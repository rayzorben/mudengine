/**
 * What one character has learned of its realm's login: the answers the
 * player typed between the socket opening and the realm's menu, kept as login
 * rows and used ahead of the realm's script from the next connection.
 *
 * Pure: the learner in `automation/LoginLearner.ts` feeds it the prompt and
 * what was typed, the file lives in `logins/<id>.json`. The rules (what is
 * never kept, when a row is forgotten, when a script row stops being used) are
 * in `mudengine-automation` › `parts/login.md` › *The login is learned*.
 */
import type { Block } from './blocks';
import type { LoginStep } from './config';
import { credentialsNamed, stepMatches, type LoginAccount } from './login';

/** A row the player taught, and how many complete logins in a row it was not seen on. */
export interface LearnedRow extends LoginStep {
  missed: number;
  /** The day it was learned or last changed, `YYYY-MM-DD`. */
  learned: string;
}

export interface LearnedLogin {
  rows: readonly LearnedRow[];
  /**
   * The `when` of each realm script row the player answered differently on
   * the same screen. Not used again for this character: the player's own
   * answer is the right one there.
   */
  retired: readonly string[];
}

export const NOTHING_LEARNED: LearnedLogin = { rows: [], retired: [] };

/** Where a learner keeps one character's record. Read once per connection. */
export interface LearnedLoginRecord {
  read(): LearnedLogin;
  write(next: LearnedLogin): void;
}

/** What the automator reads of the learned login, and tells it back. */
export interface LearnedWayIn {
  /** The learned rows, answered ahead of the script. */
  rows(): readonly LoginStep[];
  /** Whether a script row was answered differently by the player and is no longer used. */
  retires(step: LoginStep): boolean;
  /** The automator's answer to this line went out. */
  answered(line: Block): void;
}

export const NO_LEARNED_WAY: LearnedWayIn = {
  rows: () => [],
  retires: () => false,
  answered: () => undefined
};

/** The longest `when` kept: a prompt is one line, and a screenful is not a prompt. */
const WHEN_CAP = 160;
/** The shortest: a bare `:` or `>` is in nearly every prompt, so it would answer them all. */
const WHEN_FLOOR = 4;

/** A prompt line as a row's `when`: trimmed, its runs of spaces made one. */
export function promptWhen(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, WHEN_CAP);
}

/** A prompt asking for a password, by its wording, for a realm whose prompts the classifier does not type. */
export function asksForPassword(text: string): boolean {
  return /pass\s?word|passwd/i.test(text);
}

/**
 * The questions of making an account (Worldgroup's and MajorMUD's): who you
 * are, where you live, your terminal. Asked once, so an answer to one on the
 * connection the account was made on is never kept.
 */
const ONE_TIME =
  /\b(pass\s?word|passwd|birth|born|name|address|city|state|zip|postal|phone|e-?mail|gender|sex|age|user-?id|handle|alias|company|country|computer|terminal|ansi|columns|lines|correct|race|class)\b/i;

/** What one typed answer taught, or why it taught nothing. */
export type Lesson =
  | { kind: 'learned'; row: LoginStep }
  /** The script already sends this here. */
  | { kind: 'known' }
  /** The script's account rows answer this prompt; the account is theirs. */
  | { kind: 'account' }
  /** A password that is not the character's own: never written down. */
  | { kind: 'secret' }
  /** `new`: an account is being made on this connection. */
  | { kind: 'new-account' }
  /** A question of making the account, asked once. */
  | { kind: 'one-time' }
  /** Braces, which a login row reads as a placeholder. */
  | { kind: 'unsendable' }
  /** A prompt too short to tell from another. */
  | { kind: 'too-short' };

export interface TypedAnswer {
  /** The prompt line the player answered. */
  prompt: string;
  /** What the player typed, trimmed. */
  typed: string;
  /** The prompt asks for a password: typed so by the classifier, or by its wording. */
  password: boolean;
  /** An account is being made on this connection. */
  creating: boolean;
  account: LoginAccount;
  /** The realm's script as this character uses it, retired rows left out. */
  script: readonly LoginStep[];
}

/** What a typed answer at a prompt on the login teaches. */
export function lessonOf(answer: TypedAnswer): Lesson {
  const { typed, prompt, account } = answer;
  if (/^new$/i.test(typed)) return { kind: 'new-account' };
  const covering = answer.script.filter((step) => stepMatches(step, prompt));
  if (covering.some((step) => credentialsNamed(step.send).length > 0)) return { kind: 'account' };
  // Every answer to a new account's questions, the password chosen included.
  if (answer.creating && (answer.password || typed.length > 2 || ONE_TIME.test(prompt))) {
    return { kind: 'one-time' };
  }
  const isPassword = account.password.length > 0 && typed === account.password;
  if (answer.password && !isPassword) return { kind: 'secret' };
  const send = isPassword
    ? '{password}'
    : account.username.length > 0 && typed.toLowerCase() === account.username.toLowerCase()
      ? '{user}'
      : typed;
  if (send === typed && /[{}]/.test(typed)) return { kind: 'unsendable' };
  if (promptWhen(prompt).length < WHEN_FLOOR) return { kind: 'too-short' };
  if (covering.some((step) => step.send === send)) return { kind: 'known' };
  // A learned row with this answer is the learner's to count: twice alike is a pager.
  return { kind: 'learned', row: { when: promptWhen(prompt), send } };
}

/** The record with this row learned, replacing a learned row for the same prompt. */
export function learn(record: LearnedLogin, row: LoginStep, today: string): LearnedLogin {
  const kept: LearnedRow = {
    when: row.when,
    send: row.send,
    ...(row.repeat === true ? { repeat: true } : {}),
    missed: 0,
    learned: today
  };
  return { ...record, rows: [...record.rows.filter((held) => held.when !== row.when), kept] };
}

/** The record with a script row's `when` retired; unchanged when it already is. */
export function retire(record: LearnedLogin, when: string): LearnedLogin {
  return record.retired.includes(when) ? record : { ...record, retired: [...record.retired, when] };
}

/**
 * A login reached the realm's menu: a row seen on it is counted afresh, one
 * not seen has missed once more, and one that has missed `forgetAfter` in a
 * row is forgotten.
 */
export function wayInCompleted(
  record: LearnedLogin,
  seen: ReadonlySet<string>,
  forgetAfter: number
): { record: LearnedLogin; forgotten: LearnedRow[] } {
  const counted = record.rows.map((row) => ({
    ...row,
    missed: seen.has(row.when) ? 0 : row.missed + 1
  }));
  return {
    record: { ...record, rows: counted.filter((row) => row.missed < forgetAfter) },
    forgotten: counted.filter((row) => row.missed >= forgetAfter)
  };
}

/** A record read from disk, or null when it is not one. A row this build cannot read is skipped. */
export function asLearnedLogin(value: unknown): LearnedLogin | null {
  if (typeof value !== 'object' || value === null) return null;
  const { rows, retired } = value as Record<string, unknown>;
  if (!Array.isArray(rows) || !Array.isArray(retired)) return null;
  return {
    rows: rows.flatMap((entry): LearnedRow[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { when, send, repeat, missed, learned } = entry as Record<string, unknown>;
      if (typeof when !== 'string' || when.length === 0 || typeof send !== 'string') return [];
      return [
        {
          when,
          send,
          ...(repeat === true ? { repeat: true } : {}),
          missed:
            typeof missed === 'number' && Number.isInteger(missed) && missed >= 0 ? missed : 0,
          learned: typeof learned === 'string' ? learned : ''
        }
      ];
    }),
    retired: retired.filter((when): when is string => typeof when === 'string' && when.length > 0)
  };
}
