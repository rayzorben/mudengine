/**
 * Asking a carried item for the buff it can give.
 *
 * MegaMUD's `AutoBless` is ten configured commands with a priority and a timer
 * each, and this client's answer to that is `automation.spells.buffs` — a list
 * of *spells this character casts*. Neither covers the thing a warrior with the
 * right weapon actually has: **an item that casts a bless, for free, for
 * ever.**
 *
 * ## The realm says all of it
 *
 * An item's `Abil-n` slots carry `CastsSp` (43) with a `Spells` row beside it,
 * and `ItemType.cs` rewrites a bare one into `UseSpell` as the server loads the
 * item — so `use <item>` casts it. In the shipped realm:
 *
 * - **336 items** carry a usable `CastsSp`; 205 more carry the chance-on-hit
 *   pair, which no command can trigger and which `itemInvocation` refuses.
 * - **39 of the 336 state `UseCount: -1`** — unlimited. Nine of those are
 *   weapons casting `weapon major bless` or `weapon major valour`, both of
 *   duration 60, and one of them is the `shimmering longsword` this was
 *   reported from.
 *
 * So a character wielding one has a bless it can have as often as it likes,
 * costing **no mana and no charge** — and nothing in this client ever asked for
 * it.
 *
 * ## What it refuses, and why each refusal is the cheap direction
 *
 * - **Only an unlimited item.** An item with three charges spent on a buff is
 *   three charges somebody was saving for something. Refusing costs a buff;
 *   using costs a thing that does not come back — so the realm has to *say*
 *   `-1`, and silence is not unlimited. That distinction only exists in the
 *   realm file from format 25; before it, absent meant both.
 * - **Only a spell with a duration.** An item that casts a fireball is not a
 *   blessing, and `use`-ing it at nothing would spend a command to be refused,
 *   in the room, out of the budget a fight is fought with.
 * - **Only when the buff is not already up**, under its own name or any other
 *   the establishing sentence could have meant — `You feel lucky!` is five
 *   spells, and a bless that is up as `chant` is up.
 * - **Never in a fight.** A `use` spends the round the way a cast does, and
 *   this is the least urgent thing in the client: `probe` band, below walking
 *   and below the player.
 * - **Only what the pack lists.** `nameAnswersTo`, the server's own rule for a
 *   typed name — asking for an item that is not carried is a command spent to
 *   be told so.
 *
 * Off by default, like everything automated. The two exceptions in this client
 * were both on instruction, and both are cases where refusing costs a corridor
 * rather than a buff.
 */
import type { CharacterState } from '../../shared/character';
import { bareName, itemInvocation } from '../../shared/items';
import { nameAnswersTo, type WorldItem, type WorldSpell } from '../../shared/world';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CommandQueue } from './CommandQueue';
import type { SessionModule } from './Module';

/** What this needs of the realm and of the character, injected as functions. */
export interface InvokeSources {
  /** The realm's row for a carried item, by the name the listing spelled. */
  itemNamed(name: string): WorldItem | null;
  /** The realm's row for a spell an item casts. */
  spellById(id: number): WorldSpell | null;
  /**
   * And by name, for the buff list — which carries words, not ids.
   *
   * Both sides of *is this buff already up* are resolved to the realm's own
   * id before they are compared, which is the reading `Blessings.sameSpell`
   * settled on and for its reason: the server prints a spell's whole name
   * where a configuration may hold a short one, so words alone hold a
   * configured `bles` against a recorded `bless` for ever.
   */
  spellNamed(name: string): WorldSpell | null;
}

export class AutoInvoke implements SessionModule {
  /** When each item was last asked, so a proposal in flight is not repeated. */
  private readonly askedAt = new Map<string, number>();

  constructor(
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly sources: InvokeSources,
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(enabled: boolean): void {
    this.enabled = enabled;
  }

  reset(): void {
    this.askedAt.clear();
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
    for (const carried of state.inventory.items) {
      const name = bareName(carried.name);
      const found = this.offer(name, state);
      if (found === null) continue;

      const asked = this.askedAt.get(name) ?? 0;
      /*
       * The same retry floor a blessing's own recast uses. A `use` the server
       * swallowed, refused, or answered with a sentence this client does not
       * read must not be re-sent on every status line — and the buff landing
       * is what actually stops it, since the spell's onset is in the message
       * table and reaches `state.buffs`.
       */
      if (now - asked < tuning().spells.blessRetryMs) continue;

      this.askedAt.set(name, now);
      this.queue.enqueue({
        // The item's own name, as the pack listed it: `use` reads everything
        // before the last word as the item, and the last word as an exit —
        // which is why nothing is appended here (see `Walker`'s key rung).
        command: `use ${name}`,
        priority: 'probe',
        coalesceKey: `invoke:${name}`,
        expiresAt: now + tuning().spells.buffExpiresMs,
        reason: t('automation.invoke.reason', { item: name, spell: found.name })
      });
      return;
    }
  }

  /**
   * The buff this carried item would give, or null when it would give none
   * worth asking for.
   *
   * Every refusal in the module header is made here, in the order that spends
   * least: the realm's row first, then the shape of what it casts, then the
   * character's own buff list.
   */
  private offer(name: string, state: CharacterState): WorldSpell | null {
    const item = this.sources.itemNamed(name);
    if (item === null) return null;
    // The pack's spelling has to be one the server would resolve to this item,
    // or the command goes out for something else entirely.
    if (!nameAnswersTo(bareName(item.name), name)) return null;

    const invocation = itemInvocation(item);
    if (invocation === null || !invocation.unlimited) return null;

    const spell = this.sources.spellById(invocation.spell);
    // A spell the realm cannot name is one this cannot report or compare, and
    // a spell with no duration is not a blessing.
    if (spell === null || spell.duration === undefined || spell.duration <= 0) return null;

    /*
     * Already up, under its own name or any the establishing sentence could
     * have meant. Compared by the realm's **id** rather than by words, which
     * is what `Blessings.sameSpell` resolves to and the reason it does: the
     * server prints a spell's whole name where a configuration may hold a
     * short one.
     */
    const held = state.buffs.some((buff) =>
      [buff.spell, ...(buff.candidates ?? [])].some((candidate) => {
        if (candidate.trim().toLowerCase() === spell.name.trim().toLowerCase()) return true;
        return this.sources.spellNamed(candidate)?.id === spell.id;
      })
    );
    return held ? null : spell;
  }
}
