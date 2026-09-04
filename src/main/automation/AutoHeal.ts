/**
 * Healing, by a number — MegaMUD's *Heal if below*, for this character and
 * for the party it travels with.
 *
 * Two facts make it decidable without a rule: this character's own vitals,
 * which are counts against a maximum, and the party roster, whose health is a
 * **percentage** and so needs no maximum at all (the one shape a threshold can
 * act on the moment it is listed). A member the roster has not yet listed has
 * `null` health and is never healed on a guess.
 *
 * ## Two spells, because the realm has two
 *
 * `Spells.Targets` says who a spell may be cast on, and a great many heals are
 * one or the other: `way of the swan` reaches the caster alone, `minor healing`
 * reaches anybody. One configured spell for both meant a mystic who set up a
 * self heal silently armed `c swan <name>` once a round, for a refusal the
 * server prints **out loud in the room**. So `heal` is cast on this character
 * and `healPartyWith` on a member, each with its own picker.
 *
 * The realm's word is used to shape the cast, never to refuse it: a spell the
 * realm does not name — a derivative realm, a book learned from the level-up
 * line — is sent as configured, because the server's own refusal is a better
 * failure than a client that silently heals nobody. See `spellTargeting`.
 *
 * ## The pair, not the threshold
 *
 * `healBelow` starts the healing and `healTo` stops it. One cast at 50% that
 * lands at 55% leaves a character hovering under the line, casting one spell a
 * round for the rest of the fight and never getting ahead of the damage — the
 * same complaint `restBelow`/`restTo` answers, and the same shape of
 * answer. A target already being healed goes on being healed up to `healTo`;
 * one that is not is only started on under `healBelow`. `healTo: 0` is the
 * single cast at the threshold this module did before the pair existed.
 *
 * ## What it will not do
 *
 * - **Heal without a number.** Unknown is not low. An unknown maximum for this
 *   character, or a member with no listing yet, produces nothing — the same
 *   rule every threshold in this client follows, and it holds for *continuing*
 *   a heal as well as for starting one.
 * - **Cast below the mana floor.** The same `minMana` the attack spell keeps;
 *   a healer at empty is a healer that cannot heal the next one either.
 * - **Ask twice while the last cast is still in flight.** One proposal per
 *   target, coalesced, and not again for `tuning.spells.healCooldownMs` — a
 *   status line arrives several times a second under pressure and a `party`
 *   listing repeats.
 *
 * Proposes `c <short>` bare for this character — a targetless cast lands on the
 * caster (the todo's own transcript, 2026-09-01) — and `c <short> <name>` for a
 * member, except where the realm calls the spell party-wide (`healing rain`),
 * which reaches everybody friendly and takes no name. The word is the realm's
 * short name because the `Cast` command reads exactly one word as the spell
 * (`castWord`). In the `combat` band: a heal that arrives after the round has
 * been lost has lost it, unlike a rest.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import { castsBare, resolveSpell, spellCost, spellTargeting } from '../../shared/spellcraft';
import { canPayFor } from './mana';
import type { WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';

/** The key a target's cooldown and its in-progress heal are filed under. */
const SELF = '@self';

export class AutoHeal {
  private lastCastAt = new Map<string, number>();
  /**
   * Targets a heal has started on and not yet finished.
   *
   * Kept rather than re-derived because the whole point of `healTo` is that
   * the decision differs between a target that is merely below the ceiling and
   * one that was below the *floor* a moment ago. Cleared the instant a target
   * is at or above `healTo`, and on `reset` — a new session heals nobody on the
   * strength of the last one.
   */
  private healing = new Set<string>();

  constructor(
    private config: SpellsConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly now: () => number = () => Date.now(),
    /**
     * The realm's own row for a spell it names, whole.
     *
     * The entity rather than a projection of it: a caster handed only an
     * abbreviation cannot ask what the cast will cost, and the fix for each
     * new question would be another callback threaded from `SessionManager`.
     * See `resolveSpell`.
     */
    private readonly realmSpell: (name: string) => WorldSpell | null = () => null
  ) {}

  configure(config: SpellsConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.lastCastAt.clear();
    this.healing.clear();
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || this.config.healBelow <= 0) return;
    if (state.phase !== 'in-game' || !this.hasMana(state)) return;

    const self = this.config.heal.trim();
    if (self.length > 0) {
      const fraction = this.selfFraction(state);
      if (this.wants(SELF, fraction, state.inCombat)) {
        this.cast(self, null, state, t('automation.heal.reasonSelf'));
        return;
      }
    }

    const party = this.config.healPartyWith.trim();
    if (!this.config.healParty || party.length === 0) return;
    for (const member of state.party.members) {
      if (member.health === null || state.name === member.name) continue;
      if (!this.wants(member.name.toLowerCase(), member.health, state.inCombat)) continue;
      this.cast(
        party,
        member.name,
        state,
        t('automation.heal.reasonParty', {
          memberName: member.name,
          percent: Math.round(member.health * 100)
        })
      );
      return;
    }
  }

  /** This character's health as a fraction of maximum, or null while unknown. */
  private selfFraction(state: CharacterState): number | null {
    const { hp, hpMax } = state.vitals;
    if (hp === null || hpMax === null || hpMax <= 0) return null;
    return hp / hpMax;
  }

  /**
   * Whether this target should be healed now, and the bookkeeping that makes
   * `healTo` a ceiling rather than a second floor.
   *
   * Unknown is not low **and not healed**: a target with no figure is neither
   * started on nor continued, and is dropped from the in-progress set rather
   * than left in it — a member who walks out of the listing would otherwise
   * come back mid-heal on a figure nothing has restated.
   */
  private wants(key: string, fraction: number | null, inCombat: boolean): boolean {
    if (fraction === null) {
      this.healing.delete(key);
      return false;
    }
    const { healTo } = this.config;
    /*
     * A different floor in a fight, when one is set.
     *
     * MegaMUD's `HpHealAtt%`, and its own documentation says why: a heal cast
     * at 80% mid-fight is a round spent not hitting anything, and the round is
     * what the fight is made of. 0 means *use the ordinary floor for both*,
     * which is what this module did before the field existed — so the default
     * changes nothing.
     */
    const healBelow =
      inCombat && this.config.healBelowInCombat > 0
        ? this.config.healBelowInCombat
        : this.config.healBelow;
    if (fraction < healBelow) {
      this.healing.add(key);
      return true;
    }
    // Above the floor: only a target already being healed goes on, and only
    // up to the ceiling. `healTo` of 0 leaves the set empty, so this is the
    // single cast at the threshold.
    if (healTo > 0 && this.healing.has(key) && fraction < healTo) return true;
    this.healing.delete(key);
    return false;
  }

  private hasMana(state: CharacterState): boolean {
    const { mana, manaMax } = state.vitals;
    if (this.config.minMana <= 0) return true;
    if (mana === null || manaMax === null || manaMax <= 0) return false;
    return mana / manaMax >= this.config.minMana;
  }

  /** A null target is this character: cast bare, and keyed apart from any name. */
  private cast(spell: string, target: string | null, state: CharacterState, reason: string): void {
    const key = target === null ? SELF : target.toLowerCase();
    const at = this.now();
    const last = this.lastCastAt.get(key);
    if (last !== undefined && at - last < tuning().spells.healCooldownMs) return;
    const found = resolveSpell(spell, state.spellbook, this.realmSpell);
    /*
     * A cast that cannot be paid for is not sent, and no cooldown is spent on
     * it. The server answers one out loud in the room, and the next status
     * line is both when the pool changes and when this is asked again — so
     * waiting costs nothing and needs no timer. See `canPayFor`.
     */
    if (!canPayFor(state, spellCost(found))) return;
    this.lastCastAt.set(key, at);
    const word = found.word;
    /*
     * A party-wide spell takes no name: `healing rain` reaches everybody
     * friendly in the room, and the `Cast` command has nowhere to put a target
     * on one. The realm says which those are; a spell it does not name falls
     * through to the named form, which is what the configuration asked for.
     */
    const bare = target === null || castsBare(spellTargeting(found.realm?.targets));
    this.queue.enqueue({
      command: bare ? `c ${word}` : `c ${word} ${target}`,
      priority: 'combat',
      coalesceKey: `heal:${key}`,
      expiresAt: at + tuning().spells.healExpiresMs,
      reason
    });
  }
}
