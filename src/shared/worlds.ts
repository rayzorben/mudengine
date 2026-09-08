import type { RealmFamily as RealmWord } from './character';

/**
 * The two worlds the client ships, and the word a realm uses for itself.
 *
 * There are two versions of this game's data in circulation: stock MajorMUD
 * v1.11p and Paradigm's own, which grew out of it. Both are bundled, converted
 * (`resources/world/<world>.jsonl.gz`, `scripts/build-world.mjs`), and a realm
 * says which it runs at its own menu: the prompt reads `[MAJORMUD]:` or
 * `[PARADIGM]:` (`CharacterState.realm`). This module is that vocabulary and
 * nothing else — which world exists, what it is called, and which the realm's
 * word names. See `mudengine-world`, "Two worlds ship, and the realm's own
 * word chooses between them".
 */
export type ShippedWorld = 'majormud' | 'paradigm';

/** The runtime half of the union; `__tests__/worlds.test.ts` holds them together. */
export const SHIPPED_WORLDS: readonly ShippedWorld[] = ['majormud', 'paradigm'];

/** The realms' own names for themselves; closed-union vocabulary stays in code. */
export const SHIPPED_WORLD_LABEL: Record<ShippedWorld, string> = {
  majormud: 'MajorMUD',
  paradigm: 'Paradigm'
};

/**
 * What a realm walks until it has said which world it runs.
 *
 * Paradigm, because the six realms the client ships are Paradigm's and the
 * only GreaterMUD server this client has met runs Paradigm's data too.
 */
export const DEFAULT_SHIPPED_WORLD: ShippedWorld = 'paradigm';

/** Parse, do not validate: anything else is `null` rather than a cast. */
export function asShippedWorld(value: unknown): ShippedWorld | null {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().toLowerCase();
  return SHIPPED_WORLDS.find((world) => world === wanted) ?? null;
}

/** The file one bundled world is kept in, under the client's `world/` resources. */
export function shippedWorldFile(world: ShippedWorld): string {
  return `${world}.jsonl.gz`;
}

/**
 * The bundled world a realm's own word names.
 *
 * `majormud` and `paradigm` are the menu prompt's words for the two data sets.
 * `greatermud` is a *server* naming itself in its welcome line, and it walks
 * Paradigm's data: measured across 259 recorded sessions on the one GreaterMUD
 * server this client has dialled (2026-09-07), every one printed
 * `Welcome to the official Paradigm server!` and answered its menu with
 * `[PARADIGM]:`. Null until the realm has said anything.
 */
export function worldOfRealm(realm: RealmWord | null): ShippedWorld | null {
  switch (realm) {
    case 'majormud':
      return 'majormud';
    case 'paradigm':
    case 'greatermud':
      return 'paradigm';
    default:
      return null;
  }
}

/**
 * The archive a bundled world was built from — name, size and SHA-1.
 *
 * Written into the world's header by `build-world.mjs` so that a database a
 * player names can be recognised as *that very archive*: the same bytes are the
 * same world, and converting them again would only file what is learned under
 * a second name. Content, never the file's name — `pmud.zip` is anybody's name
 * for anything.
 */
export interface ArchiveIdentity {
  name: string;
  size: number;
  sha1: string;
}

/** The identity read back off a header: every field checked, none coerced. */
export function readArchiveIdentity(value: unknown): ArchiveIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const name = record['name'];
  const size = record['size'];
  const sha1 = record['sha1'];
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return null;
  if (typeof sha1 !== 'string' || !/^[0-9a-f]{40}$/.test(sha1)) return null;
  return { name, size, sha1 };
}
