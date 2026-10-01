/**
 * The planner (`KonamiPlanner`, todo 50) wired to the modules it hands goals
 * to and reads facts from, so `SessionManager` composes it in one call.
 */
import { t } from '../app/i18n';
import type { FledEntry } from '../../shared/fled';
import { tuning } from '../app/tuning';
import type { AutoHunt } from '../automation/AutoHunt';
import type { CommandQueue } from '../automation/CommandQueue';
import { KonamiPlanner, type PlannerEvents } from '../automation/konami/KonamiPlanner';
import type { ErrandStage, Supplies } from '../automation/Supplies';
import type { TrainErrand } from '../automation/TrainErrand';
import type { Walker } from '../automation/Walker';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { SafetyDecision } from '../../shared/automation';
import type { AutomationConfig } from '../../shared/config';
import type { KonamiActivity, KonamiDoing, KonamiRecords } from '../../shared/konamiRecords';
import type { ConnectionTarget } from '../../shared/types';
import type { Errands } from './Errands';
import {
  konamiBrief,
  konamiRoadFacts,
  type BriefingParts,
  type BriefingWorld
} from './KonamiBriefing';
import type { OddsReader } from './OddsBook';

/** What the host hands a session for the planner: where its records go and the client's home. */
export interface KonamiDeps {
  records: KonamiRecords;
  home: string;
}

export interface KonamiWiring {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<
    Errands,
    | 'huntingGrounds'
    | 'realmClass'
    | 'capabilities'
    | 'travellerNow'
    | 'priceAt'
    | 'trainers'
  >;
  /** The simulator's run of each lair's fight. */
  odds: Pick<OddsReader, 'lair'>;
  world: BriefingWorld | undefined;
  hunt: Pick<AutoHunt, 'steer' | 'hunting' | 'refusal' | 'heading' | 'waiting'>;
  supplies: Pick<Supplies, 'fetch' | 'current'>;
  /** The trainer a training trip is bound for, and the walk under way, for the card. */
  trainLevel: Pick<TrainErrand, 'heading' | 'refusal'>;
  walker: Pick<Walker, 'progress'>;
  queue: Pick<CommandQueue, 'enqueue'>;
  config(): AutomationConfig;
  /** The monsters this character ran from. */
  fled(): readonly FledEntry[];
  /** An escape, a move out, a walk, a trip: the character is someone else's for now. */
  busy(): boolean;
  /** The safety trace, newest first: what the modules said they would not do. */
  safety(): readonly SafetyDecision[];
  target(): ConnectionTarget | null;
  /** Configures the session again, so the plan's settings land. */
  relayer(): void;
  events: PlannerEvents;
  deps: KonamiDeps | undefined;
}

/** The `wear` proposed for a bought item, coalesced so a second status line adds nothing. */
const WEAR_KEY = 'konami:wear';

/** A shop trip's stage as the card says it: on the way, at the bank, at the counter. */
function tripStage(stage: ErrandStage): 'walking' | 'bank' | 'shop' {
  switch (stage) {
    case 'walking':
      return 'walking';
    case 'balance':
    case 'withdrawing':
      return 'bank';
    case 'waiting':
    case 'listing':
    case 'buying':
      return 'shop';
    default: {
      const never: never = stage;
      return never;
    }
  }
}

/** The goal at work, read off whichever module carries it: training, a shop trip, the hunt. */
function activityOf(wiring: KonamiWiring): KonamiActivity | null {
  const train = wiring.trainLevel.heading;
  const buy = wiring.supplies.current;
  const hunt = wiring.hunt.heading;
  const doing: KonamiDoing | null =
    train !== null
      ? { kind: 'train', ...train }
      : buy !== null
        ? { kind: 'buy', item: buy.item.name, shop: buy.shopName, stage: tripStage(buy.stage) }
        : hunt !== null
          ? { kind: 'hunt', ...hunt }
          : wiring.hunt.waiting !== null
            ? { kind: 'waiting', on: wiring.hunt.waiting }
            : null;
  if (doing === null) return null;
  const progress = wiring.walker.progress;
  const walk =
    progress.status === 'walking' ? { done: progress.done, total: progress.total } : null;
  return { doing, walk };
}

export function konamiPlanner(wiring: KonamiWiring): KonamiPlanner {
  const { tracker, errands, supplies } = wiring;
  const parts: BriefingParts = {
    world: wiring.world,
    config: wiring.config,
    survey: () => errands.huntingGrounds(null),
    realmClass: () => errands.realmClass(),
    capabilities: () => errands.capabilities(),
    traveller: (state) => errands.travellerNow(state),
    priceAt: (name, shop) => errands.priceAt(name, shop),
    lairOdds: (room) => wiring.odds.lair(room),
    fled: wiring.fled,
    // The trainer the player chose, else the cheapest (listed first). Reach is the trip's
    // to judge (`bestTrainer`), so a trainer no route reaches can price lower than it pays.
    trainCostAt: (level) => {
      const chosen = wiring.config().train.trainer;
      const taking = errands.trainers(level);
      // A level the chosen trainer does not take goes to the cheapest that does, as the trip would.
      const trainer =
        (chosen > 0 ? taking.find((each) => each.shop === chosen) : undefined) ?? taking[0];
      return trainer?.cost ?? null;
    }
  };
  return new KonamiPlanner(
    {
      state: () => tracker.current,
      brief: (now, lessons, inHand) => konamiBrief(parts, tracker.current, now, lessons, inHand),
      road: (brief) => konamiRoadFacts(parts, tracker.current, brief),
      busy: wiring.busy,
      hunting: () => wiring.hunt.hunting,
      activity: () => activityOf(wiring),
      buying: () => supplies.current !== null,
      huntRefusal: () => wiring.hunt.refusal,
      trainRefusal: () => wiring.trainLevel.refusal,
      refusals: () =>
        wiring
          .safety()
          .filter((decision) => decision.refused !== undefined)
          .slice(0, tuning().konami.refusalsKept)
          .map((decision) => `${decision.action}: ${decision.refused ?? ''}`),
      realm: () => {
        const target = wiring.target();
        return target === null ? null : `${target.host}:${target.port}`;
      }
    },
    {
      steerHunt: (key) => wiring.hunt.steer(key),
      // One of it, at the counter the brief priced: a row written nowhere.
      buy: (goal) =>
        supplies.fetch(
          { name: goal.name, min: 1, max: 1, shop: goal.shop, at: goal.at },
          tracker.current
        ),
      wear: (name) => {
        wiring.queue.enqueue({
          command: `wear ${name}`,
          priority: 'probe',
          coalesceKey: WEAR_KEY,
          expiresAt: Date.now() + tuning().konami.wearExpiresMs,
          reason: t('automation.konami.reasonWear', { item: name })
        });
      },
      relayer: wiring.relayer
    },
    wiring.events,
    wiring.deps?.records ?? null,
    wiring.deps?.home ?? null
  );
}
