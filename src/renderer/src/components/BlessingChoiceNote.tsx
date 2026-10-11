import { choiceSentences, type BlessingChoiceView } from '@shared/blessingchoice';
import { t } from '../lib/i18n';

/**
 * What Auto Choose Blessings last decided (todo 41), as its notice said it:
 * the blessings it keeps up, from the book or a carried item, each with what
 * it adds; the ones it passed over and why; or why it chose nothing and what
 * is cast instead. Nothing while the switch is off or nothing was decided.
 */
export default function BlessingChoiceNote({
  view
}: {
  view: BlessingChoiceView | null;
}): React.JSX.Element | null {
  if (view === null) return null;
  return (
    <>
      {choiceSentences(view, t).map((sentence) => (
        <p className="settings-note" data-blessing-choice key={sentence}>
          {sentence}
        </p>
      ))}
    </>
  );
}
