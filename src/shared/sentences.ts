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

export interface ShippedSentences {
  readonly actions: ActionBook;
  readonly deaths: DeathBook;
}

export const NO_SHIPPED_SENTENCES: ShippedSentences = {
  actions: new ActionBook(),
  deaths: new DeathBook()
};
