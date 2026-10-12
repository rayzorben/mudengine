/**
 * How a browser tab is faring, gathered for its report to the client
 * (`RpcReport`, written to `logs/web.log`). The browser's own long tasks and
 * key timings, a one-second timer's lateness, and what the link saw: closes,
 * time down, comebacks. Each `take` hands over the figures since the last
 * and starts again. A browser without an observer type reports zero for it.
 * Timed on `performance.now()`, which a wall-clock correction does not move.
 */
import { REPORT_CLOSES, type TabHealthFigures } from '@shared/rpc';

/** A key slower than this from press to paint is one a player feels. */
const SLOW_KEY_MS = 100;
const LAG_TICK_MS = 1000;

export class TabHealth {
  private since = performance.now();
  private longTasks = 0;
  private longTaskMs = 0;
  private longestTaskMs = 0;
  private keys = 0;
  private slowKeys = 0;
  private slowestKeyMs = 0;
  private timerLagMs = 0;
  private closes: string[] = [];
  private downSince: number | null = null;
  private downMs = 0;
  private resumes = 0;
  private renewals = 0;
  private frames = 0;
  private chars = 0;

  constructor(private readonly signal: AbortSignal) {
    this.observe('longtask', (entry) => {
      this.longTasks += 1;
      this.longTaskMs += entry.duration;
      this.longestTaskMs = Math.max(this.longestTaskMs, entry.duration);
    });
    this.observe('event', (entry) => {
      if (entry.name !== 'keydown') return;
      this.keys += 1;
      if (entry.duration > SLOW_KEY_MS) this.slowKeys += 1;
      this.slowestKeyMs = Math.max(this.slowestKeyMs, entry.duration);
    });
    let expected = performance.now() + LAG_TICK_MS;
    const lag = setInterval(() => {
      const now = performance.now();
      this.timerLagMs = Math.max(this.timerLagMs, now - expected);
      expected = now + LAG_TICK_MS;
    }, LAG_TICK_MS);
    signal.addEventListener('abort', () => clearInterval(lag));
  }

  closed(code: number): void {
    if (this.closes.length < REPORT_CLOSES)
      this.closes.push(`${code}@${Math.round((performance.now() - this.since) / 1000)}`);
  }

  down(): void {
    this.downSince ??= performance.now();
  }

  up(resumed: boolean): void {
    if (this.downSince !== null) this.downMs += performance.now() - this.downSince;
    this.downSince = null;
    if (resumed) this.resumes += 1;
    else this.renewals += 1;
  }

  frame(chars: number): void {
    this.frames += 1;
    this.chars += chars;
  }

  take(): TabHealthFigures {
    const now = performance.now();
    const downMs = this.downMs + (this.downSince === null ? 0 : now - this.downSince);
    const figures: TabHealthFigures = {
      periodMs: now - this.since,
      visible: document.visibilityState === 'visible',
      longTasks: this.longTasks,
      longTaskMs: this.longTaskMs,
      longestTaskMs: this.longestTaskMs,
      keys: this.keys,
      slowKeys: this.slowKeys,
      slowestKeyMs: this.slowestKeyMs,
      timerLagMs: Math.max(0, this.timerLagMs),
      closes: this.closes,
      downMs,
      resumes: this.resumes,
      renewals: this.renewals,
      frames: this.frames,
      chars: this.chars
    };
    this.since = now;
    if (this.downSince !== null) this.downSince = now;
    this.longTasks = this.longTaskMs = this.longestTaskMs = 0;
    this.keys = this.slowKeys = this.slowestKeyMs = this.timerLagMs = 0;
    this.closes = [];
    this.downMs = this.resumes = this.renewals = this.frames = this.chars = 0;
    return figures;
  }

  private observe(type: string, take: (entry: PerformanceEntry) => void): void {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) take(entry);
    });
    // `durationThreshold` asks for the fastest events the browser reports, 16 ms.
    observer.observe({ type, buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
    this.signal.addEventListener('abort', () => observer.disconnect());
  }
}
