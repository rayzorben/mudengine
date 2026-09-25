/**
 * What the session asks of every module it composes: to put down what it
 * decided for the character that was, and to let go of what it owns.
 *
 * `SessionManager` holds its modules on one ordered list and walks it on
 * connect, on leaving the realm, on a reload and on disposal, so a module
 * cannot be left out of one of the four and not the others. See
 * `mudengine-session` › *A module is put down from one list*.
 */
export interface SessionModule {
  /** Forgets everything decided for the character that was. Idempotent. */
  reset(): void;
  /** Releases what the module owns (a timer, a listener); nothing fires after it. */
  dispose?(): void;
}
