/**
 * A cash run (`CashRun`): a loop walked collecting the coins asked for, and,
 * each time the character is loaded to the grade asked for, a token used to a
 * town and the cash gained walked to the nearest bank, then back to the loop.
 * What the dialog asks for and what it is offered. See `mudengine-automation`
 * › *Errands*.
 */
import { DENOMINATIONS, type Denomination } from './character';

/** The grade the server prints that counts as full. */
export type CashRunFull = 'medium' | 'heavy';
export const CASH_RUN_FULL: readonly CashRunFull[] = ['medium', 'heavy'];

export interface CashRunAsk {
  /** The loop, by name, as the character's loops name it. */
  loop: string;
  /** The coins to collect. Never empty. */
  coins: Denomination[];
  /** The tokens to use, as `Items` rows, first first. Never empty. */
  tokens: number[];
  full: CashRunFull;
}

/** A carried item that takes the character to a fixed room from anywhere. */
export interface CashRunToken {
  item: number;
  name: string;
  /** The room it lands in, by name. */
  lands: string;
  /** The copper one use takes from cash on hand, or null where the realm states none. */
  fare: number | null;
}

/** The dialog's ask, or null where any part is not one. */
export function asCashRunAsk(value: unknown): CashRunAsk | null {
  if (typeof value !== 'object' || value === null) return null;
  const { loop, coins, tokens, full } = value as Record<string, unknown>;
  if (typeof loop !== 'string' || loop.trim().length === 0) return null;
  if (!Array.isArray(coins) || coins.length === 0) return null;
  if (!coins.every((coin) => DENOMINATIONS.includes(coin as Denomination))) return null;
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  if (!tokens.every((item) => Number.isInteger(item) && (item as number) > 0)) return null;
  if (!CASH_RUN_FULL.includes(full as CashRunFull)) return null;
  return {
    loop,
    coins: [...new Set(coins as Denomination[])],
    tokens: [...new Set(tokens as number[])],
    full: full as CashRunFull
  };
}
