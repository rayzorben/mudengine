/**
 * The terminal types nothing of its own into the game (todo 832). xterm answers
 * a status, device-attributes, mode, setting or colour query through `onData`,
 * and once a server turns focus, mouse or paste reporting on it sends those
 * reports the same way; everything `onData` carries goes to the game as typed.
 * So the queries go unanswered and the reporting modes are never turned on.
 * No recorded session of ours shows a server asking or setting one (every
 * capture and log, checked 2026-09-26), so nothing answers in the terminal's
 * place either. A colour *set* still reaches the terminal; only its query is
 * swallowed.
 */
import type { IParser, Terminal } from '@xterm/xterm';

/**
 * The private modes whose whole effect is the terminal writing to the game:
 * mouse reporting and its encodings, focus reporting, bracketed paste.
 */
const REPORTING_MODES: ReadonlySet<number> = new Set([
  9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004
]);

/** Whether an OSC colour sequence asks rather than sets (`11;?`, `4;1;?`). */
export function asksAColour(data: string): boolean {
  return data.split(';').includes('?');
}

export function silenceQueries(term: Pick<Terminal, 'parser' | 'write'>): void {
  const parser: IParser = term.parser;
  const swallow = (): boolean => true;
  // DSR and the cursor report: ESC[5n, ESC[6n, ESC[?6n.
  parser.registerCsiHandler({ final: 'n' }, swallow);
  parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow);
  // Device attributes, primary and secondary.
  parser.registerCsiHandler({ final: 'c' }, swallow);
  parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow);
  // A mode's state (DECRQM), ANSI and private.
  parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow);
  parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow);
  // A setting's state (DECRQSS).
  parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
  // The palette and the three dynamic colours, asked.
  for (const id of [4, 10, 11, 12]) parser.registerOscHandler(id, asksAColour);
  /*
   * A private mode set naming a reporting mode: those are dropped, and the
   * rest of the same sequence (`?1004;7h`) is set again without them, after
   * whatever had already arrived behind it. A subparameter is not a mode.
   */
  parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    const modes = params.filter((param): param is number => typeof param === 'number');
    const kept = modes.filter((mode) => !REPORTING_MODES.has(mode));
    if (kept.length === modes.length) return false;
    if (kept.length > 0) term.write(`\x1b[?${kept.join(';')}h`);
    return true;
  });
}
