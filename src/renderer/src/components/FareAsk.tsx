import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { coinWords, fareOverShare, fareShortfall, type RouteFare } from '@shared/world';

/**
 * A way whose fares are over the player's share or the purse (`Route.fare`,
 * todo 20261024-0804-01): what it pays against what they hold, one press to
 * pay past the share, and the cash the walk draws at a bank first where the
 * purse is short (the server takes a fare from cash on hand, `FareCash`).
 * Nothing walks past the share until it is answered, as with a way through
 * what they keep out of. Drawn as the route
 * choice is: tonal, never a fill.
 */
export default function FareAsk({
  fare,
  paying,
  onPay
}: {
  fare: RouteFare;
  paying: boolean;
  onPay(): void;
}) {
  const words = { fare: coinWords(fare.copper), share: fare.share };
  const short = fareShortfall(fare);
  return (
    <div className="route-choice" data-route-fare={fare.copper} role="group">
      {fareOverShare(fare) && (
        <>
          <span className="route-choice-ask">
            {fare.wealth === null
              ? t('cards.route.fare.askUnread', words)
              : t('cards.route.fare.ask', { ...words, wealth: coinWords(fare.wealth) })}
          </span>
          <button
            aria-pressed={paying}
            className="route-way"
            onClick={onPay}
            onMouseDown={keepFocus}
            type="button"
          >
            <strong>{t('cards.route.fare.pay', words)}</strong>
          </button>
        </>
      )}
      {short !== null && (
        <span className="route-choice-ask">
          {t('cards.route.fare.drawFirst', {
            fare: words.fare,
            purse: coinWords(fare.copper - short),
            short: coinWords(short)
          })}
        </span>
      )}
    </div>
  );
}
