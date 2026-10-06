/**
 * The attack spell: which one a fight is fought with, what the server is
 * repeating, and the one command a round owes when that should change.
 *
 * Out of `AutoCombat` (todo 816), which asks it what to open a fight with and
 * what a round sends. A combat spell engages its target and the server casts
 * it every round from then on, unasked, for as long as the mana lasts
 * (`Player.cs:6188`, `DoMagicRound`; MajorMUD capture 168, one `fist st` and
 * nine earthfists; GreaterMUD wire, vaelor2 2026-09-01). So a spell opens the
 * fight in place of the attack verb, a round sends only a change of action,
 * and the server's own repeats are what the casts are counted on. The rules:
 * `mudengine-automation` › `parts/combat.md` › *An attack spell opens the
 * fight, and the server casts it every round*.
 */
import { canPayFor } from './mana';
import { countMobs, countThreats } from './RuleEngine';
import { DrainWhenHurt } from './DrainWhenHurt';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { castAimedAt } from '../../shared/aim';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import { NO_INSTANT_SPELLS, type InstantSpellLore } from '../../shared/lore';
import { isBanded, mobRuleFor, type MobCast, type MobRule } from '../../shared/mobRules';
import type { MobEntity } from '../../shared/entities';
import type { RealmFamily } from '../../shared/realm';
import { resolveSpell, sameSpell, spellCost, spellingsOf } from '../../shared/spellcraft';
import { spellKey } from '../../shared/spell-messages';
import { spellReaches } from '../../shared/spellReach';
import {
  chooseAttackSpell,
  type SpellChoice,
  type SpellChoiceRefusal
} from '../../shared/spellchoice';
import { prowessSheetOf } from '../../shared/verdict';
import { mobKey, type WorldSpell } from '../../shared/world';

/**
 * What the server does each round of this character's fight, as the commands
 * left it, and whose command a spell was: the player's is theirs to change.
 */
export type Action =
  { kind: 'spell'; spell: string; area: boolean; by: 'module' | 'player' } | { kind: 'melee' };

/** A command to send, and the action the server repeats once it has gone. */
export interface Proposal {
  command: string;
  action: Action;
  reason: string;
}

/** The monster a spell is chosen for: the fight's target, or the one about to be opened on. */
export interface SpellTarget {
  name: string;
  entity: MobEntity | null;
  /** What the fight has left of it, where a blow or a look has said. */
  remaining: number | null;
}

/** What this unit says and asks for; `AutoCombatEvents` carries both. */
export interface AttackSpellEvents {
  notice?(message: string): void;
  /** The spellbook has never been read and *Auto Choose Best Spell* needs it. */
  needBook?(): void;
}

/**
 * Whether a line is a cast's own result — what an instant spell prints where a
 * combat spell prints `*Combat Engaged*` (`TryInvokeSpell`, `Player.cs:6225`):
 * the confirmation, the fizzle, the immunity, or the blow it lands.
 */
export function isCastResult(block: Block): boolean {
  if (block.type === 'spell-failed' || block.type === 'spell-ineffective') return true;
  if (block.type === 'spell-cast') return block.groups['caster'] === 'You';
  return (
    block.type === 'user-hits' &&
    block.groups['attacker'] === 'You' &&
    (block.groups['line'] ?? '').trim().toLowerCase().startsWith('cast ')
  );
}

/** The command that stops the spell the server repeats: MegaMUD's own. */
const BREAK = 'break';

/** A spell worth casting, by the name its casts are counted under, and the word that casts it. */
interface Wanted {
  spell: string;
  area: boolean;
  word: string;
}

export class AttackSpells {
  /**
   * What the server repeats each round, as far as the commands sent say: set
   * when an attack or a cast leaves (`sent`, `typed`), kept through the
   * `*Combat Off*` / `*Combat Engaged*` pair that answers one, and forgotten
   * when a fight ends any other way. Null is unknown, which changes nothing
   * to melee: a round never spends a command undoing what nobody asked for.
   */
  private repeating: Action | null = null;
  /**
   * The spell this module last cast, until an engagement answers it. A
   * confirmation or a fizzle first is an instant spell: it is invoked at once
   * and engages nothing (`Player.cs:6044-6049`), where a combat spell prints
   * `*Combat Engaged*` and rolls only in the rounds after (`DoMagicRound`).
   *
   * `afterOff`: cast while the server was repeating a spell, whose own repeats
   * go on arriving until the cast is read. Every cast into a fight is answered
   * `*Combat Off*` first (`BreakCombat(true)` before either path,
   * `Player.cs:6083`), so only what follows that Off is the cast's answer; a
   * confirmation ahead of it is a repeat, and read as one marked the spell
   * instant for the connection (818, on 816's review).
   */
  private awaiting: { spell: string; afterOff: boolean } | null = null;
  /**
   * Spells known to be instant, by every spelling, for this connection. The
   * realm's table cannot say (no `Spell Type` in any of the three `.mdb`s), so
   * the wire does: such a spell never opens a fight and is cast each round.
   * What the wire taught is the realm's (`realmInstants`, todo 820); this is
   * what the connection has learned or read back, and said.
   */
  private readonly instant = new Set<string>();
  /** Spells the server has said have no effect on the book's monster, by `keyOf`. */
  private readonly ineffective = new Set<string>();
  /** Confirmed casts against the book's monster, by `keyOf` — the caps. */
  private readonly casts = new Map<string, number>();
  /** The character's spellbook as of the last state handed in: what `keyOf` resolves against. */
  private book: CharacterState['spellbook'] = null;
  /**
   * The monster the counts and refusals are about, by key. A new one opens the
   * book again (MegaMUD's `ClearOnceEngaged`); the target going null between
   * the two halves of a re-engagement does not.
   */
  private bookFor: string | null = null;
  /** The derived spell last said, so the choice is announced on change only. */
  private saidChoice: string | null = null;
  /** The derivation's last refusal said, once per kind. */
  private saidChoiceRefusal: SpellChoiceRefusal | null = null;
  private rules: readonly MobRule[] = [];
  /** Whether the drain spells stand in while hurt, and which: asked, never decided here. */
  private readonly drain: DrainWhenHurt;

  constructor(
    private spells: SpellsConfig,
    private readonly events: AttackSpellEvents,
    private readonly realmSpell: (name: string) => WorldSpell | null,
    private readonly realmClass: () => {
      combat: number | null;
      magery: number | null;
      family: RealmFamily | null;
    },
    /** The attack spells this realm has answered instantly before, kept past the connection. */
    private readonly realmInstants: InstantSpellLore = NO_INSTANT_SPELLS,
    realmSpellById: (id: number) => WorldSpell | null = () => null
  ) {
    this.drain = new DrainWhenHurt(
      spells,
      (message) => events.notice?.(message),
      realmSpell,
      realmSpellById
    );
  }

  configure(spells: SpellsConfig | undefined, rules: readonly MobRule[]): void {
    if (spells) {
      this.spells = spells;
      this.drain.configure(spells);
    }
    this.rules = rules;
  }

  /** A new connection. */
  reset(): void {
    this.fightEnded();
    this.instant.clear();
    this.drain.reset();
    this.saidChoice = null;
    this.saidChoiceRefusal = null;
  }

  /** The fight ended some way other than an attack's own re-engagement. */
  fightEnded(): void {
    this.repeating = null;
    this.awaiting = null;
    this.bookFor = null;
    this.ineffective.clear();
    this.casts.clear();
  }

  /** The fight's target, as each state has it. A new monster opens the book again. */
  onTarget(target: string | null): void {
    if (target === null || mobKey(target) === this.bookFor) return;
    this.bookFor = mobKey(target);
    this.ineffective.clear();
    this.casts.clear();
  }

  /** Whether the round tick has anything of this unit's to decide. */
  get ticks(): boolean {
    return (
      this.spells.autoChoose ||
      this.spells.attack.trim().length > 0 ||
      this.spells.areaAttack.trim().length > 0 ||
      this.drain.armed ||
      this.rules.some((row) => isBanded(row) && row.cast !== undefined) ||
      this.repeating?.kind === 'spell'
    );
  }

  /** What an attack or a cast this module proposed does once it has gone. */
  sent(action: Action): void {
    this.awaiting =
      action.kind === 'spell'
        ? { spell: action.spell, afterOff: this.repeating?.kind === 'spell' }
        : null;
    this.repeating = action;
  }

  /**
   * The player's own attack (`attackAim` said it is one): what the server
   * repeats is theirs now — that spell, by the word typed, which this module
   * then leaves alone, or the melee round.
   */
  typed(command: string, state: CharacterState): void {
    const cast = castAimedAt(command, state.spellbook, this.realmSpell);
    this.awaiting = null;
    this.repeating =
      cast === null
        ? { kind: 'melee' }
        : { kind: 'spell', spell: cast.word, area: false, by: 'player' };
  }

  /**
   * The spell to open a fight on `target` with, in place of the attack verb,
   * or null. Never the area spell: a bare cast names nobody for the
   * engagement to bind, and the crowd is the round's to answer.
   */
  opening(state: CharacterState, target: SpellTarget, why: string): Proposal | null {
    const wanted = this.wanted(state, target, true);
    if (wanted === null) return null;
    return {
      command: `${wanted.word} ${target.name}`,
      action: { kind: 'spell', spell: wanted.spell, area: false, by: 'module' },
      reason: t('automation.combat.reason', { why })
    };
  }

  /**
   * The one command this round owes, or null: a spell the server is not
   * already repeating, or `melee` once the spell it is repeating is spent,
   * refused, capped or past what the pool pays for (`DoMagicRound` then
   * casts nothing and the character stands in the fight doing nothing). An
   * instant spell repeats nothing, so it is cast each round it is wanted; and
   * a spell the player cast is theirs, left alone either way.
   */
  change(state: CharacterState, target: SpellTarget, melee: string): Proposal | null {
    const repeating = this.repeating;
    if (repeating?.kind === 'spell' && repeating.by === 'player') return null;
    const book = state.spellbook;
    const wanted = this.wanted(state, target, false);
    if (wanted !== null) {
      const instant = this.isInstant(wanted.spell, book);
      if (
        !instant &&
        repeating?.kind === 'spell' &&
        sameSpell(repeating.spell, wanted.spell, book, this.realmSpell)
      )
        return null;
      return {
        command: wanted.area ? wanted.word : `${wanted.word} ${target.name}`,
        action: { kind: 'spell', spell: wanted.spell, area: wanted.area, by: 'module' },
        reason: wanted.area
          ? t('automation.combat.reasonRoundAreaSpell')
          : t('automation.combat.reasonRoundSpell')
      };
    }
    if (repeating?.kind !== 'spell' || melee.length === 0) return null;
    return {
      command: `${melee} ${target.name}`,
      action: { kind: 'melee' },
      reason: t('automation.combat.reasonRoundMelee', { spell: repeating.spell, verb: melee })
    };
  }

  /**
   * `break`, when the area spell this module cast has just emptied the room
   * on a MajorMUD realm, or null. The server there goes on casting it with
   * nothing to land on, and MegaMUD breaks it for stock realms only ("When an
   * area spell finishes a mob, the client now sends break"). GreaterMUD
   * stops the spell itself (`DoMagicRound`, `BreakCombat(true)`,
   * `Player.cs:6326`). No capture of a stock realm shows it (todo 828).
   * Once, because the break's send ends what the server repeats.
   */
  breakEmptied(
    was: CharacterState,
    state: CharacterState
  ): Pick<Proposal, 'command' | 'reason'> | null {
    const cast = this.repeated;
    // The same room: a new one listed empty is a move, which ends the fight on its own.
    const sameRoom = was.room.name === state.room.name && was.room.arrival === state.room.arrival;
    if (cast === null || !sameRoom || countMobs(was.room.occupants) === 0) return null;
    if (!this.breakWanted(state)) return null;
    return {
      command: BREAK,
      reason: t('automation.combat.reasonBreakEmptyRoom', { spell: cast.spell })
    };
  }

  /**
   * Whether a `break` still has something to stop: this module's area spell
   * repeating on a MajorMUD realm, into a room with no monster listed. Asked
   * again at the send, since one may walk in while it waits.
   */
  breakWanted(state: CharacterState): boolean {
    const cast = this.repeated;
    return (
      cast !== null &&
      cast.area &&
      cast.by === 'module' &&
      this.realmClass().family === 'majormud' &&
      countMobs(state.room.occupants) === 0
    );
  }

  /** A line was classified: an engagement, a cast confirmed or fizzled, or refused as having no effect. */
  heard(block: Block, state: CharacterState | null): void {
    const book = state?.spellbook ?? null;
    this.book = book;
    if (block.type === 'combat-status' && block.groups['status'] === 'Engaged')
      this.noteEngaged(book);
    else if (
      block.type === 'combat-status' &&
      block.groups['status'] === 'Off' &&
      this.awaiting?.afterOff === true
    )
      this.awaiting = { ...this.awaiting, afterOff: false };
    else if (block.type === 'spell-ineffective') this.noteIneffective();
    else if (block.type === 'spell-failed') this.noteFizzle(block.groups['spell'] ?? '', book);
    else if (block.type === 'spell-cast') this.noteCast(block, book);
    else if (block.type === 'user-hits') this.noteHit(block, book);
  }

  /**
   * A fizzle before any engagement is the roll an instant spell makes at the
   * cast (a combat spell rolls only in the rounds after it): it says the
   * spell is instant, and is no cast.
   */
  private noteFizzle(said: string, book: CharacterState['spellbook']): void {
    const awaiting = this.awaiting;
    if (awaiting === null || !this.noteInstant(said, book)) return;
    const key = this.keyOf(awaiting.spell);
    const casts = (this.casts.get(key) ?? 1) - 1;
    if (casts > 0) this.casts.set(key, casts);
    else this.casts.delete(key);
  }

  /**
   * One key per spell, however it was written — `hr` typed and `harm`
   * configured are one spell: its name (`nameOf`), else as written.
   */
  private keyOf(spell: string): string {
    return this.nameOf(spell, this.book) ?? spell.trim();
  }

  /**
   * A spell's name, which the books and what the realm taught are kept under:
   * the listing's, which is the wire's own word on this character's spells,
   * else the realm row's where the row matched the whole name, else null. A
   * short word the realm's rows share (`word`: exalted, tainted, balanced) is
   * answered with the first row and no word of the ambiguity, and a lesson
   * filed under that guess would be every character's on the realm.
   */
  private nameOf(spell: string, book: CharacterState['spellbook']): string | null {
    const found = resolveSpell(spell, book, this.realmSpell);
    if (found.known !== null) return found.known.name;
    const row = found.realm;
    return row !== null && spellKey(row.name) === spellKey(spell) ? row.name : null;
  }

  /**
   * Whether the spell is instant: learned this connection, or read back from
   * what the realm taught an earlier one — said once when it is, since it is
   * why the fight opens with the attack verb instead.
   */
  private isInstant(spell: string, book: CharacterState['spellbook']): boolean {
    const spellings = spellingsOf(spell, book, this.realmSpell);
    if (spellings.some((name) => this.instant.has(name))) return true;
    const name = this.nameOf(spell, book);
    if (name === null || !this.realmInstants.isInstantSpell(name)) return false;
    for (const spelling of spellings) this.instant.add(spelling);
    this.events.notice?.(t('automation.combat.spellInstantRemembered', { spell }));
    return true;
  }

  /**
   * The awaited cast answered by `*Combat Engaged*`: a combat spell, whatever
   * was held. A spell held instant that engages was misread (on this
   * connection or an earlier one), and a lesson kept for the realm would
   * otherwise recast it every round, breaking the fight each time, for good.
   * Forgotten, and said.
   */
  private noteEngaged(book: CharacterState['spellbook']): void {
    const awaiting = this.awaiting;
    this.awaiting = null;
    if (awaiting === null || awaiting.afterOff) return;
    const spellings = spellingsOf(awaiting.spell, book, this.realmSpell);
    if (!spellings.some((spelling) => this.instant.has(spelling))) return;
    for (const spelling of spellings) this.instant.delete(spelling);
    const name = this.nameOf(awaiting.spell, book);
    if (name !== null) this.realmInstants.forgetInstantSpell(name);
    this.events.notice?.(t('automation.combat.spellNotInstant', { spell: awaiting.spell }));
  }

  /**
   * The awaited cast answered by its own confirmation or fizzle before any
   * engagement: an instant spell, which the server repeats nothing of. A
   * confirmation is one of the cap's casts. Said once, since it changes what
   * opens, and kept for the realm, so the next connection does not pay the
   * opening again. Whether the sentence was the awaited cast's.
   */
  private noteInstant(said: string, book: CharacterState['spellbook']): boolean {
    const awaiting = this.awaiting;
    const name = said.trim().toLowerCase();
    if (awaiting === null || awaiting.afterOff || name.length === 0) return false;
    const spellings = spellingsOf(awaiting.spell, book, this.realmSpell);
    if (!spellings.includes(name)) return false;
    this.awaiting = null;
    this.repeating = null;
    this.count(awaiting.spell);
    if (this.isInstant(awaiting.spell, book)) return true;
    for (const spelling of spellings) this.instant.add(spelling);
    const kept = this.nameOf(awaiting.spell, book);
    if (kept === null) {
      this.events.notice?.(t('automation.combat.spellInstantUnkept', { spell: awaiting.spell }));
      return true;
    }
    this.realmInstants.observeInstantSpell(kept, Date.now());
    this.events.notice?.(t('automation.combat.spellInstant', { spell: awaiting.spell }));
    return true;
  }

  /**
   * The spell to fight `target` with now, or null for the melee round.
   *
   * The monster's own row first — the player named the spell for this one —
   * then the room spell when the fight is crowded enough, then the derived or
   * typed spell. Each is passed over once refused on this monster, capped, or
   * beyond the pool, and a row's spell spent is not cast again by the path
   * behind it.
   */
  private wanted(state: CharacterState, target: SpellTarget, opening: boolean): Wanted | null {
    this.book = state.spellbook;
    // The refusals are about the monster cast at, the one about to be opened on included.
    this.onTarget(target.name);
    const { mana, manaMax } = state.vitals;
    const fraction = mana !== null && manaMax !== null && manaMax > 0 ? mana / manaMax : null;
    const above = (floor: number): boolean => floor <= 0 || fraction === null || fraction >= floor;

    /*
     * Hurt: the room's drain, then the single-target one, ahead of the
     * monster's row, since the row is a preference about the monster and this
     * is the character's own health. A drain spent or refused here falls
     * through to the ordinary choice.
     */
    const drain = this.drain.standIn(state);
    if (drain !== null) {
      const room = this.roomSpell(state, drain.area, opening, above);
      if (room !== null) return room;
      if (above(this.spells.minMana)) {
        const single = drain.choose
          ? this.chosenSpell(
              state,
              target,
              () => false,
              (spell) => this.drain.choosable(spell)
            )
          : drain.single;
        if (
          single !== null &&
          single.length > 0 &&
          this.usable(single, this.spells.attackCasts) &&
          !this.ruledOut(single, target)
        ) {
          const cast = this.payable(state, single, false, opening);
          if (cast !== null) return cast;
        }
      }
    }

    const row = mobRuleFor(this.rules, target.name);
    const own: MobCast | undefined = row !== undefined && isBanded(row) ? row.cast : undefined;
    const spent = own !== undefined && !this.usable(own.spell, own.times);
    if (
      own !== undefined &&
      !spent &&
      above(this.spells.minMana) &&
      !this.ruledOut(own.spell, target)
    ) {
      const cast = this.payable(state, own.spell, false, opening);
      if (cast !== null) return cast;
    }
    const passedOver = (spell: string): boolean =>
      spent && own !== undefined && mobKey(spell) === mobKey(own.spell);

    /*
     * The room spell, when the fight is crowded enough to earn it — MegaMUD's
     * MultAttack. Its own mana floor, never below the single-target one; never
     * while a monster the realm is sure is good stands here, since a room
     * spell hits it too and the ten evil points are spent unasked; and the
     * crowd is threats (what is in this fight or would join it), never
     * `countMobs`, which counts a shopkeeper and a guard dog alike.
     */
    const room = this.roomSpell(state, this.spells.areaAttack.trim(), opening, above);
    if (room !== null) return room;

    if (!above(this.spells.minMana)) return null;
    // *Auto Choose Best Spell*: the round spell is derived, not typed (todo 09).
    if (this.spells.autoChoose) {
      const chosen = this.chosenSpell(state, target, passedOver);
      return chosen === null ? null : this.payable(state, chosen, false, opening);
    }
    const attack = this.spells.attack.trim();
    if (attack.length === 0) return null;
    /*
     * Once the server has said the round spell has no effect on this target,
     * the fallback stands in for the rest of the fight — MegaMUD's
     * `FailoverSpellAttacks`. No fallback, or the fallback refused too, and
     * the melee round carries it: the fallback is never cast *first*.
     */
    const spell = this.ruledOut(attack, target) ? this.spells.attackFallback.trim() : attack;
    if (spell.length === 0 || !this.usable(spell, this.spells.attackCasts)) return null;
    if (passedOver(spell) || this.ruledOut(spell, target)) return null;
    return this.payable(state, spell, false, opening);
  }

  /** `area` cast bare at the room, where the fight is crowded enough to earn it (see `wanted`), or null. */
  private roomSpell(
    state: CharacterState,
    area: string,
    opening: boolean,
    above: (floor: number) => boolean
  ): Wanted | null {
    if (opening || area.length === 0 || !this.usable(area, this.spells.areaCasts)) return null;
    const costly = state.room.occupants.some(
      (who) => who.kind === 'mob' && who.costly === 'always'
    );
    const crowd = Math.max(countThreats(state, this.rules), state.combat.attackers.length);
    const floor = Math.max(this.spells.areaMinMana, this.spells.minMana);
    if (costly || crowd < this.spells.areaMinMobs || !above(floor)) return null;
    return this.payable(state, area, true, opening);
  }

  /**
   * Whether `spell` is ruled out on `target`: refused on it this fight, or
   * one the world database says has no effect on it (`spellReaches`), which
   * this records for the fight and says once, since the server would answer
   * it so and break the fight (`BreakCombat(false)`).
   */
  private ruledOut(spell: string, target: SpellTarget): boolean {
    if (this.ineffective.has(this.keyOf(spell))) return true;
    const row = resolveSpell(spell, this.book, this.realmSpell).realm;
    if (row === null || spellReaches(row, target.entity?.nature) !== false) return false;
    this.ineffective.add(this.keyOf(spell));
    this.events.notice?.(t('automation.combat.spellNoEffectKnown', { spell, target: target.name }));
    return true;
  }

  /** Neither refused on this monster nor past `cap` confirmed casts (0 is no cap). */
  private usable(spell: string, cap: number): boolean {
    const key = this.keyOf(spell);
    if (this.ineffective.has(key)) return false;
    return cap <= 0 || (this.casts.get(key) ?? 0) < cap;
  }

  /**
   * The spell, where the pool can pay for it — the realm's arithmetic, where
   * `minMana` is the player's policy. A spell costing two on a character
   * holding one is answered out loud in the room; unknown never refuses.
   */
  private payable(
    state: CharacterState,
    spell: string,
    area: boolean,
    opening: boolean
  ): Wanted | null {
    // An instant spell engages nothing, so it opens no fight (`noteInstant`).
    if (opening && this.isInstant(spell, state.spellbook)) return null;
    const found = resolveSpell(spell, state.spellbook, this.realmSpell);
    if (!canPayFor(state, spellCost(found))) return null;
    return { spell, area, word: found.word };
  }

  /**
   * The best attack spell for this target, now, from the book the client has
   * read and the realm's own figures — `chooseAttackSpell`. The spells the
   * server has refused on this target and the ones capped this fight are
   * excluded, which is how the fallback derives itself; so is a row's spell
   * once spent. A choice that changes is said; a refusal is said once per
   * kind, and an unread book is asked for. `only` narrows the book (the
   * drains); finding nothing there is not said, since the ordinary choice is
   * asked next.
   */
  private chosenSpell(
    state: CharacterState,
    target: SpellTarget,
    passedOver: (spell: string) => boolean,
    only?: (spell: string) => boolean
  ): string | null {
    const { combat, magery, family } = this.realmClass();
    const excluded = new Set<string>(this.ineffective);
    if (this.spells.attackCasts > 0) {
      for (const [spell, count] of this.casts) {
        if (count >= this.spells.attackCasts) excluded.add(spell);
      }
    }
    for (const spell of state.spellbook ?? []) {
      if (passedOver(spell.name) || (spell.short !== null && passedOver(spell.short))) {
        excluded.add(spell.name);
      }
    }
    const book =
      only === undefined ? state.spellbook : (state.spellbook?.filter((s) => only(s.name)) ?? null);
    const choice = chooseAttackSpell(
      book === null
        ? { book: null }
        : {
            book,
            realm: this.realmSpell,
            level: state.progress.level,
            mana: state.vitals.mana,
            sheet: prowessSheetOf(state, { combat, magery }),
            family,
            pool: state.vitals.manaType,
            target: {
              remaining: target.remaining,
              magicRes: target.entity?.magicResist ?? null,
              abilities: target.entity?.abilities,
              nature: target.entity?.nature
            },
            excluded,
            killConfidence: tuning().spells.killConfidence
          }
    );
    if (choice.chosen === null) {
      if (only === undefined) this.sayChoiceRefusal(choice.refusal);
      return null;
    }
    // The drain's own notice names the switch; saying the pick too would
    // flip the announced spell each round a drain goes unpaid.
    if (only === undefined) this.sayChoice(choice);
    return choice.chosen.spell.name;
  }

  private sayChoice(choice: SpellChoice): void {
    const chosen = choice.chosen;
    if (chosen === null) return;
    const key = `${chosen.spell.name}|${choice.why}`;
    if (this.saidChoice === key) return;
    this.saidChoice = key;
    this.saidChoiceRefusal = null;
    const params = {
      spell: chosen.spell.name,
      min: chosen.min,
      max: chosen.max,
      expected: Math.round(chosen.expected),
      cost: chosen.cost ?? '?'
    };
    this.events.notice?.(
      choice.why === 'kills'
        ? t('automation.spells.choseKills', params)
        : t('automation.spells.choseHardest', params)
    );
  }

  private sayChoiceRefusal(refusal: SpellChoiceRefusal | null): void {
    if (refusal === null || refusal === 'no-mana') return;
    if (this.saidChoiceRefusal === refusal) return;
    this.saidChoiceRefusal = refusal;
    this.saidChoice = null;
    switch (refusal) {
      case 'no-book':
        this.events.notice?.(t('automation.spells.noBookYet'));
        this.events.needBook?.();
        return;
      case 'empty-book':
        this.events.notice?.(t('automation.spells.emptyBook'));
        return;
      case 'kai':
        this.events.notice?.(t('automation.spells.kai'));
        return;
      case 'no-attack-spells':
        this.events.notice?.(t('automation.spells.noAttackSpells'));
        return;
      case 'all-resisted':
        this.events.notice?.(t('automation.spells.allResisted'));
        return;
      case 'no-effect':
        this.events.notice?.(t('automation.spells.noEffect'));
        return;
      default: {
        const never: never = refusal;
        return never;
      }
    }
  }

  /** The spell the server is repeating, while it is one. */
  private get repeated(): Extract<Action, { kind: 'spell' }> | null {
    return this.repeating?.kind === 'spell' ? this.repeating : null;
  }

  /**
   * `Your spell has no effect on <name>.` — immunity (`Player.cs:5919`). The
   * sentence never names the spell; the one the server is repeating is the
   * one it is about. Said once per spell per target, because what the client
   * does next is a decision a person should be able to read back.
   */
  private noteIneffective(): void {
    const cast = this.repeated;
    if (cast === null || this.ineffective.has(this.keyOf(cast.spell))) return;
    this.ineffective.add(this.keyOf(cast.spell));
    const fallback = this.spells.attackFallback.trim();
    if (cast.area) {
      this.events.notice?.(t('automation.combat.spellIneffectiveArea', { spell: cast.spell }));
    } else if (
      this.drain.draining &&
      (this.drain.isDrain(cast.spell) || this.keyOf(this.spells.drain) === this.keyOf(cast.spell))
    ) {
      this.events.notice?.(t('automation.combat.drainIneffective', { spell: cast.spell }));
    } else if (
      fallback.length > 0 &&
      fallback !== cast.spell &&
      !this.ineffective.has(this.keyOf(fallback))
    ) {
      this.events.notice?.(
        t('automation.combat.spellIneffective', { spell: cast.spell, fallback })
      );
    } else {
      this.events.notice?.(
        t('automation.combat.spellIneffectiveNoFallback', { spell: cast.spell })
      );
    }
  }

  /**
   * A cast the server confirmed in the `You cast X on Y` frame, counted
   * against the spell it is repeating and no other: a heal confirmed in the
   * same round is a different spell. A fizzle confirms nothing.
   */
  private noteCast(block: Block, book: CharacterState['spellbook']): void {
    if (block.groups['caster'] !== 'You' || block.groups['announced'] !== undefined) return;
    const said = (block.groups['spell'] ?? '').trim().toLowerCase();
    if (this.noteInstant(said, book)) return;
    const cast = this.repeated;
    if (cast === null || !spellingsOf(cast.spell, book, this.realmSpell).includes(said)) return;
    this.count(cast.spell);
  }

  /**
   * A single-target cast that landed prints as a blow — `You cast harm at
   * tall kobold thief for 15 damage!` — once per cast the server repeats,
   * two a round where the energy allows. Each is one of the cap's casts.
   * Not an area spell's, which prints one of these per monster it lands on.
   */
  private noteHit(block: Block, book: CharacterState['spellbook']): void {
    if (block.groups['attacker'] !== 'You') return;
    const line = (block.groups['line'] ?? '').trim().toLowerCase();
    const names = (spell: string): string | undefined =>
      spellingsOf(spell, book, this.realmSpell).find((name) => line.startsWith(`cast ${name} `));
    const awaited = this.awaiting === null ? undefined : names(this.awaiting.spell);
    if (awaited !== undefined && this.noteInstant(awaited, book)) return;
    const cast = this.repeated;
    if (cast === null || cast.area) return;
    if (names(cast.spell) !== undefined) this.count(cast.spell);
  }

  private count(spell: string): void {
    const key = this.keyOf(spell);
    this.casts.set(key, (this.casts.get(key) ?? 0) + 1);
  }
}
