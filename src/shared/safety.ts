/**
 * The escapes: hanging up, running, the realm's teleport, and what to do when a
 * player opens on this character (`automation.safety`). Carved out of
 * `config.ts` whole (todo 118); the reasoning is in `mudengine-automation` ›
 * `parts/safety.md`.
 */
import { bool, fraction, int, isRecord, oneOf, str } from './values';

/**
 * Hanging up to save a character, and why it is not the simple option.
 *
 * Every MegaMUD-era client offers "disconnect when health is low". On this
 * server family that is one of the more reliable ways to *die*: an unclean
 * disconnect costs a percentage of **maximum** HP — fatal at low health, and
 * recorded as `DisconnectPenalty` — or drops random items. Five conditions make
 * it unclean, and they are precisely the ones that co-occur with wanting to
 * press the button. See docs/greatermud/combat.md.
 *
 * So this exists, and it defaults to refusing. Walking out is the escape that
 * works; hanging up is the escape that works *afterwards*.
 */
export interface HangUpConfig {
  /** Off unless somebody asks for it, and it says what it will and will not do. */
  enabled: boolean;
  /** Fraction of maximum health below which hanging up is considered. */
  belowHealth: number;
  /**
   * Whether this realm charges for a hang-up at all (todo 01).
   *
   * Where it does, hanging up is refused while the client can see a reason it
   * would be charged; where it does not, it hangs up below `belowHealth`.
   * **Off by default**: a PvE realm charges nothing. Paradigm's realm menu
   * states it (`Hang Penalties 25%`), and what it said outranks this; a
   * realm's own `server.yaml` (`hangPenalties`) outranks the options file,
   * and a character's own file outranks its realm.
   */
  penalties: boolean;
  /**
   * Also hang up when a player is in the room, at any health.
   *
   * Off by default. It is the PvP panic button, and it is also the one most
   * likely to fire during the five-minute window, which is where a realm's
   * penalty bites.
   */
  onPlayerInRoom: boolean;
  /**
   * Hang up naked after a death while the player is away, Auto-Hangup off
   * included (MegaMUD's `HangupNaked`, todo 79): its own switch, so turning
   * Auto-Hangup off is not mistaken for turning this off (todo 118).
   */
  whenNaked: boolean;
  /** Share of maximum health a naked hang-up keeps above a charged realm's penalty. */
  nakedMargin: number;
  /**
   * How long a hang-up waits for a run on the wire to land, so the character
   * logs back in away from what it ran from (todo 118).
   */
  afterRunSeconds: number;
}

/**
 * Running away, which is the escape that actually works.
 *
 * **It walks. There is no command for running away** — see `NOT_COMMANDS` in
 * `src/shared/commands.ts` for the eleven refusals that settled that — so
 * every escape this client makes is a **direction**, chosen from what it knows
 * about the room it is standing in, and it is never sent unless there is one.
 * Moving out carries none of the penalty an unclean disconnect does, which is
 * why `HangUpConfig` tells you to do this instead.
 *
 * Off by default like everything automated: a client that starts running away
 * on its own the first time somebody opens it is a client that decides when a
 * fight is lost, and that is the player's call until they say otherwise.
 */
export interface RetreatConfig {
  enabled: boolean;
  /** Fraction of maximum health below which the character runs. */
  belowHealth: number;
  /**
   * Also run below this fraction of maximum mana — MegaMUD's `ManaRun%`. A
   * caster out of mana is losing whatever the health bar says: its next round
   * lands nothing, and the round after that is the monster's. 0 (MegaMUD's own
   * default) never runs for mana; a class with no pool has a null maximum and
   * is never judged by it, as everywhere.
   */
  belowMana: number;
  /**
   * Also run when this many things are hitting it at once.
   *
   * Zero disables it. Being fought by three things is the situation a health
   * threshold notices too late — by the time the bar is low the next round has
   * already been rolled.
   */
  whenOutnumbered: number;
  /**
   * The shortest gap between attempts.
   *
   * An escape can fail — the exit is blocked, the move is refused — and
   * retrying every status line would fill the queue with them. This is a floor
   * on retrying, not a rate limit: the emergency band is not paced.
   */
  cooldownMs: number;
  /**
   * How far to go, **not** how to choose the exit.
   *
   * Choosing the exit is `Travel.escape`'s ladder and is not
   * configurable, because every rung of it is strictly better than the one
   * below and nobody would knowingly pick a worse one: retrace the trail
   * first, then an exit the realm data says leads back onto it, then any exit
   * the realm can place, then any exit the server just printed. Only the last
   * rung is a room the character has never seen, and all four beat standing
   * still.
   *
   * `step-back` is that one move and then nothing more. `safe-haven` takes the
   * same move and then, once the fight is over and the character is placed,
   * plans a route to `safeHavenRoom` — the walker refuses to walk into a
   * fight, so a route can never be the escape itself.
   */
  strategy: RetreatStrategy;
  /**
   * Where `safe-haven` runs to, as a loop stop names a room: `Newhaven, Town
   * Gates 1/2150`. A bare name shared by several rooms is refused, with the
   * candidates, exactly as a loop stop is. Empty is none.
   */
  safeHavenRoom: string;
}

/**
 * The last-ditch escape below `retreat` (todo 813): the realm's own teleport,
 * sent mid-fight in the emergency band, written out **literally** because each
 * realm implementation spells it differently — GreaterMUD `sys go 1 297`,
 * MajorMUD `sys goto silvermere` — and it is never derived. The realm's
 * `server.yaml` (`fleeGoto:`) states the command; a character's own `command`
 * replaces it, and this file's is used only where neither states one.
 *
 * Off by default. On GreaterMUD `sys` is a sysop's tool (`SysCommand.cs:196`);
 * a player is answered `Your command had no effect.`, read as a refusal.
 * Never above `retreat.belowHealth` while the retreat is on: the walked escape
 * has the first word. See `FleeGoto`.
 */
export interface FleeGotoConfig {
  enabled: boolean;
  /** Fraction of maximum health at or below which the teleport is sent. */
  belowHealth: number;
  /** The literal command; empty follows the realm, and none anywhere sends nothing. */
  command: string;
}

/**
 * Two, where there were three.
 *
 * The third was `flee`, and it did not describe a way out — it described
 * sending the word `flee` and letting the realm pick the exit, which the realm
 * never did because the word is not a command. `reverse-step` was the same
 * thing with one attempt in front of it, and its documented fallback was that
 * word again. Both are gone: what is left is *one move* against *one move and
 * then walk home*, which is the only axis a person was ever choosing on.
 */
export const RETREAT_STRATEGIES = ['step-back', 'safe-haven'] as const;
export type RetreatStrategy = (typeof RETREAT_STRATEGIES)[number];

export interface SafetyConfig {
  hangUp: HangUpConfig;
  retreat: RetreatConfig;
  fleeGoto: FleeGotoConfig;
  pvp: PvpConfig;
}

/** What a PvP reaction may do about the fight itself. */
export const PVP_ACTIONS = ['none', 'retreat', 'retreat-then-hangup'] as const;

export type PvpAction = (typeof PVP_ACTIONS)[number];

/**
 * What to do the moment a player opens on this character — MegaMUD's
 * NotifyGang, on the wire this client has already read: `<Name> moves to
 * attack you!` and a player's blow both put the attacker in
 * `combat.attackers` and start `HangUpWatch`'s five-minute clock, and this is
 * the reaction to that same evidence.
 *
 * Both halves off, like everything automated — and this one reaches other
 * people twice over: the broadcast speaks to the whole gang, and a retreat is
 * the client deciding a fight is lost.
 */
export interface PvpConfig {
  /**
   * Say so on the gangpath — `bg`, the realm's own verb — once per attacker
   * per five-minute window: the room and the health ride along, because the
   * gang deciding whether to come needs where and how bad.
   */
  notifyGang: boolean;
  /**
   * `retreat` runs when the attack is seen, whatever `retreat.enabled` says;
   * `retreat-then-hangup` (MegaMUD's Flee Then Hangup) hangs up once it no
   * longer counts, under the realm's penalty (`Safety`). `none` does neither.
   */
  action: PvpAction;
}

export const DEFAULT_SAFETY: SafetyConfig = {
  // Off, and refusing when on. See `HangUpConfig`: the panic button every
  // MegaMUD-era client offers is, here, a way to die.
  hangUp: {
    enabled: false,
    belowHealth: 0.15,
    penalties: false,
    onPlayerInRoom: false,
    whenNaked: true,
    nakedMargin: 0.1,
    afterRunSeconds: 3
  },
  retreat: {
    enabled: false,
    belowHealth: 0.3,
    belowMana: 0,
    whenOutnumbered: 0,
    cooldownMs: 3000,
    strategy: 'step-back',
    safeHavenRoom: ''
  },
  // Off, and between the retreat's floor and the hang-up's, so the
  // teleport has its turn before the panic button. See `FleeGotoConfig`.
  fleeGoto: { enabled: false, belowHealth: 0.2, command: '' },
  pvp: { notifyGang: false, action: 'none' }
};

/** The hang-up's whole-number bounds, for the file and the settings screen. */
export const HANG_UP_RANGES = {
  afterRunSeconds: [0, 60]
} as const satisfies Partial<Record<keyof HangUpConfig, readonly [number, number]>>;

export function normalizeSafety(value: unknown): SafetyConfig {
  const raw = isRecord(value) ? value : {};
  const hangUp = isRecord(raw['hangUp']) ? raw['hangUp'] : {};
  const retreat = isRecord(raw['retreat']) ? raw['retreat'] : {};
  const pvp = isRecord(raw['pvp']) ? raw['pvp'] : {};
  const fleeGoto = isRecord(raw['fleeGoto']) ? raw['fleeGoto'] : {};
  const f = DEFAULT_SAFETY.retreat;
  const g = DEFAULT_SAFETY.fleeGoto;
  const d = DEFAULT_SAFETY.hangUp;
  const p = DEFAULT_SAFETY.pvp;
  return {
    retreat: {
      enabled: bool(retreat['enabled'], f.enabled),
      belowHealth: fraction(retreat['belowHealth'], f.belowHealth),
      belowMana: fraction(retreat['belowMana'], f.belowMana),
      // Zero is meaningful: never run merely because there are several.
      whenOutnumbered: int(retreat['whenOutnumbered'], f.whenOutnumbered, 0, 20),
      // Floored at a second. Anything shorter retries before the server has
      // had a chance to answer the first attempt.
      cooldownMs: int(retreat['cooldownMs'], f.cooldownMs, 1000, 60_000),
      strategy: oneOf<RetreatStrategy>(retreat['strategy'], RETREAT_STRATEGIES, f.strategy),
      safeHavenRoom: str(retreat['safeHavenRoom'], f.safeHavenRoom).trim()
    },
    fleeGoto: {
      enabled: bool(fleeGoto['enabled'], g.enabled),
      belowHealth: fraction(fleeGoto['belowHealth'], g.belowHealth),
      command: str(fleeGoto['command'], g.command).trim()
    },
    hangUp: {
      enabled: bool(hangUp['enabled'], d.enabled),
      belowHealth: fraction(hangUp['belowHealth'], d.belowHealth),
      penalties: bool(hangUp['penalties'], d.penalties),
      onPlayerInRoom: bool(hangUp['onPlayerInRoom'], d.onPlayerInRoom),
      whenNaked: bool(hangUp['whenNaked'], d.whenNaked),
      nakedMargin: fraction(hangUp['nakedMargin'], d.nakedMargin),
      afterRunSeconds: int(
        hangUp['afterRunSeconds'],
        d.afterRunSeconds,
        ...HANG_UP_RANGES.afterRunSeconds
      )
    },
    pvp: {
      notifyGang: bool(pvp['notifyGang'], p.notifyGang),
      action: oneOf<PvpAction>(pvp['action'], PVP_ACTIONS, p.action)
    }
  };
}
