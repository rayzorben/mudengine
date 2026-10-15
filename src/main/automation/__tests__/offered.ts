/**
 * Every intent a queue under test is offered, in order, so a test can read
 * the decision an automated command was sent for (todo 119).
 */
import type { CommandQueue, Intent } from '../CommandQueue';
import type { DecisionKind } from '../../../shared/decisionSettings';

export interface Offered {
  intents: Intent[];
  /** The decision the first intent offered for `command` was offered as. */
  decisionOf(command: string): DecisionKind | undefined;
}

export function recordOffers(queue: Pick<CommandQueue, 'offer'>): Offered {
  const intents: Intent[] = [];
  const offer = queue.offer.bind(queue);
  queue.offer = (intent) => {
    intents.push(intent);
    return offer(intent);
  };
  return {
    intents,
    decisionOf: (command) => intents.find((intent) => intent.command === command)?.decision
  };
}
