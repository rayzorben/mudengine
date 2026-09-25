import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import { EMPTY_CHARACTER } from '../../shared/character';
import {
  clip,
  describePlayersChange,
  describeStateChange,
  summariseBlock,
  visible,
  type DebugKind,
  type DebugRecord
} from '../../shared/debug';
import type { AutomationSnapshot } from '../../shared/automation';
import { NO_PLAYERS, type PlayerRegistry } from '../../shared/players';
import type { ConnectionState, StreamLine, TelnetEvent } from '../../shared/types';
import { tuning } from '../app/tuning';

/**
 * The live trace of one session, for the debug window and for a bug report.
 *
 * ## It is another consumer of the sink, not a second pipeline
 *
 * Everything here arrives through the callbacks `SessionHost` already builds
 * for the capture and the log — the decoded stream, the framed line, the
 * classified block, the character, the connection, the negotiation, the
 * notices. Nothing new is computed in the session and nothing is threaded
 * through the parser: a second path to these facts would be a second thing to
 * keep in step with the first, and the first is where the ordering guarantees
 * live (*classify, feed, then act*).
 *
 * That is also what makes it safe with credentials. **Every outbound command
 * reaches `command()` already through `Publisher.reportable`**, which is
 * the one place this client redacts a password — the capture and the decision
 * trace take the same value. Nothing here redacts anything, because a second
 * redactor is a second thing that can be wrong, and the one that is wrong is
 * always the one somebody trusted.
 *
 * ## It records whether or not anybody is watching
 *
 * A debug log you have to turn on *before* the thing you are debugging is a
 * debug log that never catches it: the whole point of a bug report is that it
 * is written after the surprise. So the ring fills from the moment the session
 * exists, bounded by `tuning.session.debugLogLimit` records and by
 * `DEBUG_TEXT_LIMIT` characters each, and what costs something — the IPC push —
 * happens only for a window that has said it is showing the view.
 *
 * `dropped` counts what the ring threw away, because a report that silently
 * begins in the middle reads as a session that began there.
 */
export class SessionDebug {
  private readonly records: DebugRecord[] = [];
  private seq = 0;
  private dropped = 0;
  /**
   * The character as of the last record, so a change can be described rather
   * than restated. `EMPTY_CHARACTER` is the honest starting point: the first
   * push genuinely is *everything so far became known*.
   */
  private character: CharacterState = EMPTY_CHARACTER;
  /** The registry as of the last record, for `players`' reason `character` is kept. */
  private registry: PlayerRegistry = NO_PLAYERS;

  constructor(private readonly emit: (record: DebugRecord) => void) {}

  get all(): readonly DebugRecord[] {
    return this.records;
  }

  get lost(): number {
    return this.dropped;
  }

  private push(kind: DebugKind, tag: string, text: string, detail?: string): void {
    this.seq += 1;
    const record: DebugRecord = {
      seq: this.seq,
      at: Date.now(),
      kind,
      tag,
      text,
      ...(detail === undefined || detail.length === 0 ? {} : { detail })
    };
    this.records.push(record);
    while (this.records.length > tuning().session.debugLogLimit) {
      this.records.shift();
      this.dropped += 1;
    }
    this.emit(record);
  }

  /** The decoded stream as it arrived, escape sequences intact. */
  text(chunk: string): void {
    if (chunk.length === 0) return;
    this.push('in', `${chunk.length} chars`, clip(visible(chunk)));
  }

  /**
   * A command committed to the wire — **already redacted** by the manager.
   * See the class comment: nothing here may redact, and nothing here needs to.
   */
  out(command: string, source: 'user' | 'automation'): void {
    this.push('out', source, visible(command));
  }

  /** One framed line, with what a parser will actually match underneath it. */
  line(line: StreamLine): void {
    this.push('line', line.terminator, clip(visible(line.text)), `plain: ${clip(line.plain)}`);
  }

  /** What that line was classified as, with the evidence for it. */
  block(block: Block): void {
    this.push('block', block.type, summariseBlock(block), clip(block.text));
  }

  /**
   * What the character became, as a change.
   *
   * A push with nothing different in it is recorded as nothing at all: the
   * state republishes on a schedule as well as on a change, and a trace with a
   * `state` row every second saying the same numbers is one nobody reads to the
   * end.
   */
  characterState(state: CharacterState): void {
    const changes = describeStateChange(this.character, state);
    this.character = state;
    if (changes.length === 0) return;
    this.push('state', `${changes.length} changed`, changes.join(', '));
  }

  /** Who the registry learned something about, as a change: `characterState`'s rule. */
  players(registry: PlayerRegistry): void {
    const changed = describePlayersChange(this.registry, registry);
    this.registry = registry;
    if (changed.length === 0) return;
    this.push('state', `${changed.length} players`, clip(changed.join(', ')));
  }

  /**
   * The socket's own phase — on a *change*, never on a republish.
   *
   * `state` is published again for every Telnet option agreed, because the
   * negotiated set lives on it; unfiltered that put twelve identical
   * `connected` rows into the first report this wrote, between the twelve
   * negotiation records that are the actual news. Same rule as
   * `characterState`: a push with nothing different in it is not a record.
   */
  connection(state: ConnectionState): void {
    const where = state.target === null ? '' : ` ${state.target.host}:${state.target.port}`;
    const why = state.detail === null ? '' : ` — ${state.detail}`;
    const line = `${state.phase}${where}${why}`;
    if (line === this.lastLink) return;
    this.lastLink = line;
    this.push('link', state.phase, line);
  }

  private lastLink: string | null = null;

  telnet(event: TelnetEvent): void {
    this.push('link', event.direction === 'in' ? 'server' : 'client', event.summary);
  }

  notice(message: string): void {
    this.push('notice', 'client', clip(message));
  }

  /**
   * What automation decided, from the trace it already publishes.
   *
   * The **new** entries only, found by *identity* — the entry this list ended
   * at last time, looked up in the list this time.
   *
   * It was written against the timestamps, which is wrong and drops records.
   * `noteSafety` publishes on every decision and `publishAutomation` is
   * leading-edge, so two decisions made in one synchronous handler — a rest
   * declined and a heal declined on the same status line — are published as
   * *one* immediate snapshot holding the first and one trailing snapshot
   * holding both, with `Date.now()` equal for the pair. A strictly-newer test
   * rejects the second for ever, and a trace that silently loses a refusal is
   * the exact failure `AutomationSnapshot.safety` exists to prevent: *a
   * refusal is a decision, and a decision nobody can read did not happen.*
   *
   * The entries are the same objects across snapshots — the lists are copied
   * and reversed, never rebuilt — and this runs in the sink before anything is
   * serialised, so reference equality is available and is exact. Not found at
   * all means the list rolled past what was last seen (or this is the first
   * snapshot), and everything in it is reported: these lists are capped in the
   * tens, so reporting them all is bounded and losing them is not.
   *
   * Reported oldest-first, because the trace is a story and these lists are
   * stored the other way round for a card that reads backwards.
   */
  automation(snapshot: AutomationSnapshot): void {
    this.since('rule', snapshot.firings, (firing) =>
      firing.blockedBy === undefined
        ? `${firing.rule} → ${firing.commands.join('; ')}`
        : `${firing.rule} blocked by ${firing.blockedBy}`
    );
    this.since('safety', snapshot.safety, (decision) =>
      decision.acted
        ? `${decision.action} — ${decision.because}`
        : `${decision.action} refused: ${decision.refused ?? decision.because}`
    );
    this.since('engage', snapshot.engagements, (decision) =>
      decision.acted
        ? `attacked ${decision.target}${decision.because === undefined ? '' : ` — ${decision.because}`}`
        : `left ${decision.target}: ${decision.refused ?? 'no reason given'}`
    );
  }

  /** The entry each list ended at when it was last read. */
  private readonly lastSeen: Record<'rule' | 'safety' | 'engage', unknown> = {
    rule: null,
    safety: null,
    engage: null
  };

  private since<T>(
    tag: 'rule' | 'safety' | 'engage',
    rows: readonly T[],
    describe: (row: T) => string
  ): void {
    if (rows.length === 0) return;
    const at = rows.indexOf(this.lastSeen[tag] as T);
    const fresh = at === -1 ? [...rows] : rows.slice(0, at);
    this.lastSeen[tag] = rows[0];
    for (const row of fresh.reverse()) this.push('event', tag, clip(describe(row)));
  }
}
