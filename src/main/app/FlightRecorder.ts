/**
 * A flight recorder for lag (2026-10-01, the user's ask: the client stalls at
 * startup and on some clicks, and a profile attached afterwards misses it).
 *
 * A thread is sampled in chunks of `tuning.diagnostics.chunkMs`. At the end of
 * each chunk the profile is read for busy stretches (`stallsIn`); one at least
 * `stallMs` long keeps the chunk as a `.cpuprofile` beside a line in
 * `stalls.log` naming what ran. A quick chunk is dropped. A stall across the
 * end of a chunk is judged as two halves, and the moment between one chunk
 * and the next is not sampled.
 *
 * The thread is whatever `ProfilerPort` reaches: main through `node:inspector`,
 * a window through its debugger. A port that cannot start is said once in the
 * log and left alone.
 */
import fs from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import path from 'node:path';

import { tuning } from './tuning';
import { stallsIn } from './stallProfile';
import type { CpuProfile, ProfilerPort } from '../../shared/profiler';
import { errorMessage, timeOfDay } from '../../shared/values';

/** Main's own thread, through `node:inspector` in this process, connected when first started. */
export function mainThreadProfiler(): ProfilerPort {
  let session: Session | null = null;
  return {
    start: async (intervalUs) => {
      if (session === null) {
        session = new Session();
        session.connect();
      }
      await session.post('Profiler.enable');
      await session.post('Profiler.setSamplingInterval', { interval: intervalUs });
      await session.post('Profiler.start');
    },
    stop: async () => {
      if (session === null) throw new Error('the profiler was never started');
      return (await session.post('Profiler.stop')).profile as CpuProfile;
    }
  };
}

export interface FlightRecorderOptions {
  /** `main`, or a window's name: in each file's name and each log line. */
  thread: string;
  port: ProfilerPort;
  /** Where the kept profiles and `stalls.log` go. Read per chunk. */
  directory(): string;
  now?: () => number;
}

export class FlightRecorder {
  private timer: NodeJS.Timeout | null = null;
  private chunkStart = 0;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: FlightRecorderOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Starts the first chunk; with `chunkMs` 0, nothing is sampled. */
  start(): void {
    if (tuning().diagnostics.chunkMs <= 0) return;
    void this.begin();
  }

  /** Samples nothing more and reads nothing: the thread is going away. */
  dispose(): void {
    this.stopped = true;
    this.chunkStart = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async begin(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.options.port.start(tuning().diagnostics.sampleUs);
    } catch (error) {
      await this.note(`not recording ${this.options.thread}: ${errorMessage(error)}`);
      this.stopped = true;
      return;
    }
    // Disposed while the profiler was starting: nothing is owed a timer.
    if (this.stopped) return;
    this.chunkStart = this.now();
    this.timer = setTimeout(() => void this.next(), tuning().diagnostics.chunkMs);
    // A recorder never keeps the process alive on its own.
    this.timer.unref();
  }

  private async next(): Promise<void> {
    this.timer = null;
    await this.end();
    if (tuning().diagnostics.chunkMs > 0) await this.begin();
  }

  /** Stops the profiler and keeps the chunk if anything in it stalled. */
  private async end(): Promise<void> {
    if (this.chunkStart === 0) return;
    const started = this.chunkStart;
    this.chunkStart = 0;
    let profile: CpuProfile;
    try {
      profile = await this.options.port.stop();
    } catch (error) {
      if (!this.stopped) {
        await this.note(
          `${this.options.thread}: the profile could not be read: ${errorMessage(error)}`
        );
      }
      return;
    }
    const { stallMs, kept } = tuning().diagnostics;
    const stalls = stallsIn(profile, stallMs);
    if (stalls.length === 0) return;
    const directory = this.options.directory();
    const name = `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${this.options.thread}.cpuprofile`;
    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, name), JSON.stringify(profile));
      await this.prune(directory, kept);
    } catch (error) {
      await this.note(
        `${this.options.thread}: the profile could not be written: ${errorMessage(error)}`
      );
    }
    for (const stall of stalls) {
      const frames = stall.top
        .map((each) => `${Math.round(each.share * 100)}% ${each.frame}`)
        .join(' | ');
      await this.note(
        `${this.options.thread} busy ${Math.round(stall.durationMs)}ms at ${timeOfDay(started + stall.atMs)} (${name}): ${frames}`
      );
    }
  }

  /** Only the newest `kept` profiles stay; `stalls.log` keeps every line. */
  private async prune(directory: string, kept: number): Promise<void> {
    const profiles = (await fs.readdir(directory))
      .filter((file) => file.endsWith('.cpuprofile'))
      .sort();
    for (const file of profiles.slice(0, Math.max(0, profiles.length - kept))) {
      await fs.rm(path.join(directory, file), { force: true });
    }
  }

  private async note(line: string): Promise<void> {
    try {
      const directory = this.options.directory();
      await fs.mkdir(directory, { recursive: true });
      await fs.appendFile(path.join(directory, 'stalls.log'), `${timeOfDay(this.now())} ${line}\n`);
    } catch (error) {
      console.error(
        `flight recorder: ${line} (the log could not be written: ${errorMessage(error)})`
      );
    }
  }
}
