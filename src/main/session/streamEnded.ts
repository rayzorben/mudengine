import type fs from 'node:fs';

/**
 * Ends a write stream and resolves once its last byte is on disk, or it
 * failed. `end()` alone only asks: the stream flushes on the event loop.
 */
export function streamEnded(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}
