/**
 * What one browser tab was sent, by channel, for `logs/web.log`: a tab that
 * cannot keep up stops answering pings, and this says what it could not keep
 * up with. `take` hands over the tally and starts again.
 */
export class TabTraffic {
  private sent = new Map<string, { messages: number; chars: number }>();

  count(channel: string, chars: number): void {
    const tally = this.sent.get(channel) ?? { messages: 0, chars: 0 };
    tally.messages += 1;
    tally.chars += chars;
    this.sent.set(channel, tally);
  }

  /** `chars/messages` by channel, largest first. */
  take(): Record<string, string> {
    const sent = [...this.sent.entries()].sort((a, b) => b[1].chars - a[1].chars);
    this.sent = new Map();
    return Object.fromEntries(
      sent.map(([channel, tally]) => [channel, `${tally.chars}/${tally.messages}`])
    );
  }
}
