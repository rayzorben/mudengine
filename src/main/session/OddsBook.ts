/**
 * Every monster and every lair's fight run for this character at full health
 * (todo 03), in the background: fights run in slices of `survivalSliceMs`, so
 * the socket's thread is handed back between them. Run again from the start
 * when the character's fitness or its heal and casting settings move (a level
 * gained, a helm put on). What a reader asks for goes to the front. The Map
 * card's lair colours, the hunting grounds and the Combat card read it. See
 * mudengine-automation › *The verdict is also run as a fight*.
 */
import { tuning } from '../app/tuning';
import type { SessionModule } from '../automation/Module';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import {
  FightSetup,
  type FightFoe,
  type FightSetupParts,
  type FightSetupSession
} from './FightSetup';
import type { CharacterState } from '../../shared/character';
import { startFight, type FightTrials, type Odds } from '../../shared/survival';
import { lairKey, parseLair, type WorldRoom } from '../../shared/world';

export type OddsWorld = Pick<
  WorldGraph,
  'mobNames' | 'buildMobEntity' | 'everyRoom' | 'lairEntities'
>;

export interface OddsBookParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly world: OddsWorld | undefined;
  readonly errands: Pick<Errands, 'fitness'>;
  readonly setup: Pick<FightSetup, 'character' | 'foes' | 'settingsKey'>;
}

export interface OddsBookSession {
  /** A fight somebody asked for has been run: what reads it is due again. */
  ran(): void;
}

/** What a reader asks the book: one monster alone, or a lair. */
export type OddsReader = Pick<OddsBook, 'mob' | 'lair'>;

/**
 * The book and the character half it runs with, built together: `Appraisal`
 * runs the room as it stands with the same `FightSetup`.
 */
export function fightBook(
  parts: FightSetupParts & Omit<OddsBookParts, 'setup'>,
  session: FightSetupSession & OddsBookSession
): { setup: FightSetup; odds: OddsBook } {
  const setup = new FightSetup(parts, session);
  return { setup, odds: new OddsBook({ ...parts, setup }, session) };
}

type Job = { kind: 'mob'; name: string } | { kind: 'lair'; key: string; room: WorldRoom };

const UNREAD: Odds = { kind: 'unread' };
const PENDING: Odds = { kind: 'pending' };
const UNRUN: Odds = { kind: 'unrun' };

export class OddsBook implements SessionModule {
  private readonly tracker: OddsBookParts['tracker'];
  private readonly world: OddsBookParts['world'];
  private readonly errands: OddsBookParts['errands'];
  private readonly setup: OddsBookParts['setup'];
  /** The fitness and settings the book is run for; null while the character's figures are unread. */
  private key: string | null = null;
  private readonly mobs = new Map<string, Odds>();
  private readonly lairs = new Map<string, Odds>();
  private queue: Job[] = [];
  /** Asked for by a reader: run first. A monster's is said when done; the verdict carries it. */
  private readonly asked = new Set<string>();
  private readonly told = new Set<string>();
  private slice: NodeJS.Immediate | null = null;
  /** The fight part way through its trials, carried into the next slice. */
  private running: { job: Job; trials: FightTrials } | null = null;

  constructor(
    parts: OddsBookParts,
    private readonly session: OddsBookSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.errands = parts.errands;
    this.setup = parts.setup;
  }

  /**
   * Starts the book again when what it was run for moved. Asked on every
   * character change; it costs a string comparison when nothing did.
   */
  refresh(state: CharacterState): void {
    const world = this.world;
    if (world === undefined || state.phase !== 'in-game') return;
    if (this.setup.character(state, 'rested') === null) {
      // Nothing is run for a character nobody has read, and nothing kept from one that was.
      if (this.key !== null) this.reset();
      return;
    }
    const key = this.keyOf(state);
    if (key === this.key) {
      this.schedule();
      return;
    }
    this.reset();
    this.key = key;
    const lairs = new Map<string, WorldRoom>();
    for (const room of world.everyRoom()) {
      if (room.lair === undefined) continue;
      const each = lairKey(room.lair);
      if (!lairs.has(each)) lairs.set(each, room);
    }
    this.queue = [
      ...[...lairs].map(([each, room]): Job => ({ kind: 'lair', key: each, room })),
      ...world.mobNames().map((name): Job => ({ kind: 'mob', name }))
    ];
    this.schedule();
  }

  /** One monster fought alone. */
  mob(name: string): Odds {
    if (this.key === null) return UNREAD;
    const known = this.mobs.get(name);
    if (known !== undefined) return known;
    this.promote(`mob:${name}`, { kind: 'mob', name }, true);
    return PENDING;
  }

  /** A lair's fight: as many as it holds at its cap, drawn from its rows. */
  lair(room: WorldRoom): Odds {
    if (room.lair === undefined) return UNRUN;
    if (this.key === null) return UNREAD;
    const key = lairKey(room.lair);
    const known = this.lairs.get(key);
    if (known !== undefined) return known;
    this.promote(`lair:${key}`, { kind: 'lair', key, room }, false);
    return PENDING;
  }

  /** The lairs not yet run for the character as it stands: those queued and the one part way. */
  get lairsLeft(): number {
    const running = this.running?.job.kind === 'lair' ? 1 : 0;
    return (
      running + this.queue.filter((job) => job.kind === 'lair' && !this.lairs.has(job.key)).length
    );
  }

  reset(): void {
    this.cancel();
    this.key = null;
    this.mobs.clear();
    this.lairs.clear();
    this.asked.clear();
    this.told.clear();
    this.queue = [];
  }

  dispose(): void {
    this.reset();
  }

  private keyOf(state: CharacterState): string {
    return `${this.errands.fitness(state)}#${this.setup.settingsKey(state)}`;
  }

  private promote(id: string, job: Job, tell: boolean): void {
    if (this.asked.has(id)) return;
    this.asked.add(id);
    if (tell) this.told.add(id);
    this.queue.unshift(job);
    this.schedule();
  }

  private schedule(): void {
    if (this.slice !== null || (this.queue.length === 0 && this.running === null)) return;
    this.slice = setImmediate(() => {
      this.slice = null;
      this.work();
    });
  }

  private cancel(): void {
    if (this.slice !== null) clearImmediate(this.slice);
    this.slice = null;
    this.running = null;
  }

  /**
   * Fights until the slice is spent, then yields, a fight's trials included:
   * one carries on in the next slice. A key that moved stops it for `refresh`.
   */
  private work(): void {
    const began = performance.now();
    const budget = tuning().menace.survivalSliceMs;
    const spent = (): boolean => performance.now() - began >= budget;
    let told = false;
    const record = (job: Job, odds: Odds): void => {
      if (job.kind === 'mob') this.mobs.set(job.name, odds);
      else this.lairs.set(job.key, odds);
      if (this.told.delete(job.kind === 'mob' ? `mob:${job.name}` : `lair:${job.key}`)) told = true;
    };
    while ((this.running !== null || this.queue.length > 0) && !spent()) {
      const state = this.tracker.current;
      // The character moved under the book: start it again for the one there now.
      if (this.keyOf(state) !== this.key) {
        this.refresh(state);
        return;
      }
      if (this.running === null) {
        const job = this.queue.shift()!;
        const done = job.kind === 'mob' ? this.mobs.has(job.name) : this.lairs.has(job.key);
        if (done) continue;
        const started = this.start(state, job);
        if ('kind' in started) {
          record(job, started);
          continue;
        }
        this.running = { job, trials: started };
      }
      const { job, trials } = this.running;
      trials.run(spent);
      if (!trials.done) break;
      this.running = null;
      record(job, { kind: 'run', survival: trials.result() });
    }
    if (told) this.session.ran();
    this.schedule();
  }

  /** The job's fight set up for its trials, or what it comes to where none can be run. */
  private start(state: CharacterState, job: Job): Odds | FightTrials {
    const world = this.world;
    const character = this.setup.character(state, 'rested');
    if (world === undefined || character === null) return UNRUN;
    let met: FightFoe[];
    let draw: number | undefined;
    if (job.kind === 'mob') {
      const entity = world.buildMobEntity(job.name, { at: null });
      if (entity === undefined || entity.source === 'wire') return UNRUN;
      met = [{ name: job.name, subject: entity }];
    } else {
      // Everything it spawns, at its cap: a lair is hunted, so all of it fights.
      met = world.lairEntities(job.room).map((entity) => ({ name: entity.name, subject: entity }));
      draw = parseLair(job.room.lair ?? '').max ?? 1;
    }
    if (met.length === 0) return UNRUN;
    return (
      startFight({
        ...character,
        ...this.setup.foes(state, character, met),
        ...(draw === undefined ? {} : { draw })
      }) ?? UNRUN
    );
  }
}
