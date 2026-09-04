/**
 * Crediting the lines that fed a batch, so a probe's "could not read" list
 * means what it says.
 *
 * A *batch* — a stat sheet, an inventory, a `who` listing, a party roster — is
 * one parse spread over many lines, and it is emitted as a second block against
 * the line that **terminated** it. Every member line is individually `unknown`
 * by design: `Race:  Half-Ogre  Exp: 34603  Perception: 21` has no rule of its
 * own and is not supposed to.
 *
 * A probe that keys blocks by line therefore reports every member of every
 * batch as a line the client could not type. Measured on a real session that is
 * not a rounding error — a stat sheet is nine lines, a `who` listing is however
 * many people are on — and it overstates the gap enough that somebody reading
 * the list as a to-do would write patterns for a vocabulary that is already
 * read. That is precisely the false alarm a diagnostic must not raise.
 *
 * ## Two things about the matching, both learned by getting them wrong
 *
 * **A batch's `seq` is its *header* line, not its terminator.** `Classifier`
 * stamps `this.batch.seq` when the batch opens, so the member lines come
 * *after* it. A first version scanned backwards from that seq and credited
 * four lines out of a stat sheet, an inventory, a `who` and a party roster —
 * and the four it did credit were lines that merely happened to match, sitting
 * before the listing rather than in it. Scanning the wrong direction does not
 * fail loudly; it credits nothing and looks like a small correction.
 *
 * **Members are matched as a multiset, not walked in order.** The obvious
 * implementation walks the window matching one member at a time and stops at
 * the first mismatch, which happens constantly: `foldWraps` rejoins a member
 * the server broke in half, so the batch's text holds `padded gloves (Hands)`
 * where the stream held two lines. One unmatched member would then forfeit
 * credit for every member after it. A wrapped half simply goes uncredited,
 * which costs one line rather than the whole listing.
 */

/**
 * Whether this block is a batch, as far as anything outside the parser can
 * tell: batch text is the member lines joined, and no single-line rule matches
 * across a newline.
 */
export function isBatch(block) {
  return typeof block.text === 'string' && block.text.includes('\n');
}

/**
 * Marks the lines that fed `block` with `<type> (member)`.
 *
 * `seen` is the probe's own list of framed lines — `{ seq, text, types }`, in
 * arrival order, with `types` already populated. Returns how many lines were
 * credited, so a caller can report the correction rather than apply it
 * silently.
 */
export function creditBatchMembers(seen, block) {
  const members = block.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (members.length === 0) return 0;

  const wanted = new Map();
  for (const member of members) wanted.set(member, (wanted.get(member) ?? 0) + 1);

  const start = seen.findIndex((entry) => entry.seq === block.seq);
  if (start === -1) return 0;

  // Bounded, so a line identical to a batch member but printed minutes later
  // cannot be credited to it. Twice the member count plus a little covers the
  // blank lines a listing prints between its rows.
  const end = Math.min(seen.length, start + members.length * 2 + 8);
  const label = `${block.type} (member)`;
  let credited = 0;

  for (let at = start; at < end; at += 1) {
    const entry = seen[at];
    const text = entry.text.trim();
    const left = wanted.get(text) ?? 0;
    if (left === 0) continue;
    wanted.set(text, left - 1);
    if (!entry.types.includes(label)) {
      entry.types.push(label);
      credited += 1;
    }
  }

  return credited;
}

/** The same for every batch of a run. Returns the total credited. */
export function creditEveryBatch(seen, batches) {
  let credited = 0;
  for (const batch of batches) credited += creditBatchMembers(seen, batch);
  return credited;
}
