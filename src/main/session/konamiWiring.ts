/**
 * The planner (`KonamiPlanner`, todo 50) wired to the modules it hands goals
 * to and reads facts from, so `SessionManager` composes it in one call.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { AutoHunt } from '../automation/AutoHunt';
import type { CommandQueue } from '../automation/CommandQueue';
import { KonamiPlanner, type PlannerEvents } from '../automation/konami/KonamiPlanner';
import type { Supplies } from '../automation/Supplies';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { SafetyDecision } from '../../shared/automation';
import type { AutomationConfig } from '../../shared/config';
import type { KonamiRecords } from '../../shared/konamiRecords';
import type { ConnectionTarget } from '../../shared/types';
import type { Errands } from './Errands';
import { konamiBrief, type BriefingWorld } from './KonamiBriefing';

/** What the host hands a session for the planner: where its records go and the client's home. */
export interface KonamiDeps {
  records: KonamiRecords;
  home: string;
}

export interface KonamiWiring {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<
    Errands,
    'huntingGrounds' | 'realmClass' | 'capabilities' | 'travellerNow' | 'priceAt'
  >;
  world: BriefingWorld | undefined;
  hunt: Pick<AutoHunt, 'steer' | 'hunting' | 'refusal'>;
  supplies: Pick<Supplies, 'fetch' | 'current'>;
  queue: Pick<CommandQueue, 'enqueue'>;
  config(): AutomationConfig;
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

export function konamiPlanner(wiring: KonamiWiring): KonamiPlanner {
  const { tracker, errands, supplies } = wiring;
  return new KonamiPlanner(
    {
      state: () => tracker.current,
      brief: (now) =>
        konamiBrief(
          {
            world: wiring.world,
            config: wiring.config,
            survey: () => errands.huntingGrounds(null),
            realmClass: () => errands.realmClass(),
            capabilities: () => errands.capabilities(),
            traveller: (state) => errands.travellerNow(state),
            priceAt: (name, shop) => errands.priceAt(name, shop)
          },
          tracker.current,
          now
        ),
      busy: wiring.busy,
      hunting: () => wiring.hunt.hunting,
      buying: () => supplies.current !== null,
      huntRefusal: () => wiring.hunt.refusal,
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
