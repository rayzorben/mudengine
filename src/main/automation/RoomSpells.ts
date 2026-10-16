/**
 * Which room spell a crowded round is cast with, and the debuff cast first
 * (todo 55). With *Auto Choose Best Spell* on, the book's room spells follow
 * `areaAttack` by damage per mana (`rankRoomSpells`), so the next takes over
 * when the first is capped, refused or unpaid; and a debuff that lowers the
 * room's `M.R.` by more than the round it costs is cast once a fight ahead of
 * the room spell (`chooseDebuff`). `AttackSpells` asks and casts. The rules:
 * `mudengine-automation` › `parts/combat.md` › *The room spell*.
 */
import { t } from '../app/i18n';
import { standingOf, type CharacterState } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import type { NoticeSink } from '../../shared/decisionSettings';
import { attacksFirst, type MobRule } from '../../shared/mobRules';
import type { ProwessClass } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import {
  chooseDebuff,
  rankRoomSpells,
  type DebuffChoice,
  type RoomCaster
} from '../../shared/roomspells';
import type { SpellTarget as ChoiceTarget } from '../../shared/spellchoice';
import { resolveSpell, spellCost } from '../../shared/spellcraft';
import { prowessSheetOf } from '../../shared/verdict';
import { mobKey, type WorldSpell } from '../../shared/world';
import type { SpellTarget } from './AttackSpells';

export class RoomSpells {
  /** Debuffs cast this fight, by the book's spelling: one cast a fight (`Spell.cs:1046`). */
  private readonly debuffed = new Set<string>();
  /** The debuff proposed and not yet sent. */
  private pending: string | null = null;
  /** The take-over last said, so it is said on change only. */
  private saidTakeover: string | null = null;

  constructor(
    private spells: Pick<SpellsConfig, 'autoChoose'>,
    private readonly notice: NoticeSink,
    private readonly realmSpell: (name: string) => WorldSpell | null,
    private readonly realmClass: () => ProwessClass & { family: RealmFamily | null }
  ) {}

  configure(spells: Pick<SpellsConfig, 'autoChoose'>): void {
    this.spells = spells;
  }

  /** A new connection. */
  reset(): void {
    this.fightEnded();
    this.saidTakeover = null;
  }

  fightEnded(): void {
    this.debuffed.clear();
    this.pending = null;
  }

  /** A command went: the debuff proposed is now cast this fight. */
  sent(spell: string): void {
    if (this.pending !== null && this.pending === spell) this.debuffed.add(spell);
    this.pending = null;
  }

  /**
   * The room spells to try in order: `typed` first, then, with *Auto Choose
   * Best Spell* on, the book's by damage per mana. Blank `typed` and the
   * setting off is none.
   */
  candidates(
    state: CharacterState,
    typed: string,
    rules: readonly MobRule[],
    target: SpellTarget
  ): string[] {
    const first = typed.length > 0 ? [typed] : [];
    const caster = this.casterOf(state);
    if (!this.spells.autoChoose || caster === null) return first;
    // The book's spelling, so a short `areaAttack` (`fbal`) is not ranked a second time.
    const excluded = new Set(first.map((spell) => bookName(spell, state)));
    const ranked = rankRoomSpells(caster, this.monstersOf(state, rules, target), excluded);
    return [...first, ...ranked.map((candidate) => candidate.spell.name)];
  }

  /** Says which room spell took over from the first, once per change. */
  tookOver(state: CharacterState, typed: string, spell: string): void {
    const first = bookName(typed, state);
    const key = `${first}\u0000${spell}`;
    if (first === bookName(spell, state)) {
      // The first is back, so a later take-over is a change again.
      this.saidTakeover = null;
      return;
    }
    if (this.saidTakeover === key) return;
    this.saidTakeover = key;
    this.notice(t('automation.spells.roomTakeover', { first, spell }), 'room-spell');
  }

  /**
   * The debuff to cast before `room` this round, or null: *Auto Choose Best
   * Spell* on, none cast yet this fight, and `chooseDebuff` says it pays.
   * `allowed` is the caller's caps, refusals and pool.
   */
  debuffFirst(
    state: CharacterState,
    room: string,
    rules: readonly MobRule[],
    target: SpellTarget,
    allowed: (spell: string) => boolean
  ): DebuffChoice | null {
    if (!this.spells.autoChoose || this.debuffed.size > 0) return null;
    const caster = this.casterOf(state);
    const found = resolveSpell(room, state.spellbook, this.realmSpell);
    const realm = found.realm ?? (found.known === null ? null : this.realmSpell(found.known.name));
    if (caster === null || realm === null) return null;
    const excluded = new Set(caster.book.filter((s) => !allowed(s.name)).map((s) => s.name));
    const choice = chooseDebuff({
      caster,
      room: { realm, cost: spellCost(found) },
      monsters: this.monstersOf(state, rules, target),
      excluded
    });
    if (choice === null) return null;
    if (this.pending === choice.spell.name) return choice;
    this.pending = choice.spell.name;
    const said = {
      spell: choice.spell.name,
      room: bookName(room, state),
      gain: Math.round(choice.gain)
    };
    this.notice(
      choice.area
        ? t('automation.spells.debuffFirst', said)
        : t('automation.spells.debuffFirstAt', { ...said, target: target.name }),
      'room-debuff-first'
    );
    return choice;
  }

  private casterOf(state: CharacterState): RoomCaster | null {
    if (state.spellbook === null) return null;
    const { combat, magery, crits, rounds, family } = this.realmClass();
    return {
      book: state.spellbook,
      realm: this.realmSpell,
      level: state.progress.level,
      sheet: prowessSheetOf(state, { combat, magery, crits, rounds }),
      family
    };
  }

  /**
   * The monsters a room spell lands on that count: the target first, then
   * every other that is in this fight or would join it, as the crowd is
   * counted (`countThreats`), each with what the realm says of it.
   */
  private monstersOf(
    state: CharacterState,
    rules: readonly MobRule[],
    target: SpellTarget
  ): ChoiceTarget[] {
    const standing = standingOf(state);
    // The target's own entry is left out once: a room can list several of the same name.
    const own = state.room.occupants.findIndex(
      (who) => who.kind === 'mob' && mobKey(who.name) === mobKey(target.name)
    );
    const others = state.room.occupants.filter(
      (who, index) =>
        who.kind === 'mob' &&
        index !== own &&
        (attacksFirst(who, standing, rules) === true ||
          state.combat.attackers.some((name) => mobKey(name) === mobKey(who.name)))
    );
    const of = (entity: SpellTarget['entity'], remaining: number | null): ChoiceTarget => ({
      remaining,
      magicRes: entity?.magicResist ?? null,
      abilities: entity?.abilities,
      nature: entity?.nature
    });
    return [
      of(target.entity, target.remaining),
      ...others.map((who) => of(who.mob ?? null, who.mob?.hp ?? null))
    ];
  }
}

/** The book's name for a configured spell, or the word as typed when the book has none. */
function bookName(spell: string, state: CharacterState): string {
  return resolveSpell(spell, state.spellbook).known?.name ?? spell;
}
