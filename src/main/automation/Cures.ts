/**
 * Curing, by a sentence — the other half of `AutoHeal`.
 *
 * A heal is chosen by a number; a cure is chosen by the server saying a
 * condition is on this character, which the tracker keeps as a three-state
 * flag (`CharacterState.afflictions`) set and cleared only by the wire. Four
 * conditions have a cure spell to configure: blindness, poison, disease, and
 * a hold (`freedom`, todo 810), whose success is the hold's own wear-off line
 * (`Spell.cs` prints it on the way out), so no sentence of its own is read.
 *
 * ## Once per onset, then patiently
 *
 * The flag stays `yes` until the server says otherwise, and a cure it answers
 * with nothing leaves the flag exactly there. Casting on every status line
 * while it read `yes` would spend the fight's budget on one spell, so the cast
 * goes out on the *edge* — the flag becoming `yes` — and again only after
 * `RETRY_MS` if the condition is still stated: a cure resisted or under-manaed
 * gets a second chance, and a cure that worked but was never announced does
 * not become a cast every three seconds.
 *
 * `<short>` bare in the `combat` band under the shared `minMana` floor,
 * exactly as a self heal, and for the same reasons: a targetless cast lands
 * on the caster, and the realm's short name is itself the command, never
 * behind `c` (`castWord`).
 */
import type { CommandQueue } from './CommandQueue';
import { canPayFor, manaAtLeast } from './mana';
import { t } from '../app/i18n';
import type { Affliction, CharacterState } from '../../shared/character';
import { CURES, type Cure, type SpellsConfig } from '../../shared/config';
import {
  CURE_CONDITION,
  cureGates,
  OPEN_CAST_GATE,
  resolveSpell,
  spellCost,
  spellTargeting,
  type CastGate
} from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';
import type { SessionModule } from './Module';

/** How long a cure that changed nothing is trusted before it is tried again. */
export const RETRY_MS = 30_000;

export class Cures implements SessionModule {
  private lastCastAt = new Map<Cure, number>();
  private previous = new Map<Cure, Affliction>();
  /** The cures derived from the book and said, once each. */
  private saidDerived = new Map<Cure, string>();

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
    /** Where a derived cure is said, once (todo 09). */
    private readonly events: { notice?(message: string): void } = {},
    /** The one heal, blessing or cure a round, asked at the send (`CastRound`). */
    private readonly gate: CastGate = OPEN_CAST_GATE
  ) {}

  configure(config: SpellsConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.lastCastAt.clear();
    this.previous.clear();
    this.saidDerived.clear();
  }

  /**
   * The cheapest spell in the book the realm says cures this affliction —
   * `cureGates`' own reading of the ability rows — cast on the character
   * itself, so never an enemy-targeted spell. Empty where nothing derives, or
   * where the switch is off; the derivation is said once per cure.
   */
  private derived(state: CharacterState, cure: Cure): string {
    if (!this.config.autoChoose || state.spellbook === null) return '';
    let best: { name: string; cost: number } | null = null;
    for (const known of state.spellbook) {
      const realm = this.realmSpell(known.name);
      if (realm === null) continue;
      const aim = spellTargeting(realm.targets);
      if (aim === 'enemy' || aim === 'enemies') continue;
      if (!cureGates([realm.abilities ?? []])[cure]) continue;
      const cost = known.cost ?? realm.mana ?? Number.MAX_SAFE_INTEGER;
      if (best === null || cost < best.cost) best = { name: known.name, cost };
    }
    if (best === null) return '';
    if (this.saidDerived.get(cure) !== best.name) {
      this.saidDerived.set(cure, best.name);
      this.events.notice?.(t('automation.cure.derived', { cure, spell: best.name }));
    }
    return best.name;
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || state.phase !== 'in-game') return;
    for (const cure of CURES) {
      const current = state.afflictions[CURE_CONDITION[cure]];
      const before = this.previous.get(cure);
      this.previous.set(cure, current);
      if (current !== 'yes') continue;

      // The box, or — under *Auto Choose Best Spell* — the book's own cure.
      const spell = this.config.cures[cure].trim() || this.derived(state, cure);
      if (spell.length === 0) continue;
      if (!manaAtLeast(state, this.config.minMana)) continue;

      const at = this.now();
      const last = this.lastCastAt.get(cure);
      const onset = before !== 'yes';
      if (!onset && last !== undefined && at - last < RETRY_MS) continue;

      const found = resolveSpell(spell, state.spellbook, this.realmSpell);
      /*
       * A cure that cannot be paid for is not sent, and the onset is not
       * spent on it: the flag stays `yes`, so the cast goes out on the first
       * status line that can pay for it rather than waiting out the retry
       * clock. See `canPayFor`.
       */
      if (!canPayFor(state, spellCost(found))) continue;
      // Spent when the cast leaves, so one held for the round stays due.
      this.queue.enqueue({
        command: found.word,
        priority: 'combat',
        coalesceKey: `cure:${cure}`,
        expiresAt: at + tuning().spells.cureExpiresMs,
        stillWanted: () => this.gate.mayCast(found.configured),
        reason: t('automation.cure.reason', { cure }),
        onSent: () => {
          this.lastCastAt.set(cure, this.now());
          this.gate.noteCast();
        }
      });
    }
  }
}
