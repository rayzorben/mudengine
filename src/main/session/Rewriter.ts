/**
 * The facts a rewrite draws from, gathered for the feed at the moment a
 * listing completes.
 *
 * `src/shared/rewrites.ts` lays a listing out and this is what fills it: the
 * batch the classifier assembled, the realm's row for each thing in it
 * (`WorldGraph.buildItemEntity`, the join the tracker makes for the pack),
 * whether this character may put it on (`equipVerdict`, the pack card's own
 * gate) and the purse a price is measured against. Read off the tracker's
 * *published* state, since the feed sees a line before the tracker acts on
 * it; the listing's own figures come from the batch, never the state.
 * `mudengine-ui` § The console is rewritten in one grammar.
 */
import { DEFAULT_CONFIG, type RewritesUiConfig } from '../../shared/config';
import type { Block, BlockType } from '../../shared/blocks';
import type { BatchBlock } from '../parse/Classifier';
import type { CarriedItem, CharacterState, Denomination } from '../../shared/character';
import { sameItem } from '../../shared/items';
import { quotedInCopper } from '../../shared/coins';
import { wireItem } from '../../shared/entities';
import { equipVerdict, type Wearer } from '../../shared/gear';
import {
  REWRITE_KINDS,
  REWRITE_SPECS,
  renderExperience,
  renderInventory,
  renderParty,
  renderShop,
  renderWho,
  rewriteToChunk,
  type InventoryRow,
  type PartyRow,
  type RewriteKind,
  type Rewritten,
  type ShopRow,
  type WhoRow
} from '../../shared/rewrites';
import type { TerminalMark } from '../../shared/types';
import { t } from '../app/i18n';
import { itemList, parseCarriedEntries, parseCoinEntry, parseKeyEntries } from '../parse/inventory';
import type { WorldGraph } from '../world/WorldGraph';

export interface RewriteContext {
  state: CharacterState;
  world: WorldGraph | undefined;
  wearer: Wearer;
}

/** What the console is fed in the listing's place. */
export interface RewriteChunk {
  text: string;
  marks: Array<{ offset: number; mark: TerminalMark }>;
}

/**
 * The listing's `6 torch` back as one row.
 *
 * The pack holds instances — `parseCarriedEntries` expands a counted entry
 * into one per thing, which is what lets a drop take the spare before the
 * worn one — but a listing drawn for reading says what the server said: one
 * row, counted. Only a run of the same name with nothing worn folds; a worn
 * one is listed on its own by the server and stays so here.
 */
function foldInstances(items: readonly CarriedItem[]): CarriedItem[] {
  const folded: CarriedItem[] = [];
  for (const item of items) {
    const last = folded[folded.length - 1];
    if (last && !last.equipped && !item.equipped && sameItem(last.name, item.name)) {
      last.count = (last.count ?? 1) + (item.count ?? 1);
      continue;
    }
    folded.push({ ...item });
  }
  return folded;
}

function int(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value.replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export class Rewriter {
  private config: RewritesUiConfig = DEFAULT_CONFIG.ui.rewrites;

  configure(config: RewritesUiConfig): void {
    this.config = config;
  }

  /** The enabled kind that draws in place of this block type, or null. */
  kindFor(type: BlockType): RewriteKind | null {
    for (const kind of REWRITE_KINDS) {
      if (this.config[kind].enabled && REWRITE_SPECS[kind].blocks.includes(type)) return kind;
    }
    return null;
  }

  /** Whether a block of this type is drawn by the client rather than painted. */
  wants(type: BlockType): boolean {
    return this.kindFor(type) !== null;
  }

  /**
   * The listing drawn, or null where the design declines — a batch with no
   * rows, a template blanked to nothing — in which case the realm's own lines
   * are painted as they were.
   */
  render(block: Block | BatchBlock, context: RewriteContext): RewriteChunk | null {
    const kind = this.kindFor(block.type);
    if (kind === null) return null;
    const rewritten = this.draw(kind, block, context);
    if (rewritten === null || rewritten.lines.length === 0) return null;
    return rewriteToChunk(rewritten);
  }

  private draw(
    kind: RewriteKind,
    block: Block | BatchBlock,
    context: RewriteContext
  ): Rewritten | null {
    const design = this.config[kind];
    const g = block.groups ?? {};
    const rows: ReadonlyArray<Record<string, string>> = 'rows' in block ? block.rows : [];
    switch (kind) {
      case 'inventory': {
        const carrying = g['items'];
        const listed =
          carrying && !/^nothing!?$/i.test(carrying.trim())
            ? foldInstances(itemList(carrying).flatMap((entry) => parseCarriedEntries(entry)))
            : [];
        const items: InventoryRow[] = listed.map((carried) => {
          const item = context.world
            ? context.world.buildItemEntity(carried.name, {
                slot: carried.slot,
                equipped: carried.equipped,
                charges: carried.charges,
                ...(carried.count === undefined ? {} : { count: carried.count }),
                ...(carried.rawText === undefined ? {} : { rawText: carried.rawText })
              })
            : carried;
          return { item, verdict: equipVerdict(item, context.wearer, t) };
        });
        const coins: Partial<Record<Denomination, number>> = {};
        for (const entry of itemList(carrying)) {
          const coin = parseCoinEntry(entry);
          if (coin) coins[coin.denomination] = coin.count;
        }
        return renderInventory(
          design,
          {
            items,
            keys: itemList(g['keys']).flatMap((entry) => parseKeyEntries(entry)),
            coins,
            wealth: int(g['wealth']),
            encumbrance: int(g['encumbrance']),
            encumbranceMax: int(g['encumbranceMax']),
            encumbranceWord: g['encumbranceWord']?.trim() ?? null
          },
          t
        );
      }
      case 'who': {
        const who: WhoRow[] = rows.map((row) => ({
          name: [row['name'], row['last']].filter((part) => part !== undefined).join(' '),
          title: row['title']?.trim() ?? null,
          alignment: row['alignment'] ?? null,
          gang: row['gang']?.trim() ?? null,
          flags: row['flags'] ?? null
        }));
        return renderWho(design, who, t);
      }
      case 'shop': {
        const shelf: ShopRow[] = rows
          .map((row) => {
            const name = row['item']?.trim() ?? '';
            const item = context.world ? context.world.buildItemEntity(name) : wireItem(name);
            const price = row['price']?.trim() ?? '';
            return {
              name,
              quantity: int(row['quantity']),
              price,
              cost: quotedInCopper(price),
              note: row['note']?.trim() || null,
              item,
              verdict: equipVerdict(item, context.wearer, t)
            };
          })
          .filter((row) => row.name.length > 0);
        return renderShop(design, shelf, context.state.inventory.wealth, t);
      }
      case 'party': {
        const party: PartyRow[] = rows.map((row) => ({
          name: [row['name'], row['last']].filter((part) => part !== undefined).join(' '),
          class: row['class']?.trim() ?? null,
          health: int(row['health']),
          mana: int(row['mana']),
          rank: row['rank'] ?? null,
          flag: row['flag'] ?? null,
          invited: row['invited'] !== undefined
        }));
        return renderParty(design, party, this.config.statline.bands, t);
      }
      case 'experience': {
        const gained = int(g['exp']);
        if (gained === null) return null;
        const progress = context.state.progress;
        const need = progress.expNeeded === null ? null : Math.max(0, progress.expNeeded - gained);
        return renderExperience(design, {
          gained,
          exp: progress.exp === null ? null : progress.exp + gained,
          need,
          level: progress.level,
          expSession: progress.expThisSession + gained
        });
      }
    }
  }
}
