/**
 * Blessings kept up by events, with a clock behind them — the event-driven
 * replacement for the interval-only `Buffs`.
 *
 * The wire frames both ends of a buff's life: the cast confirmation (`You
 * cast bless on yourself!`, `Naji casts bless on you!`) establishes it on
 * `CharacterState.buffs`, and the wear-off frames (`The effects of bless wear
 * off!`) end it — so a recast goes out the moment the server says the spell
 * is gone rather than on a fixed clock. What the wire cannot say — the
 * per-spell custom endings (`Your skin returns to normal.`) are realm message
 * data none of the realm databases on hand export — is covered by a watchdog
 * clock: for a self blessing, the duration *measured* from this character's
 * own earlier cast→wear-off pairs (`Belongings` keeps it between sessions),
 * plus slack so the honest signal always speaks first, and `blessWatchdogMs`
 * before the first measurement; for a party member, whose wear-off lands on
 * *their* screen, the row's own `fallbackSeconds`. The realm's `Dur` column
 * is deliberately never the clock — its units are unmeasured, and a duration
 * guessed in the reassuring direction is a shield that is down longer than
 * anybody knows.
 *
 * ## Order
 *
 * The list is priority order: when several blessings are down, index 0 is
 * recast first, and **one cast is proposed per pass** — the server refuses a
 * second spell in a round (`You have already cast a spell this round!`), so
 * proposing three at once buys two refusals out of the budget the fight is
 * fought with. Entries marked `prioritizeOverHeal` are proposed from
 * `urgent()`, which `SessionManager` consults *before* `AutoHeal`; the rest
 * from `onCharacter`, after the heal, the potion and the cures have had
 * their say. Self blessings outrank party ones, always: the caster that
 * keeps its own shield up is the one still standing to bless anybody else.
 *
 * ## The peer protocol
 *
 * A blessing cast on a party member wears off on *their* screen, not this
 * one's, so a party target runs on its clock — unless both ends run
 * mudengine: `spells.notifyPartyOnWearOff` has the blessed character telepath
 * `@bless-expired <spell>` back to whoever cast it, and `onPeerExpired` marks
 * that member due now. Opt-in on the sending side, permission-gated on the
 * receiving side like every remote.
 *
 * `c <short> <name>` for a party member and `c <short>` bare for this
 * character — a targetless cast lands on the caster, and the word is the
 * realm's short name because the `Cast` command reads exactly one word as the
 * spell (`castWord`). In the `probe` band out of combat and `combat` when the
 * entry allows it mid-fight, coalesced by the entry's spell — which is the
 * row's identity: the list holds one row per spell.
 */
import type { CommandQueue } from './CommandQueue';
import { canPayFor, manaAtLeast } from './mana';
import { t } from '../app/i18n';
import type { ActiveBuff, CharacterState } from '../../shared/character';
import type { BlessingConfig, SpellsConfig } from '../../shared/config';
import type { Block } from '../../shared/blocks';
import { resolveSpell, spellCost } from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';

/** One key per blessing per person, so a party of four is four clocks. */
function clockKey(entry: BlessingConfig, target: string): string {
  return `${entry.spell.toLowerCase()}:${target.toLowerCase()}`;
}

/**
 * A party row's clock, with the coercion's own default behind the optional
 * field: `normalizeBlessings` always writes it for a party row, but the type
 * cannot say so, and an absent value must fail towards recasting late — the
 * wasteful direction — rather than every tick.
 */
function partyClockSeconds(entry: BlessingConfig): number {
  return entry.fallbackSeconds ?? 300;
}

export class Blessings {
  private timer: NodeJS.Timeout | null = null;
  private state: CharacterState | null = null;
  /** When each clock last had its cast proposed — `clockKey` → epoch ms. */
  private readonly proposedAt = new Map<string, number>();
  /** When each party clock last saw its cast *confirmed* — `clockKey` → epoch ms. */
  private readonly castAt = new Map<string, number>();
  /** Party clocks a peer notification has marked due right now. */
  private readonly dueNow = new Set<string>();
  /**
   * The last cast this module proposed anything at, module-wide: one blessing
   * at a time, so a caster with three down works through them in priority
   * order at the pace the server confirms them rather than as one burst two
   * thirds of which is refused.
   */
  private lastProposalAt = 0;

  constructor(
    private config: SpellsConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly now: () => number = () => Date.now(),
    /**
     * The observed duration of this character's own cast of a spell, in
     * seconds — `Belongings.recallSpellDurations`, read through a callback
     * so the store can arrive after construction. Null is *never measured*,
     * which falls back to `blessWatchdogMs`.
     *
     * The one thing here that is genuinely not realm data: it is measured off
     * this character's own wire, which is why it stays its own callback while
     * the id and the abbreviation folded into `realmSpell`.
     */
    private readonly learnedDuration: (spell: string) => number | null = () => null,
    /**
     * The realm's own row for a spell it names, whole.
     *
     * The entity rather than a projection of it. This module wanted two facts
     * off the same row — the id, to tell a configured `bles` from a recorded
     * `bless`, and the abbreviation, which is the word a cast sends — and was
     * given two callbacks for them; anything wanting a third would have got a
     * third. See `resolveSpell`.
     */
    private readonly realmSpell: (name: string) => WorldSpell | null = () => null
  ) {}

  /**
   * Whether a wire spelling and a configured spelling name the same spell.
   *
   * The realm accepts `bles` wherever it accepts `bless` and a MegaMUD-trained
   * player configures the abbreviation, while the cast confirmation always
   * prints the whole name — so equality alone would hold a configured `bles`
   * against a recorded `bless` for ever, recasting on the retry clock all
   * evening. A row the realm does not name answers null, and two nulls fall
   * back to the words.
   */
  private sameSpell(wire: string, configured: string): boolean {
    if (wire.trim().toLowerCase() === configured.trim().toLowerCase()) return true;
    const a = this.realmSpell(wire)?.id ?? null;
    const b = this.realmSpell(configured)?.id ?? null;
    return a !== null && b !== null && a === b;
  }

  configure(config: SpellsConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
    this.arm();
  }

  reset(): void {
    this.proposedAt.clear();
    this.castAt.clear();
    this.dueNow.clear();
    this.lastProposalAt = 0;
    this.stop();
  }

  /**
   * The blocks this module reads, handed the state as it stood **before** the
   * block was applied — which is what makes the wear-off notification
   * possible at all: the buff about to be removed is still on the list, and
   * it is the only record of who cast it.
   */
  onBlock(block: Block, before: CharacterState): void {
    if (!this.enabled) return;
    if (block.type === 'user-buff-expired') {
      const spell = block.groups['spell']?.trim();
      if (spell) this.notifyCaster(spell, before);
      return;
    }
    /*
     * A cast failed, so the shield it was meant to renew is still down. The
     * self-cast confirmation is what stops a recast (the buff appears on the
     * list); a failure is the opposite fact and must not be waited out on the
     * retry floor. Clearing this spell's `proposedAt` lets the next pass
     * propose it again — paced to one cast per `blessCooldownMs` by
     * `lastProposalAt`, so a spell that keeps failing is retried each round,
     * not each status line. Only a self entry: a party cast that failed lands
     * on the party clock, which its own confirmation restarts.
     */
    if (block.type === 'spell-failed') {
      const spell = block.groups['spell']?.trim();
      if (spell === undefined || block.groups['target'] !== undefined) return;
      for (const entry of this.config.blessings) {
        if (entry.target === 'self' && this.sameSpell(spell, entry.spell)) {
          this.proposedAt.delete(clockKey(entry, '@self'));
        }
      }
      return;
    }
    /*
     * This character's own cast landing on a party member restarts that
     * member's clock from the confirmation rather than from the proposal —
     * the proposal may have queued behind a fight, and a clock started then
     * would come due early by however long the wait was.
     */
    if (block.type === 'spell-cast' && block.groups['caster'] === 'You') {
      const spell = block.groups['spell']?.trim();
      const target = block.groups['target'];
      if (!spell || target === undefined) return;
      const own = before.name?.toLowerCase() ?? null;
      const lower = target.toLowerCase();
      if (lower === 'yourself' || lower === 'you' || lower === own) return;
      for (const entry of this.config.blessings) {
        if (entry.target !== 'party' || !this.sameSpell(spell, entry.spell)) continue;
        const key = clockKey(entry, target);
        this.castAt.set(key, block.at);
        this.dueNow.delete(key);
      }
    }
  }

  /**
   * A party member this character blessed says the spell has worn off —
   * `@bless-expired <spell>`, relayed by `Remotes` after the per-player
   * permission gate. Matched through the realm's spell table as well as by
   * the words, because the other end says the spelling *its* wire printed.
   */
  onPeerExpired(from: string, spell: string): void {
    if (!this.enabled) return;
    for (const entry of this.config.blessings) {
      if (entry.target !== 'party') continue;
      if (!this.sameSpell(spell, entry.spell)) continue;
      const key = clockKey(entry, from);
      this.dueNow.add(key);
      this.castAt.delete(key);
      this.proposedAt.delete(key);
    }
    this.check();
  }

  /**
   * The pass `SessionManager` runs *before* `AutoHeal`: only the entries
   * marked `prioritizeOverHeal`, so the shield a caster dies without goes out
   * ahead of the heal when both are due. Self targets only — a party
   * blessing never outranks this character's own heal.
   */
  urgent(state: CharacterState): void {
    this.state = state;
    // The master switch, here as at every other entry point: `SessionManager`
    // has no outer gate around these calls, so a pass that skipped this check
    // would cast with automation off.
    if (!this.enabled || state.phase !== 'in-game') return;
    this.propose(state, true);
  }

  onCharacter(state: CharacterState): void {
    this.state = state;
    if (state.phase !== 'in-game') {
      this.stop();
      return;
    }
    this.arm();
    this.check();
  }

  dispose(): void {
    this.stop();
  }

  /** One pass over the list; the interval calls it, and so does every state change. */
  check(): void {
    const state = this.state;
    if (!this.enabled || !state || state.phase !== 'in-game') return;
    this.propose(state, false);
  }

  /**
   * At most one proposal per pass, first due entry in list order wins.
   *
   * The urgent pass takes only the prioritized entries and the normal pass
   * only the rest, so an entry is considered exactly once per state change —
   * on whichever side of the heal its flag puts it.
   */
  private propose(state: CharacterState, prioritized: boolean): void {
    const now = this.now();
    if (now - this.lastProposalAt < tuning().spells.blessCooldownMs) return;

    for (const entry of this.config.blessings) {
      if (entry.prioritizeOverHeal !== prioritized) continue;
      if (entry.target !== 'self') continue;
      if (this.castSelf(entry, state, now)) return;
    }
    /*
     * Party blessings are strictly below every self blessing, whatever the
     * flags say: they are considered only after both passes' self entries
     * have found nothing to do, which the normal pass is the tail of.
     */
    if (prioritized) return;
    for (const entry of this.config.blessings) {
      if (entry.target !== 'party') continue;
      if (this.castParty(entry, state, now)) return;
    }
  }

  /** Proposes one self recast if this entry is due; true when it did. */
  private castSelf(entry: BlessingConfig, state: CharacterState, now: number): boolean {
    if (state.inCombat && !entry.inCombat) return false;
    if (!manaAtLeast(state, entry.minMana)) return false;

    const held = state.buffs.find((buff) => this.sameSpell(buff.spell, entry.spell));
    if (held !== undefined && !this.lapsed(held, entry, now)) return false;

    // `@self`, not this character's name: a self cast goes out bare, so it
    // needs no name at all, and `@` keeps the clock apart from any party
    // member's — a player name cannot start with it.
    const key = clockKey(entry, '@self');
    const proposed = this.proposedAt.get(key) ?? 0;
    // The last proposal may still be queued, in flight, or refused; a
    // confirmation resets nothing here — the buff appearing on the list is
    // what stops the recast — so an unconfirmed cast is retried on the
    // cures' own cadence rather than every state change.
    if (now - proposed < tuning().spells.blessRetryMs) return false;

    return this.enqueue(entry, null, state, key, now);
  }

  /** Proposes one party recast if any member is due; true when it did. */
  private castParty(entry: BlessingConfig, state: CharacterState, now: number): boolean {
    if (state.inCombat && !entry.inCombat) return false;
    if (!manaAtLeast(state, entry.minMana)) return false;

    const self = (state.name ?? '').toLowerCase();
    for (const member of state.party.members) {
      if (member.invited || member.name.toLowerCase() === self) continue;
      const key = clockKey(entry, member.name);
      if (!this.partyDue(key, entry, now)) continue;
      const proposed = this.proposedAt.get(key) ?? 0;
      if (now - proposed < tuning().spells.blessRetryMs) continue;
      /*
       * Mana is one pool, so a blessing this character cannot pay for is one
       * it cannot pay for on anybody. Stopping is the honest answer; walking
       * the rest of the roster would send the same refusal once per member.
       */
      return this.enqueue(entry, member.name, state, key, now);
    }
    return false;
  }

  /**
   * Whether a buff this character holds has outlived its watchdog.
   *
   * The clock runs from the cast confirmation, not from the proposal, and a
   * wear-off the client read has already taken the buff off the list — this
   * is only the watchdog for the endings it cannot read. Its length is the
   * duration measured from earlier cast→wear-off pairs plus slack, so the
   * frame gets to speak first, and the shipped default before anything has
   * been measured. Looked up under both spellings, because the buff carries
   * the wire's and the row carries the player's.
   */
  private lapsed(buff: ActiveBuff, entry: BlessingConfig, now: number): boolean {
    /*
     * The server's own countdown wins where it stated one — Paramud's `st`
     * timer, attributed to this buff by the tracker. It is a live statement
     * rather than a guess from the unmeasured `Dur` column, so it is trusted
     * outright: the recast goes out within a second of the real expiry. This
     * is what the todo asked for — *use the st time if available.*
     */
    if (buff.expiresAt !== undefined) return now >= buff.expiresAt;
    const learned = this.learnedDuration(buff.spell) ?? this.learnedDuration(entry.spell);
    const watchdogMs =
      learned !== null && learned > 0
        ? learned * 1000 * (1 + tuning().spells.blessSlack)
        : tuning().spells.blessWatchdogMs;
    return now - buff.appliedAt >= watchdogMs;
  }

  /**
   * A party member is due on the peer event, and otherwise on the clock —
   * which starts at zero, so a member never blessed is due on first sight:
   * the party formed and the blessing is the point.
   */
  private partyDue(key: string, entry: BlessingConfig, now: number): boolean {
    if (this.dueNow.has(key)) return true;
    const cast = this.castAt.get(key) ?? 0;
    return now - cast >= partyClockSeconds(entry) * 1000;
  }

  /**
   * A null target is this character: cast bare, which lands on the caster.
   *
   * Returns whether anything was proposed. A blessing that cannot be paid for
   * is not one, and **no clock is spent on it**: `proposedAt` is set only on
   * the way past the check, so the recast goes out on the first status line
   * that can afford it rather than waiting out `blessRetryMs` afterwards. The
   * captured failure this closes is `way of the owl` at `KAI=1` for a spell
   * costing 2 — the server answering `You do not have enough mana to cast that
   * spell.` in the room, every time the clock came round.
   */
  private enqueue(
    entry: BlessingConfig,
    target: string | null,
    state: CharacterState,
    key: string,
    now: number
  ): boolean {
    const found = resolveSpell(entry.spell, state.spellbook, this.realmSpell);
    if (!canPayFor(state, spellCost(found))) return false;
    this.proposedAt.set(key, now);
    this.lastProposalAt = now;
    const word = found.word;
    this.queue.enqueue({
      command: target === null ? `c ${word}` : `c ${word} ${target}`,
      // Mid-fight a recast competes for the round like a heal; idle it is the
      // least urgent thing in the client, below walking and the player.
      priority: state.inCombat ? 'combat' : 'probe',
      coalesceKey: `blessing:${key}`,
      expiresAt: now + tuning().spells.buffExpiresMs,
      reason: t('automation.blessing.reason', { name: entry.spell })
    });
    return true;
  }

  /**
   * The wear-off notification: the buff that just ended was cast by a party
   * member, so tell their client — `/<caster> @bless-expired <spell>` — and
   * let it recast on the event instead of its clock. Only with the switch on,
   * and only while the caster is still a listed member: a telepath to
   * somebody who left the party is a stranger's screen written on unasked.
   */
  private notifyCaster(spell: string, before: CharacterState): void {
    if (!this.config.notifyPartyOnWearOff) return;
    const held = before.buffs.find((buff) => this.sameSpell(buff.spell, spell));
    const caster = held?.by ?? null;
    if (caster === null) return;
    const still = before.party.members.some(
      (member) => !member.invited && member.name.toLowerCase() === caster.toLowerCase()
    );
    if (!still) return;
    this.queue.enqueue({
      command: `/${caster} @bless-expired ${spell}`,
      priority: 'probe',
      coalesceKey: `bless-expired:${caster.toLowerCase()}:${spell.toLowerCase()}`,
      expiresAt: this.now() + tuning().spells.buffExpiresMs,
      reason: t('automation.blessing.notifyReason', { caster, spell })
    });
  }

  private arm(): void {
    if (this.timer !== null) return;
    if (!this.enabled || this.config.blessings.length === 0) return;
    this.timer = setInterval(() => {
      /*
       * The clock tick runs both passes back to back — an idle character gets
       * no state changes, and a prioritized entry must not be one only a
       * fight can recast. Priority against the heal is meaningless on a tick
       * where nothing else is being decided.
       */
      const state = this.state;
      if (!this.enabled || !state || state.phase !== 'in-game') return;
      this.propose(state, true);
      this.propose(state, false);
    }, tuning().spells.buffTickMs);
    // Never hold the process open for a clock nobody is watching.
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
