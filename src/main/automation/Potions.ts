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
import type { HealthConfig, PotionRule, PotionVerb } from '../../shared/config';
import { nameAnswersTo } from '../../shared/world';
import { tuning } from '../app/tuning';

/**
 * What a proposal is *for*, which is what the cooldown and the coalescing key
 * are per. The two thresholds keep their own names, and every rule in
 * `health.potions` is keyed on its own row so two rules on one item at two
 * depths do not silence each other.
 */
type Kind = string;

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

    /*
     * The player's own list, and the only list (todo 19; the sole one since
     * todo 00).
     *
     * Two named slots stood above this — a healing potion and a mana potion,
     * each with a threshold and a shared verb. They said nothing this does not
     * and could not say four things it can, so they went rather than being
     * kept as a second way to ask the same question.
     *
     * Keyed by the row's place, not by its item, so two rules naming one
     * potion at two depths are two proposals rather than one silencing the
     * other: only an item the pack lists, one proposal per key per cooldown,
     * the vital or the condition moving is the confirmation.
     */
    this.config.potions.forEach((rule, at) => {
      if (!this.fires(rule, state)) return;
      this.drink(`rule:${at}`, rule.name, state, t('automation.potion.reasonRule'), rule.verb);
    });
  }

  /**
   * Whether a rule's condition holds.
   *
   * `hp` and `mana` are shares of maximum, and an unknown maximum is not low —
   * the rule every threshold here follows, and the reason a class with no mana
   * never drinks a mana potion. The four conditions are three-state on the
   * wire and **only a stated `yes` fires**: unknown is not afflicted, and
   * spending a cure on a maybe is the guess this client refuses everywhere.
   */
  private fires(rule: PotionRule, state: CharacterState): boolean {
    const { hp, hpMax, mana, manaMax } = state.vitals;
    switch (rule.when) {
      case 'hp':
        return below(hp, hpMax, rule.below);
      case 'mana':
        return below(mana, manaMax, rule.below);
      default:
        return state.afflictions[rule.when] === 'yes';
    }
  }

  private drink(
    kind: Kind,
    name: string,
    state: CharacterState,
    reason: string,
    verb: PotionVerb
  ): void {
    const wanted = bareName(name);
    if (wanted.length === 0) return;
    if (!state.inventory.items.some((item) => nameAnswersTo(bareName(item.name), wanted))) return;

    const at = this.now();
    const last = this.lastAt.get(kind);
    if (last !== undefined && at - last < tuning().potions.cooldownMs) return;
    this.lastAt.set(kind, at);
    this.queue.enqueue({
      command: `${verb} ${name.trim()}`,
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
