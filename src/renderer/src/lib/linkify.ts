/**
 * Turning a web address in server text into something clickable.
 *
 * People paste links into gossip, and the Talk card is where a conversation is
 * read — so a link that has to be retyped by hand is a link nobody follows. The
 * console does this with xterm's own addon; this is the same thing for the
 * cards, which are ordinary DOM.
 *
 * **Split, never replace.** The message is rendered as an array of strings and
 * anchors rather than as HTML, so nothing here can ever put markup somebody
 * else typed into the page. That is not a theoretical concern: the text is
 * written by other players on a MUD, and `dangerouslySetInnerHTML` over it
 * would be exactly the hole its name warns about.
 *
 * The pattern is deliberately narrow — `http` and `https` only. `www.` without
 * a scheme is a guess about what somebody meant, and everything else a URL can
 * be (`file:`, `smb:`, a registered handler nobody has heard of) is a thing to
 * hand the operating system only when the person typing it is the person
 * running the client. Main refuses those schemes too; this is the first of the
 * two gates rather than the only one.
 */

/**
 * A web address, ending before the punctuation that ends a sentence.
 *
 * Trailing `.`, `,`, `!`, `?`, `:`, `;` and a closing bracket are excluded from
 * the match, because "see https://example.com." is a sentence with a full stop
 * and not an address with a dot in it. A closing parenthesis is only excluded
 * when unbalanced, which is why the tail is matched rather than trimmed after.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']*[^\s<>"'.,!?:;)\]}]/gi;

export interface LinkPart {
  text: string;
  /** The address, when this part is one. */
  href?: string;
}

/** Splits a line into runs of text and the addresses between them. */
export function linkify(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let at = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: match[0], href: match[0] });
    at = start + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  // One part, always, so a caller can render the result without a special case
  // for "no links" — and an empty string stays an empty string.
  return parts.length > 0 ? parts : [{ text }];
}
