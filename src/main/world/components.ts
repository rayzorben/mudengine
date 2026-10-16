/**
 * A graph of numbered nodes: Tarjan's strongly connected components,
 * iteratively, since a realm's corridors are deeper than the call stack, and
 * the flood from a set of nodes. Read by `RealmJoins` (every move) and
 * `closedPlaces` (the moves that cross no kept-out word).
 */

/** Each node's component, numbered from 0, and how many there are. */
export interface Components {
  owner: Int32Array;
  count: number;
}

/** `out[node]` is every node one move from `node` leads to. */
export function stronglyConnected(out: ReadonlyArray<readonly number[]>): Components {
  const count = out.length;
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const owner = new Int32Array(count);
  const stack: number[] = [];
  let counter = 0;
  let components = 0;
  for (let root = 0; root < count; root++) {
    if (index[root] !== -1) continue;
    const frames: Array<{ node: number; edge: number }> = [{ node: root, edge: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = out[frame.node]!;
      if (frame.edge < edges.length) {
        const next = edges[frame.edge++]!;
        if (index[next] === -1) {
          index[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = 1;
          frames.push({ node: next, edge: 0 });
        } else if (onStack[next] === 1) {
          low[frame.node] = Math.min(low[frame.node]!, index[next]!);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) low[parent.node] = Math.min(low[parent.node]!, low[frame.node]!);
      if (low[frame.node] !== index[frame.node]) continue;
      let member: number;
      do {
        member = stack.pop()!;
        onStack[member] = 0;
        owner[member] = components;
      } while (member !== frame.node);
      components += 1;
    }
  }
  return { owner, count: components };
}

/** Every node `seeds` reach over `out`, marked 1. */
export function flood(out: ReadonlyArray<readonly number[]>, seeds: readonly number[]): Uint8Array {
  const seen = new Uint8Array(out.length);
  const stack = [...seeds];
  for (const each of stack) seen[each] = 1;
  while (stack.length > 0) {
    for (const next of out[stack.pop()!]!) {
      if (seen[next] === 1) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  return seen;
}
