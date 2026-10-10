import type { QuestReward } from '@shared/quests';
import { keepFocus } from '../lib/focus';
import { rewardWords } from '../lib/questWords';
import { t } from '../lib/i18n';

/** `#642` — this card's own stand-in for a row the realm does not name. */
const UNNAMED = /^#\d+$/;

/**
 * A realm name, drawn as the control it is everywhere else in the client.
 *
 * *A name is a control everywhere it is printed* — and this card was printing
 * five of them and making controls of two. **`yellowed note` is an item**: it
 * has a weight, a price, a row number and a panel that states them, and the
 * one card in the client that could not open it was the one telling the
 * player to go and get it. Reported 2026-09-15.
 *
 * Two refusals, both the same rule about a control bound to nowhere. **A null
 * `onName`** is a pinned float, where the panel belongs to the shown character
 * and this card's realm may not be theirs — as it already did for the asker.
 * And **`#642`** is not a name: it is this card admitting the realm gave the
 * row none, so there is nothing to look up and it stays the text it is.
 */
export function Name({
  children,
  onName
}: {
  children: string;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
}): React.JSX.Element {
  if (!onName || UNNAMED.test(children)) return <span>{children}</span>;
  return (
    <button
      className="lookup"
      onClick={(event) => onName(children, event.currentTarget)}
      onMouseDown={keepFocus}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * One reward, with the realm's own name in it as a control.
 *
 * Only the **name** is the control and never the sentence around it: a spell
 * reward reads *teaches {name}*, and a button carrying the verb would claim
 * the word *teaches* is something to look up. The other five kinds — exp,
 * coins, an ability rank, lives, an alignment shift — name nothing the realm
 * has a row for, so they stay the words `rewardWords` writes.
 */
export function Reward({
  reward,
  onName
}: {
  reward: QuestReward;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
}): React.JSX.Element {
  if (reward.kind === 'item') {
    return <Name onName={onName}>{reward.name ?? `#${reward.id}`}</Name>;
  }
  if (reward.kind === 'spell') {
    return (
      <>
        <span>{t('cards.quests.reward.spellVerb')} </span>
        <Name onName={onName}>{reward.name ?? `#${reward.id}`}</Name>
      </>
    );
  }
  return <>{rewardWords(reward)}</>;
}
