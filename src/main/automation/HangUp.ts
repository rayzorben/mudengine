import { t } from '../app/i18n';
import type { Block } from '../../shared/blocks';
import { ownAlignment, type Adventurer, type CharacterState } from '../../shared/character';
import { attacksOnSight } from '../../shared/mobs';

/**
 * Whether pulling the plug would be safe, and why not.
 *
 * The classic MegaMUD panic button is "hang up when health is low", and on this
 * server family **that is one of the more reliable ways to die**. An unclean
 * disconnect costs a percentage of *maximum* HP — which at low health is fatal,
 * and is recorded as `DeathManager.KilledByType.DisconnectPenalty` — or drops
 * random items. See docs/greatermud/combat.md.
 *
 * Five conditions make a hangup unclean, and this tracks the four a client can
 * see:
 *
 * | Condition | Visible? |
 * |---|---|
 * | A player attacked you in the last 5 minutes | yes, once the roster says who is a player |
 * | You attacked a player in the last 5 minutes | yes, same |
 * | You are in combat | yes |
 * | A mob in the room is targeting you | approximately: it has hit or swung at you recently, or the realm data says it attacks on sight |
 * | The room is protected, or a Colliseum | **no** |
 *
 * The three server flags that gate the penalty at all — `AllowPvP`,
 * `PenalizeHangInPlayerCombat`, `PenalizeHangInMobCombat` — are also invisible.
 *
 * So this **cannot** report "safe"; it reports "no reason found not to". The
 * difference matters, and the default configuration acts on the cautious
 * reading: a hangup is refused while any reason stands.
 *
 * **This is a reading of the server source, not a capture.** Measuring it means
 * arranging to be attacked by a player and then disconnecting, on a realm where
 * the cost of being wrong is a character. Where the reading and the wire
 * disagree the wire wins — but nobody has asked the wire, so the safe direction
 * is the only one worth acting on.
 */
export interface HangUpAssessment {
  /** True when no reason to expect a penalty was found. Never "safe". */
  clean: boolean;
  /** Each reason, in the words a person would use. */
  reasons: string[];
  /** Milliseconds until the PvP window lapses, or null if nothing is waiting. */
  clearInMs: number | null;
}

/**
 * The PvP window, from `ClearToHangWithoutPenalty`: five minutes since the last
 * blow either way.
 *
 * The number is the server's, so it is named rather than tuned. It is the part
 * of this nothing on screen shows — combat has ended, the room is empty, and a
 * hangup is still penalised.
 */
export const PVP_WINDOW_MS = 5 * 60 * 1000;

/**
 * How recently a mob must have swung for it to count as targeting you.
 *
 * `ShouldMobAttackTarget` is server-side state a client cannot read, so this
 * approximates it from the last blow. Deliberately generous: over-reporting a
 * reason costs a refused hangup, and under-reporting it costs a character.
 */
export const MOB_ENGAGED_MS = 12 * 1000;

export interface HangUpEvents {
  /**
   * A player opened on, or landed a blow on, *this* character — the moment
   * the five-minute window starts from the victim's side. Deliberately not
   * fired when this character is the aggressor: the reaction this feeds is
   * "tell the gang I am being attacked", and a character's own attack is not
   * that. The attacker is always named, because the roster is what made them
   * a player at all — an unvouched name never fires this, per the rule that
   * `players` counts occupants *known* from the roster. Fired once per
   * evidencing line; whoever reacts rate-limits.
   */
  pvpBlow?(attacker: string, at: number): void;
}

export class HangUpWatch {
  /** Last time a player hit this character, or this character hit a player. */
  private lastPvpAt: number | null = null;
  /** Last time a mob hit or swung at this character. */
  private lastMobBlowAt: number | null = null;
  /** Who, for the reason line. */
  private lastPvpWith: string | null = null;

  constructor(private readonly events: HangUpEvents = {}) {}

  /** A new connection is a new character-in-the-realm; nothing carries over. */
  reset(): void {
    this.lastPvpAt = null;
    this.lastMobBlowAt = null;
    this.lastPvpWith = null;
  }

  /**
   * Reads one block for evidence.
   *
   * `roster` decides whether a name is a *player*, which is the whole
   * difference between "a monster hit me" and "the five-minute PvP window just
   * started". Somebody not in the roster is treated as a mob: the roster is
   * seeded by a `who` listing and maintained by arrival broadcasts, so a name
   * missing from it is usually a monster — and the alternative, treating every
   * unknown name as a player, would keep the window permanently open and make
   * a clean hangup unreachable.
   */
  observe(block: Block, roster: readonly Adventurer[]): void {
    const isPlayer = (name: string | undefined): boolean =>
      name !== undefined && roster.some((entry) => entry.name.toLowerCase() === name.toLowerCase());

    switch (block.type) {
      // `The <mob> ... you` — the article is what distinguishes a monster's
      // blow from a player's in this server's phrasing.
      case 'mob-hits':
      case 'mob-misses':
        this.lastMobBlowAt = block.at;
        return;

      /*
       * `<Name> moves to attack you!` — the round *before* the first blow.
       * The window opens on the attack, not on the damage: the server's own
       * test is who is targeting whom.
       */
      case 'player-attacks':
      case 'user-hits': {
        const attacker = block.groups['attacker'];
        const target = block.groups['target'];
        // Somebody hit *this* character. A player doing it starts the window.
        if (target !== undefined && /^you$/i.test(target)) {
          if (attacker !== undefined && isPlayer(attacker)) {
            this.lastPvpAt = block.at;
            this.lastPvpWith = attacker;
            this.events.pvpBlow?.(attacker, block.at);
          } else {
            this.lastMobBlowAt = block.at;
          }
          return;
        }
        // This character hit somebody. Hitting a player starts it too — the
        // server penalises the aggressor exactly as it penalises the victim.
        if (isPlayer(target)) {
          this.lastPvpAt = block.at;
          this.lastPvpWith = target ?? null;
        }
        return;
      }

      default:
        return;
    }
  }

  /** Every reason found not to hang up, or none. */
  assess(state: CharacterState, now: number): HangUpAssessment {
    const reasons: string[] = [];
    let clearInMs: number | null = null;

    if (state.inCombat) reasons.push(t('automation.hangUp.reasonInCombat'));

    if (this.lastMobBlowAt !== null && now - this.lastMobBlowAt < MOB_ENGAGED_MS) {
      reasons.push(t('automation.hangUp.reasonMobEngaged'));
    }

    /*
     * `ShouldMobAttackTarget` is set the moment a monster decides to attack, a
     * full round before its first swing — and the server's test is who is
     * targeting whom, not who has landed a blow. So the blow above misses
     * exactly the window in which a hangup looks safe and is not: the monster
     * has just walked in. The realm data names which monsters decide that on
     * sight, and `attacksOnSight` is the same reading AutoCombat acts on; here
     * it only ever adds a reason. A monster the data cannot place is a reason
     * too — unknown is never the reassuring answer — worded as the doubt it
     * is, so the refusal says what it does and does not know.
     */
    const mine = ownAlignment(state);
    const onSight: string[] = [];
    const unplaced: string[] = [];
    for (const who of state.room.occupants) {
      if (who.kind !== 'mob') continue;
      const verdict = attacksOnSight(who.disposition, mine);
      if (verdict === true && !onSight.includes(who.name)) onSight.push(who.name);
      else if (verdict === null && !unplaced.includes(who.name)) unplaced.push(who.name);
    }
    if (onSight.length > 0) {
      reasons.push(t('automation.hangUp.reasonMobOnSight', { names: onSight.join(', ') }));
    }
    if (unplaced.length > 0) {
      reasons.push(t('automation.hangUp.reasonMobUnplaced', { names: unplaced.join(', ') }));
    }

    if (this.lastPvpAt !== null) {
      const since = now - this.lastPvpAt;
      if (since < PVP_WINDOW_MS) {
        const minutes = Math.ceil((PVP_WINDOW_MS - since) / 60000);
        reasons.push(
          this.lastPvpWith !== null
            ? t('automation.hangUp.reasonPvpNamed', { name: this.lastPvpWith, minutes })
            : t('automation.hangUp.reasonPvpUnnamed', { minutes })
        );
        clearInMs = PVP_WINDOW_MS - since;
      }
    }

    return { clean: reasons.length === 0, reasons, clearInMs };
  }
}

/**
 * Occupants of the room who are known to be players.
 *
 * Known, not guessed — but the knowing now happens where the room is parsed
 * rather than here. `RoomOccupant.kind` is settled by the realm roster, by the
 * annotations the listing hangs off a player's name (`*`, `(Hidden)`) and by
 * the realm's monster table, in that order; a capitalised stranger nothing has
 * placed stays `unknown` and is **not** counted. So this still under-reports
 * rather than crying wolf, and it no longer misses somebody the server itself
 * marked as attackable.
 */
export function playersHere(state: CharacterState): string[] {
  return state.room.occupants.filter((who) => who.kind === 'player').map((who) => who.name);
}
