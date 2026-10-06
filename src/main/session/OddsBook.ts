/**
 * Every monster and every lair's fight run for this character at full health
 * (todo 03), in the background: fights run in slices of `survivalSliceMs`, so
 * the socket's thread is handed back between them. Run again from the start
 * when the character's fitness or its heal and casting settings move (a level
 * gained, a helm put on); the last `survivalBooksKept` books are kept, so
 * figures that move back (a blessing lapsing and cast again) pick theirs up
 * where it was. What a reader asks for goes to the front. The Map
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

/** What the session holds of the book: the readers, the what-if, and its life. */
export type SessionOdds = Pick<
  OddsBook,
  'refresh' | 'mob' | 'mobAs' | 'lair' | 'lairsLeft' | 'reset' | 'dispose'
>;

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

/** What is run for one set of figures, and what is still owed it. */
interface Book {
  /** The fitness and settings it is run for. */
  readonly key: string;
  readonly mobs: Map<string, Odds>;
  readonly lairs: Map<string, Odds>;
  queue: Job[];
  /** Asked for by a reader: run first. A monster's is said when done; the verdict carries it. */
  readonly asked: Set<string>;
  readonly told: Set<string>;
  /** The fight part way through its trials, carried into the next slice. */
  running: { job: Job; trials: FightTrials } | null;
}

const UNREAD: Odds = { kind: 'unread' };
const PENDING: Odds = { kind: 'pending' };
const UNRUN: Odds = { kind: 'unrun' };

export class OddsBook implements SessionModule {
  private readonly tracker: OddsBookParts['tracker'];
  private readonly world: OddsBookParts['world'];
  private readonly errands: OddsBookParts['errands'];
  private readonly setup: OddsBookParts['setup'];
  /** The book for the character as it stands; null while its figures are unread. */
  private book: Book | null = null;
  /** Books for figures the character had before, oldest first. */
  private readonly kept = new Map<string, Book>();
  private slice: NodeJS.Immediate | null = null;

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
      if (this.book !== null) this.reset();
      return;
    }
    const key = this.keyOf(state);
    if (key !== this.book?.key) this.open(key, world);
    this.schedule();
  }

  /** One monster fought alone. */
  mob(name: string): Odds {
    if (this.book === null) return UNREAD;
    const known = this.book.mobs.get(name);
    if (known !== undefined) return known;
    this.promote(`mob:${name}`, { kind: 'mob', name }, true);
    return PENDING;
  }

  /**
   * One monster fought alone by `as` (the character in other gear, or at
   * another level), run now rather than queued and kept nowhere: one whole
   * fight, so a caller asks for one at a time. `attack` is the word it
   * fights with, where not `combat.attack`'s.
   */
  mobAs(name: string, as: CharacterState, attack?: string): Odds {
    const started = this.start(as, { kind: 'mob', name }, attack);
    if ('kind' in started) return started;
    started.run(() => false);
    return { kind: 'run', survival: started.result() };
  }

  /** A lair's fight: as many as it holds at its cap, drawn from its rows. */
  lair(room: WorldRoom): Odds {
    if (room.lair === undefined) return UNRUN;
    if (this.book === null) return UNREAD;
    const key = lairKey(room.lair);
    const known = this.book.lairs.get(key);
    if (known !== undefined) return known;
    this.promote(`lair:${key}`, { kind: 'lair', key, room }, false);
    return PENDING;
  }

  /** The lairs not yet run for the character as it stands: those queued and the one part way. */
  get lairsLeft(): number {
    const book = this.book;
    if (book === null) return 0;
    const running = book.running?.job.kind === 'lair' ? 1 : 0;
    return (
      running + book.queue.filter((job) => job.kind === 'lair' && !book.lairs.has(job.key)).length
    );
  }

  reset(): void {
    this.cancel();
    this.book = null;
    this.kept.clear();
  }

  dispose(): void {
    this.reset();
  }

  private keyOf(state: CharacterState): string {
    return `${this.errands.fitness(state)}#${this.setup.settingsKey(state)}`;
  }

  /**
   * The book for `key`: one kept from before, else a new one owing every lair
   * and monster. The book put down is kept, part-run fight and all, the
   * oldest past `survivalBooksKept` forgotten.
   */
  private open(key: string, world: OddsWorld): void {
    this.cancel();
    const kept = this.kept.get(key);
    this.kept.delete(key);
    if (this.book !== null) {
      this.kept.set(this.book.key, this.book);
      for (const oldest of this.kept.keys()) {
        if (this.kept.size <= tuning().menace.survivalBooksKept) break;
        this.kept.delete(oldest);
      }
    }
    this.book = kept ?? { ...this.owed(world), key };
  }

  /** A new book's queue: every lair, once per spawn list, then every monster. */
  private owed(world: OddsWorld): Omit<Book, 'key'> {
    const lairs = new Map<string, WorldRoom>();
    for (const room of world.everyRoom()) {
      if (room.lair === undefined) continue;
      const each = lairKey(room.lair);
      if (!lairs.has(each)) lairs.set(each, room);
    }
    return {
      mobs: new Map(),
      lairs: new Map(),
      queue: [
        ...[...lairs].map(([each, room]): Job => ({ kind: 'lair', key: each, room })),
        ...world.mobNames().map((name): Job => ({ kind: 'mob', name }))
      ],
      asked: new Set(),
      told: new Set(),
      running: null
    };
  }

  private promote(id: string, job: Job, tell: boolean): void {
    const book = this.book;
    if (book === null || book.asked.has(id)) return;
    book.asked.add(id);
    if (tell) book.told.add(id);
    book.queue.unshift(job);
    this.schedule();
  }

  private schedule(): void {
    const book = this.book;
    if (this.slice !== null || book === null) return;
    if (book.queue.length === 0 && book.running === null) return;
    this.slice = setImmediate(() => {
      this.slice = null;
      this.work();
    });
  }

  private cancel(): void {
    if (this.slice !== null) clearImmediate(this.slice);
    this.slice = null;
  }

  /**
   * Fights until the slice is spent, then yields, a fight's trials included:
   * one carries on in the next slice. A key that moved stops it for `refresh`.
   */
  private work(): void {
    const book = this.book;
    if (book === null) return;
    const began = performance.now();
    const budget = tuning().menace.survivalSliceMs;
    const spent = (): boolean => performance.now() - began >= budget;
    let told = false;
    const record = (job: Job, odds: Odds): void => {
      if (job.kind === 'mob') book.mobs.set(job.name, odds);
      else book.lairs.set(job.key, odds);
      if (book.told.delete(job.kind === 'mob' ? `mob:${job.name}` : `lair:${job.key}`)) told = true;
    };
    while ((book.running !== null || book.queue.length > 0) && !spent()) {
      const state = this.tracker.current;
      // The character moved under the book: open the one for the character there now.
      if (this.keyOf(state) !== book.key) {
        this.refresh(state);
        return;
      }
      if (book.running === null) {
        const job = book.queue.shift()!;
        const done = job.kind === 'mob' ? book.mobs.has(job.name) : book.lairs.has(job.key);
        if (done) continue;
        const started = this.start(state, job);
        if ('kind' in started) {
          record(job, started);
          continue;
        }
        book.running = { job, trials: started };
      }
      const { job, trials } = book.running;
      trials.run(spent);
      if (!trials.done) break;
      book.running = null;
      record(job, { kind: 'run', survival: trials.result() });
    }
    if (told) this.session.ran();
    this.schedule();
  }

  /** The job's fight set up for its trials, or what it comes to where none can be run. */
  private start(state: CharacterState, job: Job, attack?: string): Odds | FightTrials {
    const world = this.world;
    const character = this.setup.character(state, 'rested', attack);
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
