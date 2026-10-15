/**
 * What a client command (`shared/clientCommands.ts`, todo 83) sends, worked
 * out from the character as it is when the step's turn comes: the floor of
 * the room the character is in by then, the pack as it is by then. The work
 * is `@get-all`'s and the Re-equip Gear button's, so the three agree.
 */
import type { CharacterState } from '../../shared/character';
import type { ClientCommand } from '../../shared/clientCommands';
import type { NoticeSink } from '../../shared/decisionSettings';
import { t } from '../app/i18n';
import { restoreKit } from '../automation/restoreKit';
import { takeFloor } from '../automation/takeFloor';

/** The commands `command` stands for now, each notice handed to `notice`. */
export function clientCommandWords(
  command: ClientCommand,
  state: CharacterState,
  /** `automation.remotes.maxGets`, the most `get`s one `get all` sends. */
  maxGets: number,
  notice: NoticeSink
): string[] {
  const words: string[] = [];
  const send = (each: string): void => {
    words.push(each);
  };
  switch (command) {
    case 'get-all': {
      const { sent, listed, max } = takeFloor(state, maxGets, send);
      if (sent === 0) notice(t('session.clientCommand.getAllEmpty'));
      else if (listed > max)
        notice(t('session.clientCommand.getAllCapped', { max, total: listed }), 'take-floor');
      return words;
    }
    case 'equip-all': {
      const { notices } = restoreKit(state, send);
      for (const message of notices) notice(message);
      return words;
    }
    default: {
      const never: never = command;
      throw new Error(`no client command ${String(never)}`);
    }
  }
}
