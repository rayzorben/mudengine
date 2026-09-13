/**
 * The shipped tables of whole sentences a session reads lines against, beside
 * the spell table: the realm's emotes (`actions.ts`) and its monsters' death
 * sentences (`death-messages.ts`). Loaded once per process by
 * `src/main/world/ShippedSentences.ts` and handed to every session; the empty
 * pair is what a test and a client without the files get, and it reads
 * nothing — which is exactly what the frames alone did before.
 */
import { ActionBook } from './actions';
import { DeathBook } from './death-messages';
import { MessageBook, NO_MESSAGES } from './messages';

export interface ShippedSentences {
  readonly actions: ActionBook;
  readonly deaths: DeathBook;
  /** The server's own message table, fitted whole (`messages.ts`, todo 109). */
  readonly messages: MessageBook;
}

export const NO_SHIPPED_SENTENCES: ShippedSentences = {
  actions: new ActionBook(),
  deaths: new DeathBook(),
  messages: NO_MESSAGES
};
