import { memo, Fragment } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';
import { bankKey, type BankBalance, type CharacterState } from '@shared/character';

/**
 * What this character has left in each vault, and when each vault said so.
 *
 * **A card and not a face of Room**, unlike the shop beside it. A shop is a
 * property of the room the character is standing in and stops being true on
 * the next step; a balance is *accumulated* — learned in one town and still
 * wanted in another. That is the Players card's justification exactly: what
 * this client has learned and keeps after the character walks out. The Room
 * card's own `BANK` face answers "what is in this vault"; nothing standing in
 * one room can answer "and what about the other six".
 *
 * ## Every figure here is a quotation
 *
 * Nothing maintains a balance. `You deposit 102351 copper farthings.` names no
 * bank, so it cannot be credited to one — the room could be asked, but only
 * with the realm file loaded, the room resolved and a shop recorded for it, and
 * when any of those fails the choice is between crediting the wrong vault and
 * crediting none. So a deposit moves the purse and leaves every balance where
 * the bank last put it.
 *
 * Which makes the timestamp load-bearing rather than decorative, and it is
 * drawn the way a player's `@health` answer is, for the same reason: a number
 * from five minutes ago shown as though it were live is the readout claiming
 * to know something it does not. Ask a vault again and it corrects itself in
 * one command.
 *
 * ## And a bank never asked is absent, not empty
 *
 * A vault with no entry is one nobody has asked, and it is simply not listed —
 * never drawn as a balance of zero. The comfortable reading is wrong twice over
 * here: a character told they have no savings may have a great many, and this
 * is the one card whose whole subject is money they are counting on.
 */
export interface BanksCardProps extends CardChrome {
  character: CharacterState;
}

/**
 * Richest first, then by name.
 *
 * Where the money is, is the question the card is opened for, so it belongs
 * where the eye lands — the same decision the Realm card makes for standing and
 * the Gang card makes for who is online. By name within equal balances so a
 * vault does not appear to move between readings for no reason a player can
 * see.
 */
function ordered(banks: readonly BankBalance[]): BankBalance[] {
  return [...banks].sort(
    (a, b) => b.copper - a.copper || bankKey(a.name).localeCompare(bankKey(b.name))
  );
}

/** One line per vault, for pasting to somebody who asked. */
export function banksCopyText(banks: readonly BankBalance[]): string {
  const rows = ordered(banks);
  return [
    t('cards.banks.title'),
    ...rows.map((bank) =>
      t('cards.banks.copyRow', { name: bank.name, copper: bank.copper.toLocaleString() })
    )
  ].join('\n');
}

function BanksCard({ character, ...chrome }: BanksCardProps): React.JSX.Element {
  const banks = ordered(character.banks);
  /*
   * Read once for the whole render rather than per row, so two vaults read in
   * the same second cannot print different ages for the same instant.
   */
  const now = Date.now();

  const total = banks.reduce((sum, bank) => sum + bank.copper, 0);

  return (
    <BentoCard
      {...chrome}
      className="banks-card"
      badge={
        banks.length === 0 ? undefined : (
          <span className="chip">{t('cards.banks.badge', { count: banks.length })}</span>
        )
      }
      copyText={() => banksCopyText(banks)}
      title={t('cards.banks.title')}
    >
      {banks.length === 0 ? (
        <div className="aside">{t('cards.banks.none')}</div>
      ) : (
        <>
          <dl className="readout">
            {banks.map((bank) => (
              /*
                A fragment and **not** a wrapping element. `.readout` is one
                grid and CSS sizes its `auto` column from one container's own
                children, so a div around each pair would make every vault its
                own grid — the label column would stop aligning down the card,
                which is the exact failure the Room card had when it stated its
                rows in two `<dl>`s.

                Keyed by the realm's shop id where there is one and the folded
                name otherwise — the same key the merge uses, so a vault cannot
                be one row for the merge and two for React.
              */
              <Fragment key={bank.shop === null ? bankKey(bank.name) : `#${bank.shop}`}>
                <dt>{bank.name}</dt>
                <dd>
                  {t('cards.banks.copper', { copper: bank.copper.toLocaleString() })}{' '}
                  <span className="quiet-note">({ago(bank.at, now)})</span>
                </dd>
              </Fragment>
            ))}
          </dl>
          {/*
            Stated only where it says something the rows do not. One vault's
            total is that vault's row again, and a card repeating itself reads
            as two facts where there is one.
          */}
          {banks.length > 1 ? (
            <div className="aside">
              {t('cards.banks.total', { copper: total.toLocaleString() })}
            </div>
          ) : null}
        </>
      )}
    </BentoCard>
  );
}

export default memo(BanksCard);
