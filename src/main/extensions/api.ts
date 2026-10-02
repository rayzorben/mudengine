/**
 * What an extension is handed, and what it hands back (todo 84).
 *
 * An extension is a program this client does not ship: an ES module in the
 * home's `extensions/<name>/` folder, found at startup by its
 * `manifest.json`, loaded once and asked for one `ExtensionSession` per
 * character. Nothing here names any extension. It reads what the client
 * already knows about the character (the sheet, the hunting survey, the gear
 * the realm sells, the trainers ahead) and acts only through what the client
 * already does: the hunt steered to a spot, a shop trip, a command proposed
 * to the queue, settings laid over the character's own. Its card is its own
 * page, drawn in a frame on the rail (`ExtensionCard`), fed the view it
 * publishes and answering with actions.
 *
 * Types only, and stable: an extension built against them imports nothing
 * else of the client's main process.
 */
import type { AttackOption } from '../../shared/attackOptions';
import type { SafetyDecision } from '../../shared/automation';
import type { Capabilities } from '../../shared/abilities';
import type { BlessingConfig } from '../../shared/blessings';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig, SupplyItem } from '../../shared/config';
import type { LayerWrite } from '../../shared/extensions';
import type { FledEntry } from '../../shared/fled';
import type { HuntingAdvice, HuntWait } from '../../shared/hunting';
import type { TuningConfig } from '../../shared/internal';
import type { Odds } from '../../shared/survival';
import type { SlotUpgrade } from '../../shared/upgrades';
import type { RoomId, WorldRoom } from '../../shared/world';
import type { WalkProgress } from '../../shared/walk';
import type { Intent, Offered } from '../automation/CommandQueue';
import type { TrainerAhead } from '../automation/TrainErrand';
import type { RealmClass } from '../session/Errands';
import type { Traveller, WorldGraph } from '../world/WorldGraph';

/** What of the realm an extension reads: the world database, never edited. */
export type ExtensionWorld = Pick<
  WorldGraph,
  | 'size'
  | 'buildMobEntity'
  | 'byId'
  | 'lairEntities'
  | 'residentEntities'
  | 'itemsWornIn'
  | 'stockingPlaces'
  | 'spellNamed'
  | 'classNamed'
  | 'raceId'
  | 'namedClasses'
  | 'namedRaces'
  | 'route'
>;

/** A shop trip under way, as the card reads it. */
export interface ShopTrip {
  item: string;
  shop: string;
  stage: 'walking' | 'bank' | 'shop';
}

/** One character's client, as an extension sees it. Every read is the moment's. */
export interface ExtensionSessionHost {
  /** Where this extension keeps this character's records, or null where nothing is kept (a test). */
  readonly stateDir: string | null;
  /** The client's home folder, or null. */
  readonly home: string | null;

  character(): CharacterState;
  /** The settings in force: the character's own with every extension's layer over them. */
  config(): AutomationConfig;
  tuning(): TuningConfig;
  /** `host:port` of the realm connected to, or null. */
  realm(): string | null;
  world(): ExtensionWorld | undefined;

  /** The hunting survey (`Errands.huntingGrounds`), everywhere the exits reach. */
  huntingGrounds(): HuntingAdvice;
  realmClass(): RealmClass;
  capabilities(): Capabilities;
  traveller(state: CharacterState): Traveller;
  /** A counter's price in copper at that room, charm aside. */
  priceAt(name: string, shop: RoomId): number | null;
  /** The simulator's run of a lair's fight. */
  lairOdds(room: WorldRoom): Odds;
  /**
   * The blessings kept up now: under `autoChooseBlessings` the chosen self
   * rows and the list's party rows, otherwise the list (`Blessings.entries`).
   */
  blessings(): readonly BlessingConfig[];
  fled(): readonly FledEntry[];
  /** What the trip would pay each level, at the trainer it would walk to. */
  trainersAhead(levels: readonly number[]): Array<TrainerAhead | null>;
  /**
   * The better gear the realm sells per slot, the cheapest wearable kept, for
   * the character as it stands or as `as` (the same character at a later level).
   */
  gearUpgrades(perSlot: number, as?: CharacterState): SlotUpgrade[];
  /** The attacks the class can make and a round of each. */
  attacks(): AttackOption[];
  /** The safety trace, newest first. */
  safety(): readonly SafetyDecision[];
  /** An escape, a move, a walk, an errand: the character is someone else's for now. */
  busy(): boolean;
  /** The last lines of the session, colour removed. */
  backscroll(lines: number): string;

  hunt: {
    /** The spot to hunt by key, nowhere (null), or the hunt's own choice (undefined). */
    steer(key: string | null | undefined): void;
    readonly hunting: boolean;
    readonly refusal: string | null;
    readonly heading: { walking: boolean; place: string } | null;
    readonly waiting: HuntWait | null;
  };
  training: {
    readonly heading: { trainer: string; room: string; copper: number; training: boolean } | null;
    readonly refusal: { why: string; at: number } | null;
  };
  shopping: {
    /** One trip for a row; its refusal, or null once under way. */
    fetch(row: SupplyItem): string | null;
    readonly current: ShopTrip | null;
  };
  walk(): WalkProgress;
  /** A command proposed to the queue, like any module's. */
  offer(intent: Intent): Offered;
  /** Settings laid over the character's own while this extension runs; null lifts them. */
  layer(writes: readonly LayerWrite[] | null): void;
  /** Writes settings into the character's file; the error, or null. */
  keep(writes: readonly LayerWrite[]): string | null;
  notice(message: string): void;
  /** The view changed: the card is sent it again. */
  changed(): void;
}

/** One character's instance of an extension. Every hook is optional but the view. */
export interface ExtensionSession {
  onBlock?(block: Block): void;
  onCharacter?(state: CharacterState): void;
  /** The player pressed Stop. */
  playerStopped?(): void;
  configure?(config: AutomationConfig): void;
  reset?(): void;
  dispose?(): void;
  /** What the card is sent: plain data. */
  view(): unknown;
  /** One of the card's buttons, with its arguments; what it answers goes back to the card. */
  action?(name: string, args: readonly unknown[]): unknown;
}

/** What an extension's main module exports. */
export interface Extension {
  session(host: ExtensionSessionHost): ExtensionSession;
}
