/**
 * One browser tab's side of the link, kept across the sockets that carry it.
 * Every message to the tab is numbered (`n`) and held until the tab acks it;
 * every request from it is numbered (`q`) and taken once. A tab that dials
 * again with its `key` and the last number it has is sent the rest, and
 * nothing on its screen is redrawn. What is held is capped by
 * `tuning.web.resumeBytes` (`overflowing`). See `mudengine-session` ›
 * *A browser tab outlives its socket*.
 */
import { randomBytes } from 'node:crypto';

interface Held {
  readonly n: number;
  readonly text: string;
}

export class TabLink {
  /** Proves a hello comes from the tab this link was made for. */
  readonly key = randomBytes(18).toString('base64url');
  private sent = 0;
  private held: Held[] = [];
  private chars = 0;
  /** The last request taken, so one sent again after a drop is not taken twice. */
  private taken = 0;

  /** The next number, and the message held under it until the tab has it. */
  hold(text: (n: number) => string): string {
    this.sent += 1;
    const framed = text(this.sent);
    this.held.push({ n: this.sent, text: framed });
    this.chars += framed.length;
    return framed;
  }

  /** The tab has everything up to `n`. */
  ack(n: number): void {
    let drop = 0;
    while (drop < this.held.length && this.held[drop]!.n <= n) {
      this.chars -= this.held[drop]!.text.length;
      drop += 1;
    }
    if (drop > 0) this.held = this.held.slice(drop);
  }

  /**
   * What a tab that has everything up to `last` is still owed, or null when
   * it cannot be brought up to date: it claims more than was sent, or what
   * it lacks was let go.
   */
  owed(last: number): string[] | null {
    if (last > this.sent) return null;
    this.ack(last);
    const first = this.held[0]?.n ?? this.sent + 1;
    if (first !== last + 1) return null;
    return this.held.map((entry) => entry.text);
  }

  /** Whether request `q` is new; one already taken is a resend after a drop. */
  takes(q: number): boolean {
    if (q <= this.taken) return false;
    this.taken = q;
    return true;
  }

  /** The last request taken, which the tab may stop holding. */
  get got(): number {
    return this.taken;
  }

  /** Characters held for the tab: JSON is ASCII but for what the game printed. */
  get heldChars(): number {
    return this.chars;
  }

  overflowing(limit: number): boolean {
    return this.chars > limit;
  }
}
