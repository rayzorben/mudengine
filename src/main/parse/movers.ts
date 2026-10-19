/**
 * The monster a `mob-arrives-room` or `mob-leaves-room` block names, as
 * printed: the server's own sentence names it (`mob`), a blow's frame names the
 * attacker, and a realm's movement verb leaves it in `line` before its last word
 * (`orc sentry moves into the room from the south.`). Empty when nothing does.
 * Read by the room, and by the fight for a monster following (todo 20261018-1314-02).
 */
export function moverName(g: Readonly<Record<string, string>>): string {
  return g['mob'] ?? g['attacker'] ?? trimVerb(g['line'] ?? '');
}

/**
 * The name in an arrival sentence the realm data could not resolve.
 *
 * `A large lashworm crawls into the room from the above!` leaves
 * `large lashworm crawls`, and a departure (`A giant crab scurries off to the
 * north.`) leaves `giant crab scurries`: the last word is the finite verb.
 * That is positional grammar rather than a verb list, which is the thing
 * docs/greatermud/messages.md forbids: English puts the verb immediately before
 * `into the room from` or `off to the`, whatever word the realm chose.
 *
 * A last resort, used only when neither the room nor the realm's monster table
 * could say. It can be wrong — a two-word verb phrase leaves a word on the
 * name — and both consequences of being wrong are bounded: the next `Also
 * here:` replaces the list outright, and a name nothing recognises carries no
 * disposition, so it is never something the client opens a fight with.
 */
function trimVerb(middle: string): string {
  const words = middle.trim().split(/\s+/).filter(Boolean);
  return words.length <= 1 ? '' : words.slice(0, -1).join(' ');
}
