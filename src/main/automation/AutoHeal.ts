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
 * ## Which spell, when the player would rather not choose
 *
 * One configured spell is the wrong answer at one end of the bar or the other
 * (todo 01, 2026-09-13): at 145/150 a character carrying *major healing*
 * spends a major heal's mana to mend five points, and at 90/150 one carrying
 * *minor healing* never gets ahead of the damage. Under
 * `automation.spells.autoChoose` — the same switch the round spell is derived
 * by — the heal is chosen per cast against the **deficit**, the ceiling less
 * what the bar holds: `chooseHealSpell`, the cheapest cast expected to reach
 * it, else the one that mends most.
 *
 * **A derivation that cannot answer falls back to the configured spell**, and
 * says so once. This is where the heal deliberately differs from the round
 * spell, which is simply not cast when the choice refuses: a fight lost to a
 * slower spell is a fight, and a heal not cast is a death. A member whose own
 * client has never answered `@health` is the ordinary case of it — a
 * percentage cannot say how many hit points a heal must cover.
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
 * ## A member may ask
 *
 * `@heal` is one party heal whatever the listing says: the member's own word
 * is the number. Every other gate here still applies. See `mudengine-automation`
 * › *A member's `@heal` is one party heal*.
 *
 * Proposes `<short>` bare for this character — a targetless cast lands on the
 * caster (the todo's own transcript, 2026-09-01) — and `<short> <name>` for a
 * member, except where the realm calls the spell party-wide (`healing rain`),
 * which reaches everybody friendly and takes no name. The word is the realm's
 * short name, which is itself the command and never goes behind `c`
 * (`castWord`). In the `combat` band: a heal that arrives after the round has
 * been lost has lost it, unlike a rest.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { CharacterState, PartyMember } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import {
  castsBare,
  healFloor,
  resolveSpell,
  spellCost,
  spellTargeting
} from '../../shared/spellcraft';
import { canPayFor } from './mana';
import { chooseHealSpell, type HealAim, type HealChoice } from '../../shared/spellchoice';
import { prowessSheetOf } from '../../shared/verdict';
import type { RealmFamily } from '../../shared/realm';
import type { WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';
import type { SessionModule } from './Module';

/** The key a target's cooldown and its in-progress heal are filed under. */
const SELF = '@self';

export class AutoHeal implements SessionModule {
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
  /** What was last said about a derived choice, per aim, so a change is said once. */
  private saidChoice = new Map<HealAim, string>();
  /**
   * Members who said `@heal`, by lower-cased name: their own spelling and when.
   * Spent when the cast is **sent**, never when it is queued.
   */
  private asked = new Map<string, { from: string; at: number }>();
  /** Why the last request from each member was refused, so a repeat says nothing new. */
  private saidRefusal = new Map<string, string>();

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
    private readonly realmSpell: (name: string) => WorldSpell | null = () => null,
    /** Where a derived choice is said (todo 01). */
    private readonly events: { notice?(message: string): void } = {},
    /**
     * The character's own side of the casting arithmetic, read at the point of
     * use like `AutoCombat`'s: the world arrives with `useRealm` and the class
     * is not known until a stat sheet has been read. It decides `castOdds`,
     * which is how often a cast works at all.
     */
    private readonly realmClass: () => {
      combat: number | null;
      magery: number | null;
      family: RealmFamily | null;
    } = () => ({ combat: null, magery: null, family: null })
  ) {}

  configure(config: SpellsConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.lastCastAt.clear();
    this.healing.clear();
    this.saidChoice.clear();
    this.asked.clear();
    this.saidRefusal.clear();
  }

  /**
   * A party member said `@heal`. Recorded for the next decision, which the
   * caller asks for at once; refused out loud, once per asker and reason, where
   * this character would not heal them however low they were.
   *
   * Membership is asked here as well as by the permission gate, because a
   * player `allow` passes somebody who is not in the party, and a heal meant
   * for the party is not cast on a stranger for asking.
   */
  request(from: string, state: CharacterState): void {
    if (!this.enabled) return;
    const key = from.toLowerCase();
    const member = state.party.members.some(
      (row) => !row.invited && row.name.toLowerCase() === key
    );
    const refusal = !member
      ? t('automation.heal.requestNotMember', { from })
      : this.config.healBelow <= 0
        ? t('automation.heal.requestHealOff', { from })
        : !this.config.healParty
          ? t('automation.heal.requestPartyOff', { from })
          : this.config.healPartyWith.trim().length === 0 && !this.config.autoChoose
            ? t('automation.heal.requestNoSpell', { from })
            : null;
    if (refusal !== null) {
      this.sayRefusal(key, refusal);
      return;
    }
    this.asked.set(key, { from, at: this.now() });
    // Kept rather than refused: the pool refills, and the request stands until
    // it lapses. But a heal that is not coming yet is said.
    if (!this.hasMana(state)) this.sayRefusal(key, t('automation.heal.requestLowMana', { from }));
    else this.saidRefusal.delete(key);
  }

  private sayRefusal(key: string, refusal: string): void {
    if (this.saidRefusal.get(key) !== refusal) this.events.notice?.(refusal);
    this.saidRefusal.set(key, refusal);
  }

  /**
   * A request nothing answered in time — this character's own heal, another
   * member's cooldown or the purse stood in front of it — is said, once, as it
   * lapses; unless the reason it waited was already said.
   */
  private forgetStaleRequests(): void {
    if (this.asked.size === 0) return;
    const since = this.now() - tuning().spells.healRequestMs;
    for (const [key, { from, at }] of [...this.asked]) {
      if (at > since) continue;
      this.asked.delete(key);
      if (this.saidRefusal.has(key)) continue;
      this.events.notice?.(
        t('automation.heal.requestLapsed', {
          from,
          seconds: Math.round(tuning().spells.healRequestMs / 1000)
        })
      );
    }
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || this.config.healBelow <= 0) return;
    this.forgetStaleRequests();
    if (state.phase !== 'in-game' || !this.hasMana(state)) return;

    const self = this.config.heal.trim();
    if (self.length > 0 || this.config.autoChoose) {
      const fraction = this.selfFraction(state);
      if (this.wants(SELF, fraction, state.inCombat)) {
        const { hp, hpMax } = state.vitals;
        const spell = this.spellFor(state, 'self', this.deficit(hp, hpMax), self);
        if (spell.length > 0) {
          this.cast(spell, null, state, t('automation.heal.reasonSelf'));
          return;
        }
      }
    }

    const party = this.config.healPartyWith.trim();
    if (!this.config.healParty || (party.length === 0 && !this.config.autoChoose)) return;
    // Those who asked first: their own word is the freshest figure there is,
    // and a listing that lags keeps a member low for a round after the heal.
    const asking = (member: PartyMember): number =>
      this.asked.has(member.name.toLowerCase()) ? 0 : 1;
    for (const member of [...state.party.members].sort((a, b) => asking(a) - asking(b))) {
      if (state.name === member.name) continue;
      const key = member.name.toLowerCase();
      const asked = this.asked.has(key);
      /*
       * A request is one cast and nothing more: it neither needs the listing's
       * figure nor starts `healTo`'s run, so the thresholds decide everything
       * after it exactly as they would have.
       */
      if (!asked) {
        if (member.health === null) continue;
        if (!this.wants(key, member.health, state.inCombat)) continue;
      }
      /*
       * The percentage is enough to decide *whether* to heal and not enough to
       * decide *which*: 30% of 4,434 and 30% of 62 are the same bar. Only a
       * member whose own client has answered `@health` states the pair, and
       * without it the configured spell is cast — said once.
       */
      const deficit =
        member.vitals === null ? null : this.deficit(member.vitals.hp, member.vitals.hpMax);
      const spell = this.spellFor(state, 'party', deficit, party);
      /*
       * On to the next member rather than out of the loop: whether a heal can
       * be *chosen* is per member — one whose client answered `@health` states
       * the figures and one who has not does not — so the first that cannot be
       * healed must not stand in front of one that can.
       */
      if (spell.length === 0) continue;
      const reason =
        asked || member.health === null
          ? t('automation.heal.reasonRequested', { memberName: member.name })
          : t('automation.heal.reasonParty', {
              memberName: member.name,
              percent: Math.round(member.health * 100)
            });
      // Spent when the cast leaves, and by nothing else: one held back by the
      // cooldown, the purse or the queue is still owed until it lapses.
      this.cast(
        spell,
        member.name,
        state,
        reason,
        asked ? () => this.asked.delete(key) : undefined
      );
      return;
    }
  }

  /**
   * Hit points wanted back: the ceiling the healing runs to, less what the bar
   * holds. Null while either figure is unread, which is *unknown* and never 0.
   *
   * `healTo: 0` states no ceiling — it is the single cast at the threshold —
   * so the bar's own top is what the cast aims at, which is the most any one
   * spell could usefully mend.
   */
  private deficit(hp: number | null, hpMax: number | null): number | null {
    if (hp === null || hpMax === null || hpMax <= 0) return null;
    const { healTo } = this.config;
    const ceiling = healTo > 0 ? Math.min(1, healTo) : 1;
    return Math.max(0, Math.ceil(ceiling * hpMax) - hp);
  }

  /**
   * The spell to cast: the book's own answer to this deficit under
   * *Auto Choose Best Spell*, else what the player configured.
   *
   * Every way the derivation can decline ends at the configured spell rather
   * than at nothing — see the header. A deficit nothing has stated declines
   * for the same reason a refusal does: the choice is made *against* that
   * figure, and without it there is no question to answer.
   */
  private spellFor(
    state: CharacterState,
    aim: HealAim,
    deficit: number | null,
    configured: string
  ): string {
    if (!this.config.autoChoose) return configured;
    if (deficit === null) {
      this.sayOnce(aim, 'no-figures', () =>
        aim === 'party' ? t('automation.heal.noFiguresParty') : t('automation.heal.noFiguresSelf')
      );
      return configured;
    }
    const { combat, magery, family } = this.realmClass();
    const choice = chooseHealSpell(
      state.spellbook === null
        ? { book: null }
        : {
            book: state.spellbook,
            realm: this.realmSpell,
            level: state.progress.level,
            mana: state.vitals.mana,
            deficit,
            aim,
            sheet: prowessSheetOf(state, { combat, magery }),
            family
          }
    );
    if (choice.chosen === null) {
      this.sayOnce(aim, `refused:${choice.refusal}`, () =>
        configured.length > 0
          ? t('automation.heal.noChoice', { spell: configured })
          : t('automation.heal.noChoiceNoSpell')
      );
      return configured;
    }
    this.sayChoice(aim, choice, deficit);
    return choice.chosen.spell.name;
  }

  /** The derivation, said when it changes — the round spell's own rule. */
  private sayChoice(aim: HealAim, choice: HealChoice, deficit: number): void {
    const chosen = choice.chosen;
    if (chosen === null) return;
    this.sayOnce(aim, `${chosen.spell.name}|${choice.why}`, () => {
      const params = {
        spell: chosen.spell.name,
        min: chosen.min,
        max: chosen.max,
        expected: Math.round(chosen.expected),
        cost: chosen.cost ?? '?',
        deficit
      };
      return choice.why === 'covers'
        ? t('automation.heal.choseCovers', params)
        : t('automation.heal.choseMost', params);
    });
  }

  /**
   * One sentence per aim per situation.
   *
   * The message is built only where it will be said: the deficit moves with
   * every blow, so a *covers* line rebuilt per status line would format a
   * string a hundred times a fight to throw it away.
   */
  private sayOnce(aim: HealAim, key: string, message: () => string): void {
    if (this.saidChoice.get(aim) === key) return;
    this.saidChoice.set(aim, key);
    this.events.notice?.(message());
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
    if (fraction < healFloor(this.config, inCombat)) {
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

  /**
   * A null target is this character: cast bare, and keyed apart from any name.
   * `onSent` is told when the cast leaves, which is what spends a request.
   */
  private cast(
    spell: string,
    target: string | null,
    state: CharacterState,
    reason: string,
    onSent?: () => void
  ): void {
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
    const word = found.word;
    /*
     * A party-wide spell takes no name: `healing rain` reaches everybody
     * friendly in the room, and the `Cast` command has nowhere to put a target
     * on one. The realm says which those are; a spell it does not name falls
     * through to the named form, which is what the configuration asked for.
     */
    const bare = target === null || castsBare(spellTargeting(found.realm?.targets));
    const taken = this.queue.enqueue({
      command: bare ? word : `${word} ${target}`,
      priority: 'combat',
      coalesceKey: `heal:${key}`,
      expiresAt: at + tuning().spells.healExpiresMs,
      reason,
      ...(onSent === undefined ? {} : { onSent })
    });
    // A refused enqueue is *not now*, never a cast: the cooldown is for one
    // that is on its way (todo 113's rule).
    if (taken) this.lastCastAt.set(key, at);
  }
}
