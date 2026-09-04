/**
 * Reading a value out of something that came off disk or off the wire.
 *
 * Every boundary in this client parses rather than validates — an options file,
 * a profile, a draft posted from the renderer — and every one of them needs the
 * same four primitives to do it. They were written out **four times**
 * (`config.ts`, `profiles.ts`, `drafts.ts`, `SettingsEditor.ts`), which is not
 * a hypothetical cost: the fifth helper of the same family, `text`, exists in
 * two copies that **disagree** about whether to trim, and nothing says which
 * caller wanted which.
 *
 * Kept apart from `config.ts` on purpose. `drafts.ts` needs a type guard, not
 * the options schema, and importing eighteen hundred lines of realm settings to
 * get one is the coupling this file removes.
 *
 * Dependency-free, like everything in `shared/`.
 */

/**
 * A plain object, which is what every one of these files means by "a record".
 *
 * Arrays are excluded deliberately: YAML and JSON both produce them for a key
 * whose value is a list, and `typeof [] === 'object'` would let one through
 * into code that then reads named fields off it and finds nothing.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A non-empty string, trimmed, or the fallback.
 *
 * **Empty is the fallback, not the empty string.** A key somebody left blank in
 * an options file is a key they have not answered, and a blank host or a blank
 * username fails at the socket or at the login prompt rather than at load.
 */
export function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/** A boolean, or the fallback. A string `'true'` is *not* one. */
export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A whole number inside a range, or the fallback.
 *
 * Clamped rather than refused: a number outside the range is somebody asking
 * for more than the client can give, and the nearest thing it can give is a
 * better answer than the default they did not ask for. Not finite at all is a
 * different matter and takes the fallback.
 */
export function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The human sentence inside a caught `unknown`.
 *
 * `catch` hands over `unknown`, and the expression to get a message out of it
 * had been reimplemented inline at more than ten call sites — including one
 * variant that forgot `String()` and would happily interpolate `[object
 * Object]`. One spelling, here, so every error a notice carries reads the
 * same way.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
