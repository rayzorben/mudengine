/**
 * A profile is a character.
 *
 * One YAML file in the profiles directory names one character: which server,
 * which account, which character slot, and anything about the client that this
 * character wants different from everyone else. See docs/profiles.md §2 and §3.
 *
 * Two rules shape everything here, and both are why this file exists rather
 * than a second copy of the options schema.
 *
 * 1. **A profile is a sparse overlay, never a copy of the options file.** The
 *    options template is copied once and never updated, so a setting added
 *    later is invisible in every file that predates it. If a profile were a
 *    full configuration, every future global setting would be permanently
 *    absent from every existing character — the automatic-login failure,
 *    multiplied by however many characters someone has. Resolving a profile
 *    therefore *merges* what it says onto the live global config and coerces
 *    the result through `normalizeConfig`, so a character inherits every
 *    setting it does not mention, including ones that do not exist yet.
 * 2. **A profile that cannot name a server is not a profile.** It is reported
 *    and skipped, never defaulted onto `connection:`, because a defaulted
 *    profile is a tab that silently dials somewhere the player never named.
 *
 * Dependency-free, like the rest of `src/shared`.
 */
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  type AppConfig,
  type LoginStep,
  type Server
} from './config';
import type { ConnectionTarget } from './types';
import { isRecord, str } from './values';

/**
 * Identity colours a character may claim.
 *
 * Names from the theme rather than raw values, so a character's colour adapts
 * per theme and cannot become the glare source that a full-strength EGA hue
 * beside a dark slate is. `danger` is deliberately absent: it means trouble, and
 * a character permanently painted as trouble cannot report any.
 */
export const PROFILE_ACCENTS = ['cyan', 'green', 'amber', 'violet'] as const;
export type ProfileAccent = (typeof PROFILE_ACCENTS)[number];

/** Whether a value out of a profile file is an accent this client knows. */
export function isProfileAccent(value: unknown): value is ProfileAccent {
  return typeof value === 'string' && (PROFILE_ACCENTS as readonly string[]).includes(value);
}

/** One character, resolved and ready to run. */
export interface Profile {
  /**
   * The filename without its extension.
   *
   * Names the session, the log file, the capture, the tab and the decision
   * trace, which is why it is the filename rather than a generated id: renaming
   * a character is then a deliberate act with a visible consequence, and
   * `grep thorn` finds everything about it.
   */
  id: string;
  /** Display name. Defaults to the id. */
  name: string;
  target: ConnectionTarget;
  /**
   * What to call the place this character plays, for a tab.
   *
   * The server's own name when the profile referred to one — "GreaterMUD
   * (local)" reads better than a bare hostname and is what the player wrote — and
   * the host when it spelled the address out inline.
   */
  serverName: string;
  /**
   * The realm database this character plays against — empty for the shipped one.
   *
   * Taken from the *server*, like the target and the menu script, because that
   * is what it is a property of: two characters on one realm cannot be walking
   * two different maps. It is not part of `config` for the same reason
   * `connection` is assembled rather than overlaid — a character stating it
   * again in its own file would be a second spelling of the same thing, and the
   * settings screen could not keep the two honest. See `Server.database`.
   */
  database: string;
  /** Dial this character when the client starts. */
  autoConnect: boolean;
  /**
   * Dial this character again when a connection is **lost**.
   *
   * On by default, which `autoConnect` beside it deliberately is not, and the
   * difference is what each one costs when it is wrong. `autoConnect` opens a
   * connection nobody asked for; this one puts back a connection somebody
   * already had and the network took away — and on this server family a
   * character left standing in the realm while its client sits at a closed
   * socket is a character being killed while nobody watches.
   *
   * Absence therefore means *on*: a profile written before this existed gets
   * it, which is the one direction a default may be read that way here. It
   * never fires for a disconnect anybody asked for, and never once the player
   * has left the realm on purpose — see `Reconnect`.
   */
  autoReconnect: boolean;
  accent: ProfileAccent;
  /**
   * The complete options this character runs under: the global file with this
   * profile's overlay applied. Never a partial.
   */
  config: AppConfig;
}

/** Either a character, or why there is not one. */
export type ProfileResult = { profile: Profile; error?: undefined } | { error: string };

/**
 * Applies a sparse patch to a value.
 *
 * Records merge key by key; **everything else replaces**, arrays included. A
 * profile that states `automation.rules` means *these rules*, not these as well
 * as the global ones — appending would make it impossible to remove a global
 * rule for one character, and silently dropping the global set would be worse
 * still. Replacement is the only rule that is obvious from reading the file.
 */
export function overlay(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isRecord(patch) || !isRecord(base)) return patch;

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isRecord(value) && isRecord(base[key]) ? overlay(base[key], value) : value;
  }
  return merged;
}

/** Case-insensitive lookup by name, for `server:` references. */
function byName<T extends { name: string }>(entries: T[], name: string): T | undefined {
  const wanted = name.trim().toLowerCase();
  return entries.find((entry) => entry.name.toLowerCase() === wanted);
}

/**
 * The server a profile names: a reference into `servers:`, or an inline
 * mapping. Returns null when it names neither — see rule 2 above.
 */
function resolveServer(
  value: unknown,
  servers: Server[]
): { target: ConnectionTarget; name: string; login: LoginStep[]; database: string } | null {
  if (typeof value === 'string') {
    const found = byName(servers, value);
    return found
      ? {
          target: { host: found.host, port: found.port, encoding: found.encoding },
          name: found.name,
          login: found.login,
          database: found.database
        }
      : null;
  }

  if (isRecord(value)) {
    const host = str(value['host'], '');
    if (host.length === 0) return null;
    // Coerced by normalizeConfig below; this only has to be well-formed enough
    // to be recognisable as a target.
    const port = typeof value['port'] === 'number' ? value['port'] : DEFAULT_CONFIG.connection.port;
    const encoding = value['encoding'];
    return {
      // An address spelled out inline names no server entry, so there is no
      // script to inherit — the character's own, or the global default, wins.
      login: [],
      /*
       * The realm database, which an inline address *may* state.
       *
       * Unlike the script above there is nothing to inherit and nothing to
       * conflict with: an inline mapping is the realm declaration, spelled out
       * where the character sits rather than in a directory of its own. Saying
       * it here is still saying it once, about the place — a character on a
       * derivative reached by a bare `host:` would otherwise have no way to name
       * its map at all.
       */
      database: str(value['database'], ''),
      target: {
        host,
        port,
        encoding:
          encoding === 'utf8' || encoding === 'latin1' || encoding === 'cp437'
            ? encoding
            : DEFAULT_CONFIG.connection.encoding
      },
      name: host
    };
  }

  return null;
}

/**
 * The account a profile states, inline. Every character carries its own
 * username and password rather than naming a shared one — two characters on
 * the same BBS account simply state the same username twice, and if their
 * passwords drift apart that is theirs to notice, not the client's to prevent.
 */
function resolveAccount(value: unknown): { username: string; password: string } | null {
  if (!isRecord(value)) return null;
  const username = str(value['username'], '');
  if (username.length === 0) return null;
  return { username, password: str(value['password'], '') };
}

/**
 * A stable accent for a character that has not chosen one.
 *
 * Derived from the id rather than from position in the list, so adding a
 * character does not repaint the others. Identity that shifts because somebody
 * else arrived is not identity.
 */
function accentFor(id: string): ProfileAccent {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PROFILE_ACCENTS[hash % PROFILE_ACCENTS.length] as ProfileAccent;
}

/**
 * Turns one parsed profile file into a character, or says why it cannot.
 *
 * `baseSource` is the **parsed options file, before coercion** — not the coerced
 * `AppConfig`. That distinction is load-bearing and was found the hard way:
 * `normalizeConfig` is not idempotent. A rule's `when: 'every 3s'` becomes a
 * parsed trigger object and its `if: ['hp < 0.3']` becomes guard objects, and
 * feeding those back through the parser produces nothing — so overlaying onto
 * an already-normalised config silently emptied `automation.rules` for every
 * character. Any block whose coerced shape differs from its YAML shape would
 * have gone the same way.
 *
 * So a profile is an overlay on the *file*, and the sum is coerced exactly once.
 * A character still inherits every setting it does not mention, including
 * settings added to the client after its file was written.
 */
export function resolveProfile(id: string, raw: unknown, baseSource: unknown): ProfileResult {
  if (!isRecord(raw)) return { error: `${id}: not a mapping` };

  const base = normalizeConfig(baseSource);

  const server = resolveServer(raw['server'], base.servers);
  if (!server) {
    const named = typeof raw['server'] === 'string' ? ` "${raw['server']}"` : '';
    return {
      error:
        `${id}: no server${named}. Name one from \`servers:\` or give host and port inline — ` +
        'a profile is never defaulted onto `connection:`, because that would dial somewhere ' +
        'you did not choose.'
    };
  }

  const target = server.target;
  const account = resolveAccount(raw['account']);
  const login = isRecord(raw['login']) ? raw['login'] : {};

  /*
   * `enabled` defaults to *true* here, where the global `connection.login`
   * defaults to false. The difference is deliberate: `connection:` is the ad-hoc
   * path, where a client that sends an empty username at every connection is
   * worse than one that waits, whereas a profile exists precisely to say "this
   * is my character, log me in". Credentials still gate it — `LoginAutomator`
   * ignores `enabled` without a username and password — and every safety rule
   * holds unchanged: a rejected password is never retried, a repeated prompt
   * stops the sequence, a missing answer leaves the prompt alone.
   */
  const credentials = account ?? { username: '', password: '' };
  const patch = overlay(
    // Anything the profile says about the client generally — automation, ui,
    // logging — is the overlay. The connection block is assembled from the
    // fields above rather than taken from the file, so a profile cannot state
    // a host in two places and disagree with itself.
    withoutProfileKeys(raw),
    {
      connection: {
        host: target.host,
        port: target.port,
        encoding: target.encoding,
        login: {
          enabled: credentials.username.length > 0,
          /*
           * The BBS's own menu script, unless this character states one.
           *
           * A script belongs to the *server*: every character on one BBS meets
           * the same menus. What differs per character is the account and the
           * character slot, and a character that needs a different slot says so
           * by giving its own `steps` — which is why this is a plain override
           * rather than a merge. Merging two scripts would answer the same menu
           * twice, and the second answer would arrive at whatever came next.
           */
          ...(server.login.length > 0 ? { steps: server.login } : {}),
          ...login,
          username: credentials.username,
          password: credentials.password
        }
      }
    }
  );

  const accent = raw['accent'];
  return {
    profile: {
      id,
      name: str(raw['name'], id),
      target,
      serverName: server.name,
      database: server.database,
      autoConnect: raw['autoConnect'] === true,
      // `!== false`, not `=== true`: this one is on unless the file says
      // otherwise. See the field.
      autoReconnect: raw['autoReconnect'] !== false,
      accent: isProfileAccent(accent) ? accent : accentFor(id),
      // Merged onto the file as written, then coerced by the same function the
      // options file goes through: one place decides what a valid value is, and
      // it runs exactly once.
      config: normalizeConfig(overlay(baseSource, patch))
    }
  };
}

/**
 * Strips the keys that describe the character itself, leaving the overlay.
 *
 * `server`, `account` and `login` are resolved into `connection:` above; `name`,
 * `accent`, `autoConnect` and `autoReconnect` are properties of the profile
 * rather than of the client. Leaving them in would put keys into the merged
 * config that `normalizeConfig` does not know, which is harmless but
 * misleading to read.
 */
function withoutProfileKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const { server, account, login, name, accent, autoConnect, autoReconnect, ...rest } = raw;
  void server;
  void account;
  void login;
  void name;
  void accent;
  void autoConnect;
  void autoReconnect;
  return rest;
}
