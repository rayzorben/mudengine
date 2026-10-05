/**
 * The session's safety decisions that are not a direction: hanging up below
 * a health floor, which on this server family is how a character dies rather
 * than how it escapes, and telling the gang a player opened on it. It reads
 * what the realm menu said a hang-up costs, what `HangUpWatch` has seen and
 * the settings, says every refusal once, and hangs up through the session's
 * own disconnect. Running away is `Travel`'s, the PvP retreat included. See
 * `mudengine-automation` › `parts/safety.md` › *Hanging up is how you die,
 * not how you escape*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import {
  PVP_WINDOW_MS,
  playersHere,
  type HangUpAssessment,
  type HangUpWatch
} from '../automation/HangUp';
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import type { TelnetClient } from '../net/TelnetClient';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { Grounded } from './Grounded';
import type { Publisher } from './Publisher';
import type { RealmMenu } from './RealmMenu';
import type { Travel } from './Travel';
import { healthFraction, percentText } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { stanceHere } from '../../shared/mobRules';
import type { ConnectionEnd } from '../../shared/types';

/** What the two decisions read, and the one escape they hand on. */
export interface SafetyParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly hangUp: Pick<HangUpWatch, 'assess' | 'clean' | 'monsterNear'>;
  readonly realmMenu: Pick<RealmMenu, 'penalty' | 'noteCommand'>;
  readonly queue: Pick<CommandQueue, 'enqueue'>;
  readonly travel: Pick<Travel, 'runFromPlayer' | 'escapeUnanswered' | 'landings'>;
  readonly client: Pick<TelnetClient, 'connected'>;
  readonly publisher: Pick<Publisher, 'state' | 'noteSafety'>;
  /** The ground: a player's blows reach this ahead of the session's gate. */
  readonly grounded: Pick<Grounded, 'down'>;
}

/** What the session that built this answers for it. */
export interface SafetySession {
  /** The automation settings as last loaded. */
  config(): AutomationConfig;
  /** Hang up, and record who asked. See `SessionManager.disconnect`. */
  disconnect(by: ConnectionEnd): void;
  notice(message: string): void;
}

export class Safety implements SessionModule {
  private readonly tracker: SafetyParts['tracker'];
  private readonly hangUp: SafetyParts['hangUp'];
  private readonly realmMenu: SafetyParts['realmMenu'];
  private readonly queue: SafetyParts['queue'];
  private readonly travel: SafetyParts['travel'];
  private readonly client: SafetyParts['client'];
  private readonly publisher: SafetyParts['publisher'];
  private readonly grounded: SafetyParts['grounded'];
  /**
   * Gang alerts already sent, by attacker, so a fight producing a blow line
   * per round is one broadcast per attacker per five-minute window — the
   * server's own window, because that is the clock the alert is about.
   */
  private readonly pvpSaid = new Map<string, number>();
  /** The last refusal reported, so it is said once rather than per status line. */
  private lastHangUpRefusal: string | null = null;
  /**
   * A run the hang-up waits on: when the wait began, and how many runs had
   * landed then, so its answer reads as landed or failed. Null while none waits.
   */
  private runWaited: { readonly since: number; readonly landings: number } | null = null;
  /**
   * The run the hang-up waited on got out, with the health it landed at: the
   * hang-up stays off while nothing attacks and health holds. Null otherwise.
   */
  private gotOut: { readonly hp: number; said: boolean } | null = null;
  /**
   * The monster a `hangup` row names that the switch left standing in the
   * room, by key, so the refusal is said once while it stays (818).
   */
  private stalkerSaid: string | null = null;
  /**
   * Why low health with no monster here did not hang up, as last said, so it
   * is said once a stretch and again when the room is first seen (todo 01).
   */
  private nothingHereSaid: string | null = null;

  constructor(
    parts: SafetyParts,
    private readonly session: SafetySession
  ) {
    this.tracker = parts.tracker;
    this.hangUp = parts.hangUp;
    this.realmMenu = parts.realmMenu;
    this.queue = parts.queue;
    this.travel = parts.travel;
    this.client = parts.client;
    this.publisher = parts.publisher;
    this.grounded = parts.grounded;
  }

  private get automationConfig(): AutomationConfig {
    return this.session.config();
  }

  /** On connect and on leaving the realm: what was said was said to the character that was. */
  reset(): void {
    this.pvpSaid.clear();
    this.lastHangUpRefusal = null;
    this.stalkerSaid = null;
    this.runWaited = null;
    this.gotOut = null;
    this.nothingHereSaid = null;
  }

  /**
   * A player opened on this character — MegaMUD's NotifyGang moment, from the
   * evidence the client already reads: `<Name> moves to attack you!` and a
   * player's blow both put the attacker in `attackers` and start the
   * five-minute clock, and `HangUpWatch.observe` is the one place that
   * discriminates a player's blow from a monster's, so it is the one place
   * this is fired from.
   *
   * Both halves are off by default and both are said out loud when they act.
   * The broadcast rides the `combat` band — urgent, and still under the
   * escape: a message must never go out ahead of the way out. The retreat is
   * the pvp block's *own* trigger, whatever `retreat.enabled` says — a PvP
   * opener is not a health threshold — through the same emergency band,
   * coalesced with any other escape, under the same cooldown so a blow per
   * round is one move.
   */
  onPvpBlow(attacker: string, at: number): void {
    const pvp = this.automationConfig.safety.pvp;
    if (!this.automationConfig.enabled) return;
    const state = this.tracker.current;
    if (state.phase !== 'in-game') return;

    if (pvp.notifyGang) {
      const key = attacker.toLowerCase();
      const said = this.pvpSaid.get(key);
      if (said === undefined || at - said >= PVP_WINDOW_MS) {
        this.pvpSaid.set(key, at);
        /*
         * Off a gang, `bg` has nobody to reach: the server refuses and a
         * record claiming the gang was told would be a claimed action that
         * did not happen. The roster carries this character's own gang on its
         * own `who` row; a row positively showing none is a refusal said out
         * loud and written down. **Unknown still sends** — no row, or a row
         * with nothing read yet, is nobody having said, and withholding a
         * safety broadcast on an unread fact costs more than one refused
         * command.
         */
        const own = state.name
          ? state.online.find((entry) => entry.name.toLowerCase() === state.name?.toLowerCase())
          : undefined;
        if (own !== undefined && (own.gang === null || own.gang.length === 0)) {
          this.session.notice(t('session.safety.pvpNoGang', { attacker }));
          this.publisher.noteSafety({
            at,
            action: 'pvp-alert',
            because: t('session.safety.whyPvp', { attacker }),
            acted: false,
            refused: t('session.safety.pvpNoGangReason')
          });
        } else {
          // Realm-facing words, composed here rather than in the dictionary:
          // this is a line spoken to the gang over the wire, not chrome copy.
          const parts = [`attacked by ${attacker}`];
          if (state.room.name) parts.push(`at ${state.room.name}`);
          const { hp, hpMax } = state.vitals;
          if (hp !== null) parts.push(hpMax !== null ? `[HP=${hp}/${hpMax}]` : `[HP=${hp}]`);
          this.session.notice(t('session.safety.pvpAlerted', { attacker }));
          this.publisher.noteSafety({
            at,
            action: 'pvp-alert',
            because: t('session.safety.whyPvp', { attacker }),
            acted: true
          });
          this.queue.enqueue({
            command: `bg ${parts.join(' ')}`,
            priority: 'combat',
            coalesceKey: 'pvp-gang-alert',
            reason: t('session.safety.pvpAlertReason', { attacker })
          });
        }
      }
    }

    /*
     * Not from the ground (todo 760): a player finishing a kill goes on
     * hitting, and every step is refused (`MoveCommand`) — todo 20's
     * *Retreating … at -8%* by the PvP door. The gang alert above still goes:
     * `bg` is answered there, and it is how help is called.
     */
    if (pvp.action === 'retreat' && !this.grounded.down) this.travel.runFromPlayer(state, attacker);
  }

  /** A command answering the realm menu: what it said the realm chosen charges, said once. */
  noteRealmChoice(command: string): void {
    const chosen = this.realmMenu.noteCommand(command);
    if (chosen === null) return;
    this.session.notice(
      chosen.percent > 0
        ? t('session.safety.realmCharges', { realm: chosen.realm, percent: chosen.percent })
        : t('session.safety.realmChargesNothing', { realm: chosen.realm })
    );
  }

  /**
   * The panic button, and why it mostly refuses to be pressed.
   *
   * Every MegaMUD-era client offers "disconnect when health is low". On this
   * server family an unclean disconnect costs a percentage of **maximum** HP —
   * fatal at low health, and recorded as `DisconnectPenalty` — or drops random
   * items, and the five conditions that make it unclean are precisely the ones
   * that co-occur with wanting to press it. See docs/greatermud/combat.md.
   *
   * So the default is off, and switched on the default is to refuse while the
   * client can see a reason. Refusing is *said out loud* rather than done
   * quietly: somebody who turned this on is relying on it, and a safety feature
   * that silently declines is worse than one that was never offered.
   */
  considerHangingUp(state: CharacterState): void {
    // The run's answer is read before anything returns early.
    this.settleTheRun(state);
    const safety = this.automationConfig.safety.hangUp;
    if (!this.mayAct(state)) return;
    /*
     * A monster whose row says to hang up on it (todo 818, MegaMUD's
     * *Hangup*) is a reason of its own, under the same switch and the same
     * penalty as the others. The switch off is said, once while it stands
     * here: the fork disconnected whatever the switch said.
     */
    const stalker = stanceHere(
      state.room.occupants,
      this.automationConfig.combat.mobRules,
      'hangup'
    );
    if (!safety.enabled) {
      this.sayStalkerRefused(stalker);
      return;
    }

    const fraction = healthFraction(state);
    const hurt = fraction !== null && this.belowTheLine(fraction);
    const company = safety.onPlayerInRoom && playersHere(state).length > 0;
    if (!hurt && !company && stalker === null) {
      this.gotOut = null;
      this.nothingHereSaid = null;
      return;
    }

    const why = hurt
      ? t('session.safety.whyHealth', { percent: percentText(fraction) })
      : company || stalker === null
        ? t('session.safety.whyCompany')
        : t('session.safety.whyStalker', { mob: stalker });
    // Health alone is a reason only beside a monster or in a fight (todo 01).
    if (hurt && !company && stalker === null && this.nothingHere(state, why)) return;
    this.nothingHereSaid = null;
    if (this.waitForTheRun(why)) return;
    // Health alone: a player or a `hangup` row is a reason the run did not answer.
    if (!company && stalker === null && this.theRunGotOut(state, why)) return;
    const refusal = this.refusedHere(state);
    if (refusal !== null) {
      // Once per reason-set, not once per status line: at low health this runs
      // several times a second and a repeated warning is a warning nobody reads.
      const key = refusal.reasons.join('|');
      if (key !== this.lastHangUpRefusal) {
        this.lastHangUpRefusal = key;
        this.session.notice(
          t('session.safety.hangUpRefused', { why, reasons: refusal.reasons.join('; ') })
        );
        this.publisher.noteSafety({
          at: Date.now(),
          action: 'hang up',
          because: why,
          acted: false,
          refused: refusal.reasons.join('; ')
        });
      }
      return;
    }

    this.lastHangUpRefusal = null;
    const menu = this.realmMenu.penalty;
    this.session.notice(
      this.penalised
        ? t('session.safety.hangingUpClean', { why })
        : menu !== null
          ? t('session.safety.hangingUpUncharged', { why, realm: menu.realm })
          : t('session.safety.hangingUpUnchargedSetting', { why })
    );
    this.publisher.noteSafety({ at: Date.now(), action: 'hang up', because: why, acted: true });
    // Through the same path the player's own disconnect takes, so the phase,
    // the walker, the queue and the roster are all torn down identically —
    // said as the *client's* doing, because nobody pressed anything.
    this.session.disconnect('client');
  }

  /**
   * Whether the hang-up waits for a run on the wire to land, at most
   * `hangUpAfterRunMs`. The run goes first and the hang-up decides on its
   * answer (`settleTheRun`): festus ran `ne` and hung up in the same
   * millisecond at 29%, with no chance to see whether the run got him out.
   */
  private waitForTheRun(why: string): boolean {
    if (!this.travel.escapeUnanswered) return false;
    const now = Date.now();
    if (this.runWaited === null) {
      this.runWaited = { since: now, landings: this.travel.landings };
      const refused = t('session.safety.hangUpAfterRun', { why });
      this.session.notice(refused);
      this.publisher.noteSafety({
        at: now,
        action: 'hang up',
        because: why,
        acted: false,
        refused
      });
    }
    return now - this.runWaited.since < tuning().session.hangUpAfterRunMs;
  }

  /**
   * The answer to the run the hang-up waited on, once it has come: landed
   * keeps the health it landed at (`gotOut`); a refusal or no answer leaves
   * the hang-up to go. An unknown health is never a run that got out.
   */
  private settleTheRun(state: CharacterState): void {
    const waited = this.runWaited;
    if (waited === null || this.travel.escapeUnanswered) return;
    this.runWaited = null;
    const hp = state.vitals.hp;
    this.gotOut =
      this.travel.landings > waited.landings && hp !== null ? { hp, said: false } : null;
  }

  /**
   * Whether the hang-up stays off because the run it waited on got out:
   * nothing attacks where it landed and health has not fallen since. Said
   * once. Attacked there, or hurt again, the run did not get away, and the
   * hang-up goes.
   */
  private theRunGotOut(state: CharacterState, why: string): boolean {
    const out = this.gotOut;
    if (out === null) return false;
    if (!caughtAfter(out.hp, state)) {
      if (!out.said) {
        out.said = true;
        this.sayNotHangingUp(why, t('session.safety.hangUpRunGotOut'));
      }
      return true;
    }
    this.gotOut = null;
    this.session.notice(t('session.safety.hangUpRunCaught', { why }));
    return false;
  }

  /**
   * The run the hang-up waited on got out and is caught again (attacked, or
   * hurt since it landed), and the hang-up would go now, or it has gone: a
   * second run does not go on the same line (`Travel.considerEscape`).
   */
  takesOver(state: CharacterState): boolean {
    // Hung up: nothing runs on the lines still arriving while the link closes.
    if (this.publisher.state.phase === 'closing') return true;
    const out = this.gotOut;
    if (out === null || !caughtAfter(out.hp, state)) return false;
    if (!this.mayAct(state) || !this.automationConfig.safety.hangUp.enabled) return false;
    const fraction = healthFraction(state);
    if (fraction === null || !this.belowTheLine(fraction)) return false;
    return this.refusedHere(state) === null;
  }

  /**
   * Why a hang-up here is refused, or null where it goes: refused only in a
   * charged realm while `HangUpWatch` sees a reason it would be charged.
   */
  private refusedHere(state: CharacterState): HangUpAssessment | null {
    if (!this.penalised) return null;
    const assessment = this.hangUp.assess(state, Date.now());
    return assessment.clean ? null : assessment;
  }

  /** Automation on, in the realm, and not already closing. */
  private mayAct(state: CharacterState): boolean {
    if (!this.automationConfig.enabled) return false;
    if (state.phase !== 'in-game' || !this.client.connected) return false;
    // Once: the lines already in the socket still arrive while it closes, and
    // each would hang up, and say so, again.
    return this.publisher.state.phase !== 'closing';
  }

  /** A share of health at or below the hang-up line. */
  private belowTheLine(fraction: number): boolean {
    return fraction <= this.automationConfig.safety.hangUp.belowHealth;
  }

  /** Whether a hang-up here is charged: the realm's own menu outranks every setting (`RealmMenu`). */
  private get penalised(): boolean {
    const menu = this.realmMenu.penalty;
    return menu !== null ? menu.percent > 0 : this.automationConfig.safety.hangUp.penalties;
  }

  /**
   * Whether low health stays put because nothing here could hit the
   * character: said once a stretch, and again once a room not yet seen since
   * connecting turns out empty.
   */
  private nothingHere(state: CharacterState, why: string): boolean {
    if (this.hangUp.monsterNear(state, Date.now())) return false;
    const refused =
      state.room.resolvedBy === 'remembered'
        ? t('session.safety.hangUpRoomUnseen')
        : t('session.safety.hangUpNoMonster');
    if (refused !== this.nothingHereSaid) {
      this.nothingHereSaid = refused;
      this.sayNotHangingUp(why, refused);
    }
    return true;
  }

  /** A hang-up that stays off for a reason that is not a charge: said and traced. */
  private sayNotHangingUp(why: string, refused: string): void {
    this.session.notice(t('session.safety.hangUpNotBut', { why, refused }));
    this.publisher.noteSafety({
      at: Date.now(),
      action: 'hang up',
      because: why,
      acted: false,
      refused
    });
  }

  /**
   * A `hangup` row's monster standing here with the switch off: said and
   * recorded once while it stays, and forgotten when it goes.
   */
  private sayStalkerRefused(stalker: string | null): void {
    const key = stalker === null ? null : stalker.toLowerCase();
    if (key === this.stalkerSaid) return;
    this.stalkerSaid = key;
    if (stalker === null) return;
    const why = t('session.safety.whyStalker', { mob: stalker });
    const reason = t('session.safety.hangUpOffReason');
    this.session.notice(t('session.safety.hangUpSwitchedOff', { why, reason }));
    this.publisher.noteSafety({
      at: Date.now(),
      action: 'hang up',
      because: why,
      acted: false,
      refused: reason
    });
  }
}

/** Attacked where the run landed, or hurt since: the run did not get away. */
function caughtAfter(landedHp: number, state: CharacterState): boolean {
  const hp = state.vitals.hp;
  return state.combat.attackers.length > 0 || hp === null || hp < landedHp;
}
