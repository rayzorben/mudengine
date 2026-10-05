/**
 * The `logging:` block: what the client writes down, where, and for how long.
 * Out of `config.ts` with its default and its normalizer, as `locate.ts` and
 * `blessings.ts` are.
 *
 * Dependency-free, like the rest of `src/shared`.
 */
import { bool, int, isRecord, str } from './values';

export interface LoggingConfig {
  /** Append the decoded session to a file. */
  enabled: boolean;
  /**
   * Write down every fight: what it cost, and the conditions it was fought
   * under.
   *
   * Nothing reads these yet, which is the point of collecting them — every
   * question worth asking about how a character fights needs a record that
   * predates the question. One small compressed file per character beside the
   * options file, appended and never revised. See `shared/fights.ts`.
   *
   * On, unlike the capture: a fight record is a few hundred bytes, holds no
   * text the server sent and therefore cannot hold a password, and the whole
   * value of it is that it was already being collected.
   */
  fights: boolean;
  /**
   * Also record a full machine-readable capture: raw bytes, decoded text with
   * escape sequences intact, framed lines and outbound commands, timestamped.
   *
   * This is the development loop for pattern work — play manually with it on,
   * then `npm run capture:analyse`.
   *
   * **On by default**, and it was not always. It was off because it is verbose,
   * which was the wrong trade: the first real disagreement about *what the
   * server actually sent and in what order* had no file to settle it from, and
   * the argument was conducted over a pasted terminal excerpt instead — twice,
   * wrongly. A recording that exists only once somebody thinks to turn it on is
   * one that is never on when it is needed, because the moment you need it has
   * already happened.
   */
  capture: boolean;
  /**
   * How many days a session log or capture is kept after it was last written
   * to (todo 04, 2026-10-05). Older ones are deleted at launch and once a day
   * after; `0` keeps them all. A week by default: six weeks of
   * play had filled 5.6 GB.
   */
  keepDays: number;
  /**
   * Keep the Talk card's conversation history on disk, so quitting and
   * restarting restores it rather than starting the card empty.
   *
   * One plain JSONL file per character (`talk/<id>.jsonl`), appended as each
   * conversation line arrives and read back when the session is opened. On,
   * like the fights beside it: what somebody said is exactly the record whose
   * value is that it was already being collected — and unlike the capture it
   * holds only the conversation channels, never a prompt, so it cannot hold a
   * password.
   */
  conversations: boolean;
  /**
   * How much conversation to keep, in days. Entries older than this are
   * dropped when the log is opened — the cleanup, so a year of talk does not
   * become ten. Bounded below at one day; the default is a year.
   */
  conversationDays: number;
  /**
   * Where logs go. Empty means the per-user data directory, which is the only
   * reliably writable location on all three platforms.
   */
  directory: string;
  /** Stop appending past this size, rather than filling a disk unattended. */
  maxBytes: number;
}

/** The most days either retention takes: a hundred years is keeping everything. */
export const LOG_DAYS_MAX = 36500;

export const DEFAULT_LOGGING: Readonly<LoggingConfig> = {
  enabled: true,
  fights: true,
  capture: true,
  keepDays: 7,
  conversations: true,
  conversationDays: 365,
  directory: '',
  maxBytes: 64 * 1024 * 1024
};

export function normalizeLogging(value: unknown): LoggingConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_LOGGING;
  return {
    enabled: bool(raw['enabled'], d.enabled),
    fights: bool(raw['fights'], d.fights),
    capture: bool(raw['capture'], d.capture),
    keepDays: int(raw['keepDays'], d.keepDays, 0, LOG_DAYS_MAX),
    conversations: bool(raw['conversations'], d.conversations),
    // Floor of one day: zero would be a log that erases itself on every
    // launch, which is `conversations: false` wearing a number.
    conversationDays: int(raw['conversationDays'], d.conversationDays, 1, LOG_DAYS_MAX),
    directory: str(raw['directory'], d.directory),
    // Floor of 64 KiB: a cap smaller than one screenful of combat is a
    // misconfiguration rather than a preference.
    maxBytes: int(raw['maxBytes'], d.maxBytes, 64 * 1024, 4 * 1024 ** 3)
  };
}
