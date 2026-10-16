import { t } from '../app/i18n';
import type { Block } from '../../shared/blocks';
import {
  fightIsRunning,
  standingOf,
  type Adventurer,
  type CharacterState
} from '../../shared/character';
import { occupantAttacksOnSight } from '../../shared/mobRules';
import type { SessionModule } from './Module';

/**
 * Whether pulling the plug would be charged, and why.
 *
 * The classic MegaMUD panic button is "hang up when health is low", and on this
 * server family a charged hangup can kill. It costs `PVPHangHPHit` percent of
 * *maximum* HP (`DeathManager.KilledByType.DisconnectPenalty` when that kills),
 * else random items (`Player.Disconnects`, `Player.cs:2975-3024`), and only
 * where the realm allows PvP. See docs/greatermud/combat.md.
 *
 * `ClearToHangWithoutPenalty` (`Player.cs:2905-2968`) charges for PvP alone, behind
 * `PenalizeHangInPlayerCombat` (`true`, `GMUDServer.cs:121`):
 *
 * | Condition | Visible? |
 * |---|---|
 * | Your target is a player, or a player here has you as target (not in a protected room or a Colliseum) | yes, once the roster says who is a player; a Colliseum, no |
 * | A player attacked you in the last 5 minutes, in any room | yes, same |
 * | You attacked a player in the last 5 minutes | yes, same |
 *
 * Its monster case is behind `PenalizeHangInMobCombat`, `false` at
 * `GMUDServer.cs:120` and assigned nowhere, so a monster never makes a hangup
 * charged (todo 131, reversing 2026-08-29). This is a reading of the server
 * source, not a capture; Paradigm is a fork, and the day the wire shows a
 * hangup charged with no player near, the wire wins. Whether staying is
 * dangerous is a separate question (`threatened`, `monsterNear`).
 */
/** The facts `assess` words, and `clean` only counts. */
interface HangUpFindings {
  /**
   * Who this character is fighting, or who is fighting it, here now, where
   * that may be a player: `sure` for a listed player, false for a name the
   * room does not list as a monster (unknown is never the reassuring answer).
   */
  pvpNow: { name: string; sure: boolean } | null;
  pvp: { name: string | null; minutes: number; clearInMs: number } | null;
}

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
 * How recently a monster must have swung for it to count as still fighting
 * the character: a hang-up beside it, a naked one, a rest or a blessing.
 *
 * `ShouldMobAttackTarget` is server-side state a client cannot read, so this
 * approximates it from the last blow. Deliberately generous: a rest or a
 * blessing held a few seconds too long costs less than one sent into a fight.
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

export class HangUpWatch implements SessionModule {
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

  /**
   * What would charge a hangup, unworded.
   *
   * One set of tests for both readers below: the guard field asks on every
   * status line and needs a boolean, the settings path asks on a click and
   * needs the sentences. Wording the reasons per line for a boolean was 4%
   * of the parse path (2026-09-11).
   */
  private findings(state: CharacterState, now: number): HangUpFindings {
    let pvp: HangUpFindings['pvp'] = null;
    if (this.lastPvpAt !== null) {
      const since = now - this.lastPvpAt;
      if (since < PVP_WINDOW_MS) {
        pvp = {
          name: this.lastPvpWith,
          minutes: Math.ceil((PVP_WINDOW_MS - since) / 60000),
          clearInMs: PVP_WINDOW_MS - since
        };
      }
    }
    return { pvpNow: playerFighting(state), pvp };
  }

  /**
   * Whether anything here could be what low health is a reason to hang up on
   * (todo 01): a fight running, a monster's blow inside `MOB_ENGAGED_MS`, or
   * something standing in the room that is not a player. In an empty room
   * nothing can hit the character, so a hang-up there only loses the session.
   * A passive monster counts, as a shopkeeper would. On a reconnect the room
   * arrives with the first look, and a monster walking in puts it here on the
   * next line. A capitalised stranger the client cannot place counts: it may
   * be a named monster.
   */
  monsterNear(state: CharacterState, now: number): boolean {
    return (
      this.monsterSwung(now) ||
      fightIsRunning(state) ||
      state.room.occupants.some((who) => who.kind !== 'player')
    );
  }

  /**
   * Whether something here would attack the character: a fight, a monster's
   * recent blow, a monster that attacks on sight or that the realm data
   * cannot place (unknown is never the reassuring answer), or a hangup the
   * realm would charge for. What a naked character's hang-up asks: whether
   * staying is dangerous, which a monster decides though it charges nothing.
   */
  threatened(state: CharacterState, now: number): boolean {
    if (state.inCombat || this.monsterSwung(now) || !this.clean(state, now)) return true;
    const standing = standingOf(state);
    return state.room.occupants.some(
      (who) => who.kind === 'mob' && occupantAttacksOnSight(who, standing) !== false
    );
  }

  /** A monster hit or swung at this character inside `MOB_ENGAGED_MS`. */
  monsterSwung(now: number): boolean {
    return this.lastMobBlowAt !== null && now - this.lastMobBlowAt < MOB_ENGAGED_MS;
  }

  /** Whether no reason to expect a charge was found. Never "safe". */
  clean(state: CharacterState, now: number): boolean {
    const found = this.findings(state, now);
    return found.pvpNow === null && found.pvp === null;
  }

  /** Every reason found that a hangup would be charged, in words, or none. */
  assess(state: CharacterState, now: number): HangUpAssessment {
    const found = this.findings(state, now);
    const reasons: string[] = [];
    if (found.pvpNow !== null) {
      reasons.push(
        found.pvpNow.sure
          ? t('automation.hangUp.reasonPvpNow', { name: found.pvpNow.name })
          : t('automation.hangUp.reasonPvpUnplaced', { name: found.pvpNow.name })
      );
    }
    if (found.pvp !== null) {
      reasons.push(
        found.pvp.name !== null
          ? t('automation.hangUp.reasonPvpNamed', {
              name: found.pvp.name,
              minutes: found.pvp.minutes
            })
          : t('automation.hangUp.reasonPvpUnnamed', { minutes: found.pvp.minutes })
      );
    }
    return { clean: reasons.length === 0, reasons, clearInMs: found.pvp?.clearInMs ?? null };
  }
}

/**
 * Who in the fight may be a player, by the name the fight holds, or null: a
 * listed player first, else a name the room does not list as a monster (an
 * `unknown` occupant, or one not listed at all). The server does not charge
 * for it in a protected room (`Room.safe`); a Colliseum is not in the realm
 * data, so it counts.
 */
function playerFighting(state: CharacterState): HangUpFindings['pvpNow'] {
  if (state.room.safe === true) return null;
  const kindOf = (name: string) =>
    state.room.occupants.find((who) => who.name.toLowerCase() === name.toLowerCase())?.kind;
  const fighting = [state.combat.target, ...state.combat.attackers].filter(
    (name): name is string => name !== null
  );
  const player = fighting.find((name) => kindOf(name) === 'player');
  if (player !== undefined) return { name: player, sure: true };
  const doubt = fighting.find((name) => kindOf(name) !== 'mob');
  return doubt === undefined ? null : { name: doubt, sure: false };
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
