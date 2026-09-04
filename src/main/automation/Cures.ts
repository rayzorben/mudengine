/**
 * Curing, by a sentence — the other half of `AutoHeal`.
 *
 * A heal is chosen by a number; a cure is chosen by the server saying a
 * condition is on this character, which the tracker keeps as a three-state
 * flag (`CharacterState.afflictions`) set and cleared only by the wire. Three
 * conditions have a cure spell to configure: blindness, poison and disease.
 * Paralysis is tracked too and has none here, because no capture names a
 * spell that ends it and a spell name from memory is a command said out loud.
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
 * `c <short>` bare in the `combat` band under the shared `minMana` floor,
 * exactly as a self heal, and for the same reasons: a targetless cast lands
 * on the caster, and the `Cast` command reads exactly one word as the spell,
 * which is the realm's short name (`castWord`).
 */
import type { CommandQueue } from './CommandQueue';
import { canPayFor, manaAtLeast } from './mana';
import { t } from '../app/i18n';
import type { Affliction, Afflictions, CharacterState } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import { resolveSpell, spellCost } from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';

/** How long a cure that changed nothing is trusted before it is tried again. */
export const RETRY_MS = 30_000;

type Cure = keyof SpellsConfig['cures'];
const FLAG: Record<Cure, keyof Afflictions> = {
  blindness: 'blind',
  poison: 'poisoned',
  disease: 'diseased'
};
const CURES: readonly Cure[] = ['blindness', 'poison', 'disease'];

export class Cures {
  private lastCastAt = new Map<Cure, number>();
  private previous = new Map<Cure, Affliction>();

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
    this.previous.clear();
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || state.phase !== 'in-game') return;
    for (const cure of CURES) {
      const current = state.afflictions[FLAG[cure]];
      const before = this.previous.get(cure);
      this.previous.set(cure, current);
      if (current !== 'yes') continue;

      const spell = this.config.cures[cure].trim();
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
      this.lastCastAt.set(cure, at);
      this.queue.enqueue({
        command: `c ${found.word}`,
        priority: 'combat',
        coalesceKey: `cure:${cure}`,
        expiresAt: at + tuning().spells.cureExpiresMs,
        reason: t('automation.cure.reason', { affliction: cure })
      });
    }
  }
}
