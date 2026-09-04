/**
 * Replays a capture through the real classifier and reports what it missed.
 *
 *   npm run capture:analyse -- <file.mudcap.jsonl> [--unknown 40] [--colour]
 *
 * This is the development loop for pattern work: play manually with capture on,
 * then run this. It answers the only question that matters — *what is the
 * parser failing to understand?* — from what the server actually sent, rather
 * than from what a different client's source suggests it might send.
 *
 * Reports:
 *   - coverage: how many framed lines were classified at all
 *   - a histogram of block types, so a pattern that never fires is obvious
 *   - the unclassified lines, grouped by shape, commonest first
 *   - which command each unclassified line followed, since a response is only
 *     interpretable next to its request
 *   - with --colour, the SGR codes each block type actually wears
 */
import fs from 'node:fs';
import path from 'node:path';

// Run through tsx (see the npm script) so the real classifier can be imported
// directly. Analysing with a copy of the patterns would defeat the purpose.
const { Classifier, foregroundCodes } = await import('../src/main/parse/Classifier.ts');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const showColour = args.includes('--colour');
const unknownLimit = Number(args[args.indexOf('--unknown') + 1]) || 40;

if (!file || !fs.existsSync(file)) {
  console.error('usage: npm run capture:analyse -- <file.mudcap.jsonl> [--unknown N] [--colour]');
  process.exit(1);
}

const entries = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const meta = entries.find((e) => e.k === 'meta') ?? {};
console.log(`\n${path.basename(file)}`);
console.log(
  `  ${meta.host ?? '?'}:${meta.port ?? '?'} (${meta.encoding ?? '?'})  ${meta.startedAt ?? ''}`
);
console.log(`  ${entries.length.toLocaleString()} entries\n`);

const classifier = new Classifier();
const byType = new Map();
const unknown = new Map();
const colours = new Map();

let lines = 0;
let classified = 0;
let lastCommand = '(none)';
let seq = 0;

/** Collapses a line to its shape, so variants group together. */
const shapeOf = (text) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 90);

for (const entry of entries) {
  if (entry.k === 'out') {
    lastCommand = entry.s || '(enter)';
    // The classifier needs it too, not just the report: this server echoes the
    // command back and speaks the ones it does not know, and neither line is
    // recognisable except next to what was sent. Replaying without this makes
    // the analysis disagree with the running client, which defeats the point
    // of replaying through the real classifier.
    if (entry.s) classifier.observeCommand(entry.s);
    continue;
  }
  if (entry.k !== 'line') continue;

  lines += 1;
  seq += 1;
  const line = {
    seq,
    at: entry.t,
    text: entry.raw ?? entry.s,
    plain: entry.s,
    terminator: entry.term
  };
  const { block, batch, tails } = classifier.classify(line);

  const record = (type) => byType.set(type, (byType.get(type) ?? 0) + 1);
  record(block.type);
  /*
   * A prompt may carry a sentence on its own framed line — see
   * `tailAfterPrompt`. The line already counts as classified by its prompt, so
   * a tail never moves the coverage figure; recording it under its own type is
   * what makes an *unread* one visible instead of hidden behind a status line
   * that read fine.
   */
  for (const tail of tails ?? []) record(`${tail.type} (tail)`);
  if (batch) {
    record(`${batch.type} (batch)`);
    // The lines that fed a batch are understood even though each was
    // individually `unknown`; counting them as misses hides real gaps behind
    // noise. Credit them retrospectively.
    classified += Math.max(0, batch.text.split('\n').filter((l) => l.trim()).length - 1);
    for (const member of batch.text.split('\n')) {
      unknown.delete(shapeOf(member));
    }
  }

  if (block.type === 'unknown') {
    if (entry.s.trim().length === 0) continue;
    const shape = shapeOf(entry.s);
    const seen = unknown.get(shape) ?? { count: 0, sample: entry.s, after: new Set() };
    seen.count += 1;
    seen.after.add(lastCommand);
    unknown.set(shape, seen);
  } else {
    classified += 1;
    if (showColour) {
      const codes = foregroundCodes(entry.raw ?? '').join(',') || 'none';
      const key = `${block.type}`;
      const bucket = colours.get(key) ?? new Map();
      bucket.set(codes, (bucket.get(codes) ?? 0) + 1);
      colours.set(key, bucket);
    }
  }
}

const blank = entries.filter((e) => e.k === 'line' && e.s.trim().length === 0).length;
const meaningful = lines - blank;
const pct = meaningful > 0 ? ((classified / meaningful) * 100).toFixed(1) : '0.0';

console.log(`coverage: ${classified}/${meaningful} meaningful lines classified (${pct}%)`);
console.log(`          ${blank} blank lines ignored\n`);

console.log('block types');
for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  if (type === 'unknown') continue;
  console.log(`  ${String(count).padStart(5)}  ${type}`);
}

if (showColour) {
  console.log('\ncolours actually worn (SGR foreground codes)');
  for (const [type, bucket] of colours) {
    const parts = [...bucket.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([codes, n]) => `${codes}×${n}`)
      .join('  ');
    console.log(`  ${type.padEnd(24)} ${parts}`);
  }
}

const ranked = [...unknown.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`\nunclassified shapes: ${ranked.length} distinct`);
for (const [shape, info] of ranked.slice(0, unknownLimit)) {
  const after = [...info.after].slice(0, 3).join(', ');
  console.log(`  ${String(info.count).padStart(4)}  ${JSON.stringify(info.sample.slice(0, 88))}`);
  console.log(`        after: ${after}`);
}
if (ranked.length > unknownLimit) {
  console.log(`  … ${ranked.length - unknownLimit} more shapes not shown`);
}
console.log('');
