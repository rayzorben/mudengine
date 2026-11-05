/**
 * The console's local echo, bound to one terminal: each key drawn as it is
 * typed, the realm's echo of it taken out of the stream, and a key the realm
 * never echoed taken back after `tuning().localEchoGiveUpMs`
 * (todo 20261104-1915-01). The rules are `lib/localEcho.ts`'s. Off
 * (`terminal.localEcho`), nothing is drawn and the line is forgotten. Each
 * echo that comes back is timed onto the page's performance timeline as
 * `ECHO_MEASURE`, which a browser tab reports (`lib/tabHealth.ts`).
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';

import { ECHO_MEASURE, LocalEcho } from '../lib/localEcho';
import { tuning } from '../lib/tuning';
import type { StreamChunk } from '@shared/types';
import type { TerminalHandle } from '../components/TerminalView';

export interface LocalEchoPort {
  /** A key or run about to be sent: drawn now where the rules allow. */
  typed(data: string): void;
  /** A chunk from main, with the echoes already drawn taken out. */
  arrived(chunk: StreamChunk): StreamChunk;
  /** The console was written again: forget every guess. */
  reset(): void;
}

export function useLocalEcho(
  handle: RefObject<Pick<TerminalHandle, 'echo'> | null>,
  enabled: boolean
): LocalEchoPort {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const on = useRef(enabled);
  on.current = enabled;
  const port = useMemo(() => {
    // Monotonic, so a wall-clock correction neither expires a guess nor skews its measure.
    const now = (): number => performance.now();
    const echo = new LocalEcho((drawnAt) => {
      performance.measure(ECHO_MEASURE, { start: drawnAt, end: now() });
      // The observer already has it; the page's own buffer would only grow.
      performance.clearMeasures(ECHO_MEASURE);
    });
    const draw = (text: string): void => {
      // A hidden page writes nothing (`lib/hiddenPage.ts`); its console is redrawn when shown.
      if (text.length > 0 && document.visibilityState !== 'hidden') handle.current?.echo(text);
    };
    const arm = (): void => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      const oldest = echo.oldest;
      if (oldest === null) return;
      const limit = tuning().localEchoGiveUpMs;
      timer.current = setTimeout(
        () => {
          timer.current = null;
          draw(echo.expire(now(), limit));
          arm();
        },
        Math.max(0, oldest + limit - now())
      );
    };
    return {
      typed: (data: string) => {
        // Off, a guess already drawn still waits for its echo; the line typed now is not counted.
        if (on.current) draw(echo.typed(data, now()));
        else echo.forget();
        arm();
      },
      arrived: (chunk: StreamChunk): StreamChunk => {
        const text = echo.arrived(chunk.text, chunk.prompt === true);
        arm();
        return text === chunk.text ? chunk : { ...chunk, text };
      },
      reset: () => {
        echo.reset();
        arm();
      }
    };
  }, [handle]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  return port;
}
