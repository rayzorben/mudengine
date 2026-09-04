/**
 * Whether a character can see where it is standing, and what it would take.
 *
 * The server's own arithmetic, read out of `Room.GetLightLevelDesc` and
 * `Player.ShowRoom` in the GreaterMUD source and then **confirmed on the
 * wire** before any of it was written down here (2026-09-03). `rm` prints
 * `Room Illu: <room> (<seen>)` — the room's recorded level beside what the
 * character actually sees — and every recorded session agrees with the sum
 * below exactly:
 *
 * | character | room | worn | seen |
 * |---|---|---|---|
 * | Gaunt One (night vision 200) | −175 Dark Cave | nothing lit | **25** |
 * | Gaunt One | 0 | nothing lit | **200** |
 * | Kang (night vision 0) | −175 Dark Cave | torch lit (100), carved ivory mask (25) | **−50** |
 * | Kang / Half-Ogre | 0 | nothing | **0** |
 *
 * So what a character sees by is the room's level, plus its race's night
 * vision, plus what every equipped item grants — the readied light's reach
 * and any worn thing with a night-vision bonus — plus the light every *other*
 * player in the room is holding, which this client cannot see and treats as
 * nothing: assuming somebody else's lantern is the reassuring guess, and the
 * cost of being wrong the other way is one torch lit that was not needed.
 * Spells with a light effect are the same absence for the same reason.
 *
 * Dependency-free, like everything in `src/shared/`: the tracker computes it
 * from the pack and the realm, the walker asks it before a step, and the Self
 * card draws it.
 */
import type { RoomLight } from './character';
import type { ItemEntity } from './entities';

/**
 * The three `Abil-n` ids that carry light, by number.
 *
 * `13` (`Illu`) is night vision — what a race or a worn item lets a character
 * see by; `14` (`RoomIllu`) lights the room for everybody in it; `54`
 * (`IlluTarget`, "Illu target" in the server's own naming) is how far a
 * readied light reaches. `src/shared/abilities.ts` names all three, and
 * `light.test.ts` asserts these numbers against that table so the two cannot
 * drift.
 */
export const NIGHT_VISION_ABILITY = 13;
export const ROOM_LIGHT_ABILITY = 14;
export const LIGHT_REACH_ABILITY = 54;

/**
 * Where each phrase begins, read straight off `GetLightLevelDesc`.
 *
 * `< -200` pitch black and `< -150` very dark are the two the server prints
 * **instead of** the room — no name, no exits, no occupants. `< -100` barely
 * visible and `< 0` dimly lit annotate a room already read. At 0 and above
 * nothing is printed at all. The realm's own numbers rather than tuning keys,
 * for the reason `COPPER_PER_GOLD` is: they are the server's arithmetic, not
 * a determination this client makes.
 */
export const LIGHT_BANDS: Readonly<Record<RoomLight, number>> = {
  'pitch black': -200,
  'very dark': -150,
  'barely visible': -100,
  'dimly lit': 0
};

/** The least light at which the server still describes the room. */
export const CAN_SEE_FROM = LIGHT_BANDS['very dark'];

/** The phrase the server would print for this much light, or null for none. */
export function lightPhrase(illu: number): RoomLight | null {
  if (illu < LIGHT_BANDS['pitch black']) return 'pitch black';
  if (illu < LIGHT_BANDS['very dark']) return 'very dark';
  if (illu < LIGHT_BANDS['barely visible']) return 'barely visible';
  if (illu < LIGHT_BANDS['dimly lit']) return 'dimly lit';
  return null;
}

/** Whether the room is described at this much light. */
export function canSeeAt(illu: number): boolean {
  return illu >= CAN_SEE_FROM;
}

/** The sum of one ability across a set of `[id, value]` pairs. */
export function abilitySum(pairs: ReadonlyArray<readonly [number, number]>, id: number): number {
  let total = 0;
  for (const [ability, value] of pairs) if (ability === id) total += value;
  return total;
}

/**
 * One light the character carries, as the decision needs it.
 *
 * `reach` is the item's `IlluTarget`, null where the realm does not carry the
 * item — a derivative's own lantern is exactly where the client knows nothing,
 * and a null reach is refused rather than guessed at when choosing. `charges`
 * is what the listing counted, null where it counted nothing; the server
 * treats a zero-charge light as absent (`use glowing pearl` → `You don't have
 * glowing pearl.`, measured 2026-08-27), and unstated is not zero.
 */
export interface CarriedLight {
  name: string;
  reach: number | null;
  charges: number | null;
  /** Readied — the listing's own word for the lit slot. */
  lit: boolean;
}

/** Whether this light still gives light. Unstated charges are not zero. */
export function lightIsUsable(light: CarriedLight): boolean {
  return light.charges !== 0;
}

/**
 * What the character can see by, from everything but the room.
 *
 * `vision` is the night vision — race plus every equipped item's `Illu` and
 * `RoomIllu`, the lit light's own `Illu` included — and `reach` is the readied
 * light's `IlluTarget`, or 0 with nothing lit or the lit thing spent. The two
 * are kept apart because the decision *is* the difference between them: a
 * character whose vision alone reads the room needs no torch, and one whose
 * torch is the whole of it needs the next torch the moment this one goes out.
 */
export interface Sight {
  vision: number;
  reach: number;
  /** The light that is lit and giving light, by name, or null. */
  lit: string | null;
  /** What the room's level is added to: `vision + reach`. */
  total: number;
  /**
   * Whether the race's share of `vision` is known. False before the stat
   * sheet has named the race, when the figure is worked out from the kit
   * alone — a Gaunt One is then priced as seeing nothing, which is the
   * direction that lights one torch too many rather than walks blind.
   */
  raceKnown: boolean;
}

export function sightOf(
  vision: number,
  lights: ReadonlyArray<CarriedLight>,
  raceKnown: boolean
): Sight {
  const lit = lights.find((light) => light.lit && lightIsUsable(light));
  const reach = lit?.reach ?? 0;
  return { vision, reach, lit: lit?.name ?? null, total: vision + reach, raceKnown };
}

/** Whether two sights say the same thing, so an unchanged one is not republished. */
export function sameSight(a: Sight | null, b: Sight | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.vision === b.vision &&
    a.reach === b.reach &&
    a.lit === b.lit &&
    a.total === b.total &&
    a.raceKnown === b.raceKnown
  );
}

/**
 * The lights in the pack, as the decision needs them.
 *
 * Only what the realm's own kind says is a light (`ItemKind === 'light'`);
 * the reach is its `IlluTarget`, and null for an item the realm carries
 * without one — or does not carry at all, where `abilities` is absent.
 */
export function carriedLights(items: ReadonlyArray<ItemEntity>): CarriedLight[] {
  const lights: CarriedLight[] = [];
  for (const item of items) {
    if (item.kind !== 'light') continue;
    lights.push({
      name: item.name,
      reach: item.abilities === undefined ? null : abilitySum(item.abilities, LIGHT_REACH_ABILITY),
      charges: item.charges,
      lit: item.equipped
    });
  }
  return lights;
}

/**
 * What every equipped thing adds to the character's own vision — `Illu` and
 * `RoomIllu`, the lit light's own night-vision bonus included (a readied
 * torch has none; a carved ivory mask has 25).
 */
export function wornVision(items: ReadonlyArray<ItemEntity>): number {
  let total = 0;
  for (const item of items) {
    if (!item.equipped || item.abilities === undefined) continue;
    total += abilitySum(item.abilities, NIGHT_VISION_ABILITY);
    total += abilitySum(item.abilities, ROOM_LIGHT_ABILITY);
  }
  return total;
}

/**
 * What a room at `level` reads as for this character, or null when the realm
 * records no level for it — which is an ordinarily lit room *as far as the
 * data goes*, and the honest answer is that nothing is claimed.
 */
export function seenAt(level: number | undefined, sight: Sight): number | null {
  return level === undefined ? null : level + sight.total;
}

/**
 * The light to ready for a room at `level`, or the reason none will do.
 *
 * Only a light that would actually make the room readable is worth its
 * charges: one that lifts `pitch black` to `very dark` burns for nothing, so
 * it is not chosen. Among those that suffice, the one with the **least**
 * reach wins — a torch is spent on a sewer and a marsh light kept for a cave
 * — and a light the realm cannot measure (null reach) is never chosen over a
 * measured one, because choosing it is a guess about whether it lights
 * anything. With nothing measured that suffices, an unmeasured usable light
 * is offered as a `guess`: the player packed it as a light and the cost of
 * trying is one command.
 *
 * `dim` widens the question from *readable* to *not dark at all*, which is
 * MegaMUD's "provide light in dimly-lit rooms".
 */
export type LightChoice =
  /** The room is readable by vision alone; nothing to light. */
  | { kind: 'unneeded' }
  /** A usable light is lit and reaches. */
  | { kind: 'lit' }
  | { kind: 'ready'; light: CarriedLight; guess: boolean }
  | { kind: 'none'; reason: 'nothing carried' | 'nothing usable' | 'nothing reaches' };

export function chooseLight(
  level: number,
  vision: number,
  lights: ReadonlyArray<CarriedLight>,
  dim = false
): LightChoice {
  const enough = (reach: number): boolean =>
    dim ? lightPhrase(level + vision + reach) === null : canSeeAt(level + vision + reach);
  if (enough(0)) return { kind: 'unneeded' };
  const lit = lights.find((light) => light.lit && lightIsUsable(light));
  if (lit !== undefined && (lit.reach === null || enough(lit.reach))) return { kind: 'lit' };
  if (lights.length === 0) return { kind: 'none', reason: 'nothing carried' };
  const usable = lights.filter((light) => !light.lit && lightIsUsable(light));
  if (usable.length === 0) return { kind: 'none', reason: 'nothing usable' };
  const measured = usable
    .filter((light): light is CarriedLight & { reach: number } => light.reach !== null)
    .filter((light) => enough(light.reach))
    .sort((a, b) => a.reach - b.reach);
  if (measured[0] !== undefined) return { kind: 'ready', light: measured[0], guess: false };
  const unmeasured = usable.find((light) => light.reach === null);
  if (unmeasured !== undefined) return { kind: 'ready', light: unmeasured, guess: true };
  return { kind: 'none', reason: 'nothing reaches' };
}

/**
 * Whether the character needs a light readied for a room at `level`.
 *
 * Asked of the room *without* the light that is currently lit, so a torch
 * already burning is counted by `chooseLight` rather than assumed here.
 */
export function needsLightAt(level: number, vision: number, dim = false): boolean {
  return dim ? lightPhrase(level + vision) !== null : !canSeeAt(level + vision);
}
