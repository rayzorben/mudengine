/**
 * Drinking, by a number — the potion row MegaMUD's Health tab kept beside
 * *Heal if below*, for the character with no healing spell and for the caster
 * whose mana has run out mid-fight.
 *
 * Two facts make it decidable: the character's own vitals, which are counts
 * against a maximum, and the pack listing, which says whether the potion is
 * carried at all. Both come from the wire and both are maintained for free
 * (`inventory.ts`), so this needs no command of its own to find out.
 *
 * ## What it will not do
 *
 * - **Drink without a number.** Unknown is not low: an unknown maximum
 *   produces nothing, the rule every threshold in this client follows.
 * - **Ask for a potion the pack does not list.** `drink healing potion` with
 *   none carried is a command spent to be told so — in the room, on this
 *   server. The pack is matched the way the server matches a typed name
 *   (`nameAnswersTo`): exact, a prefix, or the start of a later word, so
 *   `healing potion` finds `minor healing potion` as the server would.
 * - **Ask twice while the last one is still working.** One proposal per kind,
 *   coalesced, and not again for `tuning.potions.cooldownMs`: a status line arrives several
 *   times a second under pressure, and the drink's effect reaches the client
 *   on the *next* status line rather than in a sentence this client reads.
 *   The potion's own sentence (`You drink the red potion, and a healing
 *   warmth spreads through your body!`, twelve times in the corpus) is not
 *   parsed; the vital moving is the confirmation, exactly as for a heal.
 *
 * Proposes `<verb> <name>` in the `combat` band, like a heal and for the same
 * reason: a potion that arrives after the round has been lost has lost it.
 * `drink` by default — the verb the corpus has seen consume a potion — with
 * `use` as the alternative; both are in the server's command table, so neither
 * is ever said out loud.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { bareName } from '../../shared/items';
import type { CharacterState } from '../../shared/character';
import type { HealthConfig } from '../../shared/config';
import { nameAnswersTo } from '../../shared/world';
import { tuning } from '../app/tuning';

type Kind = 'health' | 'mana';

export class Potions {
  private lastAt = new Map<Kind, number>();

  constructor(
    private config: HealthConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: HealthConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.lastAt.clear();
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || state.phase !== 'in-game') return;
    const { hp, hpMax, mana, manaMax } = state.vitals;

    if (below(hp, hpMax, this.config.drinkHealingPotionBelow)) {
      this.drink(
        'health',
        this.config.healingPotionName,
        state,
        t('automation.potion.reasonHealth')
      );
    }
    // A class with no mana has no `MA=` and so a null maximum, which is unknown
    // rather than low: nothing is proposed, the same rule `meditateBelow` keeps.
    if (below(mana, manaMax, this.config.drinkManaPotionBelow)) {
      this.drink('mana', this.config.manaPotionName, state, t('automation.potion.reasonMana'));
    }
  }

  private drink(kind: Kind, name: string, state: CharacterState, reason: string): void {
    const wanted = bareName(name);
    if (wanted.length === 0) return;
    if (!state.inventory.items.some((item) => nameAnswersTo(bareName(item.name), wanted))) return;

    const at = this.now();
    const last = this.lastAt.get(kind);
    if (last !== undefined && at - last < tuning().potions.cooldownMs) return;
    this.lastAt.set(kind, at);
    this.queue.enqueue({
      command: `${this.config.potionVerb} ${name.trim()}`,
      priority: 'combat',
      coalesceKey: `potion:${kind}`,
      expiresAt: at + tuning().potions.expiresMs,
      reason
    });
  }
}

/** Under the threshold, with a known maximum. 0 is never; unknown is not low. */
function below(current: number | null, max: number | null, threshold: number): boolean {
  if (threshold <= 0 || current === null || max === null || max <= 0) return false;
  return current / max < threshold;
}
