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
 * ## An amount is not a thing a button may carry
 *
 * The exits above are safe to compose here because the realm's own text does
 * not go stale between the line being printed and the button being pressed. A
 * *figure* does, and `Deposit All` used to carry one: `['i', 'deposit 192600',
 * 'bank']`, composed the moment the room's name printed, with a note saying
 * the `i` was what made the figure current by the time the deposit was read.
 * It cannot be — the number is a literal by then, and all three strings leave
 * the client together. It was measured doing exactly that
 * (`logs/2026-09-04_20-39-52_festus`) against a purse two levels' training had
 * left 2,200 copper high, and this server refuses an over-deposit in silence.
 *
 * So the deposit is a `TerminalIntentAction`: the button names the action and
 * `AutoDeposit` runs it, sending the `i` and composing the figure from the
 * listing that answers it. Nothing about the amount is decided here.
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
 * The deposit names an action rather than commands, for the reason in the
 * header — its figure is not knowable until the `i` it sends has been
 * answered, and a list of strings cannot wait for anything. `wealth` is
 * therefore read here for one thing only: **whether to offer the button at
 * all**. Null is nobody having said rather than nothing to bank, and a button
 * offered on an absence is one whose only outcome is a refusal.
 *
 * That is a weaker claim than the figure it used to carry, and deliberately:
 * the maintained purse can be stale in either direction, so the offer is a
 * guess and the amount is not. A press that finds an empty purse says so.
 */
function bankActions(wealth: number | null, bankBalance: number | null): TerminalAction[] {
  const actions: TerminalAction[] = [];
  if (wealth !== null && wealth > 0) {
    actions.push({
      label: t('terminal.actions.depositAll'),
      act: 'deposit-all',
      title: t('terminal.actions.depositAllTitle')
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
   * `i` **after**, unlike the deposit's, and it is kept even though
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
