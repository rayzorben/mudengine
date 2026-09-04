/**
 * What a character keeps between sessions, and the seam it is kept through.
 *
 * Two facts, and they are here together because they are the same *kind* of
 * fact and want the same file: what a vault is holding, and what was in each
 * worn slot. Both are the character's own — not the realm's the way a monster's
 * health is, and not another player's the way `PlayerBook` is — and both die
 * with the socket unless something writes them down.
 *
 * - **A balance.** `bank` answers only for the counter the character is
 *   standing at, so a figure read in Godfrey is unreadable again until somebody
 *   walks back there. The Banks card, which exists to answer *how much have I
 *   got and where*, was empty on every launch until they did.
 * - **A loadout.** Dying takes everything off and leaves it in the pack, and at
 *   that moment `CarriedItem.slot` is null on every one of them, because a slot
 *   is where the *listing* said something sits and the listing no longer says.
 *   A character standing up after a death has a pack full of kit and nothing
 *   that knows which helm was on its head.
 *
 * **A sink, not a store**, for the reason `FightSink` and `RealmMemory` are:
 * the tracker is the parse path and may not acquire a file handle. It reports a
 * fact and recalls one; where the bytes live belongs to whoever wired it up.
 *
 * **Per character, not per realm.** This is the one record here that is not
 * shared: what is in Rand's vault is not in Probe's, and neither is the kit on
 * Rand's back. `PlayerBook` is realm-keyed because what somebody *wears* is a
 * fact about them; these are facts about the character reading them.
 *
 * Dependency-free like everything in `shared/`.
 */
import type { BankBalance, KnownSpell } from './character';
import type { Loadout } from './gear';

export interface BelongingsSink {
  /**
   * What the banks last said, from before this session.
   *
   * Read at `reset()` — every connection — rather than once at startup, which
   * is where `RealmPlayers.recall` is read and for the same reason: a reconnect
   * is a new session and has to be seeded like the first one.
   *
   * Empty is *nothing kept*, never *nothing banked*. The distinction is the one
   * the whole state model keeps, and here the comfortable reading is the wrong
   * one: a vault drawn as empty is a character told they have no savings they
   * in fact have.
   */
  recallBanks(): readonly BankBalance[];
  /**
   * A bank has spoken; keep what it said.
   *
   * Handed the **whole** list rather than the one entry that moved, because
   * that is what `withBankBalance` has already merged and re-deriving the merge
   * here would be a second copy of the rule that decides when two printed names
   * are one vault.
   */
  rememberBanks(banks: readonly BankBalance[]): void;
  /**
   * What was in each slot when the character last had it on.
   *
   * Read at `reset()` beside the balances, and onto `CharacterState.loadout`
   * — which is deliberately *not* `inventory.items`. What is worn **now** is a
   * fact only a listing can state; this is the memory of what *was*, and
   * restoring it into the pack view would draw a helm as being on a head it
   * came off two deaths ago.
   */
  recallLoadout(): Loadout;
  /** A listing has named a slot and what is in it. See {@link Loadout}. */
  rememberLoadout(loadout: Loadout): void;
  /**
   * What the `sp` / `pow` listing last said this character knows.
   *
   * Null is *never read*, not *knows nothing* — the same distinction
   * `CharacterState.spellbook` keeps, and here it is what stops a settings
   * screen from disabling a cure because a book was never opened.
   */
  recallSpellbook(): readonly KnownSpell[] | null;
  /** A listing has said what the character knows; keep the whole of it. */
  rememberSpellbook(spellbook: readonly KnownSpell[]): void;
  /**
   * How long each of this character's own casts was observed to last, in
   * seconds, keyed by the spell's lowercased name.
   *
   * Measured — cast confirmation to wear-off frame — never derived from the
   * realm's `Dur` column, whose units nothing on hand establishes. Own casts
   * only: a party member's duration scales with *their* level and would be
   * remembered against the wrong caster.
   */
  recallSpellDurations(): Readonly<Record<string, number>>;
  /** A cast→wear-off pair has been observed; the newest measurement wins. */
  rememberSpellDuration(spell: string, seconds: number): void;
}

/**
 * The sink for a session with nowhere to write — every test, and the anonymous
 * case. Forgetting is better than refusing to play.
 */
export const NO_BELONGINGS: BelongingsSink = {
  recallBanks: () => [],
  rememberBanks: () => {},
  recallLoadout: () => [],
  rememberLoadout: () => {},
  recallSpellbook: () => null,
  rememberSpellbook: () => {},
  recallSpellDurations: () => ({}),
  rememberSpellDuration: () => {}
};
