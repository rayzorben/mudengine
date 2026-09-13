/**
 * Replays the whole `captures/` corpus through the real classifier.
 *
 *   npm run capture:corpus -- [--unknown 60] [--shapes out.tsv] [--accept]
 *
 * `analyse-capture.mjs` answers "what did the parser miss in *my* session?"
 * from a `.mudcap.jsonl` this client wrote. This answers the same question
 * against every capture in `captures/` — 214 other people posted between roughly 1997 and 2023, plus our own —
 * a corpus no probe against the test realm can reproduce, because it spans
 * realms, versions and classes this account does not have.
 *
 * Two differences from a session capture, both of which cost fidelity and are
 * reported rather than papered over:
 *
 *   - **There is no outbound record.** What was typed survives only as the
 *     echo the server appends to its own status line (`[HP=197]:sn`), so the
 *     command is recovered from there. A capture whose poster stripped the
 *     prompts has no commands at all, and the two rules that need one
 *     (`command-echo`, `command-unknown`) cannot fire in it.
 *   - **There is no room state.** `present()` is rebuilt from the corpus's own
 *     `Also here:` lines and arrivals rather than from `CharacterTracker`, so
 *     a monster named only by a line this analyser could not read is missing
 *     from the lookup that would have named it. That under-reports name
 *     resolution and never over-reports it.
 *
 * Colour is absent from every file (the posters pasted text), so no rule that
 * scores on SGR can score here. Per CLAUDE.md that changes nothing: colour
 * only ever adjusts confidence and never gates a match.
 */
import fs from 'node:fs';
import path from 'node:path';

const { Classifier } = await import('../src/main/parse/Classifier.ts');
const { WorldGraph } = await import('../src/main/world/WorldGraph.ts');
const { STATUS_LINE } = await import('../src/main/parse/patterns.ts');
const { loadShippedSentences } = await import('../src/main/world/ShippedSentences.ts');

// The server's own words for an emote and for a monster dying, read as the
// client reads them; a corpus that ignored the shipped tables could not show
// what they changed.
const sentences = loadShippedSentences(path.resolve('resources/world'), (message) =>
  console.error(message)
);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const unknownLimit = Number(flag('unknown', 60)) || 60;
const shapesOut = flag('shapes', null);
/*
 * Some posters pasted their capture into an indented block, so a whole file
 * arrives four spaces in and every `^`-anchored rule in the table misses it.
 * That is the poster's editor, not the server, so `--trim` measures the corpus
 * as the wire would have delivered it. Both numbers are worth having: the raw
 * one says what this corpus costs to read, the trimmed one says what the
 * classifier is actually missing.
 */
const trimIndent = args.includes('--trim');

const dir = path.resolve('captures');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.txt'))
  .sort();
if (files.length === 0) {
  console.error('no captures found in captures/');
  process.exit(1);
}

const world = WorldGraph.load(path.resolve('resources/world/paradigm.jsonl.gz'));
console.log(
  `\nrealm: ${world.size.toLocaleString()} rooms, ${world.mobCount.toLocaleString()} monsters`
);
console.log(`corpus: ${files.length} captures\n`);

/** Collapses a line to its shape, so variants group together. */
const shapeOf = (text) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 90);

const byType = new Map();
const unknown = new Map();
/** Prompt-tails nothing could read — see `tailAfterPrompt`. */
const unreadTails = new Map();
const perFile = [];

let lines = 0;
let blank = 0;
let classified = 0;

for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  // The corpus has no room state of its own, so the lookup is rebuilt from
  // what the capture itself says is standing here. Cleared by a room name for
  // the same reason the tracker clears it: the list belongs to one room.
  let present = [];
  const classifier = new Classifier(
    {
      present: () => present,
      mob: (name) => world.mob(name)
    },
    undefined,
    (text) => sentences.deaths.mobsOf(text),
    (text) => sentences.actions.match(text)
  );

  let seq = 0;
  let fileLines = 0;
  let fileClassified = 0;
  let lastCommand = '(none)';
  let sawCommand = false;

  for (const raw of text.split('\n')) {
    const plain = trimIndent
      ? raw.replace(/\r$/, '').replace(/^[ \t]+/, '')
      : raw.replace(/\r$/, '');
    lines += 1;
    fileLines += 1;
    if (plain.trim().length === 0) {
      blank += 1;
      continue;
    }
    seq += 1;

    const { block, batch, tails } = classifier.classify({
      seq,
      at: seq,
      text: plain,
      plain,
      terminator: 'crlf'
    });

    const record = (type) => byType.set(type, (byType.get(type) ?? 0) + 1);
    record(block.type);
    /*
     * A prompt may carry a sentence on its own framed line — see
     * `tailAfterPrompt`. The line is already counted as classified by its
     * prompt, so a tail never moves the coverage figure; it is recorded under
     * its own type so an *unread* one shows up here rather than hiding behind
     * a status line that read fine.
     */
    for (const tail of tails ?? []) {
      record(`${tail.type} (tail)`);
      if (tail.type === 'unknown') unreadTails.set(plain, (unreadTails.get(plain) ?? 0) + 1);
    }
    if (batch) {
      record(`${batch.type} (batch)`);
      const members = batch.text.split('\n').filter((l) => l.trim());
      const credited = Math.max(0, members.length - 1);
      classified += credited;
      fileClassified += credited;
      for (const member of members) unknown.delete(shapeOf(member));
    }

    if (block.type === 'unknown') {
      const shape = shapeOf(plain);
      const seen = unknown.get(shape) ?? {
        count: 0,
        sample: plain,
        after: new Set(),
        files: new Set()
      };
      seen.count += 1;
      seen.after.add(lastCommand);
      seen.files.add(file);
      unknown.set(shape, seen);
    } else {
      classified += 1;
      fileClassified += 1;
    }

    // Keep the room lookup roughly true. Both of these are the corpus's own
    // words, not an inference: a listing replaces, an arrival adds.
    if (block.type === 'room-name') present = [];
    const alsoHere = /^Also here:\s*(.+?)\.\s*$/.exec(plain);
    if (alsoHere) {
      present = alsoHere[1]
        .split(',')
        .map((who) =>
          who
            .trim()
            .replace(/\s*\((?:Hidden|Charmed)\)$/i, '')
            .replace(/\*$/, '')
        )
        .filter(Boolean);
    }
    const arrived =
      /^(?:The )?(.+?) (?:just )?(?:walks|crawls|slithers|flies|strides|steps|wanders|shambles|lumbers)? ?into the room/i.exec(
        plain
      );
    if (arrived && arrived[1] && !present.includes(arrived[1])) present.push(arrived[1]);

    // The only record of what was typed: the server's echo on its own prompt.
    const status = STATUS_LINE.exec(plain);
    if (status) {
      const typed = plain.slice(status[0].length).trim();
      if (typed) {
        classifier.observeCommand(typed);
        lastCommand = typed;
        sawCommand = true;
      }
    }
  }

  perFile.push({ file, lines: fileLines, classified: fileClassified, sawCommand });
}

const meaningful = lines - blank;
const pct = ((classified / meaningful) * 100).toFixed(1);
console.log(
  `coverage: ${classified.toLocaleString()}/${meaningful.toLocaleString()} meaningful lines classified (${pct}%)`
);
console.log(`          ${blank.toLocaleString()} blank lines ignored`);
console.log(
  `          ${perFile.filter((f) => !f.sawCommand).length} captures carry no command echo at all\n`
);

console.log('block types');
for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  if (type === 'unknown') continue;
  console.log(`  ${String(count).padStart(6)}  ${type}`);
}

const ranked = [...unknown.entries()].sort((a, b) => b[1].count - a[1].count);
const unknownTotal = ranked.reduce((n, [, i]) => n + i.count, 0);
console.log(
  `\nunclassified: ${unknownTotal.toLocaleString()} lines in ${ranked.length.toLocaleString()} distinct shapes\n`
);
for (const [, info] of ranked.slice(0, unknownLimit)) {
  console.log(
    `  ${String(info.count).padStart(5)} ×${String(info.files.size).padStart(3)}f  ${JSON.stringify(info.sample.slice(0, 84))}`
  );
}
if (ranked.length > unknownLimit)
  console.log(`  … ${ranked.length - unknownLimit} more shapes not shown`);

const tailRanked = [...unreadTails.entries()].sort((a, b) => b[1] - a[1]);
if (tailRanked.length > 0) {
  const total = tailRanked.reduce((n, [, c]) => n + c, 0);
  console.log(
    `\nunread prompt tails: ${total.toLocaleString()} in ${tailRanked.length.toLocaleString()} distinct lines\n`
  );
  for (const [sample, count] of tailRanked.slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)}  ${JSON.stringify(sample.slice(0, 84))}`);
  }
  if (tailRanked.length > 20) console.log(`  … ${tailRanked.length - 20} more not shown`);
}

if (shapesOut) {
  const rows = ['count\tfiles\tafter\tsample'];
  for (const [, info] of ranked) {
    rows.push(
      [info.count, info.files.size, [...info.after].slice(0, 2).join(' | '), info.sample].join('\t')
    );
  }
  fs.writeFileSync(shapesOut, rows.join('\n') + '\n');
  console.log(`\nunclassified shapes written to ${shapesOut}`);
}

/*
 * The baseline is the last accepted reading of this corpus, kept beside it
 * (`captures/` is not in git, so neither is a reading of it). A replay that
 * differs fails and names the difference, so a parser change proves itself
 * in one replay rather than one with and one without; `--accept` records
 * the reading once the difference is the intended one.
 */
const baselineFile = path.join(dir, 'baseline.json');
const reading = {
  trimmed: trimIndent,
  captures: files.length,
  classified,
  meaningful,
  unknownLines: unknownTotal,
  unknownShapes: ranked.length,
  unreadTails: tailRanked.reduce((n, [, count]) => n + count, 0),
  byType: Object.fromEntries(
    [...byType.entries()]
      .filter(([type]) => type !== 'unknown')
      .sort(([a], [b]) => a.localeCompare(b))
  ),
  files: Object.fromEntries(perFile.map((f) => [f.file, f.classified]))
};
if (args.includes('--accept')) {
  fs.writeFileSync(baselineFile, JSON.stringify(reading, null, 2) + '\n');
  console.log(`\nbaseline recorded at ${path.relative(process.cwd(), baselineFile)}`);
} else if (!fs.existsSync(baselineFile)) {
  console.log('\nno baseline to compare with; run with --accept to record this reading');
} else {
  const base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  if (base.trimmed !== reading.trimmed) {
    console.log(
      `\nthe baseline was recorded ${base.trimmed ? 'with' : 'without'} --trim; not compared`
    );
  } else {
    const drift = [];
    for (const key of [
      'captures',
      'classified',
      'meaningful',
      'unknownLines',
      'unknownShapes',
      'unreadTails'
    ]) {
      if (base[key] !== reading[key]) drift.push(`${key}: was ${base[key]}, now ${reading[key]}`);
    }
    for (const type of new Set([
      ...Object.keys(base.byType),
      ...Object.keys(reading.byType)
    ]).values()) {
      const was = base.byType[type] ?? 0;
      const now = reading.byType[type] ?? 0;
      if (was !== now) drift.push(`${type}: was ${was}, now ${now}`);
    }
    for (const file of new Set([
      ...Object.keys(base.files),
      ...Object.keys(reading.files)
    ]).values()) {
      const was = base.files[file];
      const now = reading.files[file];
      if (was !== now)
        drift.push(`${file}: was ${was ?? 'absent'}, now ${now ?? 'absent'} classified`);
    }
    if (drift.length === 0) console.log('\nthe corpus reads as the baseline does');
    else {
      console.log(
        `\nthe corpus differs from the baseline in ${drift.length} place${drift.length === 1 ? '' : 's'}:`
      );
      for (const line of drift.slice(0, 40)) console.log(`  ${line}`);
      if (drift.length > 40) console.log(`  … ${drift.length - 40} more`);
      console.log('if that is the change intended, record it: npm run capture:corpus -- --accept');
      process.exitCode = 1;
    }
  }
}
console.log('');
