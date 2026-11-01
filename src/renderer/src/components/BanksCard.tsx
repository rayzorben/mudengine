import { memo, useMemo, type CSSProperties } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import Kpi from './viz/Kpi';
import SplitBar, { type SplitPart } from './viz/SplitBar';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';
import { bankKey, type BankBalance, type CharacterState } from '@shared/character';
import { bankedCopper } from '@shared/coins';

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

/** A figure for the split bar's key, with thousands separated. */
const plainFigure = (value: number): string => value.toLocaleString();

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
  const banks = useMemo(() => ordered(character.banks), [character.banks]);
  /*
   * Read once for the whole render rather than per row, so two vaults read in
   * the same second cannot print different ages for the same instant.
   */
  const now = Date.now();

  const total = bankedCopper(banks);
  const wealth = character.inventory.wealth;
  const richest = banks[0]?.copper ?? 0;
  // A share of all the money, drawn only once the purse is read: an unread
  // purse counted as none would make every vault's share a claim.
  const all = wealth === null ? null : total + wealth;
  /*
   * The cash on hand beside each vault, so where the money is reads as one
   * bar. The purse is left out while it is unread: a zero there would be a
   * claim the listing did not make.
   */
  const parts = useMemo<SplitPart[]>(
    () => [
      ...(wealth === null
        ? []
        : [
            {
              key: 'purse',
              label: t('cards.inventory.wealthLabel'),
              value: wealth,
              tone: 'a' as const
            }
          ]),
      ...banks.map((bank) => ({
        key: keyOf(bank),
        label: bank.name,
        value: bank.copper,
        tone: 'c' as const
      }))
    ],
    [banks, wealth]
  );

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
          {/* At every size, what is banked in all and what is carried. */}
          <div className="kpis banks-kpis">
            <Kpi
              hint={t('cards.banks.unit')}
              label={t('cards.banks.banked')}
              tone="accent"
              value={total.toLocaleString()}
            />
            <Kpi
              hint={t('cards.banks.unit')}
              label={t('cards.inventory.wealthLabel')}
              value={wealth === null ? null : wealth.toLocaleString()}
            />
          </div>
          <div className="banks-split">
            <SplitBar format={plainFigure} label={t('cards.banks.splitAria')} parts={parts} />
          </div>
          {/*
            A vault a row, each with a bar against the richest, so the one the
            money is in is the long bar. Keyed as the merge keys a vault, so a
            vault cannot be one row for the merge and two for React.
          */}
          <ul className="bank-rows from-medium">
            {banks.map((bank) => (
              <li
                key={keyOf(bank)}
                title={t('cards.banks.copper', { copper: bank.copper.toLocaleString() })}
              >
                <span className="bank-name">{bank.name}</span>
                <span className="bank-age">{ago(bank.at, now)}</span>
                <span className="bank-share from-large">
                  {all !== null && all > 0 ? `${Math.round((100 * bank.copper) / all)}%` : ''}
                </span>
                <b className="bank-figure">{bank.copper.toLocaleString()}</b>
                <i
                  className="bank-bar"
                  style={{ '--share': richest > 0 ? bank.copper / richest : 0 } as CSSProperties}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </BentoCard>
  );
}

/** The realm's shop id where the header printed one, else the folded name. */
function keyOf(bank: BankBalance): string {
  return bank.shop === null ? bankKey(bank.name) : `#${bank.shop}`;
}

export default memo(BanksCard);
