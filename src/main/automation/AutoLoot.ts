/**
 * Picking things up, unasked — MegaMUD's auto-get.
 *
 * The one thing every script in the capture corpus did first after a kill
 * was `get` (`.@get-all`, `g gold`), and the client now hears the two facts
 * that make it safe to do the same: `18 gold drop to the ground.` the moment
 * something dies (`room-coins`), and a look's `You notice 15 copper farthings,
 * a rusty key here.` (`room-items`). Both are facts the tracker already reads;
 * this is the thing that acts on them.
 *
 * ## What it will not do
 *
 * - **Ask twice in one room.** A listing repeats on every look, and a `get`
 *   the server refused — over-encumbered, or somebody else got there first —
 *   would otherwise be re-proposed on every one. Each name is tried once per
 *   room; a new room clears the memory, and so does the pack confirming a
 *   pick-up (`You took …`).
 * - **Reach for anything while the character is resting.** Held pending a
 *   measurement: the belief this was written under — that *anything* breaks a
 *   rest — was wrong (2026-08-27, see `Recovery`), but whether `get`
 *   specifically breaks one has never been asked of the wire. Refusing is the
 *   direction that cannot cost anything but a delay, so coins go on waiting
 *   until `npm run probe:rest` says. The claim has a date on it.
 * - **Pick up anything not named.** Coins are a switch and a list of
 *   denominations; everything else is a list of names, matched by prefix
 *   because that is how the server reads `get`. Nothing here weighs, values or
 *   sells.
 *
 * ## A supply is collected off the floor as well as bought
 *
 * `automation.supplies` states a floor and a ceiling per item, and until now
 * the only way it filled one was a walk to a shop. Which is wrong for half of
 * what a list holds: a `black star key` is min 2, max 2 and is sold nowhere —
 * it is found. So a floor entry naming a listed supply the pack is **under the
 * ceiling of** is taken, whether it was lying in the open or a search turned it
 * up, exactly as a name on the loot list is. Under the ceiling and never past
 * it: at four torches of a maximum six, a fifth and a sixth are picked up and a
 * seventh is left where it is. `Supplies` owns the other end of the same rule —
 * see its `considerSurplus`.
 *
 * ## Hidden cash is asked for by quantity
 *
 * A `search` prints the same `You notice … here.` sentence a look does, and
 * what it turns up **stays concealed** — so its coins refuse a bare `get` and
 * take a count instead. `Classifier` tells the two listings apart from the
 * command each answers (`room-hidden-items`) and this branches on that, using
 * the count only where it is needed: a drop line states one pile while the
 * floor may hold several, so a counted `get` there would take one and leave
 * the rest, where the bare form takes the lot.
 *
 * ## And the other end of the same list: coins it puts back
 *
 * `discardKinds` is `coinKinds` inverted — the denominations to shed rather
 * than collect, exclusive with it by construction (`normalizeLoot`) so nothing
 * can be picked up and dropped for ever. A coin on neither list is *kept*,
 * which is the third answer the pair exists to express.
 *
 * It reads the pack listing, like `AutoDrop`, because the server's own
 * `DropCommand` needs the count: `drop {#} {name}` is its stated syntax, and
 * the coin branch is reached only when a number leads. And it refuses while
 * the pack holds an item the same word would match — `GetItemStacks` is tried
 * **first** and strips the count, so `drop 15 copper` drops a copper ring and
 * never reaches the purse. That is the server's own rule, read, not a guess
 * about it; the same hazard `COIN` below exists for on the way in.
 *
 * Proposes to `CommandQueue` in the `probe` band like `Recovery`; nothing here
 * touches a socket.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { EncumbranceGate, LootConfig, SuppliesConfig } from '../../shared/config';
import { carriedCount } from '../../shared/supplies';
import { DENOMINATIONS, type Denomination } from '../../shared/character';
import { bareName, countedName } from '../../shared/items';
import { nameAnswersTo } from '../../shared/world';
import { wireItem, type ItemEntity } from '../../shared/entities';
import { tuning } from '../app/tuning';

/**
 * A floor entry that is **entirely** a coin pile: `15 copper farthings`, or the
 * bare `18 gold` a drop line prints.
 *
 * Anchored at both ends, and that is the whole point. It was anchored only at
 * the start, so `gold ring` matched — a gold ring on the floor was read as a
 * pile of gold, the client sent `get gold` into a room with no coins in it, and
 * the ring stayed where it was. Every denomination is also an ordinary English
 * adjective (`copper kettle`, `silver locket`, `platinum band`), so the bug was
 * one for each of the five.
 *
 * The trailing word is the realm's own noun for the coin and is optional
 * because a drop line omits it; at most one, because two words after the
 * denomination is an item with a colour in its name.
 */
const COIN = /^(?<count>\d+) (?<coin>copper|silver|gold|platinum|runic)(?: [a-z]+)?$/i;

/**
 * How the server's own grading words rank against each other.
 *
 * Only what has been seen or is named by MegaMUD: `None` appears in four
 * captures and `Medium` in one, and MegaMUD's own cash page offers *medium* and
 * *heavy*. Anything else is unranked and leaves every gate closed — see
 * `atLeast`.
 */
/**
 * The server's own rule for whether a typed word names a carried thing.
 *
 * `Misc.IsMatch`, transcribed: the typed text has to appear in the name
 * **starting a word** — so `copper` names a `copper ring` and a `bright copper
 * kettle`, and does not name `coppice`. Read here rather than reused from
 * `nameAnswersTo`, which answers the different question of whether a listed
 * item answers to a configured name and is anchored at the start.
 */
function matchesWord(name: string, word: string): boolean {
  const text = name.toLowerCase();
  const wanted = word.toLowerCase();
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    if (at === 0 || text[at - 1] === ' ') return true;
  }
  return false;
}

const GRADE_RANK: Readonly<Record<string, number>> = {
  none: 0,
  light: 1,
  medium: 2,
  heavy: 3
};

export class AutoLoot {
  /** Names already asked for in this room, lower case. */
  private attempted = new Set<string>();

  /**
   * Denominations already asked to drop, with the count the ask was for.
   *
   * `AutoDrop`'s rule, keyed on the figure rather than the name: the pack is
   * the release, and what says a `drop 15 copper` landed is the next listing
   * saying the copper is no longer 15. Keyed that way rather than cleared on
   * any change, because a kill's coins arriving would otherwise re-arm an ask
   * the server has not answered yet.
   */
  private shed = new Map<Denomination, number>();

  /**
   * Denominations whose drop was refused because the pack holds a namesake.
   *
   * Said once per session per coin. The situation persists for as long as the
   * item is carried, and the listing that restates the purse arrives every few
   * seconds — a line per listing is the terminal again.
   */
  private saidClash = new Set<Denomination>();

  constructor(
    private config: LootConfig,
    /**
     * The supplies list, for its **ceiling** only: what is short is a walk to
     * a shop and `Supplies`' business, and what is on the floor here is this
     * module's. One list read by both, so the two cannot disagree about how
     * many of a thing the character is supposed to be carrying.
     */
    private supplies: SuppliesConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    /**
     * The realm's row for a name on the floor, whole.
     *
     * The entity rather than a price, on `AutoHeal`'s precedent and for the
     * same reason: a module handed one projection cannot ask a second question
     * without a second callback threaded from `SessionManager`. Here it is
     * asked two — what a thing is worth and what it weighs — and the default
     * answers neither, which is what a realm with no data says and is a first
     * class answer rather than an error.
     */
    private readonly realmItem: (name: string) => ItemEntity = (name) => wireItem(name),
    /**
     * Something worth telling the player, for the one decision here that is a
     * **refusal**: a coin this client will not shed because dropping it would
     * drop a piece of kit instead. A safety feature that silently declines is
     * worse than one never offered.
     */
    private readonly notice: (message: string) => void = () => {}
  ) {}

  configure(config: LootConfig, supplies: SuppliesConfig, enabled: boolean): void {
    this.config = config;
    this.supplies = supplies;
    this.enabled = enabled;
  }

  reset(): void {
    this.attempted.clear();
    this.shed.clear();
    this.saidClash.clear();
  }

  /**
   * The purse, read off the maintained listing: what to put back on the floor.
   *
   * Driven from the state path rather than `onBlock` for `AutoDrop`'s reason —
   * the listing is both the trigger and the release, and the figure this needs
   * is the one the block has already been folded into.
   */
  onCharacter(state: CharacterState): void {
    /*
     * The release, before any gate: a count that has moved is an ask the
     * server has answered one way or the other, and the denomination is free
     * to be asked about again. Read whether or not this is currently allowed
     * to act, exactly as the pack frees a dropped name in `AutoDrop`.
     */
    for (const [coin, asked] of this.shed) {
      if (state.inventory.coins[coin] !== asked) this.shed.delete(coin);
    }

    if (!this.enabled || state.phase !== 'in-game') return;
    if (this.config.discardKinds.length === 0) return;
    if (state.inCombat) return;
    // Unmeasured rather than settled, as for the `get` above.
    if (state.vitals.resting || state.vitals.meditating) return;

    for (const coin of this.config.discardKinds) {
      const count = state.inventory.coins[coin];
      // Null is nobody has said, and 0 is nothing to shed. Neither is a drop.
      if (count === null || count <= 0) continue;
      if (this.shed.has(coin)) continue;
      /*
       * The server tries the pack **before** the purse and strips the count
       * while doing it (`ItemContainer.GetItemStacks`), so a `drop 15 copper`
       * with a copper ring in the pack drops the ring. Its own rule, read off
       * its own source: a name matches where the typed word begins a word of
       * it. Refused rather than worked around, and said once — the alternative
       * is this client throwing away a piece of kit to tidy up some change.
       */
      const clash = state.inventory.items.find((item) => matchesWord(item.name, coin));
      if (clash !== undefined) {
        if (this.saidClash.has(coin)) continue;
        this.saidClash.add(coin);
        this.notice(t('automation.loot.discardBlocked', { coin, item: clash.name }));
        continue;
      }
      this.shed.set(coin, count);
      this.queue.enqueue({
        command: `drop ${count} ${coin}`,
        priority: 'probe',
        coalesceKey: `loot:shed:${coin}`,
        expiresAt: Date.now() + tuning().loot.expiresMs,
        reason: t('automation.loot.reasonDiscard', { count, coin })
      });
    }
  }

  onBlock(block: Block, state: CharacterState): void {
    // A new room is a new floor; the memory belongs to the old one.
    if (block.type === 'room-name') {
      this.attempted.clear();
      return;
    }
    // The pack confirming a pick-up frees the name for the next drop.
    if (block.type === 'player-gets' && block.groups['player'] === undefined) {
      const item = block.groups['item'];
      if (item) this.attempted.delete(item.toLowerCase());
      return;
    }
    if (block.type === 'user-gets-coins') {
      const coin = block.groups['coin']?.split(' ')[0];
      if (coin) this.attempted.delete(coin.toLowerCase());
      return;
    }
    if (!this.enabled || state.phase !== 'in-game') return;
    /*
     * The converter is decided on the *grade*, and an inventory listing is the
     * only thing that states one — so it is considered on every block, gated
     * by that grade rather than by a block type. Coalesced by one key, so a
     * listing repeating is one decision.
     */
    this.convert(state);
    // Unmeasured rather than settled: see the header. `get` may or may not
    // break a rest, and waiting costs only the wait.
    if (state.vitals.resting || state.vitals.meditating) return;

    if (block.type === 'room-coins') {
      const coin = block.groups['coin'];
      if (coin && this.wantsCoin(coin, state))
        this.take(
          coin,
          t('automation.loot.reasonCoinsDropped', { count: block.groups['count'] ?? '', coin })
        );
      return;
    }

    if (block.type === 'room-items' || block.type === 'room-hidden-items') {
      /*
       * A search's finds are the same sentence and a different floor, and the
       * difference reaches the wire in one place: **hidden coins refuse a bare
       * `get` and want the quantity.** Measured on the live realm, the same
       * room twice — `get copper` answered `You don't see any copper
       * farthings` while `4 copper farthings` sat in the listing, and `g 4 cop`
       * took them. Seven of seven bare gets at searched-up coins were refused
       * that way across the recorded sessions.
       *
       * The count is **not** used for coins lying in the open, and that is the
       * whole reason the two listings are told apart. A drop line states one
       * pile (`18 gold drop to the ground.`) while the floor may hold several,
       * so `get 18 gold` would take one and walk away from the rest, where the
       * bare `get gold` takes the lot — and the bare form is proven there,
       * hundreds of times over, in the same recordings.
       */
      const hidden = block.type === 'room-hidden-items';
      const items = (block.groups['items'] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      for (const item of items) {
        const found = COIN.exec(item)?.groups;
        const coin = found?.['coin'];
        if (coin) {
          if (this.wantsCoin(coin, state)) {
            const word = coin.toLowerCase();
            const count = found?.['count'];
            this.take(
              hidden && count !== undefined ? `${count} ${word}` : word,
              t('automation.loot.reasonListed', { item }),
              // Keyed on the denomination whichever form goes out, so one
              // room asks for its copper once however many times a repeated
              // search lists it.
              word
            );
          }
          continue;
        }
        /*
         * **The figure in front of a thing is a count, not part of its name.**
         * `66 bone key` and `2 amethyst ring` are what a mummy's crypt lists
         * (reported 2026-09-06), and `2 rope and grapple, 2 mine pass` is in
         * captures/119 — so a configured `bone key` matched nothing here,
         * `worthTaking` asked the realm about an item called "66 bone key" and
         * was told nothing, and `get 66 bone key` is not a command. One `get`
         * per name takes one of the pile, which is the same bend as taking the
         * only one there.
         */
        const { name: bare } = countedName(item);
        const named = this.config.items.find((name) =>
          bare.toLowerCase().startsWith(name.toLowerCase())
        );
        const worth = this.worthTaking(bare);
        if (named !== undefined) {
          // A name on the list is an instruction, and the only thing that
          // overrides it is the weight ceiling — which exists precisely to
          // stop an unattended character looting itself to a standstill.
          if (worth !== 'too heavy') this.take(named, t('automation.loot.reasonListed', { item }));
          continue;
        }
        /*
         * And a supply the pack is under the ceiling of, which is the same
         * instruction stated in the other list — a `black star key` at min 2,
         * max 2 is sold nowhere and can only ever be found. Under the ceiling
         * and never past it: the count is re-read from the pack on every
         * proposal, and `attempted` is cleared by the pack confirming the last
         * one, so a floor holding three keys is taken one at a time until the
         * pack says two.
         */
        const stocking = this.stockingUp(bare, state);
        if (stocking !== null) {
          if (worth !== 'too heavy') {
            this.take(
              stocking.name,
              t('automation.loot.reasonStocking', {
                item,
                have: stocking.have,
                max: stocking.max
              })
            );
          }
          continue;
        }
        if (worth === 'worth it') {
          this.take(bare, t('automation.loot.reasonWorth', { item }));
        }
      }
    }
  }

  /**
   * The supplies row this floor entry would fill, while the pack is under its
   * ceiling — or null.
   *
   * Matched by `nameAnswersTo` against the configured name, which is the rule
   * `carriedCount` counts by and the rule the server reads a typed `get` by:
   * what is taken has to be what is counted, or a `torch` picked up against a
   * `torch` row would never satisfy it. The command carries the **configured**
   * name for the same reason — the floor's own spelling may be `2 torch`, and
   * the count in front of a thing is not part of it.
   */
  private stockingUp(
    bare: string,
    state: CharacterState
  ): { name: string; have: number; max: number } | null {
    if (!this.supplies.enabled) return null;
    const floor = bareName(bare);
    if (floor.length === 0) return null;
    for (const row of this.supplies.items) {
      const wanted = bareName(row.name);
      const ceiling = Math.max(row.min, row.max);
      if (wanted.length === 0 || ceiling <= 0) continue;
      if (!nameAnswersTo(floor, wanted)) continue;
      const have = carriedCount(state, row.name);
      if (have >= ceiling) continue;
      return { name: row.name, have, max: ceiling };
    }
    return null;
  }

  /**
   * Whether the realm's own numbers say to bend down for this.
   *
   * Three answers rather than a boolean, because the two refusals are
   * different and only one of them outranks a name on the list: *too heavy* is
   * a ceiling on the pack and beats an instruction, while *not worth it* is
   * merely this predicate declining to add something nobody asked for.
   *
   * **Unknown is asymmetric here, on purpose.** A price the realm does not
   * state is not a high one, so `minPrice` never takes it — `minPrice` is a
   * claim about value and an absence is not a claim. A weight the realm does
   * not state is *not heavy*, so `maxEncumbrance` never refuses on it —
   * refusing on absence would stop a derivative realm looting anything at all.
   * The two absences point opposite ways because the two settings do.
   */
  private worthTaking(name: string): 'worth it' | 'not worth it' | 'too heavy' {
    const { minPrice, maxEncumbrance } = this.config;
    if (minPrice <= 0 && maxEncumbrance <= 0) return 'not worth it';
    const item = this.realmItem(name);
    if (maxEncumbrance > 0 && item.encumbrance !== undefined && item.encumbrance > maxEncumbrance) {
      return 'too heavy';
    }
    if (minPrice <= 0) return 'not worth it';
    return item.price !== undefined && item.price >= minPrice ? 'worth it' : 'not worth it';
  }

  /**
   * Whether this denomination is one to bend down for, right now.
   *
   * Three questions, and they answer different things: the master switch,
   * whether the player wants *this* coin at all, and whether the character is
   * already too loaded to be picking up more of it.
   */
  private wantsCoin(coin: string, state: CharacterState): boolean {
    if (!this.config.coins) return false;
    const word = coin.trim().toLowerCase();
    const wanted = DENOMINATIONS.find((name) => name === word);
    // A denomination this client cannot name is one a realm has renamed, and
    // it is left alone rather than guessed at — the rule the pack's own coin
    // counting already follows.
    if (wanted === undefined || !this.config.coinKinds.includes(wanted)) return false;
    return !this.atLeast(this.config.stopAtGrade, state.inventory.encumbranceWord);
  }

  /**
   * Whether the server's own grading has reached the gate.
   *
   * The word, never a percentage this client computed — the thresholds behind
   * the grades are unsampled and MegaMUD's "67% is Heavy" has never been seen
   * on this wire. A word the ranking does not know leaves the gate **closed**,
   * which is `drop.whenEncumbered`'s rule: unknown is not encumbered, and
   * refusing to loot on a word nobody has sampled would be this client's
   * ignorance stopping an automation that works.
   */
  private atLeast(gate: EncumbranceGate, word: string | null): boolean {
    if (gate === 'never') return false;
    const rank = GRADE_RANK[word?.trim().toLowerCase() ?? ''];
    return rank !== undefined && rank >= GRADE_RANK[gate]!;
  }

  /**
   * The converter, where the character is carrying one and is loaded enough.
   *
   * `use <item>` is the realm's own verb for a thing with charges, and the item
   * is matched by the server's own rule for a typed name — asking for one that
   * is not in the pack is a command spent to be told so, out loud in the room.
   * One proposal at a time: the next listing says whether it worked, and the
   * grade is what re-arms this.
   */
  private convert(state: CharacterState): void {
    const wanted = this.config.convertWith.trim();
    if (wanted.length === 0) return;
    if (!this.atLeast(this.config.convertAt, state.inventory.encumbranceWord)) return;
    const held = state.inventory.items.find((item) =>
      nameAnswersTo(bareName(item.name), bareName(wanted))
    );
    if (held === undefined) return;
    this.queue.enqueue({
      command: `use ${held.name}`,
      priority: 'probe',
      coalesceKey: 'loot:convert',
      expiresAt: Date.now() + tuning().loot.expiresMs,
      reason: t('automation.loot.reasonConvert', { item: held.name })
    });
  }

  private take(name: string, reason: string, asked = name): void {
    const key = asked.toLowerCase();
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    this.queue.enqueue({
      command: `get ${name}`,
      priority: 'probe',
      // One key per name: two drops of gold in one round are one `get gold`,
      // and gold and silver are two.
      coalesceKey: `loot:${key}`,
      expiresAt: Date.now() + tuning().loot.expiresMs,
      reason
    });
  }
}
