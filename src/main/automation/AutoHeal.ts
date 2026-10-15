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
 * `automation.spells.autoChooseHeal` (the heal's own switch since todo 05;
 * before that it used `autoChoose`), the heal is chosen per cast against the
 * **deficit**, the ceiling less what the bar holds: `chooseHealSpell`, the
 * cheapest cast expected to reach it, else the one that mends most. With more
 * than one person hurt, `planHeal` weighs one heal on each against a
 * party-wide heal on all.
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
 * - **Cast below the mana floor.** `healMinMana`, the heal's own, apart from
 *   the attack spell's `minMana`; a healer at empty is a healer that cannot
 *   heal the next one either.
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
import {
  inAParty,
  joinedMembers,
  type CharacterState,
  type PartyMember
} from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import {
  castsBare,
  healFloor,
  gatedCast,
  OPEN_CAST_GATE,
  resolveSpell,
  spellCost,
  spellTargeting,
  type CastGate
} from '../../shared/spellcraft';
import { canPayFor, manaAtLeast } from './mana';
import {
  chooseHealSpell,
  healCeiling,
  healDeficit,
  pickHeal,
  type HealAim,
  type HealChoice
} from '../../shared/spellchoice';
import { healTargets, planHeal } from '../../shared/healplan';
import type { ProwessClass } from '../../shared/prowess';
import { prowessSheetOf } from '../../shared/verdict';
import type { RealmFamily } from '../../shared/realm';
import type { WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';
import type { SessionModule } from './Module';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';

/** The key a target's cooldown and its in-progress heal are filed under. */
const SELF = '@self';
/** The key a party-wide heal's cooldown is filed under: it has no one target. */
const AREA = '@party';
/** Whose heal a choice or a cast is, as the settings behind it file it. */
const HEAL_KIND: Record<HealAim, DecisionKind> = { self: 'heal-self', party: 'heal-party' };

/** A joined member a heal is wanted for, with the listing's share and whether they asked. */
interface WantedMember {
  readonly member: PartyMember;
  readonly share: number | null;
  readonly asked: boolean;
}

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
    private readonly events: { notice?: NoticeSink } = {},
    /**
     * The character's own side of the casting arithmetic, read at the point of
     * use like `AutoCombat`'s: the world arrives with `useRealm` and the class
     * is not known until a stat sheet has been read. It decides `castOdds`,
     * which is how often a cast works at all.
     */
    private readonly realmClass: () => ProwessClass & { family: RealmFamily | null } = () => ({
      combat: null,
      magery: null,
      crits: 0,
      family: null
    }),
    /** The one heal, blessing or cure a round, asked at the send (`CastRound`). */
    private readonly gate: CastGate = OPEN_CAST_GATE
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
          : this.config.healPartyWith.trim().length === 0 && !this.config.autoChooseHeal
            ? t('automation.heal.requestNoSpell', { from })
            : null;
    if (refusal !== null) {
      this.sayRefusal(key, refusal);
      return;
    }
    this.asked.set(key, { from, at: this.now() });
    // Kept rather than refused: the pool refills, and the request stands until
    // it lapses. But a heal that is not coming yet is said.
    if (!this.hasMana(state))
      this.sayRefusal(key, t('automation.heal.requestLowMana', { from }), 'mana-floor');
    else this.saidRefusal.delete(key);
  }

  private sayRefusal(key: string, refusal: string, decision: DecisionKind = 'heal-request'): void {
    if (this.saidRefusal.get(key) !== refusal) this.events.notice?.(refusal, decision);
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
        }),
        'heal-request'
      );
    }
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || this.config.healBelow <= 0) return;
    this.forgetStaleRequests();
    if (state.phase !== 'in-game' || !this.hasMana(state)) return;
    if (this.config.autoChooseHeal && this.planned(state)) return;

    const self = this.config.heal.trim();
    const selfShare = this.selfFraction(state);
    const selfWanted =
      (self.length > 0 || this.config.autoChooseHeal) &&
      this.wants(SELF, selfShare, state.inCombat);
    const members = this.membersWanting(state);
    /*
     * The lowest bar first (todo 61, MegaMUD's *Heal Party over self, IF
     * lower*): a member whose share is under this character's is healed
     * before this character is. A request does not jump this character's own
     * bar, and equal shares heal this character.
     */
    const lower = ({ share }: WantedMember): boolean =>
      selfShare !== null && share !== null && share < selfShare;
    if (selfWanted && this.healMembers(state, members.filter(lower))) return;
    if (selfWanted && this.healSelf(state)) return;
    this.healMembers(state, members);
  }

  /** The first of `members` a party heal answers, cast; false where none does. */
  private healMembers(state: CharacterState, members: readonly WantedMember[]): boolean {
    const party = this.config.healPartyWith.trim();
    for (const { member, share, asked } of members) {
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
      this.healMember(spell, member.name, share, asked, state);
      return true;
    }
    return false;
  }

  /** This character's own heal, bare; false where no spell answers. */
  private healSelf(state: CharacterState): boolean {
    const { hp, hpMax } = state.vitals;
    const spell = this.spellFor(state, 'self', this.deficit(hp, hpMax), this.config.heal.trim());
    if (spell.length === 0) return false;
    this.cast(spell, null, state, t('automation.heal.reasonSelf'), 'heal-self');
    return true;
  }

  /**
   * The joined members a heal is wanted for now, those who asked first and
   * then the lowest share (todo 61); a share the listing does not state sorts
   * last. A request is one cast and nothing more: it neither needs the
   * listing's figure nor starts `healTo`'s run, so the thresholds decide
   * everything after it exactly as they would have.
   */
  private membersWanting(state: CharacterState): WantedMember[] {
    const party = this.config.healPartyWith.trim();
    if (!this.config.healParty || (party.length === 0 && !this.config.autoChooseHeal)) return [];
    const wanted: WantedMember[] = [];
    for (const member of joinedMembers(state)) {
      const asked = this.asked.has(member.name.toLowerCase());
      // An unstated share leaves `healTo`'s run as it was: unknown is not "healed".
      const low =
        member.health !== null &&
        this.wants(member.name.toLowerCase(), member.health, state.inCombat);
      if (asked || low) {
        wanted.push({ member, share: member.health, asked });
      }
    }
    const unstatedLast = (share: number | null): number => share ?? 2;
    return wanted.sort(
      (a, b) => Number(b.asked) - Number(a.asked) || unstatedLast(a.share) - unstatedLast(b.share)
    );
  }

  /**
   * Under *Auto Choose Best Heal*: one heal on the worst hurt, or a party-wide
   * heal on everybody, whichever `planHeal` weighs higher. False where it has
   * no answer, and the configured spells decide as they do with the switch
   * off.
   *
   * The lowest bar is served first even without figures: a member whose own
   * client never answered `@health` has a share and no maximum, so no choice
   * can be priced for them, and they get the configured spell ahead of a
   * better-known member who is less hurt. Unknown is the unsafe case.
   */
  private planned(state: CharacterState): boolean {
    const { figured, unfigured } = healTargets(
      state,
      this.config.healParty,
      (key, share) => this.wants(key ?? SELF, share, state.inCombat),
      (key) => this.asked.has(key)
    );
    const wanted = figured.filter((target) => target.wanted);
    const lowest = Math.min(...wanted.map((target) => target.hp / target.hpMax));
    // Somebody who asked first, then the lowest share.
    const worst = [...unfigured].sort(
      (a, b) => Number(b.asked) - Number(a.asked) || (a.share ?? 0) - (b.share ?? 0)
    )[0];
    if (
      worst !== undefined &&
      (wanted.length === 0 || worst.asked || (worst.share !== null && worst.share < lowest))
    ) {
      const spell = this.spellFor(state, 'party', null, this.config.healPartyWith.trim());
      if (spell.length === 0) return false;
      this.healMember(spell, worst.name, worst.share, worst.asked, state);
      return true;
    }
    if (wanted.length === 0) return false;

    const { combat, magery, crits, family } = this.realmClass();
    const { healTo } = this.config;
    const plan =
      state.spellbook === null
        ? null
        : planHeal({
            book: state.spellbook,
            realm: this.realmSpell,
            level: state.progress.level,
            mana: state.vitals.mana,
            sheet: prowessSheetOf(state, { combat, magery, crits }),
            family,
            targets: figured,
            ceiling: healCeiling(healTo),
            urgency: this.config.healUrgency,
            nearEnough: tuning().spells.healNearEnough,
            // Nobody joined, or no listing read yet, is no party: a rain cast
            // alone reaches only the caster, and a single heal is the cast for
            // one bar.
            partyWide: this.config.healParty && inAParty(state)
          });
    if (plan === null) return false;

    if (plan.kind === 'area') {
      const { cast, reaches } = plan;
      this.sayOnce('party', `area|${cast.spell.name}`, () => {
        const params = {
          spell: cast.spell.name,
          min: cast.min,
          max: cast.max,
          cost: cast.cost ?? '?',
          count: reaches
        };
        return reaches === 1
          ? t('automation.heal.choseArea.one', params)
          : t('automation.heal.choseArea.many', params);
      });
      // Everybody who asked is reached, figures or none (`FullPartyArea`).
      const askers = [...this.asked.keys()];
      const reached = wanted.map((target) => target.name?.toLowerCase() ?? SELF);
      this.cast(
        cast.spell.name,
        null,
        state,
        t('automation.heal.reasonArea', { count: reaches }),
        'heal-party',
        () => askers.forEach((key) => this.asked.delete(key)),
        [AREA, ...reached]
      );
      return true;
    }

    const { target, choice } = plan;
    const deficit = this.deficit(target.hp, target.hpMax) ?? 0;
    if (target.name === null) {
      this.sayChoice('self', choice, deficit);
      this.cast(
        choice.chosen.spell.name,
        null,
        state,
        t('automation.heal.reasonSelf'),
        'heal-self'
      );
      return true;
    }
    this.sayChoice('party', choice, deficit);
    const asked = this.asked.has(target.name.toLowerCase());
    this.healMember(choice.chosen.spell.name, target.name, target.hp / target.hpMax, asked, state);
    return true;
  }

  /**
   * One heal on a member: said as their request or their share, and a request
   * spent when the cast leaves and by nothing else, since one held back by the
   * cooldown, the purse or the queue is still owed until it lapses.
   */
  private healMember(
    spell: string,
    name: string,
    share: number | null,
    asked: boolean,
    state: CharacterState
  ): void {
    const key = name.toLowerCase();
    const reason =
      asked || share === null
        ? t('automation.heal.reasonRequested', { memberName: name })
        : t('automation.heal.reasonParty', { memberName: name, percent: Math.round(share * 100) });
    const decision: DecisionKind = asked ? 'heal-request' : 'heal-party';
    this.cast(
      spell,
      name,
      state,
      reason,
      decision,
      asked ? () => this.asked.delete(key) : undefined
    );
  }

  /** Hit points wanted back (`healDeficit`); null while either figure is unread. */
  private deficit(hp: number | null, hpMax: number | null): number | null {
    return healDeficit(this.config.healTo, hp, hpMax);
  }

  /**
   * The spell to cast, by `pickHeal`: the book's own answer to this deficit
   * under *Auto Choose Best Heal*, else what the player configured. A refusal
   * or an unread deficit falls back to the configured spell (see the header).
   */
  private spellFor(
    state: CharacterState,
    aim: HealAim,
    deficit: number | null,
    configured: string
  ): string {
    const pick = pickHeal(this.config.autoChooseHeal, deficit, (wanted) => {
      if (state.spellbook === null) return chooseHealSpell({ book: null });
      const { combat, magery, crits, family } = this.realmClass();
      return chooseHealSpell({
        book: state.spellbook,
        realm: this.realmSpell,
        level: state.progress.level,
        mana: state.vitals.mana,
        deficit: wanted,
        aim,
        sheet: prowessSheetOf(state, { combat, magery, crits }),
        family
      });
    });
    switch (pick.kind) {
      case 'configured':
        if (pick.why === 'no-figures') {
          this.sayOnce(aim, 'no-figures', () =>
            aim === 'party'
              ? t('automation.heal.noFiguresParty')
              : t('automation.heal.noFiguresSelf')
          );
        }
        return configured;
      case 'refused':
        this.sayOnce(aim, `refused:${pick.refusal}`, () =>
          configured.length > 0
            ? t('automation.heal.noChoice', { spell: configured })
            : t('automation.heal.noChoiceNoSpell')
        );
        return configured;
      case 'chosen':
        this.sayChoice(aim, pick.choice, pick.deficit);
        return pick.chosen.spell.name;
      default: {
        const unreachable: never = pick;
        return unreachable;
      }
    }
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
    this.events.notice?.(message(), HEAL_KIND[aim]);
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
    return manaAtLeast(state, this.config.healMinMana);
  }

  /**
   * A null target is this character: cast bare, and keyed apart from any name.
   * `onSent` is told when the cast leaves, which is what spends a request.
   * `keys` are the cooldowns the cast waits on and spends: a party-wide heal
   * spends everybody's it reached, so neither it nor a single heal lands
   * again on a bar that has not yet shown the last one.
   */
  private cast(
    spell: string,
    target: string | null,
    state: CharacterState,
    reason: string,
    decision: DecisionKind,
    onSent?: () => void,
    keys: readonly string[] = [target === null ? SELF : target.toLowerCase()]
  ): void {
    const at = this.now();
    const recent = (key: string): boolean => {
      const last = this.lastCastAt.get(key);
      return last !== undefined && at - last < tuning().spells.healCooldownMs;
    };
    if (keys.some(recent)) return;
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
    // The cooldown is spent when the cast leaves: a refused enqueue or a
    // round already cast is *not now*, never a cast (todo 113's rule).
    this.queue.enqueue({
      command: bare ? word : `${word} ${target}`,
      priority: 'combat',
      coalesceKey: `heal:${keys[0]}`,
      decision,
      expiresAt: at + tuning().spells.healExpiresMs,
      reason,
      ...gatedCast(this.gate, found.configured, () => {
        for (const key of keys) this.lastCastAt.set(key, this.now());
        onSent?.();
      })
    });
  }
}
