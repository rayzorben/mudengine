import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { WorldGraph } from '../WorldGraph';

/**
 * A realm written to disk and loaded the way the client loads one: the header,
 * with whatever tables a test stands beside it, then a row per room.
 *
 * Beside the tests rather than inside one of them because several need it,
 * and the realm file's header written out in each was one more copy to chase
 * when the format moves. The directory goes whether or not the load throws.
 */
export function worldOf(
  rooms: ReadonlyArray<Record<string, unknown>>,
  header: Record<string, unknown> = {}
): WorldGraph {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-world-'));
  try {
    const file = path.join(dir, 'rooms.jsonl.gz');
    const top = { v: 1, source: 'test', rooms: rooms.length, generatedAt: 'x', ...header };
    const lines = [JSON.stringify(top), ...rooms.map((room) => JSON.stringify(room))];
    fs.writeFileSync(file, zlib.gzipSync(lines.join('\n') + '\n'));
    return WorldGraph.load(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
