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
import { wireItem, type ItemEntity } from '../../shared/entities';
import { equipVerdict, type Wearer } from '../../shared/gear';
import { readEffects } from '../../shared/abilities';
import {
  activeDesign,
  ENTITY_SPECS,
  NO_EFFECTS,
  renderRewrite,
  REWRITE_ENTITIES,
  rewriteToChunk,
  type InventoryRow,
  type ReadEffects,
  type PartyRow,
  type RewriteDesign,
  type RewriteEntity,
  type RewriteFacts,
  type ShopRow,
  type WhoRow
} from '../../shared/rewrites';
import { figuresOf, type StatlineFigures } from '../../shared/statline';
import type { Drawn } from '../../shared/template';
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

  /** The design that draws this entity: the first enabled one, or null. */
  designFor(entity: RewriteEntity): RewriteDesign | null {
    return activeDesign(this.config.designs, entity);
  }

  /** The enabled entity that draws in place of this block type, or null. */
  entityFor(type: BlockType): RewriteEntity | null {
    for (const entity of REWRITE_ENTITIES) {
      if (ENTITY_SPECS[entity].blocks.includes(type) && this.designFor(entity) !== null) {
        return entity;
      }
    }
    return null;
  }

  /** Whether a block of this type is drawn by the client rather than painted. */
  wants(type: BlockType): boolean {
    return this.entityFor(type) !== null;
  }

  /** The design that draws the prompt row, where one is on and says something. */
  promptDesign(): RewriteDesign | null {
    const design = this.designFor('statline');
    return design !== null && design.template.trim().length > 0 ? design : null;
  }

  /** The prompt row drawn for these figures, or null where no design draws it. */
  prompt(figures: StatlineFigures): Drawn | null {
    const design = this.promptDesign();
    if (design === null) return null;
    return renderRewrite(design, { entity: 'statline', figures }, this.config.bands, t)[0] ?? null;
  }

  /**
   * The listing drawn, or null where the design declines — a batch with no
   * rows, a template blanked to nothing — in which case the realm's own lines
   * are painted as they were.
   */
  render(block: Block | BatchBlock, context: RewriteContext): RewriteChunk | null {
    const entity = this.entityFor(block.type);
    const design = entity === null ? null : this.designFor(entity);
    if (entity === null || design === null) return null;
    const facts = this.gather(entity, block, context);
    if (facts === null) return null;
    const lines = renderRewrite(design, facts, this.config.bands, t);
    if (lines.length === 0) return null;
    return rewriteToChunk(lines);
  }

  /**
   * What the realm says a thing does, read into words.
   *
   * Here rather than in the pure renderer for the reason the equip verdict is:
   * naming an ability needs the realm on the other end (three ids are worded
   * differently on GreaterMUD) and the realm's own class table for a
   * restriction. `readEffects` is the one reading, shared with the Reference
   * card so a ring cannot say two things.
   */
  private effectsOf(item: ItemEntity, context: RewriteContext): ReadEffects {
    const pairs = item.abilities;
    if (pairs === undefined || pairs.length === 0) return NO_EFFECTS;
    return readEffects(
      pairs,
      {
        table: 'item',
        family: context.state.realm === 'greatermud' ? 'greatermud' : 'other',
        classNames: context.world?.namedClasses() ?? {}
      },
      t
    );
  }

  private gather(
    entity: RewriteEntity,
    block: Block | BatchBlock,
    context: RewriteContext
  ): RewriteFacts | null {
    const figures = figuresOf(context.state);
    const g = block.groups ?? {};
    const rows: ReadonlyArray<Record<string, string>> = 'rows' in block ? block.rows : [];
    switch (entity) {
      case 'statline':
        return { entity, figures };
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
          return {
            item,
            verdict: equipVerdict(item, context.wearer, t),
            effects: this.effectsOf(item, context)
          };
        });
        const coins: Partial<Record<Denomination, number>> = {};
        for (const entry of itemList(carrying)) {
          const coin = parseCoinEntry(entry);
          if (coin) coins[coin.denomination] = coin.count;
        }
        return {
          entity,
          figures,
          pack: {
            items,
            keys: itemList(g['keys']).flatMap((entry) => parseKeyEntries(entry)),
            coins,
            wealth: int(g['wealth']),
            encumbrance: int(g['encumbrance']),
            encumbranceMax: int(g['encumbranceMax']),
            encumbranceWord: g['encumbranceWord']?.trim() ?? null
          }
        };
      }
      case 'who': {
        const who: WhoRow[] = rows.map((row) => ({
          name: [row['name'], row['last']].filter((part) => part !== undefined).join(' '),
          title: row['title']?.trim() ?? null,
          alignment: row['alignment'] ?? null,
          gang: row['gang']?.trim() ?? null,
          flags: row['flags'] ?? null
        }));
        return { entity, figures, rows: who };
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
              verdict: equipVerdict(item, context.wearer, t),
              effects: this.effectsOf(item, context)
            };
          })
          .filter((row) => row.name.length > 0);
        return { entity, figures, rows: shelf };
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
        return { entity, figures, rows: party };
      }
      case 'experience': {
        const gained = int(g['exp']);
        if (gained === null) return null;
        const progress = context.state.progress;
        const need = progress.expNeeded === null ? null : Math.max(0, progress.expNeeded - gained);
        return {
          entity,
          figures,
          gain: {
            gained,
            exp: progress.exp === null ? null : progress.exp + gained,
            need,
            level: progress.level,
            expSession: progress.expThisSession + gained
          }
        };
      }
    }
  }
}
