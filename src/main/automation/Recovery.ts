/**
 * Sitting down. Nothing here gets a character up again.
 *
 * The last thing on the roadmap's phase-6a list that had never been built:
 * *"Still not built: rest and heal."* Every MegaMUD-era client has a **Health**
 * tab with a *Rest if below* on it, and this is that — the whole of it, because
 * the whole of it is two thresholds and two commands.
 *
 * ## What the server actually does
 *
 * ```
 * rest              You are now resting.   [HP=34 (Resting) ]:
 * rest              idempotent — the same line, still resting
 * (being attacked)  broken
 * (moving)          broken
 * (casting)         broken   — the wire, 2026-09-02; see below
 * l                 NOT broken
 * ```
 *
 * **Only some commands break a rest, and this module sends none of them.**
 *
 * That last line is the correction that removed half of this file. The client
 * believed *anything* breaks a rest — `<enter> broken. l broken.`, read off
 * `npm run probe:rest` in 2026-08-26 — and built a `restUntil` threshold that
 * sent `l` on reaching it, on the reasoning that standing up costs a command
 * anyway so it may as well re-read the room. A look does not stand a character
 * up. On 2026-08-27 a character sat at full health in a room whose rest `l`
 * could not break, and the threshold answered the same status line the same way
 * 431 times in fourteen seconds
 * (`logs/2026-08-27_21-24-03_main.mudcap.jsonl`).
 *
 * The threshold is gone rather than fixed, because the thing it was for is not
 * needed: **resting blocks nothing.** A character can look, talk and read its
 * pack while sitting down, and the two things it cannot do sitting down — move
 * and attack — end the rest themselves as a side effect. Nothing has to be
 * spent to get a character up; the next command it actually wanted does it.
 *
 * ## Casting *does* break a rest, and that is what `restTo` is for
 *
 * The line above used to read *"look, talk, read its pack and cast"*, and the
 * cast half was never measured — `probe:rest`'s candidate list has no `c` in
 * it. The wire settled it on 2026-09-02
 * (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`): `[HP=48/KAI=5]: (Resting)`
 * answered with `c swan`, and the very next prompt is `[HP=48/KAI=4]:` with
 * the flag gone and never coming back. The wire wins over the belief.
 *
 * It is expensive. The same capture has the character regenerating 2 HP every
 * 5s sitting and 2 HP every 30s standing, so a heal that mends six points
 * bought them at six times the price of waiting — and then went on paying it
 * for the four minutes back to full, because `restBelow` had already been
 * crossed and nothing here sits a character down above the floor.
 *
 * `restTo` is the ceiling that answers it: `restBelow` starts a stretch of
 * resting and `restTo` carries it on through whatever breaks it, which is the
 * `healBelow`/`healTo` pair applied to the other half of the same recovery.
 * The result is *rest, heal, rest, heal* rather than one rest and a long walk
 * home. Off by default, because widening the band widens what a **manual**
 * move gets sat back down out of.
 *
 * What is left is two floors to go down at, a ceiling to stay down to, and
 * three refusals:
 *
 * - **Asking twice is free but pointless.** The status line carries `(Resting)`
 *   and the tracker already reads it, so this proposes nothing while the flag
 *   is up. That is what keeps a threshold from becoming one `rest` per status
 *   line for as long as the character is hurt. It is a guard on a *state*, not
 *   a memory of having asked — which is exactly why it could not save the
 *   stand-up path, where the flag being up was the trigger rather than the
 *   thing that silenced it.
 * - **And a memory of having asked behind it** (`askedUntil`), because the flag
 *   is the *server's answer* and does not exist until the `rest` has been
 *   answered. Eight probe replies were outstanding at login on 2026-09-02, so
 *   eight status lines came back before the first `rest` did and every one of
 *   them proposed another: eight `You are now resting.` inside 80ms, seven of
 *   them spent from the same budget a fight is fought with. The state guard was
 *   right and simply had nothing to say yet.
 * - **Never while the fight is here.** Being attacked breaks a rest, so a
 *   `rest` sent during a fight is a command spent to be refused — from the
 *   same budget the fight is being fought with. The test is whether anything
 *   is *swinging*, not whether the server's combat flag is up: the flag
 *   outlives an escape by about three and a half seconds, and refusing on it cost
 *   that whole window to a character that had just run away hurt. See
 *   `fightIsHere`, which has the measurements.
 *
 * ## Where it sits
 *
 * Proposes to `CommandQueue` like everything else; nothing here touches a
 * socket. In the `probe` band: below the player, below a walk, above the
 * keep-alive. A rest that arrives a step late has lost nothing, and one that
 * displaced an attack would have.
 *
 * **Not `safety`.** Running away and sitting down are opposite answers to the
 * same number, and the settings that produce them must not be able to fire
 * together: the escape is `emergency` and this is `probe`, so a character below
 * both thresholds runs first and rests wherever it lands.
 */
import type { CommandQueue } from './CommandQueue';
import { countThreats } from './RuleEngine';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import { DEFAULT_CONFIG, type HealthConfig, type PartyConfig } from '../../shared/config';
import { tuning } from '../app/tuning';

/**
 * Whether the fight the combat flag names is in *this* room.
 *
 * `inCombat` is the server's own `*Combat Engaged*` / `*Combat Off*` pair, and
 * after an escape it is **stale for about three and a half seconds** — the
 * character is a room away and nothing is swinging, but the server has not
 * said so yet. Refusing to rest on the flag alone therefore cost the whole of
 * that window, every time, to a character that had just run for its life at
 * under half health. That is the reported *"2-3 second delay before the rest
 * was sent"*, and the client was never slow: measured on
 * `logs/2026-09-02_11-53-51_festus.mudcap.jsonl`, the `rest` went out **1ms**
 * after `*Combat Off*` arrived.
 *
 * Three things were measured across the recorded sessions before changing it:
 *
 * - **The wait is real and it is the server's.** 44 retreats where nothing was
 *   sent waited a median of 3,493ms from arriving in the new room to
 *   `*Combat Off*`.
 * - **Any command ends it early.** In 15 retreats where something *was* sent —
 *   `c swan`, `exp`, `l festus`, `rest` — `*Combat Off*` came back in the same
 *   response, 1.4-2.4s after arrival rather than 3.5s. The client already acts
 *   through this window; only resting refused to.
 * - **`rest` specifically is accepted there**, which is the question that
 *   mattered: a hand-typed one at
 *   `logs/2026-09-02_09-58-25_festus.mudcap.jsonl` t=94683, 1,774ms after
 *   arriving, was answered `*Combat Off*` and then `You are now resting.` in
 *   one packet. It was not refused, and it did not wait out the timer.
 *
 * So the flag is not the question. Two facts answer it, and the second exists
 * because the first is not enough on its own.
 *
 * **Something recorded as swinging is a fight, flag or no flag.**
 * `CharacterTracker` clears `attackers`, `target` and `health` on a confirmed
 * move — *a step taken leaves the fight's participants behind* — so after a
 * escape both are empty. This half is stronger than the flag it replaces:
 * something swinging at a character that was never formally engaged used to
 * pass the old guard and does not pass this one.
 *
 * **But an empty pair does not mean the fight is over**, and reading it that
 * way was wrong for three cases a review caught before this shipped:
 *
 * - **A fight opened with a spell, or with a bare `a`.** `noteCommand` binds a
 *   target only for `ATTACK_COMMANDS` *with an argument*, and `Cast` is in
 *   neither set — so a caster's whole opening round has the flag up, no
 *   target and no attacker. That is this realm's mystics, which is to say the
 *   character the delay was reported from.
 * - **A kill in a room holding two.** `FightTracker.died` drops the dead
 *   name from both fields and no `*Combat Off*` comes while the survivor is
 *   still engaged.
 * - **A blow nothing can vouch for.** `vouchedFor` files no attacker for a
 *   name the roster, room and party do not know (`Acid burns you for 1
 *   damage!`, captured).
 *
 * What separates all three from an escape is not the participants but **the
 * room**: the thing being fought is standing in it, and after an escape it is a
 * room behind. So an unexplained flag falls back to asking whether this
 * character is alone. Deliberately *anybody*, not just a monster the realm
 * rates hostile — `countThreats` below counts only `attacksOnSight === true`,
 * which is silent for a passive monster this character chose to attack and for
 * every alignment-dependent one until a `who` has been read, so it cannot
 * serve as the backstop here.
 *
 * Room identity is deliberately not used for this. Comparing where the fight
 * began against where the character now stands is the more direct statement,
 * and it needs both rooms *resolved* — which is exactly what a dark cave, the
 * place this character actually fights, does not give.
 */
export function fightIsHere(state: CharacterState): boolean {
  if (state.combat.attackers.length > 0 || state.combat.target !== null) return true;
  if (!state.inCombat) return false;
  return state.room.occupants.length > 0;
}

export class Recovery {
  private state: CharacterState | null = null;
  /**
   * When a proposed `rest` stops being trusted to be in flight.
   *
   * The declared postcondition this module's own note asks for: a `rest` is
   * expected to produce `(Resting)`, and until it does — or until the deadline
   * lapses — there is nothing to ask again. The state guard alone is not
   * enough, because the flag does not arrive until the server has answered,
   * and at login there were eight probe answers ahead of it in the queue: one
   * `rest` per status line, eight of them inside 80ms, each answered `You are
   * now resting.` (`logs/2026-09-02_09-08-19_festus.mudcap.jsonl`,
   * 2026-09-02).
   *
   * It is a memory of having *asked*, deliberately bounded — a `rest` the
   * server swallowed must still be asked for again — and it is cleared the
   * instant the flag arrives, so a rest broken a second later is re-proposed
   * at once rather than waiting out a timer that has already been answered.
   *
   * It is also the only bound on a case nothing has measured: a realm that
   * *refuses* a rest without setting the flag — a room that forbids one, an
   * encumbrance refusal — leaves the threshold true for ever, and since
   * `SessionManager.reconsider` now asks once a second rather than once a
   * status line, the deadline is what makes that one command every three
   * seconds instead of one every one. `probe:rest` does not ask that question,
   * which is the same omission that hid the casting finding.
   */
  private askedUntil = 0;
  /**
   * Whether this character is in a stretch of resting that `restTo` should
   * carry on.
   *
   * Armed by the **wire**, not by the proposal: whoever sat the character down
   * — this module, or the player typing `rest` — the sitting is what `restTo`
   * continues, and a rest the player started is one they want the benefit of.
   * Cleared the moment health reaches the ceiling, and on `reset`.
   */
  private sitting = false;

  /**
   * The verbs the realm has answered with `Your command had no effect.`
   *
   * A mystic on the sanctioned realm answered `med` that way on **every**
   * status line for as long as its Kai was under the threshold — a refused
   * command every three seconds, all evening, because `askedUntil` bounds a
   * rest the server *swallowed* and nothing read the answer when the server
   * refused it outright. The attack verbs already drop a refused word for the
   * session (`AutoCombat`, `attack-refused`); this is the same rule for the
   * two words this module owns. Per session, like theirs: a realm's answer to
   * a verb is a fact about the realm and the class, and both survive a
   * reconnect, but a refusal remembered for ever would outlive a bug fix.
   */
  private readonly refused = new Set<string>();
  /**
   * The verb this module last proposed and how long an answer to it is still
   * expected. A refusal is honoured only against this: the server answers in
   * order, but a player's own command can be echoed on a bare line between
   * the prompt and the refusal (`captures/009:141`, `hid` then `bs k`), and
   * a refusal read against the wrong verb would switch a safety feature off
   * for the session on a guess. A declared postcondition with a deadline,
   * which is what `Recovery`'s own rule asks of anything corrective here.
   */
  private proposed: { command: string; until: number } | null = null;

  constructor(
    private config: HealthConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private party: PartyConfig = DEFAULT_CONFIG.automation.party,
    private readonly events: { notice?(message: string): void } = {}
  ) {}

  configure(config: HealthConfig, enabled: boolean, party?: PartyConfig): void {
    this.config = config;
    this.enabled = enabled;
    if (party) this.party = party;
  }

  reset(): void {
    this.state = null;
    this.askedUntil = 0;
    this.sitting = false;
    this.refused.clear();
    this.proposed = null;
  }

  /**
   * The server answered a command with `Your command had no effect.`
   *
   * `command` is what the status line echoed, which is the server's own
   * statement of what it was answering — null when the line carried no echo.
   * Only the two words this module proposes are read; a `flee` or a typo of
   * the player's is somebody else's refusal. Said out loud once, because
   * somebody who set `meditateBelow` and sees nothing happen needs to know
   * the realm said no, not the client.
   */
  noteNoEffect(command: string | null): void {
    if (command === null) return;
    const verb = command.trim().toLowerCase();
    if (verb !== 'rest' && verb !== 'med') return;
    const asked = this.proposed;
    if (asked === null || asked.command !== verb || Date.now() >= asked.until) return;
    this.proposed = null;
    if (this.refused.has(verb)) return;
    this.refused.add(verb);
    this.askedUntil = 0;
    this.events.notice?.(t('automation.recovery.verbRefused', { verb }));
  }

  /**
   * Character state changed.
   *
   * Read down the guards: every one is a refusal, cheapest first, and the last
   * line is the only place anything is proposed. Same shape as every other
   * safety decision here, for the same reason — it should be possible to see at
   * a glance exactly what had to be true.
   */
  onCharacter(state: CharacterState): void {
    this.state = state;
    if (!this.enabled) return;
    if (state.phase !== 'in-game') return;
    // A rest is broken by being attacked, so one sent while something is
    // actually swinging is a command spent to be told so — out of the same
    // budget the fight is being fought with. The flag alone is not that; see
    // `fightIsHere`.
    if (fightIsHere(state)) return;

    const { hp, hpMax, mana, manaMax, resting, meditating } = state.vitals;

    /*
     * Already down, and nothing sends it back up.
     *
     * The status line says so on every repaint, so there is nothing left to
     * ask — and a character left sitting has lost nothing, because the first
     * step of a walk or the first swing of a fight ends the rest on its way
     * past. This used to be the *second* thing checked, behind a threshold that
     * stood the character up; it is the first thing now, and it is the whole of
     * what this module does about a character that is already resting.
     */
    if (resting || meditating) {
      // The postcondition met: what was asked for has happened, so the memory
      // of having asked has nothing left to suppress. A rest broken on the
      // very next line is re-proposed on it.
      this.askedUntil = 0;
      if (resting) this.sitting = true;
      return;
    }
    /*
     * Asked already, and the answer is still on its way. Everything below
     * re-derives from the state, and the state cannot say *yet* — see
     * `askedUntil`.
     */
    if (Date.now() < this.askedUntil) return;
    /*
     * Nor with something in the room that attacks on sight: measured on the
     * road above the arena, where the monsters wander up — rest, attacked,
     * fight, rest, all evening. A rest about to be broken is a command spent.
     */
    if (countThreats(state) > 0) return;

    if (this.wantsRest(hp, hpMax) && !this.refused.has('rest')) {
      this.propose('rest', t('automation.recovery.reasonHealth'));
      return;
    }
    /*
     * Mana, and only for a class that has any. A warrior's status line carries
     * no `MA=` at all — `manaMax` is null, `below` refuses, and `med` is never
     * sent to be answered `Your command had no effect.` in the room. A class
     * that *has* a figure and is still refused — a mystic's Kai, measured
     * 2026-09-04 — is what `refused` is for.
     */
    if (this.below(mana, manaMax, this.config.meditateBelow) && !this.refused.has('med')) {
      this.propose('med', t('automation.recovery.reasonMana'));
      return;
    }

    /*
     * Sitting down because the leader has. The party listing's flag and `stops
     * to rest` say who is resting; a follower still standing while its leader
     * mends is a follower a lair finds alone. `med` only for a class with mana
     * to meditate — a warrior's `med` is answered with a refusal in the room.
     */
    if (!this.party.restWithLeader || state.party.following === null) return;
    const leader = state.party.members.find(
      (member) => member.name.toLowerCase() === state.party.following?.toLowerCase()
    );
    if (leader?.activity?.state === 'resting') {
      if (this.refused.has('rest')) return;
      this.propose('rest', t('automation.party.reasonRestWithLeader', { leader: leader.name }));
    } else if (leader?.activity?.state === 'meditating' && manaMax !== null && manaMax > 0) {
      if (this.refused.has('med')) return;
      this.propose('med', t('automation.party.reasonMeditateWithLeader', { leader: leader.name }));
    }
  }

  /** The last state seen, for tests. */
  get current(): CharacterState | null {
    return this.state;
  }

  /**
   * Whether to sit this character down, and the bookkeeping that makes
   * `restTo` a ceiling rather than a second floor.
   *
   * `restBelow` starts a stretch of resting; `restTo` is what carries it on
   * once something has broken it. The difference matters because the server
   * keeps a character resting long past `restBelow` for free — so the floor on
   * its own describes only how a rest *begins*, and the first thing to break
   * one above it left the character standing for the rest of the recovery, at
   * a sixth of the regeneration (2 HP per 5s sitting against 2 HP per 30s
   * standing, measured 2026-09-02). On this realm a cast is one of those
   * things: `c swan` sent to a `(Resting)` prompt, and every prompt after it
   * without the flag.
   *
   * Unknown is not low, here as everywhere: a character with no maximum is
   * neither sat down nor kept down, and the stretch is ended rather than left
   * open on a figure nothing has restated.
   */
  private wantsRest(hp: number | null, hpMax: number | null): boolean {
    if (this.below(hp, hpMax, this.config.restBelow)) return true;
    const { restTo } = this.config;
    if (restTo <= 0 || !this.sitting) return false;
    if (this.below(hp, hpMax, restTo)) return true;
    this.sitting = false;
    return false;
  }

  /**
   * Below a threshold, with `unknown` meaning *no*.
   *
   * A maximum that has not arrived yet must never start anything, which is the
   * rule an unknown maximum follows everywhere in this client: it is what stops
   * a meter painting red and a character running from a fight it was winning. Here
   * it stops a character sitting down in a corridor because the stat sheet is
   * three hundred milliseconds away.
   */
  private below(value: number | null, max: number | null, threshold: number): boolean {
    if (threshold <= 0) return false;
    if (value === null || max === null || max <= 0) return false;
    return value / max < threshold;
  }

  private propose(command: string, reason: string): void {
    this.queue.enqueue({
      command,
      priority: 'probe',
      /*
       * One key for the whole module, not one per command.
       *
       * `rest` and `med` are the same intent — *sit this character down over
       * the number that is low* — and only one of them can be right at a time.
       * A key each would let both sit in the queue, and the queue would send
       * them in order: the second one landing on a character the first had
       * already sat down.
       */
      coalesceKey: 'recovery',
      expiresAt: Date.now() + tuning().rest.expiresMs,
      reason
    });
    // Asked. Nothing else is proposed until the status line says it worked, or
    // until the deadline says it never will — see `askedUntil`.
    this.askedUntil = Date.now() + tuning().rest.askedMs;
    // And a refusal inside that window is this verb's — see `proposed`.
    this.proposed = { command, until: this.askedUntil };
  }
}
