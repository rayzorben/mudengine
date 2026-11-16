/**
 * One chunk off the socket, read in order: framed, each line published, the
 * tail fed and painted. It is the `ChunkGate` the casts and the rest ask
 * before a send: the server writes a combat round as one chunk and repaints
 * the prompt after every blow, so a heal chosen on the first of those prompts
 * is chosen for a part of the round's damage. See `mudengine-automation` ›
 * `parts/recovery.md` › *A heal is sized on the chunk's last line*.
 */
import type { ChunkGate } from '../../shared/automation';
import type { FramedLine, LineTokenizer } from '../net/LineTokenizer';
import type { Paint } from './Paint';
import type { TerminalFeed } from './TerminalFeed';

/** What a chunk is framed by, and what its tail is handed to. */
export interface ChunkParts {
  readonly tokenizer: Pick<LineTokenizer, 'push' | 'buffered'>;
  readonly feed: Pick<TerminalFeed, 'partial'>;
  readonly paint: Pick<Paint, 'afterChunk'>;
}

/** What the session that built this does with a chunk and its lines. */
export interface ChunkSession {
  /** Bytes came, whatever they say: the link's clock, the feed's and the capture's tap. */
  arrived(text: string): void;
  /** A line the chunk framed: classified, fed and acted on (`SessionManager.publishLine`). */
  publish(framed: FramedLine, at: number): void;
  /** Decides what a line put off, once the chunk is read (`SessionManager.reconsider`). */
  settle(): void;
}

export class ChunkRead implements ChunkGate {
  private reading = false;
  /** A send asked `over()` mid-chunk and was refused: `settle` is owed at the end. */
  private owed = false;

  constructor(
    private readonly parts: ChunkParts,
    private readonly session: ChunkSession
  ) {}

  /*
   * Framed first, painted second, and both in this call. The terminal is fed
   * lines rather than the raw chunk, so that a line can be withheld by what
   * it is; what keeps the old guarantee is that every line terminated in this
   * chunk is emitted before this returns, and the unterminated tail with it
   * unless a quiet command is being answered. A parser fault costs the line
   * its type, never its paint: `publishLine` guards the classifier.
   *
   * Deliberately no `routines.noteSent()`: the keep-alive counts this
   * client's own silence, and bytes arriving are not it. This realm repaints
   * its status line unprompted every thirty seconds, so counting them reset a
   * forty-five second clock forever. See `Routines.noteSent` for the capture.
   */
  read(text: string, at: number): void {
    this.session.arrived(text);
    this.reading = true;
    try {
      for (const framed of this.parts.tokenizer.push(text)) this.session.publish(framed, at);
    } finally {
      this.reading = false;
    }
    this.parts.feed.partial(this.parts.tokenizer.buffered);
    // A tail that is a finished prompt is framed in here, and acted on with the chunk read.
    this.parts.paint.afterChunk(at);
    if (!this.owed) return;
    this.owed = false;
    this.session.settle();
  }

  /**
   * Whether the chunk is read through. Asked while its lines are still being
   * published the answer is no, and `settle` is called once after the tail,
   * since the last line may change nothing and so decide nothing.
   */
  over(): boolean {
    if (this.reading) this.owed = true;
    return !this.reading;
  }
}
