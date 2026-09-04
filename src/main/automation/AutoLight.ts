/**
 * Readying a light before the dark, unasked — MegaMUD's AutoLight.
 *
 * `Walker` has always known, a step ahead, that the next room is dark, and
 * until 2026-09-03 it warned and deliberately did not act, pointing at
 * `automation.rules`. A rule cannot see the step about to be taken, which is
 * the only moment lighting a torch is worth anything: a character that arrives
 * in `pitch black` gets no room block at all — no exits, no occupants — and a
 * light readied *after* that costs a second command to read the room. So this
 * is asked twice, and the first time is the one that matters:
 *
 * - **Before a step** (`beforeStep`, from the walker, with the destination's
 *   recorded level): the light goes out ahead of the direction in the same
 *   band, so the server lights the torch and then moves the character.
 * - **On arrival** (`onCharacter`): a room the server printed a dark phrase
 *   for — a typed direction, a follow, a dark room the realm had no level for
 *   — and, when the arrival was blinding, one `look` behind the light so the
 *   room the character is now standing in gets read.
 *
 * ## The arithmetic is the server's
 *
 * `src/shared/light.ts`: the room's level, plus the race's night vision, plus
 * what every equipped item grants, plus the readied light's reach. Readable at
 * −150 and above. A Gaunt One in a −175 sewer needs nothing; a Kang with a
 * torch reads it at −75. The tracker keeps that sum as `CharacterState.sight`
 * and this reads it; the lights themselves come off the pack with the realm's
 * reach beside each.
 *
 * ## What it will not do
 *
 * - **Light something that would not help.** A pearl lifting `pitch black` to
 *   `very dark` burns for nothing. `chooseLight` refuses, and the refusal is
 *   recorded (`SafetyDecision`) so somebody who packed a torch and stood in the
 *   dark can read why it was not lit.
 * - **Light over a spent light.** The server answers `You already have
 *   something lit!` while anything sits in the readied slot, a burnt-out torch
 *   included, so the spent one is removed first — two commands, in order.
 * - **Say the same thing twice.** One decision per room per answer; a
 *   corridor of six dark rooms with nothing to light is one line, not six.
 * - **Put a light out mid-route.** `extinguishInLight` fires only while nothing
 *   is walking the character: a route's next step may be dark again, and a
 *   torch put out and relit at every doorway is two commands per doorway.
 *
 * Proposes to `CommandQueue`; nothing here touches a socket. `movement` band
 * for the two that must precede a step, `probe` for the look and the
 * extinguish, which can wait a turn.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import type { SafetyDecision } from '../../shared/automation';
import { isBlinding, type CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import {
  carriedLights,
  chooseLight,
  lightIsUsable,
  needsLightAt,
  type CarriedLight,
  type LightChoice
} from '../../shared/light';

export interface LightEvents {
  notice?(message: string): void;
  /** The trace: what was lit, what was put out, and what was refused and why. */
  decided?(decision: SafetyDecision): void;
  /** Whether an escape is in flight; nothing is lit while one is. See `on`. */
  escaping?(): boolean;
}

/** What `beforeStep` is told about the room being stepped into. */
export interface StepAhead {
  /** The destination's name, for the trace. */
  name: string;
  /** The realm's recorded level, or undefined for a room it records none for. */
  light: number | undefined;
}

export class AutoLight {
  /** The last decision's key, so an unchanged answer is not recorded again. */
  private lastKey: string | null = null;
  /** The room an extinguish was last proposed in, so a listing repeat does not re-propose. */
  private extinguishedIn: string | null = null;
  /** Where the last decision was taken, so leaving a room re-arms both memories. */
  private decidedIn: string | null = null;
  /** When a light was last asked for, so an extinguish cannot race it. */
  private litAt = 0;
  /** The room an arrival light was proposed in. */
  private arrivalLitIn: string | null = null;

  constructor(
    private config: MovementConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly events: LightEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: MovementConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.lastKey = null;
    this.extinguishedIn = null;
    this.arrivalLitIn = null;
    this.decidedIn = null;
    this.litAt = 0;
  }

  /**
   * The walker is about to send a step into `ahead`.
   *
   * Decided from the realm's level, not from a phrase: the phrase is what the
   * server will print *after* the step, which is too late. A room the realm
   * records no level for is an ordinarily lit one, and nothing is done.
   */
  beforeStep(ahead: StepAhead, state: CharacterState): void {
    if (!this.on(state) || ahead.light === undefined) return;
    this.provide(ahead.light, ahead.name, state, 'movement');
  }

  /**
   * Every state change: an arrival the server described as dark, and a lit
   * room the light can be put out in.
   */
  onCharacter(state: CharacterState, walking: boolean): void {
    if (!this.on(state)) return;
    const here = roomKey(state);
    /*
     * A room the character has left takes its memories with it. `arrivalLitIn`
     * was a single slot cleared only by a new connection, so walking out of a
     * dark room and back in — by a typed direction or a party follow, the two
     * paths `beforeStep` does not cover — found it still set and did nothing
     * at all, leaving the character in the dark with a torch in the pack and
     * nothing in the trace to say why.
     */
    if (here !== this.decidedIn) {
      this.decidedIn = here;
      this.arrivalLitIn = null;
      this.extinguishedIn = null;
      this.lastKey = null;
    }
    const phrase = state.room.light;

    if (phrase !== null) {
      /*
       * The server said the room is dark, whatever the realm recorded. Once
       * per room: the phrase is restated on every look and every repaint.
       */
      if (here !== null && this.arrivalLitIn === here) return;
      const dark = isBlinding(phrase) || this.config.lightDimRooms;
      if (!dark) return;
      this.arrivalLitIn = here;
      /*
       * The realm's level where it records one — and `undefined`, not zero,
       * where it does not. The server has just said this room is dark; pricing
       * an absent column as *lit* would let missing data outrank the wire,
       * which is the one direction this client never reads it. Undefined takes
       * the guess branch, which is what a dark room nothing can measure wants.
       */
      this.provide(state.room.lightLevel, state.room.name ?? phrase, state, 'movement');
      return;
    }

    this.extinguish(state, walking, here);
  }

  /**
   * `You lit the torch.` in a room the server would not describe: the room has
   * to be asked for again, because nothing reprints it on its own.
   */
  onBlock(block: Block, state: CharacterState): void {
    if (!this.on(state) || block.type !== 'user-equipped') return;
    if (!isBlinding(state.room.light)) return;
    const item = block.groups['item'];
    if (item === undefined) return;
    if (!carriedLights(state.inventory.items).some((light) => light.name === item)) return;
    this.queue.enqueue({
      command: 'l',
      priority: 'probe',
      coalesceKey: 'light:look',
      expiresAt: this.now() + tuning().light.expiresMs,
      reason: t('automation.light.reasonLook', { item })
    });
  }

  private on(state: CharacterState): boolean {
    if (!this.enabled || !this.config.provideLight || state.phase !== 'in-game') return false;
    /*
     * Not while the character is running away. Every module that spends a
     * command in a crisis stands down for the escape — the heal, the potion,
     * the cures, the blessings and `mayRest` all do — and a torch is the least
     * urgent of them: the escape is a move in the `emergency` band and this
     * proposes in `movement`, so a light queued now is a command in front of
     * the one that gets the character out. Lighting it on the way out of a
     * lair is defensible, which is why this is a decision rather than an
     * omission.
     */
    return !(this.events.escaping?.() ?? false);
  }

  /**
   * The decision, for a room at `level`.
   *
   * `level` undefined is the arrival case in a room the realm cannot place:
   * the phrase said it is dark and nothing says how dark, so the strongest
   * usable light is tried and the trace says it was a guess.
   */
  private provide(
    level: number | undefined,
    where: string,
    state: CharacterState,
    priority: 'movement' | 'probe'
  ): void {
    const sight = state.sight;
    const vision = sight?.vision ?? 0;
    const dim = this.config.lightDimRooms;
    const lights = carriedLights(state.inventory.items);
    let choice: LightChoice;
    if (level === undefined) {
      const usable = lights
        .filter((light) => !light.lit && lightIsUsable(light))
        .sort((a, b) => (b.reach ?? -1) - (a.reach ?? -1));
      choice = lights.some((light) => light.lit && lightIsUsable(light))
        ? { kind: 'lit' }
        : usable[0] === undefined
          ? { kind: 'none', reason: lights.length === 0 ? 'nothing carried' : 'nothing usable' }
          : { kind: 'ready', light: usable[0], guess: true };
    } else {
      if (!needsLightAt(level, vision, dim)) return;
      choice = chooseLight(level, vision, lights, dim);
    }

    if (choice.kind === 'lit' || choice.kind === 'unneeded') return;
    const key = `${where}|${level ?? '?'}|${choice.kind}|${
      choice.kind === 'ready' ? choice.light.name : choice.reason
    }`;
    if (choice.kind === 'none') {
      if (this.lastKey === key) return;
      this.lastKey = key;
      this.events.decided?.({
        at: this.now(),
        action: 'light',
        because: t('automation.light.becauseDark', { room: where }),
        acted: false,
        refused: refusalFor(choice.reason, lights)
      });
      return;
    }

    /*
     * The same answer, again, inside the window the proposal is good for.
     *
     * Only the refusal branch above deduplicated, so a dark room the client
     * could not *place* — where `arrivalLitIn` has no key to compare — asked
     * for the same torch on every status line, in the `movement` band, for as
     * long as the character stood there. That is `restUntil`'s 431 looks in
     * fourteen seconds in a feature that is on by default. Bounded by the
     * proposal's own life rather than by a room, so a light the server never
     * answered is still asked for again once the first ask has expired.
     */
    if (this.lastKey === key && this.now() - this.litAt < tuning().light.expiresMs) return;
    this.lastKey = key;
    const spent = lights.find((light) => light.lit && !lightIsUsable(light));
    const expiresAt = this.now() + tuning().light.expiresMs;
    if (spent !== undefined) {
      this.queue.enqueue({
        command: `remove ${spent.name}`,
        priority,
        coalesceKey: 'light:remove',
        expiresAt,
        reason: t('automation.light.reasonRemoveSpent', { item: spent.name })
      });
    }
    this.queue.enqueue({
      command: `light ${choice.light.name}`,
      priority,
      coalesceKey: 'light',
      expiresAt,
      reason: t('automation.light.reasonLight', { item: choice.light.name, room: where })
    });
    this.litAt = this.now();
    this.events.decided?.({
      at: this.now(),
      action: 'light',
      because: t('automation.light.becauseDark', { room: where }),
      acted: true,
      ...(choice.guess
        ? { refused: t('automation.light.guessedReach', { item: choice.light.name }) }
        : {})
    });
  }

  /**
   * A lit light in a room that does not need it, while nothing is walking.
   *
   * Only where the room is placed — a room the realm cannot place is one the
   * client cannot promise is lit — and never inside a beat of lighting one,
   * so the phrase has time to arrive before it is judged absent.
   */
  private extinguish(state: CharacterState, walking: boolean, here: string | null): void {
    if (!this.config.extinguishInLight || walking || here === null) return;
    if (this.extinguishedIn === here) return;
    if (this.now() - this.litAt < tuning().light.expiresMs) return;
    const sight = state.sight;
    if (sight === null || sight.lit === null) return;
    const level = state.room.lightLevel ?? 0;
    if (needsLightAt(level, sight.vision, this.config.lightDimRooms)) return;
    this.extinguishedIn = here;
    this.queue.enqueue({
      command: `remove ${sight.lit}`,
      priority: 'probe',
      coalesceKey: 'light:out',
      expiresAt: this.now() + tuning().light.expiresMs,
      reason: t('automation.light.reasonExtinguish', { item: sight.lit })
    });
    this.events.decided?.({
      at: this.now(),
      action: 'light',
      because: t('automation.light.becauseLit', { room: state.room.name ?? here }),
      acted: true
    });
  }
}

function roomKey(state: CharacterState): string | null {
  return state.room.map === null || state.room.number === null
    ? null
    : `${state.room.map}/${state.room.number}`;
}

function refusalFor(
  reason: 'nothing carried' | 'nothing usable' | 'nothing reaches',
  lights: readonly CarriedLight[]
): string {
  switch (reason) {
    case 'nothing carried':
      return t('automation.light.refusalNothingCarried');
    case 'nothing usable':
      return t('automation.light.refusalNothingUsable', {
        items: lights.map((light) => light.name).join(', ')
      });
    case 'nothing reaches':
      return t('automation.light.refusalNothingReaches', {
        items: lights
          .filter((light) => !light.lit && lightIsUsable(light))
          .map((light) => `${light.name} (${light.reach ?? '?'})`)
          .join(', ')
      });
  }
}
