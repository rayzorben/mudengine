/**
 * The uses left on each charged item the character carries, by name, as the
 * wire has said them (todo 44): a `look` this ledger sent and its
 * `Uses remaining: N`, a use whose spell landed, `There are no more uses in X.`
 * and the cleanup's `A new day has come!`. The one place a look is paired
 * with its answer: the line names no item, the server answers in order, and
 * every look sent here is at an item with a `UseCount`, which always prints
 * its uses, or at one gone from the pack (`You don't see X here.`, which drops
 * that look). A `look` the player types at a charged item while one of these
 * is out is not told apart. `asks.itemUses` off, nothing is looked at
 * (todo 118). The arithmetic is `shared/charges.ts`. See `mudengine-automation`
 * › parts/recovery.md, *A charged bless item is used when its uses come back*.
 */
import type { Block } from '../../shared/blocks';
import type { AsksConfig } from '../../shared/asks';
import { chargesAfter, type ChargeEvent } from '../../shared/charges';
import { capacityNamed, type BlessingRealm } from '../../shared/invoke';
import { bareName } from '../../shared/items';
import type { CommandQueue, Intent } from './CommandQueue';
import type { SessionModule } from './Module';

/** How a look is asked: what an `Intent` carries besides the command. */
export type LookAsk = Pick<Intent, 'reason'> &
  Partial<Pick<Intent, 'priority' | 'coalesceKey' | 'expiresAt' | 'decision'>>;

/** What a consumer reads and asks of the ledger. */
export interface ChargeLedger {
  /** The uses left on `item`, or null where nothing on the wire has said. */
  usesLeft(item: string): number | null;
  /** Sends `look <item>`; `answered` gets its `Uses remaining:` count. */
  look(item: string, ask: LookAsk, answered?: (uses: number) => void): void;
  /** Looks at `item` once a session, while its count is unknown. */
  lookOnce(item: string, reason: string): void;
  /** A `use` of `item` whose spell landed. */
  used(item: string): void;
}

interface LookOut {
  item: string;
  answered?: (uses: number) => void;
}

export class ItemCharges implements SessionModule, ChargeLedger {
  /** Uses left by `bareName`; absent and null are both unknown. */
  private readonly left = new Map<string, number | null>();
  /** Looks sent and not yet answered, oldest first. */
  private out: LookOut[] = [];
  /** Items looked at once this session (`lookOnce`). */
  private readonly asked = new Set<string>();

  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    /** The realm the items are read in, at the point of use; undefined while none is loaded. */
    private readonly realm: () => Pick<BlessingRealm, 'itemsNamed'> | undefined,
    /** The settings as last loaded: `asks.itemUses` says whether a count is looked for. */
    private readonly config: () => { readonly asks: Pick<AsksConfig, 'itemUses'> }
  ) {}

  reset(): void {
    this.left.clear();
    this.out = [];
    this.asked.clear();
  }

  usesLeft(item: string): number | null {
    return this.left.get(bareName(item)) ?? null;
  }

  look(item: string, ask: LookAsk, answered?: (uses: number) => void): void {
    this.queue.enqueue({
      priority: 'probe',
      ...ask,
      command: `look ${item}`,
      onSent: () => {
        this.out.push(answered === undefined ? { item } : { item, answered });
      }
    });
  }

  lookOnce(item: string, reason: string): void {
    const key = bareName(item);
    if (!this.config().asks.itemUses) return;
    if (this.asked.has(key) || this.usesLeft(item) !== null) return;
    this.asked.add(key);
    this.look(item, { reason, coalesceKey: `charges:look:${key}`, decision: 'item-charges-look' });
  }

  used(item: string): void {
    this.apply(item, { kind: 'used' });
  }

  onBlock(block: Block): void {
    switch (block.type) {
      case 'item-uses-left': {
        // A line nobody here asked for (the player's own look) is not taken.
        const look = this.out.shift();
        if (look === undefined) return;
        const uses = Number(block.groups['uses']);
        this.apply(look.item, { kind: 'looked', uses });
        look.answered?.(uses);
        return;
      }
      case 'target-missing': {
        // `You don't see <item> here.`: a look at an item no longer carried gets no
        // count, so it leaves the line before the next look's answer is paired with it.
        const target = block.groups['target'];
        const missed = this.out.findIndex(
          (look) => target !== undefined && bareName(look.item) === bareName(target)
        );
        if (missed !== -1) this.out.splice(missed, 1);
        return;
      }
      case 'item-used-up': {
        // `That item has no more uses left!` names none; the use that asked reads it.
        const item = block.groups['item'];
        if (item !== undefined) this.apply(item, { kind: 'used-up' });
        return;
      }
      case 'realm-cleanup':
        for (const key of this.left.keys()) this.apply(key, { kind: 'new-day' });
        // A count that was unknown may be known full now; one looked at is looked at again.
        this.asked.clear();
        return;
      default:
        return;
    }
  }

  private apply(item: string, event: ChargeEvent): void {
    const key = bareName(item);
    const capacity = capacityNamed(key, this.realm());
    const charged = capacity?.kind === 'charged' ? capacity : null;
    this.left.set(key, chargesAfter(this.usesLeft(key), charged, event));
  }
}
