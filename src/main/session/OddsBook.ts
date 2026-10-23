/**
 * Every monster and every lair's fight run for this character at full health
 * (todo 03), in the background: each fight is set up here, in slices of
 * `survivalSliceMs`, and run by the simulator (`FightSimulator`: worker
 * threads in the app), one at a time. Run again from the start
 * when the character's fitness or its heal and casting settings move (a level
 * gained, a helm put on); the last `survivalBooksKept` books are kept, so
 * figures that move back (a blessing lapsing and cast again) pick theirs up
 * where it was. What a reader asks for goes to the front. The Map
 * card's lair colours, the hunting grounds and the Combat card read it. See
 * mudengine-automation › *The verdict is also run as a fight*.
 */
import { mobRowName } from '../world/rowNames';
import { tuning } from '../app/tuning';
import { roundMsAt } from '../automation/RoundBeat';
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
import { standingOf, type CharacterState } from '../../shared/character';
import { waitsToBeStruck } from '../../shared/mobs';
import { SlicedSimulator } from './slicedSimulator';
import type { FightSimulator } from '../../shared/simulator';
import type { HarmOdds, HarmPrediction } from '../../shared/harm';
import { mobTerms, worstModel } from '../../shared/mobRound';
import { simulateFight, type Odds, type SurvivalInput } from '../../shared/survival';
import type { PartyOdds } from '../../shared/partyFight';
import { lairKey, parseLair, roomAddress, type WorldRoom } from '../../shared/world';

export type OddsWorld = Pick<
  WorldGraph,
  'mobNames' | 'buildMobEntity' | 'everyRoom' | 'lairEntities' | 'mobAsPrinted'
>;

export interface OddsBookParts {
  readonly tracker: Pick<CharacterTracker, 'current'>;
  readonly world: OddsWorld | undefined;
  readonly errands: Pick<Errands, 'fitness' | 'realmSpeed'>;
  readonly setup: Pick<FightSetup, 'character' | 'foes' | 'settingsKey'>;
  readonly simulator: FightSimulator;
}

export interface OddsBookSession {
  /** A fight somebody asked for has been run: what reads it is due again. */
  ran(): void;
}

/** What a reader asks the book: one monster alone, or a lair. */
export type OddsReader = Pick<OddsBook, 'mob' | 'lair'>;

/**
 * The readers, a lair run past (todo 31), a lair hunted beside the party
 * (todo 152, the hunting grounds'), and the lair's fights as they stand
 * without queueing them (the router's).
 */
export type OddsPeeker = OddsReader &
  Pick<
    OddsBook,
    'pass' | 'mobKnown' | 'lairKnown' | 'passKnown' | 'lairsLeft' | 'partyLair' | 'alone'
  >;

/** What the session holds of the book: the readers, the what-if, and its life. */
export type SessionOdds = Pick<
  OddsBook,
  | 'refresh'
  | 'mob'
  | 'mobKnown'
  | 'mobAs'
  | 'predict'
  | 'lair'
  | 'partyLair'
  | 'alone'
  | 'lairKnown'
  | 'pass'
  | 'passKnown'
  | 'lairsLeft'
  | 'reset'
  | 'dispose'
>;

/**
 * The book and the character half it runs with, built together: `Appraisal`
 * runs the room as it stands with the same `FightSetup`.
 */
export function fightBook(
  parts: Omit<FightSetupParts, 'joiners'> &
    Omit<OddsBookParts, 'setup' | 'simulator'> & { world: Pick<WorldGraph, 'joiners'> | undefined },
  session: FightSetupSession & OddsBookSession,
  simulator: FightSimulator = new SlicedSimulator()
): { setup: FightSetup; odds: OddsBook; simulator: FightSimulator } {
  const setup = new FightSetup({ ...parts, joiners: parts.world?.joiners }, session);
  return { setup, odds: new OddsBook({ ...parts, setup, simulator }, session), simulator };
}

/**
 * How a lair is met: hunted, every monster struck in turn, or run past, where
 * nobody is struck and what waits to be struck stays out of it (todo 31).
 */
type LairWay = 'hunt' | 'pass';

type Job =
  | { kind: 'mob'; name: string }
  | { kind: 'lair'; key: string; room: WorldRoom; way: LairWay; party?: PartyOdds };

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
  /**
   * The lairs hunted beside the party last asked for, by lair key; only one
   * party's are kept, and only those asked (the hunting grounds).
   */
  party: { key: string; lairs: Map<string, Odds> } | null;
}

const UNREAD: Odds = { kind: 'unread' };
const PENDING: Odds = { kind: 'pending' };
const UNRUN: Odds = { kind: 'unrun' };

export class OddsBook implements SessionModule {
  private readonly tracker: OddsBookParts['tracker'];
  private readonly world: OddsBookParts['world'];
  private readonly errands: OddsBookParts['errands'];
  private readonly setup: OddsBookParts['setup'];
  private readonly simulator: FightSimulator;
  /** The book for the character as it stands; null while its figures are unread. */
  private book: Book | null = null;
  /** Books for figures the character had before, oldest first. */
  private readonly kept = new Map<string, Book>();
  private slice: NodeJS.Immediate | null = null;
  /** The fight with the simulator, and how to drop it. */
  private running: { book: Book; job: Job; drop: () => void } | null = null;

  constructor(
    parts: OddsBookParts,
    private readonly session: OddsBookSession
  ) {
    this.tracker = parts.tracker;
    this.world = parts.world;
    this.errands = parts.errands;
    this.setup = parts.setup;
    this.simulator = parts.simulator;
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
    const row = this.rowOf(name);
    const known = this.book.mobs.get(row);
    if (known !== undefined) return known;
    const job: Job = { kind: 'mob', name: row };
    this.promote(idOf(job), job, true);
    return PENDING;
  }

  /**
   * One monster fought alone as the book holds it, queueing nothing: a route
   * search weighs the wanderers of every room it expands (todo 25). Every
   * monster is owed from the book's start, so pending until its turn.
   */
  mobKnown(name: string): Odds {
    if (this.book === null) return UNREAD;
    return this.book.mobs.get(this.rowOf(name)) ?? PENDING;
  }

  /** The realm's row behind a printed name, so one fight is run for every spelling. */
  private rowOf(name: string): string {
    return mobRowName(this.world, name);
  }

  /**
   * One monster fought alone by `as` (the character in other gear, or at
   * another level), run now rather than queued and kept nowhere: one whole
   * fight, so a caller asks for one at a time. `attack` is the word it
   * fights with, where not `combat.attack`'s.
   */
  mobAs(name: string, as: CharacterState, attack?: string): Odds {
    const input = this.inputOf(as, { kind: 'mob', name }, attack);
    if ('kind' in input) return input;
    const survival = simulateFight(input);
    return survival === null ? UNRUN : { kind: 'run', survival };
  }

  /**
   * What the book predicts for the monster as printed against the character
   * as the line found it, stamped on a fight's record at its opening (todo 26): the
   * model's terms against its worst row (as the fight is run), and the
   * monster's fight alone as the book holds it. A fight not yet run is asked
   * for and runs off the thread, so the record says pending. Null with no
   * realm or no sheet.
   */
  predict(printed: string, state: CharacterState): HarmPrediction | null {
    const world = this.world;
    const character = this.setup.character(state, 'now');
    if (world === undefined || character === null) return null;
    const row = world.mobAsPrinted(printed)?.name ?? null;
    const entity = world.buildMobEntity(printed, { at: roomAddress(state.room) });
    const terms = entity.source === 'wire' ? null : mobTerms(worstModel(entity, character.player));
    const odds: HarmOdds = row === null ? { kind: 'unrun' } : harmOdds(this.mob(row));
    return { row, terms, odds, roundMs: roundMsAt(this.errands.realmSpeed) };
  }

  /**
   * A lair's fight as the book holds it, queueing nothing: a route search
   * touches every lair it expands, and queueing each would run fights for
   * rooms nobody walks (todo 23). Pending until `lair` has asked for it.
   */
  lairKnown(room: WorldRoom): Odds {
    return this.known(room, 'hunt');
  }

  /** A lair's fight: as many as it holds at its cap, drawn from its rows. */
  lair(room: WorldRoom): Odds {
    return this.asked(room, 'hunt');
  }

  /**
   * A lair hunted with the party beside the character (todo 152), queued
   * when asked. Asking for another party forgets the last one's fights.
   */
  partyLair(room: WorldRoom, party: PartyOdds): Odds {
    if (room.lair === undefined) return UNRUN;
    const book = this.book;
    if (book === null) return UNREAD;
    if (book.party?.key !== party.key) this.forgetParty(book, party.key);
    const key = lairKey(room.lair);
    const known = book.party?.lairs.get(key);
    if (known !== undefined) return known;
    const job: Job = { kind: 'lair', key, room, way: 'hunt', party };
    this.promote(idOf(job), job, false);
    return PENDING;
  }

  /** The hunting grounds asked alone: the last party's fights are forgotten, and those owed are not run. */
  alone(): void {
    const book = this.book;
    if (book === null || book.party === null) return;
    this.forgetParty(book, null);
  }

  /** `passKnown`'s queueing twin: a lair run past, as a route about to be read meets it. */
  pass(room: WorldRoom): Odds {
    return this.asked(room, 'pass');
  }

  /**
   * A lair run past as the book holds it, queueing nothing (`lairKnown`): the
   * same draw, with only the monsters that attack on sight swinging. Where
   * none of its monsters waits to be struck, it is the hunt's fight.
   */
  passKnown(room: WorldRoom): Odds {
    return this.known(room, 'pass');
  }

  private known(room: WorldRoom, way: LairWay): Odds {
    if (room.lair === undefined) return UNRUN;
    if (this.book === null) return UNREAD;
    return this.book.lairs.get(this.lairJob(room, way).key) ?? PENDING;
  }

  private asked(room: WorldRoom, way: LairWay): Odds {
    if (room.lair === undefined) return UNRUN;
    if (this.book === null) return UNREAD;
    const job = this.lairJob(room, way);
    const known = this.book.lairs.get(job.key);
    if (known !== undefined) return known;
    this.promote(idOf(job), job, false);
    return PENDING;
  }

  /**
   * A lair's job and the key its odds are kept under. A pass where nothing
   * waits to be struck is the hunt's fight, so it shares the hunt's key and
   * is never run twice. The book is per standing and per item held that a
   * monster spares its holder for (`Errands.fitness`), so who waits is fixed
   * for its life.
   */
  private lairJob(room: WorldRoom, way: LairWay): Job & { kind: 'lair' } {
    const key = lairKey(room.lair ?? '');
    const standing = standingOf(this.tracker.current);
    const passes =
      way === 'pass' &&
      (this.world?.lairEntities(room) ?? []).some((entity) => waitsToBeStruck(entity, standing));
    return passes
      ? { kind: 'lair', key: `${key}#pass`, room, way }
      : { kind: 'lair', key, room, way: 'hunt' };
  }

  /** The lair fights not yet run for the character as it stands (hunts, passes, and those beside the party asked about): those queued and the one part way. */
  get lairsLeft(): number {
    const book = this.book;
    if (book === null) return 0;
    const running = this.running?.book === book && this.running.job.kind === 'lair' ? 1 : 0;
    return running + book.queue.filter((job) => job.kind === 'lair' && !done(book, job)).length;
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

  /**
   * A new book's queue: every lair hunted, once per spawn list, then each run
   * past where some of it waits to be struck (the router prices a pass off
   * the book without queueing it), then every monster.
   */
  private owed(world: OddsWorld): Omit<Book, 'key'> {
    const hunts: Job[] = [];
    const passes: Job[] = [];
    const seen = new Set<string>();
    for (const room of world.everyRoom()) {
      if (room.lair === undefined) continue;
      const hunt = this.lairJob(room, 'hunt');
      if (seen.has(hunt.key)) continue;
      seen.add(hunt.key);
      hunts.push(hunt);
      // Its pass where some of it waits to be struck; the hunt's own fight where none does.
      const pass = this.lairJob(room, 'pass');
      if (pass.key !== hunt.key) passes.push(pass);
    }
    return {
      mobs: new Map(),
      lairs: new Map(),
      queue: [...hunts, ...passes, ...world.mobNames().map((name): Job => ({ kind: 'mob', name }))],
      asked: new Set(),
      told: new Set(),
      party: null
    };
  }

  /** Drops one party's fights and what is owed them; `key` is the party now asked about, null for none. */
  private forgetParty(book: Book, key: string | null): void {
    book.party = key === null ? null : { key, lairs: new Map() };
    book.queue = book.queue.filter((job) => job.kind !== 'lair' || job.party === undefined);
    for (const id of book.asked) if (id.startsWith('party:')) book.asked.delete(id);
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
    if (this.slice !== null || this.running !== null || book === null) return;
    if (book.queue.length === 0) return;
    this.slice = setImmediate(() => {
      this.slice = null;
      this.work();
    });
  }

  /** Stops setting fights up, and hands the one with the simulator back to its book's queue. */
  private cancel(): void {
    if (this.slice !== null) clearImmediate(this.slice);
    this.slice = null;
    const running = this.running;
    if (running === null) return;
    this.running = null;
    running.drop();
    running.book.queue.unshift(running.job);
  }

  /**
   * Sets fights up until one goes to the simulator or the slice is spent: a
   * job that cannot be fought is recorded here. A key that moved stops it
   * for `refresh`.
   */
  private work(): void {
    const book = this.book;
    if (book === null) return;
    const began = performance.now();
    const budget = tuning().menace.survivalSliceMs;
    let told = false;
    while (book.queue.length > 0 && performance.now() - began < budget) {
      const state = this.tracker.current;
      // The character moved under the book: open the one for the character there now.
      if (this.keyOf(state) !== book.key) {
        this.refresh(state);
        return;
      }
      const job = book.queue.shift()!;
      if (done(book, job)) continue;
      const input = this.inputOf(state, job);
      if ('kind' in input) {
        told = this.record(book, job, input) || told;
        continue;
      }
      this.running = {
        book,
        job,
        drop: this.simulator.run(input, (survival) => {
          this.running = null;
          const odds: Odds = survival === null ? UNRUN : { kind: 'run', survival };
          if (this.record(book, job, odds)) this.session.ran();
          this.schedule();
        })
      };
      break;
    }
    if (told) this.session.ran();
    this.schedule();
  }

  /** Writes a job's odds into its book: whether a reader asked to be told. */
  private record(book: Book, job: Job, odds: Odds): boolean {
    if (job.kind === 'mob') book.mobs.set(job.name, odds);
    else if (job.party === undefined) book.lairs.set(job.key, odds);
    else if (book.party?.key === job.party.key) book.party.lairs.set(job.key, odds);
    return book.told.delete(idOf(job));
  }

  /** The job's fight as the simulator takes it, or what it comes to where none can be set up. */
  private inputOf(state: CharacterState, job: Job, attack?: string): Odds | SurvivalInput {
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
      /*
       * Everything it spawns, at its cap. Hunted, all of it is fought, and
       * what does not attack on sight joins only when struck; run past,
       * nothing is struck that does not swing first, so that never joins.
       */
      const standing = standingOf(state);
      met = world.lairEntities(job.room).map((entity) => ({
        name: entity.name,
        subject: entity,
        waits: waitsToBeStruck(entity, standing)
      }));
      draw = parseLair(job.room.lair ?? '').max ?? 1;
    }
    if (met.length === 0) return UNRUN;
    // A lair's draw and a monster met alone come into the room with the fight, arrivals and all.
    return {
      ...character,
      ...this.setup.foes(state, character, met, 'arriving'),
      ...(draw === undefined ? {} : { draw }),
      ...(job.kind === 'lair' && job.way === 'pass' ? { passing: true } : {}),
      ...(job.kind === 'lair' && job.party !== undefined ? { party: job.party.party } : {})
    };
  }
}

/** What a job is asked and told by. */
function idOf(job: Job): string {
  if (job.kind === 'mob') return `mob:${job.name}`;
  return job.party === undefined ? `lair:${job.key}` : `party:${job.key}`;
}

/** Whether a job's odds are in its book, or its party is no longer the one asked about. */
function done(book: Book, job: Job): boolean {
  if (job.kind === 'mob') return book.mobs.has(job.name);
  if (job.party === undefined) return book.lairs.has(job.key);
  return book.party?.key !== job.party.key || book.party.lairs.has(job.key);
}

/** The book's odds as a record keeps them: the figures a report reads, not the whole run. */
function harmOdds(odds: Odds): HarmOdds {
  if (odds.kind !== 'run') return { kind: odds.kind };
  const { survives, rounds, lostMean, worstRound } = odds.survival;
  return { kind: 'run', survives, rounds: rounds.value, lostMean, worstRound };
}
