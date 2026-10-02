/**
 * Sampling a thread's CPU: the profile V8 writes and the port that starts and
 * stops it. Declared here, below both the flight recorder that reads a
 * profile (`src/main/app/FlightRecorder.ts`) and the hosts that reach a
 * thread (main through `node:inspector`, a window through its debugger).
 */

/** The parts of a `.cpuprofile` the client reads. */
export interface CpuProfile {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
  }>;
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** Starting and stopping a sampling profiler on one thread. */
export interface ProfilerPort {
  start(intervalUs: number): Promise<void>;
  stop(): Promise<CpuProfile>;
}
