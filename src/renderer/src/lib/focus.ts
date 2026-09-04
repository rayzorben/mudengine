import type { MouseEvent } from 'react';

/**
 * Stops a click from taking the caret out of the terminal.
 *
 * The terminal is where focus lives (docs/ui-design.md §3.6), and a surface
 * that takes no typed input must never move it. Chrome that is *clickable* is
 * still not chrome that is *typed into*: switching a card to its second face or
 * picking a room off the map is a mouse action, and afterwards the next thing
 * the player types must still reach the game.
 *
 * Preventing the default on `mousedown` is what does it — the click still
 * happens, the button simply never receives focus. Keyboard focus is untouched,
 * so anything reachable by Tab stays reachable and still shows a focus ring;
 * this only refuses the *mouse's* attempt to park the caret on chrome.
 *
 * Spelled once and shared, because the alternative is remembering it per
 * control, and the ones that get forgotten are the ones that quietly swallow a
 * keystroke — which in this game can cost a character.
 *
 * **Never on a `<select>`, and that is the one exception.** This works on a
 * button because a button's `mousedown` default is *only* the focus move, so
 * refusing it costs nothing. A `<select>` opens its popup on that same default,
 * so `keepFocus` there does not merely decline the caret — it stops the control
 * working at all, silently: the loop picker held every loop the
 * character had and clicking it showed none of them, which reads as a card
 * that has lost its list rather than as a control refusing focus. Anything
 * whose `mousedown` default is the interaction itself belongs in this
 * exception; hand the caret back on `change` instead, which is the same promise
 * kept a moment later.
 */
export function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}
