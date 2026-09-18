/**
 * The placeholders a login step may ask the client to fill in.
 *
 * The menus differ per BBS, and so does the wording of the two prompts that ask
 * for the account: answering those from the *block vocabulary* worked only for
 * a realm that spells them `Please enter your username or "new":` and `Please
 * enter your password:`. A realm that asks `Enter your ID:` got no typed block,
 * so nothing was answered and the sequence stalled with no way to describe the
 * prompt — while every other menu on the same realm was already describable.
 *
 * So the two join the script they were the exception to. The step matches the
 * prompt's own text like any other, and names the value it wants rather than
 * holding it: the credentials stay on the character's own file, which is local
 * and gitignored, and the script stays on the realm, which is shared.
 *
 * The vocabulary is **closed and small on purpose**. A placeholder the client
 * does not know is refused out loud rather than sent, so a typo cannot be typed
 * at a live service and `{` stays reserved for this.
 */

/** The two values a script may name but must not hold. */
export type Credential = 'username' | 'password';

/**
 * What may stand in braces, and which credential it means.
 *
 * Two spellings each, because both are the obvious one to somebody who has not
 * read this file, and a client that sent `{username}` verbatim at a password
 * prompt would be teaching that lesson at the worst possible moment.
 */
const PLACEHOLDERS: Readonly<Record<string, Credential>> = {
  user: 'username',
  username: 'username',
  pass: 'password',
  password: 'password'
};

/** The account a script is filled in from. */
export interface LoginAccount {
  username: string;
  password: string;
}

/**
 * What filling a step's `send` produced.
 *
 * Three outcomes rather than a string and a null, because the two refusals are
 * different sentences: a missing credential is a field the player has not
 * filled in, and an unknown placeholder is a typo in the script.
 */
export type FilledLogin =
  | { kind: 'filled'; command: string; credentials: readonly Credential[] }
  | { kind: 'missing'; credential: Credential }
  | { kind: 'unknown'; placeholder: string };

/** `{word}`, anywhere in the answer: `{password}` alone, or `user {user}`. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fills a step's answer from the account, or says why it cannot.
 *
 * An answer with no placeholder in it comes back as written — which is every
 * menu row, and is why this runs over the whole script rather than over rows
 * somebody has had to mark.
 */
export function fillLogin(send: string, account: LoginAccount): FilledLogin {
  const credentials: Credential[] = [];
  let missing: Credential | null = null;
  let unknown: string | null = null;

  const command = send.replace(PLACEHOLDER, (whole: string, name: string) => {
    const credential = PLACEHOLDERS[name.toLowerCase()];
    if (credential === undefined) {
      unknown ??= whole;
      return whole;
    }
    const value = account[credential];
    if (value.length === 0) {
      missing ??= credential;
      return whole;
    }
    if (!credentials.includes(credential)) credentials.push(credential);
    return value;
  });

  // A typo outranks a missing value: the placeholder nobody can fill in is the
  // one the player has to fix, and naming the other first would send them to a
  // field that is already correct.
  if (unknown !== null) return { kind: 'unknown', placeholder: unknown };
  if (missing !== null) return { kind: 'missing', credential: missing };
  return { kind: 'filled', command, credentials };
}

/**
 * Which credentials an answer names, filled in or not.
 *
 * Asked *before* filling, which is why it is not just `fillLogin().credentials`:
 * the automator has to know what a row would send in order to decide whether to
 * send it, and a row whose value is missing names one all the same.
 *
 * Two readers. The automator refuses a row naming a credential it has already
 * sent this connection — the account coming back means the realm refused it,
 * and *which credential* is the only order- and wording-independent way to know
 * that, since two rows may answer one prompt in two spellings. The migration
 * asks the weaker question: a script naming any credential is one somebody has
 * written rows for, so a second pair would answer the same prompt twice.
 */
export function credentialsNamed(send: string): readonly Credential[] {
  const named: Credential[] = [];
  send.replace(PLACEHOLDER, (whole: string, name: string) => {
    const credential = PLACEHOLDERS[name.toLowerCase()];
    if (credential !== undefined && !named.includes(credential)) named.push(credential);
    return whole;
  });
  return named;
}
