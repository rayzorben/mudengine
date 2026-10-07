/** The server's line editor as this client models it, for the shadow buffer `SessionManager.send` keeps. */
/**
 * The part of a chunk of keystrokes the server's line editor would keep.
 *
 * `send`'s shadow buffer exists to answer one question — *does the player have
 * a half-typed line on the wire* — and automation stands down entirely while
 * the answer is yes. So the buffer has to hold what the **server** holds, and
 * a control byte is not text: a terminal sends `\x1b` for Escape, `\x1b[A` for
 * an arrow key and `\t` for Tab, and none of them leaves a character in the
 * server's line.
 *
 * Measured, in the capture that produced this function
 * (`logs/2026-08-30_20-57-36_main.mudcap.jsonl`, t=66056): twenty Escapes and
 * an Enter were answered with a bare room reprint — which is exactly what an
 * *empty* line is answered with. The server had kept none of them. This client
 * had kept all twenty, so `outbound` never emptied, `noteTyping(true)` stood
 * automation down, and the attack decided the millisecond a hostile walked
 * into the room (t=43603) sat in the queue for **twenty-two seconds** while
 * the monster hit the character sixteen times. Nothing on screen said why: the
 * hold is invisible, and the only thing that released it was the player
 * pressing Enter.
 *
 * The terminator is kept, because the commit loop is what reads it, and so is
 * the erase pair, which is modelled rather than dropped.
 */
export function editorInput(data: string): string {
  let kept = '';
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i]!;
    if (ch === '\x1b') {
      // The whole sequence, dropped as one: dropping only the introducer
      // left `[A` behind, the same bug wearing the arrow key's hat.
      i = endOfEscape(data, i);
      continue;
    }
    // The terminator and the two erases are modelled by the caller.
    if (ch === '\r' || ch === '\n' || ch === '\b' || ch === '\x7f') kept += ch;
    // Every other C0 control — Tab, a Ctrl chord, a stray NUL — leaves no
    // text behind for anything to be glued onto.
    else if (ch >= ' ') kept += ch;
  }
  return kept;
}

/**
 * The index of the last byte of the escape sequence beginning at `start`.
 *
 * CSI (`ESC [`) and SS3 (`ESC O`) run to a final byte in `@`–`~`, which is how
 * every arrow, function and editing key this client's own terminal emits is
 * shaped. Anything else after ESC is a two-byte sequence. A sequence the chunk
 * ends inside is consumed whole: the shadow buffer must never be left holding
 * half of something the server is not holding at all.
 */
function endOfEscape(data: string, start: number): number {
  const next = data[start + 1];
  if (next === undefined) return data.length;
  if (next !== '[' && next !== 'O') return start + 1;
  for (let i = start + 2; i < data.length; i += 1) {
    const ch = data[i]!;
    if (ch >= '@' && ch <= '~') return i;
  }
  return data.length;
}
