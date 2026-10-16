/**
 * The macro running now (todo 134): a typed line, a key's line or an alias,
 * read into steps (`shared/macroSteps.ts`), its calls flattened, and its
 * commands queued up to the next `{goto}` or `{sneak}`. There it waits: the
 * walk's arrival, or the answer to `sn`, queues the next run; a walk that
 * stops, `sn` refused, a hold, a death or the Talk box's Drop drops the rest
 * and says why. One waits at a time; a new macro drops the one waiting and
 * says so. `alias` and `unalias` are answered here, before anything splits
 * the line. `mudengine-automation` › *A macro is a list of steps*.
 */
import { aliasCommandOf } from '../../shared/aliasCommand';
import { expandAlias } from '../../shared/aliases';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { asTyped } from '../../shared/clientCommands';
import type { KeyBindings } from '../../shared/keys';
import type { MacroPlaceholder } from '../../shared/macro';
import { macroBook } from '../../shared/macroBook';
import { expandMacros, typedSteps, type MacroStep } from '../../shared/macroSteps';
import type { RoomMatch } from '../../shared/loops';
import { roomAddress, roomId, type RoomId, type RoomReference } from '../../shared/world';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SessionModule } from '../automation/Module';
import { isSneakAnswer } from '../automation/walk/Sneak';
import { answerAlias, type AliasFile } from './aliasAnswers';
import {
  cancelRun,
  macroFaultText,
  queueStep,
  refused,
  type MacroBatch,
  type MacroParts
} from './macros';

export interface MacroRunnerParts extends MacroParts {
  /** The keys this character binds, as its files state them now, for `{f2}`. */
  keys(): KeyBindings;
  /** The character's own file, where `alias` writes; null where nothing may be written. */
  aliasFile(): AliasFile | null;
  /** Whether a move sent is still unanswered, so a route cannot start from it yet. */
  movesPending(): boolean;
  /** A room the server refuses `sn` in (`cannotSneakHere`). */
  sneakBlocked(state: CharacterState): boolean;
  /** The room a request names (`roomNamed`). */
  roomNamed(request: string): RoomMatch;
  /** The player's own route to `at`, auto-combat on as a walk asked for has it: the refusal, or the walk. */
  walkTo(at: RoomReference): { stepCount: number; room: string } | string;
  /** Whether a detour's walk still owes the route it interrupted (`Travel.owesRoute`). */
  routeOwed(): boolean;
}

type Action = Extract<MacroStep, { kind: 'goto' | 'sneak' }>;

/** What a run waits on before its next steps go. */
type Waiting =
  /** The commands before the action are still going out. */
  | { kind: 'turn' }
  /** A `{goto}` whose turn came while a move was still unanswered. */
  | { kind: 'moves'; step: Extract<Action, { kind: 'goto' }> }
  /** Walking to the room. */
  | { kind: 'walk'; to: RoomId; room: string }
  /** `sn` sent, its answer not yet heard. */
  | { kind: 'sneak' };

interface Run {
  readonly batch: MacroBatch;
  rest: MacroStep[];
  waiting: Waiting | null;
}

export class MacroRunner implements SessionModule {
  private runs = 0;
  private running: Run | null = null;
  /** The last player to telepath this character, for `{telepath}`. */
  private telepathFrom: string | null = null;
  /** How long `sn` may go unanswered before the macro is dropped. */
  private sneakDeadline: NodeJS.Timeout | null = null;

  constructor(private readonly parts: MacroRunnerParts) {}

  reset(): void {
    this.clearDeadline();
    this.running = null;
    this.telepathFrom = null;
  }

  dispose(): void {
    this.clearDeadline();
  }

  /** A line typed in the Talk box or the terminal, or a key's line. */
  run(typed: string): void {
    const parts = this.parts;
    const command = asTyped(typed) === null ? aliasCommandOf(typed) : null;
    if (command !== null) {
      const book = { keys: parts.keys(), aliases: parts.automation().aliases };
      return answerAlias(command, book, parts.aliasFile(), parts.notice);
    }
    const line = expandAlias(typed, parts.automation().aliases) ?? typed;
    const read = typedSteps(line);
    if (read === null) return parts.send(`${asTyped(line) ?? line}\r`);
    const book = macroBook(parts.keys(), parts.automation().aliases);
    const expanded =
      'fault' in read ? read : expandMacros(read.steps, book, tuning().session.macroCommands);
    if ('fault' in expanded) return parts.notice(macroFaultText(expanded.fault));
    const holding = parts.queue.holding;
    if (holding !== null || !parts.connected()) {
      return parts.notice(
        holding !== null ? t('session.macro.held', { reason: holding }) : t('session.macro.offline')
      );
    }
    const before = this.running;
    // One a value stopped has said so already.
    if (before !== null && !before.batch.stopped()) {
      this.stop(before, t('session.macro.replaced', { line: before.batch.line }));
    }
    this.runs += 1;
    const run: Run = { batch: this.batchFor(line), rest: expanded.steps, waiting: null };
    this.running = run;
    this.advance(run);
  }

  /** A walk ended: the one a `{goto}` started, arrived where it was going, lets the rest go. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    const run = this.running;
    if (run?.waiting?.kind !== 'walk') return;
    const { to, room } = run.waiting;
    if (!arrived) {
      return this.stop(
        run,
        reason === null
          ? t('session.macro.walkEnded', { room })
          : t('session.macro.walkStopped', { room, reason })
      );
    }
    if (roomAddress(state.room) !== to) {
      // A shop on the way (`Travel.walkRoute`) ends a leg short of the room: the route is owed on.
      if (this.parts.routeOwed()) return;
      // Anywhere else, or a room nothing has placed, is not the room the next lines were written for.
      return this.stop(run, t('session.macro.walkElsewhere', { room }));
    }
    run.waiting = null;
    this.advance(run);
  }

  onBlock(block: Block): void {
    // The receipt of one sent carries no message; only one received names its sender.
    if (block.type === 'conversation-telepath' && block.groups['message'] !== undefined) {
      this.telepathFrom = block.groups['player'] ?? this.telepathFrom;
    }
    const run = this.running;
    const waiting = run?.waiting;
    if (run === null || waiting === null || waiting === undefined) return;
    if (waiting.kind === 'moves' && !this.parts.movesPending()) return this.walk(run, waiting.step);
    if (waiting.kind !== 'sneak' || !isSneakAnswer(block.type)) return;
    if (block.type !== 'user-sneak-initiate') {
      return this.stop(run, t('session.macro.notSneaking'));
    }
    this.clearDeadline();
    run.waiting = null;
    this.advance(run);
  }

  /** The Talk box's Drop, a death or a closed connection: the rest of a waiting macro goes too. */
  drop(): void {
    const run = this.running;
    if (run !== null) this.stop(run, t('session.macro.droppedRest', { line: run.batch.line }));
  }

  /** The commands up to the next action, queued; then the action's turn, queued behind them. */
  private advance(run: Run): void {
    while (this.running === run) {
      const step = run.batch.stopped() ? undefined : run.rest.shift();
      if (step === undefined) {
        this.running = null;
        break;
      }
      switch (step.kind) {
        case 'send':
        case 'client':
          if (!queueStep(step, run.batch, this.parts)) this.running = null;
          continue;
        case 'goto':
        case 'sneak':
          return this.queueTurn(run, step);
        case 'call':
          // Flattened when the macro started (`expandMacros`).
          throw new Error(`macro step ${step.name} was never expanded`);
        default: {
          const never: never = step;
          throw new Error(`no macro step ${String(never)}`);
        }
      }
    }
    this.parts.published();
  }

  /**
   * The action goes when its turn in the queue comes, after every command
   * before it has gone: `{sneak}` as its `sn` (or nothing, already sneaking),
   * `{goto}` as the route's first step.
   */
  private queueTurn(run: Run, step: Action): void {
    run.waiting = { kind: 'turn' };
    const command = step.kind === 'sneak' ? 'sn' : `{goto ${step.request}}`;
    const taken = this.parts.queue.enqueue({
      command,
      priority: 'user',
      typed: true,
      coalesceKey: `${run.batch.key}${run.batch.next()}`,
      reason: t('session.macro.reason', { line: run.batch.line }),
      stillWanted: () => this.running === run && !run.batch.stopped(),
      resolve: () => this.turn(run, step)
    });
    if (taken) return this.parts.published();
    refused(command, run.batch, this.parts);
    this.running = null;
  }

  /** The action's turn: what it sends now, if anything. */
  private turn(run: Run, step: Action): readonly string[] {
    if (step.kind === 'goto') {
      if (this.parts.movesPending()) run.waiting = { kind: 'moves', step };
      else this.walk(run, step);
      return [];
    }
    const state = this.parts.state();
    if (state.stealth === 'sneaking') {
      run.waiting = null;
      this.advance(run);
      return [];
    }
    if (this.parts.sneakBlocked(state)) {
      this.stop(run, t('session.macro.cannotSneak'));
      return [];
    }
    run.waiting = { kind: 'sneak' };
    // An answer that never comes leaves the character not known to be sneaking: the unsafe case.
    this.sneakDeadline = setTimeout(() => {
      this.sneakDeadline = null;
      if (this.running === run && run.waiting?.kind === 'sneak') {
        this.stop(run, t('session.macro.sneakUnanswered'));
      }
    }, tuning().walk.sneakAnswerMs);
    return ['sn'];
  }

  private walk(run: Run, step: Extract<Action, { kind: 'goto' }>): void {
    const { request } = step;
    const match = this.parts.roomNamed(request);
    switch (match.kind) {
      case 'none':
        return this.stop(run, t('session.macro.gotoNone', { request }));
      case 'several': {
        const addresses = match.rooms.map(({ map, room }) => roomId(map, room)).join(', ');
        return this.stop(run, t('session.macro.gotoSeveral', { request, addresses }));
      }
      case 'one': {
        const walk = this.parts.walkTo(match.at);
        if (typeof walk === 'string') {
          return this.stop(run, t('session.macro.gotoRefused', { request, reason: walk }));
        }
        run.waiting = { kind: 'walk', to: roomId(match.at.map, match.at.room), room: walk.room };
        this.parts.published();
        return;
      }
      default: {
        const never: never = match;
        return never;
      }
    }
  }

  /** Drops what is left of `run`, queued or not, and says why. */
  private stop(run: Run, message: string): void {
    this.clearDeadline();
    cancelRun(run.batch, this.parts.queue);
    if (this.running === run) this.running = null;
    this.parts.notice(message);
    this.parts.published();
  }

  private clearDeadline(): void {
    if (this.sneakDeadline !== null) clearTimeout(this.sneakDeadline);
    this.sneakDeadline = null;
  }

  private batchFor(line: string): MacroBatch {
    let stopped = false;
    let n = 0;
    return {
      line,
      key: `macro:${this.runs}:`,
      next: () => (n += 1),
      stopped: () => stopped,
      stop: () => {
        stopped = true;
      },
      value: (name, state) => this.value(name, state)
    };
  }

  private value(name: MacroPlaceholder, state: CharacterState): string | null {
    switch (name) {
      case 'mob':
        return this.parts.mob(state);
      case 'leader':
        return state.party.following;
      case 'telepath':
        return this.telepathFrom;
      case 'item':
        return state.room.items[0]?.name ?? null;
      default: {
        const never: never = name;
        return never;
      }
    }
  }
}
