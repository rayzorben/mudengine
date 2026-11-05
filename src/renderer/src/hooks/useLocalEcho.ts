/**
 * The console's local echo, bound to one terminal: each key drawn as it is
 * typed, the realm's echo of it taken out of the stream, and a key the realm
 * never echoed taken back after `tuning().localEchoGiveUpMs`
 * (todo 20261104-1915-01). The rules are `lib/localEcho.ts`'s.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';

import { LocalEcho } from '../lib/localEcho';
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
  handle: RefObject<Pick<TerminalHandle, 'echo'> | null>
): LocalEchoPort {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const port = useMemo(() => {
    const echo = new LocalEcho();
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
          draw(echo.expire(Date.now(), limit));
          arm();
        },
        Math.max(0, oldest + limit - Date.now())
      );
    };
    return {
      typed: (data: string) => {
        draw(echo.typed(data, Date.now()));
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
