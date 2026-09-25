/**
 * Getting back into the shadows between fights, so the next one opens from
 * them — the standing-still half of stealth `Walker.sneakFirst` never had.
 *
 * A backstab is worth about four ordinary swings (measured 2026-09-12; see
 * `mudengine-automation` § *The opener is re-armed between fights*), and the
 * server grants it in two places only: `sn` and `hide`, both refused while a
 * monster is in the room. A hunting character sneaks in, backstabs once, and
 * then stands in a lair that keeps making monsters, in plain sight, because
 * nothing ever asked for the shadows back.
 *
 * `hide` while standing still: it rolls the whole Stealth figure against 150,
 * uncapped and uncrowded (`HideCommand.cs:46`). `sn` while a lap or a route
 * has the character: the step ahead is what the sneak is for, and the walker
 * asks again before it (`sneakFirst`). Neither receipt is trusted: the state
 * goes to `unknown` on the send, where the opener is spent and the cost of a
 * failed roll is one downgraded swing.
 */
import type { CommandQueue } from './CommandQueue';
import { cannotSneakHere } from './Walker';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';
import { commandOf } from '../../shared/commands';
import type { CombatConfig } from '../../shared/config';
import type { SessionModule } from './Module';

export interface StealthEvents {
  notice?(message: string): void;
  /** Whether an escape is in flight; nothing hides on the way out of a room. */
  escaping?(): boolean;
  /**
   * Whether a lap is running or a route is walking. Between steps the answer
   * is `sn`, because the step ahead is what the stealth is for.
   */
  moving?(): boolean;
  /** Whether a move is outstanding: the room's list is the room being left. */
  moveInFlight?(): boolean;
  /**
   * Whether the server has refused the opener this session — for this
   * character or for the weapon in hand (`AutoCombat.openerRefused`). A hide
   * for a backstab the server will not perform is a wasted command.
   */
  openerRefused?(): boolean;
  /**
   * Whether this character's class carries `ShadowHome` on the loaded realm —
   * `restsInTheShadows` (`src/shared/abilities.ts`), which reads the realm's
   * own `Classes.Abil-n` and requires the GreaterMUD family.
   *
   * With it, `hide` and `sneak` do not clear `Resting` (`HideCommand.cs:20`,
   * `SneakCommand.cs:28`) and `rest` does not break stealth
   * (`RestCommand.cs:31`), so the two do not undo each other in either
   * direction and a resting character may be asked for the shadows.
   */
  restsHidden?(): boolean;
}

/** Past this the move roll gains nothing (`Exits.cs:149` clamps at 100). */
const WALKING_STEALTH_CEILING = 100;

export class AutoStealth implements SessionModule {
  /** When the shadows were last asked for, so a failed roll retries at a stated rate. */
  private askedAt = 0;
  /** Whether *Stealth 0* has been said this session. */
  private saidNoSkill = false;
  /** Whether the Stealth ceiling has been said this session. */
  private saidCeiling = false;

  constructor(
    private config: CombatConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly events: StealthEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: CombatConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.askedAt = 0;
    this.saidCeiling = false;
  }

  /** Every state change: is the character standing seen in an empty room? */
  onCharacter(state: CharacterState): void {
    if (state.phase !== 'in-game') return;
    const opener = this.config.opener.trim();
    // The command table's own reading: `bs` is `BackStab`, and nothing else is.
    const backstabber = commandOf(opener) === 'BackStab';
    if (backstabber) this.sayCeiling(state);
    if (!this.enabled || !this.config.hideForOpener || !backstabber) return;
    const moving = this.events.moving?.() === true;
    // The combat block's master switch governs everything under it; a lap
    // engages whatever the switch says, as `AutoCombat.acting` reads it.
    if (!this.config.enabled && !moving) return;
    if (state.stealth !== 'seen') return;
    if (this.events.escaping?.() === true) return;
    if (this.events.moveInFlight?.() === true) return;
    if (this.events.openerRefused?.() === true) return;
    /*
     * The sheet's `Stealth:` figure is the roll for both commands
     * (`SneakCommand.cs`, `HideCommand.cs`); zero never passes (todo 104).
     * Said once, and an unread sheet never refuses.
     */
    if (state.progress.stealthSkill === 0) {
      if (!this.saidNoSkill) {
        this.saidNoSkill = true;
        this.events.notice?.(t('automation.stealth.noSkill'));
      }
      return;
    }
    /*
     * The server's own precondition, transcribed: both commands sit inside
     * `CurrentTarget == null && Room.Mobs.Count == 0`, so a monster here or a
     * fight running means a refusal, out of the budget the fight is fought
     * from.
     */
    if (cannotSneakHere(state)) return;
    /*
     * Both commands clear `Resting` (`HideCommand.cs:20`, `SneakCommand.cs:28`)
     * — unless the class carries `ShadowHome`, which exempts it. Standing a
     * hurt character up to hide it is the wrong trade, so without the ability
     * this waits and the rest ending re-asks.
     *
     * With it, resting is not a reason to wait: the character stays seated and
     * gains the shadows, which is the whole of the hide-rest-backstab loop the
     * ability exists for (todo 17). Read from the realm's own class row, never
     * from a class name, and false on any realm but GreaterMUD's engine.
     */
    if (state.vitals.resting && this.events.restsHidden?.() !== true) return;
    const now = this.now();
    if (now - this.askedAt < tuning().stealth.askEveryMs) return;
    this.askedAt = now;
    const { expiresMs } = tuning().stealth;
    if (moving) {
      // The walker's own key and band, so its `sn` before the step and this
      // one are one command.
      this.queue.enqueue({
        command: 'sn',
        priority: 'movement',
        coalesceKey: 'sneak',
        expiresAt: now + expiresMs,
        reason: t('automation.stealth.reasonSneak', { verb: opener })
      });
      return;
    }
    this.queue.enqueue({
      command: 'hide',
      priority: 'probe',
      coalesceKey: 'hide',
      expiresAt: now + expiresMs,
      reason: t('automation.stealth.reasonHide', { verb: opener })
    });
  }

  /**
   * Realm arithmetic the player cannot see: a move rolls Stealth clamped to
   * 100 (`Exits.cs:149`) and `sn` clamps to 95 (`SneakCommand.cs:63`), while
   * `hide` rolls the whole figure against 150 (`HideCommand.cs:46`). A
   * character past 100 gains nothing more from it walking and keeps gaining
   * standing still. Said once a session, to a backstabber only.
   */
  private sayCeiling(state: CharacterState): void {
    if (this.saidCeiling) return;
    const skill = state.progress.stealthSkill;
    if (skill === null || skill <= WALKING_STEALTH_CEILING) return;
    this.saidCeiling = true;
    this.events.notice?.(
      t('automation.stealth.ceiling', { skill, ceiling: WALKING_STEALTH_CEILING })
    );
  }
}
