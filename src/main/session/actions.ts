/**
 * What can be done in the room whose name the console just printed.
 *
 * The buttons beside a room's name, decided here rather than in the renderer
 * for the reason every other fact is: the realm data and the character's own
 * state both live in main, and a renderer deciding this would be a second
 * reading of both.
 *
 * ## Nothing here is guessed
 *
 * A button sends a command verbatim, and **an unrecognised command on this
 * server is said out loud to everybody in the room** — so a wrong guess is not
 * a button that does nothing, it is a button that broadcasts. Every action
 * therefore comes from one of exactly two authorities:
 *
 * - **the realm's own data**, for an exit whose instruction names the command
 *   (`Text: go manhole, go man`); or
 * - **the server's own command table** (docs/greatermud/commands.md), for the
 *   verbs a kind of shop takes.
 *
 * Nothing is offered from taste, from another client's source, or from a verb
 * that looks like it should work.
 *
 * ## A label we wrote is Capital Case; a label the realm wrote is verbatim
 *
 * The two authorities above produce two kinds of label, and they are cased
 * differently on purpose. `Deposit All` is *our* words for an action we
 * composed; `go manhole` is the realm's own command text quoted back, and
 * recasing that would misrepresent the thing the button sends — it is the one
 * string on screen a player might retype by hand.
 *
 * So: anything reaching `t('terminal.actions.…')` for its label is Capital
 * Case in `ui.en.yaml`; anything whose label *is* its command stays exactly as
 * the realm data spells it.
 *
 * **These two are the exception to the client's own sentence case**, which is
 * what every other authored label in `ui.en.yaml` uses (`Keep playing`, `Reset
 * pane widths`, `Bring every character into this window`). The exception is
 * deliberate and it is about *where* they sit: every one of those lives in
 * chrome — a dialog, the palette, a card's action row — where a label is read
 * as prose. These sit inside the console, on the game's own line, among the
 * realm's own words, and Capital Case is what separates a control from the
 * text it is printed beside. Requested directly, and kept to the two-word
 * shape the terminal has room for.
 *
 * ## The amount is a number the client already has
 *
 * `deposit` takes a figure in copper, and `inventory.wealth` is exactly that —
 * `Wealth: 123456 copper farthings` is the server's own normalisation over the
 * five denominations, printed on every `i` and captured live against
 * `sys addcopper` (2026-08-29: 123,456 added, `Wealth:` said 123456). So the
 * button names a number the server itself stated in the unit the command
 * wants. `depo all` is *not* sent: the realm's transcripts have only ever
 * shown a figure, and an unrecognised command here is said out loud.
 *
 * **The purse is maintained, not merely seeded.** Every way money moves that
 * the wire announces now moves it: a listing states all five counts and the
 * total, coins picked up move their own denomination, and a purchase or sale
 * moves the total by the exact copper the server quoted (`withSpend`). That
 * last one was the gap — `buy flask` for 980 left the item moving and the
 * money still, so a shop trip made the figure stale by exactly the price.
 *
 * **Where it can still drift, the button refreshes first.** Coins from a chest
 * and other unannounced gains are real, so the action sends `i` and then the
 * deposit: the listing is authoritative and restates the purse a fraction of a
 * second before the figure is used. That is the maintained-listing shape the
 * whole client follows — the broadcasts keep it true for free, and a command
 * establishes it when being exactly right matters.
 */
import type { TerminalAction } from '../../shared/types';
import type { ShopKind } from '../../shared/world';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';

/**
 * The commands a room's own exits take, as the realm names them.
 *
 * `Text:` exits are not walked by typing a direction — `go manhole` is the
 * whole of how that exit works — so the button is the only way through one that
 * does not require knowing the realm data by heart.
 *
 * The list is `WorldGraph.exitCommandsNamed`'s, which is already one command
 * per exit (the realm lists the canonical phrasing first and its synonyms
 * after — `Text: go manhole, go man` — and offering both would be two buttons
 * that do one thing) and already refuses a name several rooms share.
 *
 * **The label is the command, uncased.** These are the realm's words, not
 * ours, and the label doubles as the thing a player can retype; `Go Manhole`
 * would be a button whose face and payload disagree.
 */
function exitActions(commands: readonly string[]): TerminalAction[] {
  return commands.map((command) => ({
    label: command,
    commands: [command],
    title: t('terminal.actions.exitTitle', { command })
  }));
}

/**
 * The bank's buttons: read the purse and bank it, or take the vault out.
 *
 * `i` first, always — not only when the figure looks stale. The listing is
 * authoritative and costs one command, and the alternative is a client that
 * banks a number it merely believes: coins out of a chest, a corpse or a
 * quest reward arrive with nothing on the wire announcing them, so no amount
 * of maintaining covers every case. Refreshing is the maintained-listing rule
 * applied where being exactly right matters.
 *
 * The figure sent is the one the client holds *now*, and the `i` in front of it
 * is what makes that figure current by the time the deposit is read. It is
 * offered at all only once a listing has stated a purse — before that
 * `inventory.wealth` is null, which is nobody having said rather than nothing
 * to bank, and a button reading `deposit 0` would act on an absence.
 */
function bankActions(wealth: number | null, bankBalance: number | null): TerminalAction[] {
  const actions: TerminalAction[] = [];
  if (wealth !== null && wealth > 0) {
    actions.push({
      label: t('terminal.actions.depositAll'),
      /*
       * `i` before, and `bank` after.
       *
       * The `i` makes the purse current, so the figure this button sends is
       * the one the character is actually carrying rather than one the client
       * merely believes.
       *
       * The `bank` after is now the *authority*, not the only source. Since
       * `CharacterTracker.creditVault` a deposit made in a room whose vault
       * has answered maintains that balance for free, exactly as the pack and
       * the roster are maintained — but the first press in a bank that has
       * not been asked has nothing to maintain, and that press is when the
       * Bank face is most looked at. One command establishes the figure and
       * every later press keeps it true.
       *
       * Safe to send here and nowhere else: `bank` is in the server's own
       * command table, it is offered only in a room the realm calls a bank,
       * and it answers for the vault standing in front of the character.
       */
      commands: ['i', `deposit ${wealth}`, 'bank'],
      title: t('terminal.actions.depositAllTitle', { amount: wealth })
    });
  }
  /*
   * The other direction, from the figure the vault itself last stated.
   *
   * `withdraw` is the server's own verb (docs/greatermud/commands.md:116) and
   * the amount is `BankBalance.copper`, the number `bank` printed for the
   * vault the character is standing in — offered only once that vault has
   * been asked, because an unasked balance is nobody having said rather than
   * an empty account, and a button reading `withdraw 0` would act on an
   * absence exactly as `deposit 0` would.
   *
   * `i` **after**, unlike the deposit's `i` before, and it is kept even though
   * `You withdrew N copper farthings.` is now read (`user-withdraws`) and the
   * purse maintained from it. Two reasons it still earns its command: the
   * maintained figure can only move a purse the client already has a number
   * for — this button is offered on the vault's figure alone, so `wealth` may
   * well be null — and the listing restates encumbrance, which a purse this
   * much heavier has just changed. Then `bank`, which is the vault's own
   * authority over the balance the deposit note above describes.
   */
  if (bankBalance !== null && bankBalance > 0) {
    actions.push({
      label: t('terminal.actions.withdrawAll'),
      commands: [`withdraw ${bankBalance}`, 'i', 'bank'],
      title: t('terminal.actions.withdrawAllTitle', { amount: bankBalance })
    });
  }
  return actions;
}

export function actionsFor(
  kind: ShopKind | undefined,
  exits: readonly string[],
  wealth: number | null,
  /** What `bank` last said this vault holds, or null while it has not been asked. */
  bankBalance: number | null = null
): TerminalAction[] {
  const actions = [
    ...(kind === 'bank' ? bankActions(wealth, bankBalance) : []),
    // A shop is why somebody is standing here; an exit is how they leave.
    ...exitActions(exits)
  ];
  return actions.slice(0, tuning().session.roomActions);
}
