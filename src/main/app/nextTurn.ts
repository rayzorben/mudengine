/**
 * One turn of the event loop given back, for a plan that runs long on the
 * thread that reads every socket: the lap index, the gear trip, the quest
 * reach and the fight log's fold each yield between slices with this.
 */
export function nextTurn(): Promise<void> {
  return new Promise<void>((next) => setImmediate(next));
}
