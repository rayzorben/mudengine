/**
 * Using a chosen carried item for the blessing it casts (`use <item>`), when
 * that blessing is not up. The realm's reading (unlimited items, spells with a
 * duration, a weapon or armour only while worn) is `carriedBlessing`, shared
 * with the Spells page's list. On top of it: only the items Auto Choose
 * Blessings picked (`ChosenItems`), else those in `invokeWith`; only when the
 * spell's mana is there (an item cast costs it, `MA=21` to `MA=13` on the
 * wire); never over a blessing up that `RemovesSpell` ties it to; never in a
 * fight; and one cast a round through `CastGate`. See `mudengine-automation`
 * › parts/recovery.md, *A weapon that blesses is chosen, and pays the spell's
 * mana*.
 */
import type { CharacterState } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import { exclusive } from '../../shared/blessingeffects';
import { bareName } from '../../shared/items';
import {
  carriedBlessing,
  chosenToInvoke,
  NO_CHOSEN_ITEMS,
  type BlessingRealm,
  type ChosenItems
} from '../../shared/invoke';
import { gatedCast, OPEN_CAST_GATE, sameSpell, type CastGate } from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue } from './CommandQueue';
import { canPayFor } from './mana';
import type { SessionModule } from './Module';

/** What this needs of the realm, injected as functions. */
export interface InvokeSources extends BlessingRealm {
  /**
   * A spell by name, for the buff list, which carries words, not ids.
   *
   * Both sides of *is this buff already up* are resolved to the realm's own
   * id before they are compared, which is the reading `Blessings.sameSpell`
   * settled on and for its reason: the server prints a spell's whole name
   * where a configuration may hold a short one.
   */
  spellNamed(name: string): WorldSpell | null;
}

/** The two settings this reads: the switch and the items it may use. */
type InvokeSettings = Pick<SpellsConfig, 'invokeItems' | 'invokeWith'>;

export class AutoInvoke implements SessionModule {
  /** When each item's `use` last went out, so one in flight is not repeated. */
  private readonly sentAt = new Map<string, number>();
  private enabled = false;
  private chosen: readonly string[] = [];

  constructor(
    spells: InvokeSettings,
    enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly sources: InvokeSources,
    private readonly gate: CastGate = OPEN_CAST_GATE,
    private readonly now: () => number = () => Date.now(),
    private readonly picked: ChosenItems = NO_CHOSEN_ITEMS
  ) {
    this.configure(spells, enabled);
  }

  configure(spells: InvokeSettings, enabled: boolean): void {
    // `invokeItems` switches the hand list only: an item Auto Choose Blessings
    // picked is used without it, or the choice it names would go unused.
    this.enabled = enabled;
    this.chosen = spells.invokeItems ? spells.invokeWith : [];
  }

  reset(): void {
    this.sentAt.clear();
  }

  /**
   * Considers the pack against the buffs that are up, and asks for at most one.
   *
   * One per state change, deliberately: two `use` commands in a breath is two
   * rounds spent, and the second buff is still there to ask for on the next
   * status line.
   */
  consider(state: CharacterState): void {
    if (!this.enabled) return;
    // A `use` spends the round like a cast. Blessing is what you do before a
    // fight, not during one.
    if (state.inCombat) return;
    // An unlisted pack is not an empty one — the router and `AutoKeys` refuse
    // on the same silence, and this refuses on it too rather than asking for
    // items nobody has read.
    if (state.inventory.listedAt === null) return;

    const now = this.now();
    // Auto Choose Blessings' items where it has chosen; the hand list otherwise.
    const chosen = this.picked.chosenItems() ?? this.chosen;
    if (chosen.length === 0) return;
    for (const carried of state.inventory.items) {
      const name = bareName(carried.name);
      if (!chosenToInvoke(chosen, name)) continue;
      const found = this.offer(name, carried.equipped, state);
      if (found === null) continue;

      /*
       * The same retry floor a blessing's own recast uses. A `use` the server
       * swallowed, refused, or answered with a sentence this client does not
       * read must not be re-sent on every status line — and the buff landing
       * is what actually stops it, since the spell's onset is in the message
       * table and reaches `state.buffs`.
       */
      if (now - (this.sentAt.get(name) ?? 0) < tuning().spells.blessRetryMs) continue;

      this.queue.enqueue({
        // The item's own name, as the pack listed it: `use` reads everything
        // before the last word as the item, and the last word as an exit —
        // which is why nothing is appended here (see `Walker`'s key rung).
        command: `use ${name}`,
        priority: 'probe',
        coalesceKey: `invoke:${name}`,
        expiresAt: now + tuning().spells.buffExpiresMs,
        reason: t('automation.invoke.reason', { item: name, spell: found.name }),
        // Spent when the `use` leaves, so one held for the round is proposed
        // again rather than waiting out `blessRetryMs`.
        ...gatedCast(this.gate, found.name, () => {
          this.sentAt.set(name, this.now());
        })
      });
      return;
    }
  }

  /**
   * The buff this chosen item would give now, or null when it would give
   * none worth asking for: the realm's reading first, then the hand, the
   * mana, and the buffs that are up.
   */
  private offer(name: string, equipped: boolean, state: CharacterState): WorldSpell | null {
    const blessing = carriedBlessing(name, this.sources);
    if (blessing === null) return null;
    if (blessing.mustBeEquipped && !equipped) return null;
    const { spell } = blessing;
    if (!canPayFor(state, spell.mana ?? null)) return null;

    // Already up, under its own name or any the establishing sentence could
    // have meant (`sameSpell`: the server prints the whole name).
    const held = state.buffs.some((buff) =>
      [buff.spell, ...(buff.candidates ?? [])].some((candidate) =>
        sameSpell(candidate, spell.name, state.spellbook, this.sources.spellNamed)
      )
    );
    if (held) return null;
    /*
     * A blessing up that this one takes off, or that takes this one off
     * (`RemovesSpell`, `Spell.cs` applies it on the cast): the one up stays.
     * Zeal takes off the engraved warhorn's blast, so a paladin with zeal on
     * the list would otherwise spend a `use` on every zeal recast.
     */
    const clashes = state.buffs.some((buff) => {
      const up = this.sources.spellNamed(buff.spell);
      return up !== null && up.id !== spell.id && exclusive(up, spell);
    });
    return clashes ? null : spell;
  }
}
